import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { addLocalDays, type ScheduleRule } from "@niho-experience/experience-domain";
import type { Pool } from "pg";
import { GuestBookingAccess } from "../src/booking-access.ts";
import { BookingCancellations, GUEST_NOTICE_TOPICS, type RefundSubmission } from "../src/booking-cancellations.ts";
import { StoreAccessDeniedError, StoreConflictError, StoreNotFoundError, StoreValidationError } from "../src/errors.ts";
import { GuestBookingRepository, type GuestBookingStart, type StartGuestBookingInput } from "../src/guest-bookings.ts";
import { GuestMailOutbox } from "../src/guest-mail-outbox.ts";
import { HOST_NOTIFICATION_TOPICS } from "../src/host-notification-outbox.ts";
import { ExperienceStore } from "../src/repository.ts";

/** 取消と返金 (#285 slice 7) against a real schema, synthetic data only. */
const databaseUrl = process.env.TEST_DATABASE_URL;
const ownerA = { providerId: "provider-a", nihoUserId: "owner-a" } as const;
const editorA = { providerId: "provider-a", nihoUserId: "editor-a" } as const;
const support = { nihoUserId: "support-admin-1" } as const;
const CONSENT = "sample-terms-2026-10";
const NO_QUESTIONS = createHash("sha256").update("[]", "utf8").digest("hex");
const HOUR_MS = 3_600_000;
const ACCOUNT = "acct_SampleA0001";

function day(offset: number): string {
  return addLocalDays(new Date(Date.now() + 9 * HOUR_MS).toISOString().slice(0, 10), offset);
}

const RULE: ScheduleRule = {
  id: "sample-walk-am", timeZone: "Asia/Tokyo", startsOn: day(1), localStartTime: "10:00", durationMinutes: 90, capacity: 12,
  bookingCutoffMinutes: 60, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "DAILY" },
};

function request(overrides: Partial<StartGuestBookingInput> = {}): StartGuestBookingInput {
  return {
    slug: "sample-walk", offerId: "sample-walk-am", occurrenceDate: day(5), adultCount: 2, childCount: 1, expectedTotalYen: 7500,
    bookingQuestionsFingerprint: NO_QUESTIONS, answers: [], termsConsentVersion: CONSENT, currentConsentVersion: CONSENT,
    conditionsConsentVersion: null, guestName: "Sample Guest", guestEmail: "guest@example.com", guestLanguage: "EN",
    clientRequestKey: randomUUID(), ...overrides,
  };
}

interface Context {
  readonly pool: Pool;
  readonly store: ExperienceStore;
  readonly guests: GuestBookingRepository;
  readonly access: GuestBookingAccess;
  readonly cancellations: BookingCancellations;
  readonly outbox: GuestMailOutbox;
}

async function withSchema(run: (context: Context) => Promise<void>, policy: "FREE_UNTIL_48H" | "NONE" = "FREE_UNTIL_48H"): Promise<void> {
  const { Pool } = await import("pg");
  const schema = `cancellations_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 6, options: `-c search_path=${schema}` });
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const migrations = (await readdir(new URL("../migrations/", import.meta.url))).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort();
    for (const name of migrations) await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a')");
    await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES ('provider-a','owner-a','OWNER',true), ('provider-a','editor-a','EDITOR',true)");
    await pool.query(
      `INSERT INTO experience_products
         (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
       VALUES ('provider-a','walk','sample-walk','PUBLISHED','Synthetic walk','{}','JPY',3000,'terms-v1','seller-provider-a','${ACCOUNT}','Sample Seller A')`,
    );
    const store = new ExperienceStore(pool);
    const guests = new GuestBookingRepository(pool);
    await guests.setProviderSaleSettings("provider-a", { supportEnabled: false });
    await guests.setSaleTerms(ownerA, "walk", {
      childPricing: { priceYen: 1500, minAge: 4, maxAge: 12, adultRequired: true }, minimumParticipants: 1, maxPartySize: 6,
      cancellationPolicy: policy, bookingQuestions: [], conditionsVersion: null,
    });
    await store.saveScheduleRule(ownerA, "walk", RULE, null, randomUUID());
    await run({ pool, store, guests, access: new GuestBookingAccess(pool), cancellations: new BookingCancellations(pool), outbox: new GuestMailOutbox(pool) });
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
}

let events = 0;
async function paid(context: Context, overrides: Partial<StartGuestBookingInput> = {}, amountDelta = 0): Promise<GuestBookingStart> {
  const start = await context.guests.startGuestBooking(request(overrides));
  events += 1;
  await context.store.confirmBookingPayment({ providerId: "provider-a" }, {
    publicBookingId: start.publicBookingId, connectedAccountId: ACCOUNT, stripePaymentRef: `pi_sample_${events}`,
    stripeEventId: `evt_sample_${events}`, stripeEventType: "checkout.session.completed", eventOccurredAtUtc: new Date().toISOString(),
    amount: start.totalAmount + amountDelta, currency: "JPY",
  });
  return start;
}

/** A session on the guest's booking page (slice 6). */
async function sessionFor(context: Context, publicBookingId: string): Promise<string> {
  const grant = await context.access.issueBookingAccessGrant(publicBookingId);
  assert.ok(grant);
  const opened = await context.access.openBookingSession(grant.token);
  assert.ok(opened);
  return opened.sessionId;
}

/** Moves the booking's start `ms` from now (the snapshot trigger is off for this test schema only). */
async function startsIn(pool: Pool, publicBookingId: string, ms: number): Promise<string> {
  const start = new Date(Date.now() + ms).toISOString();
  const end = new Date(Date.parse(start) + 90 * 60_000).toISOString();
  await pool.query("ALTER TABLE bookings DISABLE TRIGGER bookings_protect_snapshots");
  await pool.query(
    `UPDATE bookings SET occurrence_snapshot = occurrence_snapshot || jsonb_build_object('startUtc', $2::text, 'endUtc', $3::text)
      WHERE public_booking_id=$1`,
    [publicBookingId, start, end],
  );
  await pool.query("ALTER TABLE bookings ENABLE TRIGGER bookings_protect_snapshots");
  return start;
}

const deadline48 = (startUtc: string) => new Date(Date.parse(startUtc) - 48 * HOUR_MS).toISOString();

async function booking(pool: Pool, publicBookingId: string) {
  return (await pool.query(
    "SELECT status, cancelled_at, cancelled_by, cancellation_reason, cancellation_note, confirmed_at FROM bookings WHERE public_booking_id=$1",
    [publicBookingId],
  )).rows[0];
}

async function refunds(pool: Pool, publicBookingId: string) {
  return (await pool.query(
    `SELECT r.id::text AS id, r.kind, r.amount::int AS amount, r.status, r.refund_application_fee, r.requested_by, r.stripe_refund_ref,
            r.failure_code, r.closed_at, r.superseded_by::text AS superseded_by
       FROM booking_refunds r JOIN bookings b ON b.provider_id=r.provider_id AND b.id=r.booking_id
      WHERE b.public_booking_id=$1 ORDER BY r.created_at, r.id`,
    [publicBookingId],
  )).rows;
}

async function ledger(pool: Pool, publicBookingId: string) {
  return (await pool.query(
    `SELECT l.entry_id, l.kind, l.amount::int AS amount FROM payment_ledger_entries l JOIN bookings b ON b.provider_id=l.provider_id AND b.id=l.booking_id
      WHERE b.public_booking_id=$1 ORDER BY l.created_at, l.entry_id`,
    [publicBookingId],
  )).rows;
}

async function outboxTopics(pool: Pool, publicBookingId: string): Promise<string[]> {
  return (await pool.query("SELECT topic FROM outbox_messages WHERE aggregate_id=$1 ORDER BY id", [publicBookingId])).rows.map((row) => String(row.topic));
}

async function seatsLeft(context: Context, date: string): Promise<number> {
  const availability = await context.guests.listPublicAvailability("sample-walk");
  return availability!.occurrences.find((occurrence) => occurrence.date === date)!.seatsLeft;
}

function refundEvent(submission: RefundSubmission, status: "pending" | "succeeded" | "failed", overrides: Record<string, unknown> = {}) {
  events += 1;
  return {
    publicBookingId: submission.publicBookingId, refundId: submission.refundId, stripeRefundRef: `re_test_${submission.refundId.slice(0, 8)}`,
    connectedAccountId: submission.connectedAccountId, stripePaymentRef: submission.stripePaymentRef, amount: submission.amount,
    currency: submission.currency, status, failureCode: status === "failed" ? "expired_or_canceled_card" : null,
    stripeEventId: `evt_refund_${events}`, stripeEventType: status === "failed" ? "refund.failed" : "refund.updated",
    eventOccurredAtUtc: new Date().toISOString(), ...overrides,
  };
}

describe("PostgreSQL booking cancellations and refunds (#285 slice 7)", { skip: databaseUrl === undefined }, () => {
  it("cancels for the guest before free cancellation ends: a full refund with NIHO's fee, seats back, the guest and host told", async () => {
    await withSchema(async (context) => {
      const { pool, cancellations } = context;
      const made = await paid(context);
      const start = await startsIn(pool, made.publicBookingId, 49 * HOUR_MS);
      assert.equal(await seatsLeft(context, day(5)), 9);
      const session = await sessionFor(context, made.publicBookingId);
      const commandId = randomUUID();
      const input = { commandId, choice: "FULL_REFUND", shownDeadlineUtc: deadline48(start) } as const;

      const result = await cancellations.cancelAsGuest(session, made.publicBookingId, input);
      assert.ok(result);
      assert.equal(result.outcome, "CANCELLED");
      assert.equal(result.repeated, false);
      assert.deepEqual(result.bookingIds, [made.publicBookingId]);
      assert.equal(result.refunds.length, 1);
      const [submission] = result.refunds;
      assert.deepEqual({ ...submission, refundId: "x" }, {
        refundId: "x", publicBookingId: made.publicBookingId, connectedAccountId: ACCOUNT, stripePaymentRef: submission!.stripePaymentRef,
        kind: "FULL", amount: 7500, currency: "JPY", refundApplicationFee: true,
      });

      const row = await booking(pool, made.publicBookingId);
      assert.equal(row.status, "CANCELLED");
      assert.equal(row.cancelled_by, "GUEST");
      assert.equal(row.cancellation_reason, "GUEST_REQUEST");
      assert.equal(row.confirmed_at, null);
      assert.ok(row.cancelled_at);
      assert.equal(await seatsLeft(context, day(5)), 12);
      assert.deepEqual((await refunds(pool, made.publicBookingId)).map((refund) => [refund.kind, refund.amount, refund.status, refund.requested_by]), [["FULL", 7500, "REQUESTED", "GUEST"]]);
      const topics = await outboxTopics(pool, made.publicBookingId);
      assert.ok(topics.includes(GUEST_NOTICE_TOPICS.cancelled));
      assert.ok(topics.includes(HOST_NOTIFICATION_TOPICS.cancellation));
      const recalculated = await pool.query("SELECT 1 FROM calendar_outbox_events WHERE payload->>'cause' = 'booking_cancelled'");
      assert.equal(recalculated.rowCount, 1);

      // The same command again: the same result, and the refund Stripe has not accepted is handed back to send.
      const again = await cancellations.cancelAsGuest(session, made.publicBookingId, input);
      assert.equal(again?.outcome, "CANCELLED");
      assert.equal(again?.repeated, true);
      assert.deepEqual(again?.refunds.map((refund) => refund.refundId), [submission!.refundId]);
      // Another command on a cancelled booking: nothing more.
      const other = await cancellations.cancelAsGuest(session, made.publicBookingId, { ...input, commandId: randomUUID() });
      assert.equal(other?.outcome, "NOT_CANCELLABLE");
      assert.equal((await refunds(pool, made.publicBookingId)).length, 1);
      // The same command ID with other input is refused.
      await assert.rejects(cancellations.cancelAsGuest(session, made.publicBookingId, { ...input, choice: "REQUEST" }), StoreConflictError);

      // The guest's page reads the cancellation and the refund on its way.
      const view = await context.access.readBookingSession(session, made.publicBookingId);
      assert.equal(view?.status, "CANCELLED");
      assert.equal(view?.cancelledBy, "GUEST");
      assert.deepEqual(view?.refunds, [{ status: "PROCESSING", amount: 7500, currency: "JPY", refundedAtUtc: null }]);
      assert.equal(view?.freeCancellationOpen, false);
    });
  });

  it("holds the free cancellation deadline exactly: after it a full refund is refused as changed, and the guest asks support", async () => {
    await withSchema(async (context) => {
      const { pool, cancellations } = context;
      const made = await paid(context);
      const session = await sessionFor(context, made.publicBookingId);
      // The page showed free cancellation; the deadline passed before the click.
      const start = await startsIn(pool, made.publicBookingId, 48 * HOUR_MS - 60_000);
      const view = await context.access.readBookingSession(session, made.publicBookingId);
      assert.equal(view?.freeCancellationOpen, false);
      assert.equal(view?.freeCancellationUntilUtc, deadline48(start));
      const late = await cancellations.cancelAsGuest(session, made.publicBookingId, { commandId: randomUUID(), choice: "FULL_REFUND", shownDeadlineUtc: deadline48(start) });
      assert.equal(late?.outcome, "CHANGED");
      assert.equal((await booking(pool, made.publicBookingId)).status, "CONFIRMED");
      // A deadline the booking does not have is refused as changed too.
      const wrong = await cancellations.cancelAsGuest(session, made.publicBookingId, { commandId: randomUUID(), choice: "REQUEST", shownDeadlineUtc: new Date().toISOString() });
      assert.equal(wrong?.outcome, "CHANGED");

      const asked = await cancellations.cancelAsGuest(session, made.publicBookingId, { commandId: randomUUID(), choice: "REQUEST", shownDeadlineUtc: deadline48(start) });
      assert.equal(asked?.outcome, "REQUESTED");
      assert.deepEqual(asked?.refunds, []);
      assert.equal((await booking(pool, made.publicBookingId)).status, "CONFIRMED");
      // Asking again keeps the one open request.
      const twice = await cancellations.cancelAsGuest(session, made.publicBookingId, { commandId: randomUUID(), choice: "REQUEST", shownDeadlineUtc: deadline48(start) });
      assert.equal(twice?.outcome, "REQUESTED");
      const requests = await pool.query("SELECT status FROM booking_cancellation_requests");
      assert.deepEqual(requests.rows.map((row) => row.status), ["OPEN"]);
      const page = await context.access.readBookingSession(session, made.publicBookingId);
      assert.equal(page?.cancellationRequest?.status, "OPEN");
      assert.deepEqual(page?.refunds, []);
      // No refund was made, and none is shown.
      assert.deepEqual(await refunds(pool, made.publicBookingId), []);

      // A minute before the deadline it is still free.
      const early = await paid(context, { guestEmail: "early@example.com" });
      const earlyStart = await startsIn(pool, early.publicBookingId, 48 * HOUR_MS + 60_000);
      const earlySession = await sessionFor(context, early.publicBookingId);
      const notYet = await cancellations.cancelAsGuest(earlySession, early.publicBookingId, { commandId: randomUUID(), choice: "REQUEST", shownDeadlineUtc: deadline48(earlyStart) });
      assert.equal(notYet?.outcome, "CHANGED");
      const free = await cancellations.cancelAsGuest(earlySession, early.publicBookingId, { commandId: randomUUID(), choice: "FULL_REFUND", shownDeadlineUtc: deadline48(earlyStart) });
      assert.equal(free?.outcome, "CANCELLED");

      // Another booking's session acts on nothing, and an ended experience takes no request.
      assert.equal(await cancellations.cancelAsGuest(earlySession, made.publicBookingId, { commandId: randomUUID(), choice: "REQUEST", shownDeadlineUtc: deadline48(start) }), null);
      const over = await paid(context, { guestEmail: "over@example.com" });
      const overSession = await sessionFor(context, over.publicBookingId);
      const overStart = await startsIn(pool, over.publicBookingId, -2 * HOUR_MS);
      const ended = await cancellations.cancelAsGuest(overSession, over.publicBookingId, { commandId: randomUUID(), choice: "REQUEST", shownDeadlineUtc: deadline48(overStart) });
      assert.equal(ended?.outcome, "NOT_CANCELLABLE");
    });
  });

  it("offers no free cancellation for a non-refundable booking: the guest can only ask", async () => {
    await withSchema(async (context) => {
      const { pool, cancellations } = context;
      const made = await paid(context);
      await startsIn(pool, made.publicBookingId, 10 * 24 * HOUR_MS);
      const session = await sessionFor(context, made.publicBookingId);
      const view = await context.access.readBookingSession(session, made.publicBookingId);
      assert.equal(view?.cancellationPolicy, "NONE");
      assert.equal(view?.freeCancellationUntilUtc, null);
      assert.equal(view?.freeCancellationOpen, false);
      const refused = await cancellations.cancelAsGuest(session, made.publicBookingId, { commandId: randomUUID(), choice: "FULL_REFUND", shownDeadlineUtc: null });
      assert.equal(refused?.outcome, "CHANGED");
      const asked = await cancellations.cancelAsGuest(session, made.publicBookingId, { commandId: randomUUID(), choice: "REQUEST", shownDeadlineUtc: null });
      assert.equal(asked?.outcome, "REQUESTED");
    }, "NONE");
  });

  it("lets only one of concurrent cancellations happen and never refunds twice", async () => {
    await withSchema(async (context) => {
      const { pool, cancellations } = context;
      const made = await paid(context);
      const start = await startsIn(pool, made.publicBookingId, 72 * HOUR_MS);
      const session = await sessionFor(context, made.publicBookingId);
      const results = await Promise.all([
        cancellations.cancelAsGuest(session, made.publicBookingId, { commandId: randomUUID(), choice: "FULL_REFUND", shownDeadlineUtc: deadline48(start) }),
        cancellations.cancelAsHost(ownerA, made.publicBookingId, { commandId: randomUUID(), reason: "WEATHER" }),
        cancellations.cancelAsSupport(support, made.publicBookingId, { commandId: randomUUID(), reason: "OTHER", refund: { kind: "FULL" } }),
      ]);
      assert.deepEqual(results.map((result) => result?.outcome).filter((outcome) => outcome === "CANCELLED").length, 1);
      assert.equal(results.filter((result) => result?.outcome === "NOT_CANCELLABLE").length, 2);
      assert.equal((await refunds(pool, made.publicBookingId)).length, 1);
      // The database refuses a second live full refund of the same booking whatever the code does.
      await assert.rejects(pool.query(
        `INSERT INTO booking_refunds (id, provider_id, booking_id, command_id, kind, amount, currency, refund_application_fee, requested_by, stripe_payment_ref, status)
         SELECT $1::uuid, provider_id, booking_id, $2::uuid, 'FULL', amount, currency, true, 'SUPPORT', stripe_payment_ref, 'REQUESTED' FROM booking_refunds LIMIT 1`,
        [randomUUID(), randomUUID()],
      ), /booking_refunds_one_full_idx/);
    });
  });

  it("lets the OWNER cancel one booking or a whole session with full refunds, and closes the session to new bookings", async () => {
    await withSchema(async (context) => {
      const { pool, cancellations, guests } = context;
      const one = await paid(context);
      await assert.rejects(cancellations.cancelAsHost(editorA, one.publicBookingId, { commandId: randomUUID(), reason: "WEATHER" }), StoreAccessDeniedError);
      await assert.rejects(cancellations.cancelAsHost(ownerA, one.publicBookingId, { commandId: randomUUID(), reason: "LATE_PAYMENT" as never }), StoreValidationError);
      await assert.rejects(cancellations.cancelAsHost(ownerA, randomUUID(), { commandId: randomUUID(), reason: "WEATHER" }), StoreNotFoundError);
      const cancelled = await cancellations.cancelAsHost(ownerA, one.publicBookingId, { commandId: randomUUID(), reason: "HOST_UNAVAILABLE", note: "  Kitchen repair  " });
      assert.equal(cancelled.outcome, "CANCELLED");
      assert.equal(cancelled.refunds[0]?.kind, "FULL");
      const row = await booking(pool, one.publicBookingId);
      assert.deepEqual([row.cancelled_by, row.cancellation_reason, row.cancellation_note], ["HOST", "HOST_UNAVAILABLE", "Kitchen repair"]);
      // The guest gets the email; the host no push for their own cancellation.
      assert.deepEqual(await outboxTopics(pool, one.publicBookingId), ["booking.confirmed", "host.notify.new_booking", GUEST_NOTICE_TOPICS.cancelled]);
      const shown = await guests.getGuestBookingForHost(ownerA, one.publicBookingId);
      assert.equal(shown.status, "CANCELLED");
      assert.equal(shown.cancelledBy, "HOST");
      assert.equal(shown.cancellationNote, "Kitchen repair");
      assert.equal(shown.refundPendingAmount, 7500);
      assert.equal(shown.refundedAmount, 0);

      // A session: two confirmed bookings and a payment under review, which stays for support.
      const date = day(6);
      const first = await paid(context, { occurrenceDate: date, guestEmail: "first@example.com" });
      const second = await paid(context, { occurrenceDate: date, guestEmail: "second@example.com", adultCount: 1, childCount: 0, expectedTotalYen: 3000 });
      const review = await paid(context, { occurrenceDate: date, guestEmail: "review@example.com", adultCount: 1, childCount: 0, expectedTotalYen: 3000 }, 1);
      assert.equal((await booking(pool, review.publicBookingId)).status, "PAYMENT_REVIEW");
      // A guest still on Stripe's Checkout: a hold that has not been paid.
      const held = await guests.startGuestBooking(request({ occurrenceDate: date, guestEmail: "held@example.com", adultCount: 1, childCount: 0, expectedTotalYen: 3000 }));
      assert.equal((await booking(pool, held.publicBookingId)).status, "HOLD");
      const key = { productId: "walk", offerId: "sample-walk-am", localDate: date, localStartTime: "10:00" };
      await assert.rejects(cancellations.cancelSessionAsHost(ownerA, key, { commandId: randomUUID(), reason: "GUEST_REQUEST" as never }), StoreValidationError);
      const commandId = randomUUID();
      const session = await cancellations.cancelSessionAsHost(ownerA, key, { commandId, reason: "WEATHER" });
      assert.equal(session.outcome, "CANCELLED");
      assert.deepEqual([...session.bookingIds].sort(), [first.publicBookingId, second.publicBookingId].sort());
      assert.deepEqual(session.refunds.map((refund) => refund.amount).sort(), [3000, 7500]);
      assert.equal((await booking(pool, review.publicBookingId)).status, "PAYMENT_REVIEW");
      const closed = await pool.query("SELECT desired_state FROM schedule_occurrence_sales_states WHERE rule_id='sample-walk-am'");
      assert.deepEqual(closed.rows.map((state) => state.desired_state), ["CLOSED"]);
      // The unpaid hold goes with the session; a payment that arrives later is for support, not a booking for a session called off.
      assert.equal((await booking(pool, held.publicBookingId)).status, "EXPIRED");
      events += 1;
      await context.store.confirmBookingPayment({ providerId: "provider-a" }, {
        publicBookingId: held.publicBookingId, connectedAccountId: ACCOUNT, stripePaymentRef: `pi_sample_${events}`,
        stripeEventId: `evt_sample_${events}`, stripeEventType: "checkout.session.completed", eventOccurredAtUtc: new Date().toISOString(),
        amount: held.totalAmount, currency: "JPY",
      });
      assert.equal((await booking(pool, held.publicBookingId)).status, "PAYMENT_REVIEW");
      const repeated =await cancellations.cancelSessionAsHost(ownerA, key, { commandId, reason: "WEATHER" });
      assert.equal(repeated.repeated, true);
      assert.equal(repeated.refunds.length, 2);
      const nothing = await cancellations.cancelSessionAsHost(ownerA, key, { commandId: randomUUID(), reason: "WEATHER" });
      assert.equal(nothing.outcome, "NOT_CANCELLABLE");
      // The host cannot take a payment under review.
      const hostReview = await cancellations.cancelAsHost(ownerA, review.publicBookingId, { commandId: randomUUID(), reason: "OTHER" });
      assert.equal(hostReview.outcome, "NOT_CANCELLABLE");
    });
  });

  it("lets support refund in part (NIHO's fee kept) or in full, answer requests, and resolve late payments", async () => {
    await withSchema(async (context) => {
      const { pool, cancellations, guests } = context;
      const part = await paid(context);
      await assert.rejects(cancellations.cancelAsSupport(support, part.publicBookingId, { commandId: randomUUID(), reason: "OTHER", refund: { kind: "PARTIAL", amount: 7501 } }), StoreValidationError);
      await assert.rejects(cancellations.cancelAsSupport(support, part.publicBookingId, { commandId: randomUUID(), reason: "OTHER", refund: { kind: "PARTIAL", amount: 7500 } }), StoreValidationError);
      const partial = await cancellations.cancelAsSupport(support, part.publicBookingId, { commandId: randomUUID(), reason: "HOST_UNAVAILABLE", note: "Half by agreement", refund: { kind: "PARTIAL", amount: 3750 } });
      assert.equal(partial.outcome, "CANCELLED");
      assert.deepEqual([partial.refunds[0]?.kind, partial.refunds[0]?.amount, partial.refunds[0]?.refundApplicationFee], ["PARTIAL", 3750, true]);
      assert.equal((await booking(pool, part.publicBookingId)).cancelled_by, "SUPPORT");
      assert.ok((await outboxTopics(pool, part.publicBookingId)).includes(HOST_NOTIFICATION_TOPICS.cancellation));

      // "Ask to cancel": declined (the booking stays and the guest gets support's words), then not asked again.
      const asked = await paid(context, { guestEmail: "asked@example.com" });
      const start = await startsIn(pool, asked.publicBookingId, 2 * HOUR_MS);
      const session = await sessionFor(context, asked.publicBookingId);
      await cancellations.cancelAsGuest(session, asked.publicBookingId, { commandId: randomUUID(), choice: "REQUEST", shownDeadlineUtc: deadline48(start) });
      assert.equal((await cancellations.supportQueue()).cancellationRequests.length, 1);
      await assert.rejects(cancellations.resolveCancellationRequest(support, asked.publicBookingId, { commandId: randomUUID(), decision: "DECLINE", message: "  " }), StoreValidationError);
      const declined = await cancellations.resolveCancellationRequest(support, asked.publicBookingId, { commandId: randomUUID(), decision: "DECLINE", message: "The host has already prepared your meal." });
      assert.equal(declined.outcome, "DECLINED");
      assert.equal((await booking(pool, asked.publicBookingId)).status, "CONFIRMED");
      assert.ok((await outboxTopics(pool, asked.publicBookingId)).includes(GUEST_NOTICE_TOPICS.requestDeclined));
      const page = await context.access.readBookingSession(session, asked.publicBookingId);
      assert.deepEqual([page?.cancellationRequest?.status, page?.cancellationRequest?.declineMessage], ["DECLINED", "The host has already prepared your meal."]);
      const again = await cancellations.cancelAsGuest(session, asked.publicBookingId, { commandId: randomUUID(), choice: "REQUEST", shownDeadlineUtc: deadline48(start) });
      assert.equal(again?.outcome, "NOT_CANCELLABLE");
      const noRequest = await cancellations.resolveCancellationRequest(support, asked.publicBookingId, { commandId: randomUUID(), decision: "APPROVE", refund: { kind: "FULL" } });
      assert.equal(noRequest.outcome, "NOT_CANCELLABLE");

      // Approved: cancelled with the refund support chose.
      const approvedBooking = await paid(context, { guestEmail: "approved@example.com" });
      const approvedStart = await startsIn(pool, approvedBooking.publicBookingId, 3 * HOUR_MS);
      const approvedSession = await sessionFor(context, approvedBooking.publicBookingId);
      await cancellations.cancelAsGuest(approvedSession, approvedBooking.publicBookingId, { commandId: randomUUID(), choice: "REQUEST", shownDeadlineUtc: deadline48(approvedStart) });
      assert.equal((await guests.getGuestBookingForHost(ownerA, approvedBooking.publicBookingId)).cancellationRequested, true);
      const approved = await cancellations.resolveCancellationRequest(support, approvedBooking.publicBookingId, { commandId: randomUUID(), decision: "APPROVE", refund: { kind: "FULL" } });
      assert.equal(approved.outcome, "CANCELLED");
      assert.equal(approved.refunds[0]?.refundApplicationFee, true);
      const requests = await pool.query("SELECT status, resolved_by FROM booking_cancellation_requests ORDER BY created_at");
      assert.deepEqual(requests.rows.map((row) => [row.status, row.resolved_by]), [["DECLINED", support.nihoUserId], ["APPROVED", support.nihoUserId]]);

      // A late payment (under review): what Stripe captured goes back in full; the host was never told, so no push.
      const late = await paid(context, { guestEmail: "late@example.com" }, 100);
      const queue = await cancellations.supportQueue();
      assert.deepEqual(queue.paymentReviews.map((review) => [review.publicBookingId, review.paidAmount]), [[late.publicBookingId, 7600]]);
      const resolved = await cancellations.resolvePaymentReview(support, late.publicBookingId, { commandId: randomUUID() });
      assert.equal(resolved.outcome, "CANCELLED");
      assert.deepEqual([resolved.refunds[0]?.kind, resolved.refunds[0]?.amount], ["FULL", 7600]);
      const lateRow = await booking(pool, late.publicBookingId);
      assert.deepEqual([lateRow.status, lateRow.cancelled_by, lateRow.cancellation_reason], ["CANCELLED", "SUPPORT", "LATE_PAYMENT"]);
      assert.equal((await outboxTopics(pool, late.publicBookingId)).includes(HOST_NOTIFICATION_TOPICS.cancellation), false);
      assert.equal((await cancellations.supportQueue()).paymentReviews.length, 0);
      const notReview = await cancellations.resolvePaymentReview(support, late.publicBookingId, { commandId: randomUUID() });
      assert.equal(notReview.outcome, "NOT_CANCELLABLE");
    });
  });

  it("follows Stripe's answers and webhooks forward only, keeps the ledger, and shows failed refunds to support until settled", async () => {
    await withSchema(async (context) => {
      const { pool, cancellations, guests, outbox } = context;
      const made = await paid(context);
      const cancelled = await cancellations.cancelAsHost(ownerA, made.publicBookingId, { commandId: randomUUID(), reason: "ILLNESS" });
      const submission = cancelled.refunds[0]!;

      // Stripe accepted it as pending: PENDING, and the money left the seller's balance in the ledger.
      assert.equal(await cancellations.recordRefundSubmission(submission.refundId, { kind: "accepted", stripeRefundRef: "re_test_A1", status: "pending" }), "PENDING");
      assert.deepEqual((await ledger(pool, made.publicBookingId)).map((entry) => [entry.kind, entry.amount]), [["PAYMENT_CAPTURED", 7500], ["REFUND", -7500]]);
      // The webhook says succeeded: SUCCEEDED, recorded once, the guest's email queued.
      const succeeded = refundEvent(submission, "succeeded", { stripeRefundRef: "re_test_A1" });
      assert.deepEqual(await cancellations.applyRefundEvent(succeeded), { status: "SUCCEEDED", duplicateEvent: false });
      assert.deepEqual(await cancellations.applyRefundEvent(succeeded), { status: "SUCCEEDED", duplicateEvent: true });
      const outcomes = await pool.query("SELECT outcome FROM stripe_webhook_events WHERE event_type LIKE 'refund.%'");
      assert.deepEqual(outcomes.rows.map((row) => row.outcome), ["REFUNDED"]);
      // An older "pending" arriving late changes nothing.
      assert.deepEqual(await cancellations.applyRefundEvent(refundEvent(submission, "pending", { stripeRefundRef: "re_test_A1" })), { status: "SUCCEEDED", duplicateEvent: false });
      assert.equal(await cancellations.recordRefundSubmission(submission.refundId, { kind: "accepted", stripeRefundRef: "re_test_A1", status: "pending" }), "SUCCEEDED");
      assert.ok((await outboxTopics(pool, made.publicBookingId)).includes(GUEST_NOTICE_TOPICS.refunded));
      const host = await guests.getGuestBookingForHost(ownerA, made.publicBookingId);
      assert.deepEqual([host.refundedAmount, host.refundPendingAmount, host.refundFailed], [7500, 0, false]);
      // Events that do not match the refund are refused.
      await assert.rejects(cancellations.applyRefundEvent(refundEvent(submission, "succeeded", { stripeRefundRef: "re_test_A1", connectedAccountId: "acct_SampleOther01" })), StoreConflictError);
      await assert.rejects(cancellations.applyRefundEvent(refundEvent(submission, "succeeded", { stripeRefundRef: "re_test_A1", amount: 1 })), StoreConflictError);
      await assert.rejects(cancellations.applyRefundEvent(refundEvent(submission, "succeeded", { stripeRefundRef: "re_test_OTHER" })), StoreConflictError);
      await assert.rejects(cancellations.applyRefundEvent(refundEvent(submission, "succeeded", { refundId: randomUUID() })), StoreNotFoundError);

      // A refund that fails after Stripe accepted it: FAILED, the ledger reversed, support sees it.
      const second = await paid(context, { guestEmail: "second@example.com" });
      const secondRefund = (await cancellations.cancelAsHost(ownerA, second.publicBookingId, { commandId: randomUUID(), reason: "ILLNESS" })).refunds[0]!;
      // The webhook may come before the API answer is recorded.
      assert.equal((await cancellations.applyRefundEvent(refundEvent(secondRefund, "pending", { stripeRefundRef: "re_test_B1" }))).status, "PENDING");
      assert.equal(await cancellations.recordRefundSubmission(secondRefund.refundId, { kind: "accepted", stripeRefundRef: "re_test_B1", status: "pending" }), "PENDING");
      assert.equal((await cancellations.applyRefundEvent(refundEvent(secondRefund, "failed", { stripeRefundRef: "re_test_B1" }))).status, "FAILED");
      assert.deepEqual((await ledger(pool, second.publicBookingId)).map((entry) => [entry.kind, entry.amount]), [["PAYMENT_CAPTURED", 7500], ["REFUND", -7500], ["ADJUSTMENT", 7500]]);
      assert.equal((await refunds(pool, second.publicBookingId))[0]?.failure_code, "expired_or_canceled_card");
      const queue = await cancellations.supportQueue();
      assert.deepEqual(queue.refunds.map((refund) => [refund.refundId, refund.refundStatus]), [[secondRefund.refundId, "FAILED"]]);
      assert.equal((await guests.getGuestBookingForHost(ownerA, second.publicBookingId)).refundFailed, true);
      // Its success email is not sent: a failed refund has none.
      const notices = await outbox.claimBookingNotices({ limit: 50, leaseSeconds: 60 });
      assert.equal(notices.notices.some((notice) => notice.email?.kind === "REFUNDED" && notice.email.publicBookingId === second.publicBookingId), false);

      // Tried again: a new refund (a new Stripe key), the failed one closed and pointing to it.
      const retried = await cancellations.retryRefund(support, secondRefund.refundId, { commandId: randomUUID() });
      assert.equal(retried.outcome, "REFUND_RETRIED");
      assert.notEqual(retried.refunds[0]?.refundId, secondRefund.refundId);
      assert.equal(retried.refunds[0]?.amount, 7500);
      const rows = await refunds(pool, second.publicBookingId);
      assert.deepEqual(rows.map((row) => [row.status, row.closed_at !== null, row.superseded_by]), [["FAILED", true, retried.refunds[0]!.refundId], ["REQUESTED", false, null]]);
      assert.equal((await cancellations.supportQueue()).refunds.length, 0);
      // A refund that has not failed is not tried again as a new one.
      const notFailed = await cancellations.retryRefund(support, submission.refundId, { commandId: randomUUID() });
      assert.equal(notFailed.outcome, "NOT_CANCELLABLE");

      // Refused by Stripe for good: FAILED with its code; closed by hand, it leaves the list.
      assert.equal(await cancellations.recordRefundSubmission(retried.refunds[0]!.refundId, { kind: "rejected", failureCode: "charge_already_refunded" }), "FAILED");
      assert.equal((await cancellations.supportQueue()).refunds.length, 1);
      await assert.rejects(cancellations.closeFailedRefund(support, retried.refunds[0]!.refundId, { commandId: randomUUID(), note: "" }), StoreValidationError);
      const closed = await cancellations.closeFailedRefund(support, retried.refunds[0]!.refundId, { commandId: randomUUID(), note: "Refunded by bank transfer" });
      assert.equal(closed.outcome, "REFUND_CLOSED");
      assert.equal((await cancellations.supportQueue()).refunds.length, 0);

      // A refund Stripe never answered shows after ten minutes, and is sent again as it is.
      const third = await paid(context, { guestEmail: "third@example.com" });
      const thirdRefund = (await cancellations.cancelAsHost(ownerA, third.publicBookingId, { commandId: randomUUID(), reason: "ILLNESS" })).refunds[0]!;
      assert.equal((await cancellations.supportQueue()).refunds.length, 0);
      await pool.query("UPDATE booking_refunds SET created_at = clock_timestamp() - interval '11 minutes' WHERE id = $1::uuid", [thirdRefund.refundId]);
      assert.deepEqual((await cancellations.supportQueue()).refunds.map((refund) => refund.refundStatus), ["REQUESTED"]);
      const resend = await cancellations.retryRefund(support, thirdRefund.refundId, { commandId: randomUUID() });
      assert.equal(resend.outcome, "REFUND_RETRIED");
      assert.deepEqual(resend.refunds.map((refund) => refund.refundId), [thirdRefund.refundId]);
      assert.equal(await cancellations.recordRefundSubmission(thirdRefund.refundId, { kind: "accepted", stripeRefundRef: "re_test_C1", status: "pending" }), "PENDING");
      assert.equal((await cancellations.supportQueue()).refunds.length, 0);
      // Accepted but not finished for a week (the webhook never came): support looks at it in Stripe.
      await pool.query("UPDATE booking_refunds SET created_at = clock_timestamp() - interval '8 days' WHERE id = $1::uuid", [thirdRefund.refundId]);
      assert.deepEqual((await cancellations.supportQueue()).refunds.map((refund) => refund.refundStatus), ["PENDING"]);
      assert.equal(await cancellations.recordRefundSubmission(thirdRefund.refundId, { kind: "accepted", stripeRefundRef: "re_test_C1", status: "succeeded" }), "SUCCEEDED");
      assert.equal((await cancellations.supportQueue()).refunds.length, 0);
    });
  });

  it("does not subtract a refund from the ledger when an older pending answer arrives after its failure", async () => {
    await withSchema(async (context) => {
      const { pool, cancellations } = context;
      const made = await paid(context, { guestEmail: "late-answer@example.com" });
      const refund = (await cancellations.cancelAsHost(ownerA, made.publicBookingId, { commandId: randomUUID(), reason: "ILLNESS" })).refunds[0]!;
      // The failure webhook is recorded first; the API's "pending" answer, older than it, is recorded after.
      assert.equal((await cancellations.applyRefundEvent(refundEvent(refund, "failed", { stripeRefundRef: "re_test_LATE1" }))).status, "FAILED");
      assert.equal(await cancellations.recordRefundSubmission(refund.refundId, { kind: "accepted", stripeRefundRef: "re_test_LATE1", status: "pending" }), "FAILED");
      // Nothing was subtracted, so nothing needs reversing: the capture is the only entry.
      assert.deepEqual((await ledger(pool, made.publicBookingId)).map((entry) => [entry.kind, entry.amount]), [["PAYMENT_CAPTURED", 7500]]);
      assert.equal((await refunds(pool, made.publicBookingId))[0]?.status, "FAILED");
      // The same answer again changes nothing either.
      assert.equal(await cancellations.recordRefundSubmission(refund.refundId, { kind: "accepted", stripeRefundRef: "re_test_LATE1", status: "pending" }), "FAILED");
      assert.equal((await ledger(pool, made.publicBookingId)).length, 1);
    });
  });

  it("emails the guest what happened, keeps guests with unsettled refunds or open requests, and erases notes with them", async () => {
    await withSchema(async (context) => {
      const { pool, cancellations, outbox, guests } = context;
      const made = await paid(context);
      await startsIn(pool, made.publicBookingId, 72 * HOUR_MS);
      const cancelled = await cancellations.cancelAsHost(ownerA, made.publicBookingId, { commandId: randomUUID(), reason: "WEATHER", note: "Typhoon" });
      await cancellations.recordRefundSubmission(cancelled.refunds[0]!.refundId, { kind: "accepted", stripeRefundRef: "re_test_D1", status: "succeeded" });
      const claim = await outbox.claimBookingNotices({ limit: 10, leaseSeconds: 60 });
      const kinds = claim.notices.map((notice) => notice.email?.kind);
      assert.deepEqual(kinds, ["CANCELLED", "REFUNDED"]);
      const [cancelledNotice, refundedNotice] = claim.notices;
      assert.equal(cancelledNotice?.email?.kind === "CANCELLED" && cancelledNotice.email.cancelledBy, "HOST");
      assert.equal(cancelledNotice?.email?.kind === "CANCELLED" && cancelledNotice.email.refundAmount, 7500);
      assert.equal(cancelledNotice?.email?.kind === "CANCELLED" && cancelledNotice.email.reason, "WEATHER");
      assert.equal(refundedNotice?.email?.kind === "REFUNDED" && refundedNotice.email.amount, 7500);
      assert.equal(cancelledNotice?.email?.guestEmail, "guest@example.com");
      await outbox.completeBookingNotice(cancelledNotice!.id);
      assert.equal(await outbox.retryBookingNotice(refundedNotice!.id, refundedNotice!.attempts), "RETRY");
      // Confirmations stay with their own claim.
      assert.equal((await outbox.claimBookingConfirmations({ limit: 10, leaseSeconds: 60 })).confirmations.length, 1);

      // A year on: the settled one is erased with its note; a pending refund and an open request keep their guests.
      const pending = await paid(context, { guestEmail: "pending@example.com" });
      await cancellations.cancelAsHost(ownerA, pending.publicBookingId, { commandId: randomUUID(), reason: "WEATHER" });
      const asking = await paid(context, { guestEmail: "asking@example.com" });
      const askingStart = await startsIn(pool, asking.publicBookingId, HOUR_MS);
      const session = await sessionFor(context, asking.publicBookingId);
      await cancellations.cancelAsGuest(session, asking.publicBookingId, { commandId: randomUUID(), choice: "REQUEST", shownDeadlineUtc: deadline48(askingStart) });
      await pool.query("UPDATE bookings SET cancelled_at = clock_timestamp() - interval '400 days' WHERE status = 'CANCELLED'");
      await startsIn(pool, asking.publicBookingId, -400 * 24 * HOUR_MS);
      const erased = await guests.eraseGuestData({ endedBefore: new Date(Date.now() - 365 * 24 * HOUR_MS).toISOString() });
      assert.equal(erased, 1);
      const left = await pool.query(
        `SELECT b.public_booking_id::text AS id, g.pii_erased_at IS NOT NULL AS erased, b.cancellation_note
           FROM bookings b JOIN booking_guests g ON g.provider_id=b.provider_id AND g.booking_id=b.id ORDER BY b.id`,
      );
      assert.deepEqual(left.rows.map((row) => [row.id, row.erased, row.cancellation_note]), [
        [made.publicBookingId, true, null],
        [pending.publicBookingId, false, null],
        [asking.publicBookingId, false, null],
      ]);
    });
  });
});
