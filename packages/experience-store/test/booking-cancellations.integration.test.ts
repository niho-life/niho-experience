import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { addLocalDays, type ScheduleRule } from "@niho-experience/experience-domain";
import type { Pool } from "pg";
import { GuestBookingAccess } from "../src/booking-access.ts";
import { GuestBookingMessages } from "../src/booking-messages.ts";
import { BOOKING_CANCELLATION_LIMITS, BookingCancellations, GUEST_NOTICE_TOPICS, type RefundSubmission } from "../src/booking-cancellations.ts";
import { StoreAccessDeniedError, StoreConflictError, StoreNotFoundError, StoreValidationError } from "../src/errors.ts";
import { EXPERIENCE_SUPPORT_CONSENT_VERSION, GuestBookingRepository, type GuestBookingStart, type StartGuestBookingInput } from "../src/guest-bookings.ts";
import { GuestMailOutbox } from "../src/guest-mail-outbox.ts";
import { HOST_NOTIFICATION_TOPICS } from "../src/host-notification-outbox.ts";
import { ExperienceStore } from "../src/repository.ts";
import { ExperienceSupportRepository } from "../src/support-settlement.ts";
import { consentSupportOffForTest, seedTestPublications } from "./helpers/experience-publication-fixtures.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";

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

async function withSchema(
  run: (context: Context) => Promise<void>,
  policy: "FREE_UNTIL_48H" | "NONE" = "FREE_UNTIL_48H",
  customCancellation?: { readonly windowMinutes: number | null; readonly refundBasisPoints: number },
  supportEnabled = false,
): Promise<void> {
  const db = await createIsolatedDatabase(databaseUrl, "cancellations", { max: 6 });
  const pool = db.pool;
  try {
    await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a')");
    await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES ('provider-a','owner-a','OWNER',true), ('provider-a','editor-a','EDITOR',true)");
    await pool.query(
      `INSERT INTO experience_products
         (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
       VALUES ('provider-a','walk','sample-walk','PUBLISHED','Synthetic walk','{}','JPY',3000,'terms-v1','seller-provider-a','${ACCOUNT}','Sample Seller A')`,
    );
    const store = new ExperienceStore(pool);
    const guests = new GuestBookingRepository(pool);
    if (supportEnabled) {
      await guests.setProviderSupportSettings(ownerA, {
        supportEnabled: true,
        consentVersion: EXPERIENCE_SUPPORT_CONSENT_VERSION,
        expectedVersion: 0,
      });
    } else {
      await consentSupportOffForTest(guests, ownerA);
    }
    await guests.setSaleTerms(ownerA, "walk", {
      childPricing: { priceYen: 1500, minAge: 4, maxAge: 12, adultRequired: true }, minimumParticipants: 1, maxPartySize: 6,
      cancellationPolicy: policy,
      ...(customCancellation ? {
        cancellationWindowMinutesBeforeStart: customCancellation.windowMinutes,
        cancellationRefundBasisPoints: customCancellation.refundBasisPoints,
      } : {}),
      bookingQuestions: [], conditionsVersion: null,
    });
    await store.saveScheduleRule(ownerA, "walk", RULE, null, randomUUID());
    await seedTestPublications(pool);
    await run({ pool, store, guests, access: new GuestBookingAccess(pool), cancellations: new BookingCancellations(pool), outbox: new GuestMailOutbox(pool) });
  } finally {
    await db.dispose();
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

/** A cancelled booking whose refund Stripe has not accepted, asked for `minutesAgo` minutes ago. */
async function requestedRefund(context: Context, guestEmail: string, minutesAgo: number): Promise<RefundSubmission> {
  const made = await paid(context, { guestEmail });
  const cancelled = await context.cancellations.cancelAsHost(ownerA, made.publicBookingId, { commandId: randomUUID(), reason: "WEATHER" });
  const refund = cancelled.refunds[0]!;
  await context.pool.query("UPDATE booking_refunds SET created_at = clock_timestamp() - make_interval(mins => $2) WHERE id = $1::uuid", [refund.refundId, minutesAgo]);
  return refund;
}

/** How many times a sender took the refund, and when last (seconds ago). */
async function sendState(pool: Pool, refundId: string) {
  const row = (await pool.query(
    "SELECT status, send_attempts, extract(epoch FROM clock_timestamp() - send_claimed_at)::float AS claimed_ago FROM booking_refunds WHERE id = $1::uuid",
    [refundId],
  )).rows[0];
  return { status: String(row.status), attempts: Number(row.send_attempts), claimedAgo: row.claimed_ago === null ? null : Number(row.claimed_ago) };
}

async function setSendState(pool: Pool, refundId: string, attempts: number, claimedSecondsAgo: number | null): Promise<void> {
  await pool.query(
    "UPDATE booking_refunds SET send_attempts = $2, send_claimed_at = CASE WHEN $3::float8 IS NULL THEN NULL ELSE clock_timestamp() - make_interval(secs => $3::float8) END WHERE id = $1::uuid",
    [refundId, attempts, claimedSecondsAgo],
  );
}

const AUTO = { limit: 10, olderThanSeconds: 120, leaseSeconds: 120 } as const;

describe("PostgreSQL booking cancellations and refunds (#285 slice 7)", { skip: databaseUrl === undefined }, () => {
  it("confirms and cancels a free booking without payment, ledger, or refund rows", async () => {
    await withSchema(async (context) => {
      const { pool, guests, cancellations, outbox } = context;
      await pool.query("UPDATE experience_products SET unit_amount=0 WHERE provider_id='provider-a' AND id='walk'");
      await guests.setSaleTerms(ownerA, "walk", {
        childPricing: { priceYen: 0, minAge: 4, maxAge: 12, adultRequired: false }, minimumParticipants: 1, maxPartySize: 6,
        cancellationPolicy: "FREE_UNTIL_48H", bookingQuestions: [], conditionsVersion: null,
      }, 1);
      await seedTestPublications(pool);

      const made = await guests.startGuestBooking(request({ adultCount: 1, childCount: 1, expectedTotalYen: 0 }));
      assert.equal(made.status, "CONFIRMED");
      assert.equal(made.booking.pricingSnapshot.paymentRequired, false);
      assert.equal(made.checkoutSessionRef, null);
      const confirmation = (await outbox.claimBookingConfirmations({ limit: 10, leaseSeconds: 120 })).confirmations
        .find((item) => item.email?.publicBookingId === made.publicBookingId);
      const confirmationEmail = confirmation?.email;
      assert.ok(confirmationEmail);
      assert.equal(confirmationEmail.totalAmount, 0);
      assert.equal((await ledger(pool, made.publicBookingId)).length, 0);
      assert.deepEqual(await refunds(pool, made.publicBookingId), []);
      assert.equal(await seatsLeft(context, day(5)), 10);

      const start = await startsIn(pool, made.publicBookingId, 49 * HOUR_MS);
      const session = await sessionFor(context, made.publicBookingId);
      const result = await cancellations.cancelAsGuest(session, made.publicBookingId, {
        commandId: randomUUID(), choice: "POLICY_CANCEL", shownDeadlineUtc: deadline48(start),
      });
      assert.equal(result?.outcome, "CANCELLED");
      assert.deepEqual(result?.refunds, []);
      assert.deepEqual(await refunds(pool, made.publicBookingId), []);
      assert.equal((await ledger(pool, made.publicBookingId)).length, 0);
      assert.equal(await seatsLeft(context, day(5)), 12);
      const topics = await outboxTopics(pool, made.publicBookingId);
      assert.ok(topics.includes("booking.confirmed"));
      assert.ok(topics.includes(HOST_NOTIFICATION_TOPICS.newBooking));
      assert.ok(topics.includes(GUEST_NOTICE_TOPICS.cancelled));
      assert.ok(topics.includes(HOST_NOTIFICATION_TOPICS.cancellation));
    });
  });

  it("uses the snapshotted refund percentage for custom cancellation and rounds down to whole yen", async () => {
    await withSchema(async (context) => {
      const { pool, cancellations } = context;
      const made = await paid(context);
      const start = await startsIn(pool, made.publicBookingId, 6 * HOUR_MS);
      const deadline = new Date(Date.parse(start) - 3 * HOUR_MS).toISOString();
      const session = await sessionFor(context, made.publicBookingId);
      const view = await context.access.readBookingSession(session, made.publicBookingId);
      assert.equal(view?.cancellationRefundBasisPoints, 3750);
      assert.equal(view?.freeCancellationUntilUtc, deadline);
      assert.equal(view?.freeCancellationOpen, true);

      const result = await cancellations.cancelAsGuest(session, made.publicBookingId, {
        commandId: randomUUID(), choice: "POLICY_CANCEL", shownDeadlineUtc: deadline,
      });
      assert.equal(result?.outcome, "CANCELLED");
      assert.deepEqual(result?.refunds.map(({ kind, amount }) => ({ kind, amount })), [{ kind: "PARTIAL", amount: 2812 }]);
      assert.deepEqual((await refunds(pool, made.publicBookingId)).map(({ kind, amount }) => [kind, amount]), [["PARTIAL", 2812]]);
    }, "NONE", { windowMinutes: 180, refundBasisPoints: 3750 });
  });

  it("allows cancellation within a configured zero-refund window without creating a refund", async () => {
    await withSchema(async (context) => {
      const { pool, cancellations } = context;
      const made = await paid(context);
      const start = await startsIn(pool, made.publicBookingId, 6 * HOUR_MS);
      const deadline = new Date(Date.parse(start) - 3 * HOUR_MS).toISOString();
      const session = await sessionFor(context, made.publicBookingId);
      const result = await cancellations.cancelAsGuest(session, made.publicBookingId, {
        commandId: randomUUID(), choice: "POLICY_CANCEL", shownDeadlineUtc: deadline,
      });
      assert.equal(result?.outcome, "CANCELLED");
      assert.deepEqual(result?.refunds, []);
      assert.deepEqual(await refunds(pool, made.publicBookingId), []);
    }, "NONE", { windowMinutes: 180, refundBasisPoints: 0 });
  });

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
    }, "FREE_UNTIL_48H", undefined, true);
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
      // A session with only an unpaid hold still stops selling, and a repeated command creates no refund.
      const emptyDate = day(7);
      const emptyHold = await guests.startGuestBooking(request({ occurrenceDate: emptyDate, guestEmail: "empty@example.com", adultCount: 1, childCount: 0, expectedTotalYen: 3000 }));
      const emptyKey = { ...key, localDate: emptyDate };
      const emptyCommand = randomUUID();
      const empty = await cancellations.cancelSessionAsHost(ownerA, emptyKey, { commandId: emptyCommand, reason: "WEATHER" });
      assert.equal(empty.outcome, "CANCELLED");
      assert.deepEqual(empty.bookingIds, []);
      assert.deepEqual(empty.refunds, []);
      assert.equal((await booking(pool, emptyHold.publicBookingId)).status, "EXPIRED");
      assert.equal((await cancellations.cancelSessionAsHost(ownerA, emptyKey, { commandId: emptyCommand, reason: "WEATHER" })).repeated, true);
      assert.equal((await cancellations.cancelSessionAsHost(ownerA, emptyKey, { commandId: randomUUID(), reason: "WEATHER" })).outcome, "NOT_CANCELLABLE");
      // The host cannot take a payment under review.
      const hostReview = await cancellations.cancelAsHost(ownerA, review.publicBookingId, { commandId: randomUUID(), reason: "OTHER" });
      assert.equal(hostReview.outcome, "NOT_CANCELLABLE");
    });
  });

  it("lets support refund in part (NIHO's fee returned proportionally) or in full, answer requests, and resolve late payments", async () => {
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
    }, "FREE_UNTIL_48H", undefined, true);
  });

  it("previews support ledger amounts, executes the expected snapshot, and replays the same UUID after its own state change", async () => {
    await withSchema(async (context) => {
      const { pool, cancellations } = context;
      const fullBooking = await paid(context, { guestEmail: "preview-full@example.com" });
      const fullPreview = await cancellations.previewSupportOperation(support, { action: "CANCEL", publicBookingId: fullBooking.publicBookingId, refund: { kind: "FULL" } });
      assert.deepEqual(
        [fullPreview.publicBookingId, fullPreview.bookingStatus, fullPreview.bookingStatusAfter, fullPreview.refundAmount, fullPreview.currency, fullPreview.expectedSnapshot.length],
        [fullBooking.publicBookingId, "CONFIRMED", "CANCELLED", 7500, "JPY", 64],
      );
      const commandId = randomUUID();
      const input = { commandId, expectedSnapshot: fullPreview.expectedSnapshot, reason: "OTHER" as const, refund: { kind: "FULL" as const } };
      const first = await cancellations.cancelAsSupport(support, fullBooking.publicBookingId, input);
      assert.deepEqual([first.outcome, first.repeated, first.refunds[0]?.amount], ["CANCELLED", false, 7500]);
      const repeated = await cancellations.cancelAsSupport(support, fullBooking.publicBookingId, input);
      assert.deepEqual([repeated.outcome, repeated.repeated, repeated.refunds[0]?.refundId], ["CANCELLED", true, first.refunds[0]?.refundId]);
      assert.equal(Number((await pool.query("SELECT count(*) AS count FROM booking_cancellation_commands WHERE command_id=$1::uuid", [commandId])).rows[0].count), 1);
      assert.equal((await refunds(pool, fullBooking.publicBookingId)).length, 1);

      const partialBooking = await paid(context, { guestEmail: "preview-partial@example.com" });
      const partialPreview = await cancellations.previewSupportOperation(support, { action: "CANCEL", publicBookingId: partialBooking.publicBookingId, refund: { kind: "PARTIAL", amount: 3000 } });
      assert.equal(partialPreview.refundAmount, 3000);
      const partial = await cancellations.cancelAsSupport(support, partialBooking.publicBookingId, {
        commandId: randomUUID(), expectedSnapshot: partialPreview.expectedSnapshot, reason: "HOST_UNAVAILABLE", refund: { kind: "PARTIAL", amount: 3000 },
      });
      assert.deepEqual([partial.refunds[0]?.kind, partial.refunds[0]?.amount], ["PARTIAL", 3000]);
    }, "FREE_UNTIL_48H", undefined, true);
  });

  it("rejects stale support snapshots before recording a command or refund when another Admin or refund update wins", async () => {
    await withSchema(async (context) => {
      const { pool, cancellations } = context;
      const made = await paid(context, { guestEmail: "stale-admin@example.com" });
      const stale = await cancellations.previewSupportOperation(support, { action: "CANCEL", publicBookingId: made.publicBookingId, refund: { kind: "FULL" } });
      const winning = await cancellations.previewSupportOperation({ nihoUserId: "support-admin-2" }, { action: "CANCEL", publicBookingId: made.publicBookingId, refund: { kind: "PARTIAL", amount: 1000 } });
      await cancellations.cancelAsSupport({ nihoUserId: "support-admin-2" }, made.publicBookingId, {
        commandId: randomUUID(), expectedSnapshot: winning.expectedSnapshot, reason: "OTHER", refund: { kind: "PARTIAL", amount: 1000 },
      });
      const before = await pool.query("SELECT (SELECT count(*) FROM booking_cancellation_commands)::int AS commands, (SELECT count(*) FROM booking_refunds)::int AS refunds");
      await assert.rejects(() => cancellations.cancelAsSupport(support, made.publicBookingId, {
        commandId: randomUUID(), expectedSnapshot: stale.expectedSnapshot, reason: "OTHER", refund: { kind: "FULL" },
      }), StoreConflictError);
      const after = await pool.query("SELECT (SELECT count(*) FROM booking_cancellation_commands)::int AS commands, (SELECT count(*) FROM booking_refunds)::int AS refunds");
      assert.deepEqual(after.rows[0], before.rows[0]);

      const refundBooking = await paid(context, { guestEmail: "stale-refund@example.com" });
      const refund = (await cancellations.cancelAsHost(ownerA, refundBooking.publicBookingId, { commandId: randomUUID(), reason: "WEATHER" })).refunds[0]!;
      const retry = await cancellations.previewSupportOperation(support, { action: "RETRY_REFUND", refundId: refund.refundId });
      await cancellations.recordRefundSubmission(refund.refundId, { kind: "accepted", stripeRefundRef: "re_test_stale_preview", status: "pending" });
      const beforeRetry = await pool.query("SELECT (SELECT count(*) FROM booking_cancellation_commands)::int AS commands, (SELECT count(*) FROM booking_refunds)::int AS refunds");
      await assert.rejects(() => cancellations.retryRefund(support, refund.refundId, { commandId: randomUUID(), expectedSnapshot: retry.expectedSnapshot }), StoreConflictError);
      const afterRetry = await pool.query("SELECT (SELECT count(*) FROM booking_cancellation_commands)::int AS commands, (SELECT count(*) FROM booking_refunds)::int AS refunds");
      assert.deepEqual(afterRetry.rows[0], beforeRetry.rows[0]);
    }, "FREE_UNTIL_48H", undefined, true);
  });

  it("refuses support preview for support-OFF and legacy consent snapshots", async () => {
    await withSchema(async (context) => {
      const made = await paid(context, { guestEmail: "support-off-preview@example.com" });
      await assert.rejects(() => context.cancellations.previewSupportOperation(support, { action: "CANCEL", publicBookingId: made.publicBookingId, refund: { kind: "FULL" } }), StoreAccessDeniedError);
    });
    await withSchema(async (context) => {
      const made = await paid(context, { guestEmail: "legacy-preview@example.com" });
      await context.pool.query("ALTER TABLE bookings DISABLE TRIGGER bookings_protect_snapshots");
      await context.pool.query("UPDATE bookings SET pricing_snapshot=pricing_snapshot #- '{platformFee,supportConsentVersion}' #- '{platformFee,supportAgreementRevision}' WHERE public_booking_id=$1", [made.publicBookingId]);
      await context.pool.query("ALTER TABLE bookings ENABLE TRIGGER bookings_protect_snapshots");
      await assert.rejects(() => context.cancellations.previewSupportOperation(support, { action: "CANCEL", publicBookingId: made.publicBookingId, refund: { kind: "FULL" } }), StoreAccessDeniedError);
    }, "FREE_UNTIL_48H", undefined, true);
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
    }, "FREE_UNTIL_48H", undefined, true);
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
  it("sends a refund Stripe has not accepted again from the job: after a grace period, one holder at a time, with a growing wait and a cap", async () => {
    await withSchema(async (context) => {
      const { pool, cancellations } = context;
      // A request's own send goes first: nothing younger than the grace period is taken.
      const fresh = await requestedRefund(context, "fresh@example.com", 0);
      assert.deepEqual(await cancellations.claimRefundsToSend(AUTO), []);
      assert.deepEqual(await sendState(pool, fresh.refundId), { status: "REQUESTED", attempts: 0, claimedAgo: null });
      await pool.query("UPDATE booking_refunds SET created_at = clock_timestamp() - interval '119 seconds' WHERE id = $1::uuid", [fresh.refundId]);
      assert.deepEqual(await cancellations.claimRefundsToSend(AUTO), []);
      await pool.query("UPDATE booking_refunds SET created_at = clock_timestamp() - interval '121 seconds' WHERE id = $1::uuid", [fresh.refundId]);

      // Taken with exactly what the booking and the refund say, as the request's own send had it; one attempt.
      const claimed = await cancellations.claimRefundsToSend(AUTO);
      assert.deepEqual(claimed, [fresh]);
      assert.equal((await sendState(pool, fresh.refundId)).attempts, 1);
      // Held: another run (or the same one again) gets nothing while the lease runs.
      assert.deepEqual(await cancellations.claimRefundsToSend(AUTO), []);
      assert.deepEqual(await cancellations.claimRefundsToSend({ ...AUTO, leaseSeconds: 3600 }), []);

      // Oldest first, at most `limit`; refunds Stripe accepted, refused or finished are never returned.
      const accepted = await requestedRefund(context, "accepted@example.com", 60);
      const succeeded = await requestedRefund(context, "succeeded@example.com", 59);
      const refused = await requestedRefund(context, "refused@example.com", 58);
      const olderOne = await requestedRefund(context, "older-one@example.com", 30);
      const olderTwo = await requestedRefund(context, "older-two@example.com", 20);
      const olderThree = await requestedRefund(context, "older-three@example.com", 10);
      assert.equal(await cancellations.recordRefundSubmission(accepted.refundId, { kind: "accepted", stripeRefundRef: "re_test_E1", status: "pending" }), "PENDING");
      assert.equal(await cancellations.recordRefundSubmission(succeeded.refundId, { kind: "accepted", stripeRefundRef: "re_test_E2", status: "succeeded" }), "SUCCEEDED");
      assert.equal(await cancellations.recordRefundSubmission(refused.refundId, { kind: "rejected", failureCode: "charge_already_refunded" }), "FAILED");
      assert.deepEqual((await cancellations.claimRefundsToSend({ ...AUTO, limit: 2 })).map((refund) => refund.refundId), [olderOne.refundId, olderTwo.refundId]);
      assert.deepEqual((await cancellations.claimRefundsToSend(AUTO)).map((refund) => refund.refundId), [olderThree.refundId]);
      assert.deepEqual(await cancellations.claimRefundsToSend(AUTO), []);
      for (const done of [accepted, succeeded, refused]) {
        await setSendState(pool, done.refundId, 0, null);
        assert.equal((await sendState(pool, done.refundId)).attempts, 0);
      }
      assert.deepEqual(await cancellations.claimRefundsToSend(AUTO), []);

      // The wait grows with each try: 2, 4, 8 … minutes, an hour at most; the lease is its floor.
      const ladder: readonly [number, number][] = [[1, 120], [2, 240], [3, 480], [4, 960], [5, 1920], [6, 3600], [7, 3600]];
      for (const [attempts, waitSeconds] of ladder) {
        await setSendState(pool, fresh.refundId, attempts, waitSeconds - 5);
        assert.deepEqual(await cancellations.claimRefundsToSend(AUTO), [], `${attempts} tries: still waiting`);
        assert.equal((await sendState(pool, fresh.refundId)).attempts, attempts);
        await setSendState(pool, fresh.refundId, attempts, waitSeconds + 5);
        assert.deepEqual((await cancellations.claimRefundsToSend(AUTO)).map((refund) => refund.refundId), [fresh.refundId], `${attempts} tries: due`);
        assert.equal((await sendState(pool, fresh.refundId)).attempts, attempts + 1);
      }
      // A longer lease than the wait is the floor.
      await setSendState(pool, fresh.refundId, 1, 200);
      assert.deepEqual(await cancellations.claimRefundsToSend({ ...AUTO, leaseSeconds: 600 }), []);

      // After the last automatic attempt the refund stays for support, however long ago it was tried.
      await setSendState(pool, fresh.refundId, BOOKING_CANCELLATION_LIMITS.refundAutoSendAttempts, 30 * 86_400);
      assert.deepEqual(await cancellations.claimRefundsToSend(AUTO), []);
      // Eight tries take hours: by then it is on support's list (Stripe has not answered for ten minutes).
      await pool.query("UPDATE booking_refunds SET created_at = clock_timestamp() - interval '4 hours' WHERE id = $1::uuid", [fresh.refundId]);
      assert.deepEqual((await cancellations.supportQueue()).refunds.filter((refund) => refund.refundId === fresh.refundId).map((refund) => refund.refundStatus), ["REQUESTED"]);
      // Support can still send it, and that is not an automatic attempt.
      const resent = await cancellations.retryRefund(support, fresh.refundId, { commandId: randomUUID() });
      assert.equal(resent.outcome, "REFUND_RETRIED");
      assert.deepEqual(resent.refunds, [fresh]);
      assert.equal((await sendState(pool, fresh.refundId)).attempts, BOOKING_CANCELLATION_LIMITS.refundAutoSendAttempts);
      // And when Stripe takes it, the job never sends it again.
      assert.equal(await cancellations.recordRefundSubmission(fresh.refundId, { kind: "accepted", stripeRefundRef: "re_test_E3", status: "pending" }), "PENDING");
      await setSendState(pool, fresh.refundId, 1, 30 * 86_400);
      assert.deepEqual(await cancellations.claimRefundsToSend(AUTO), []);

      // A claim names its bounds.
      for (const bad of [{ ...AUTO, limit: 0 }, { ...AUTO, limit: 51 }, { ...AUTO, limit: 1.5 }, { ...AUTO, olderThanSeconds: -1 }, { ...AUTO, leaseSeconds: 29 }, { ...AUTO, leaseSeconds: 3601 }]) {
        await assert.rejects(cancellations.claimRefundsToSend(bad), StoreValidationError);
      }
    }, "FREE_UNTIL_48H", undefined, true);
  });

  it("never lets the job and support's resend, or two job runs, send the same refund at the same time", async () => {
    await withSchema(async (context) => {
      const { pool, cancellations } = context;
      const refund = await requestedRefund(context, "race@example.com", 10);

      // Two runs of the job at once: one of them holds it.
      const runs = await Promise.all([1, 2, 3, 4].map(() => cancellations.claimRefundsToSend(AUTO)));
      assert.deepEqual(runs.flat().map((item) => item.refundId), [refund.refundId]);
      assert.equal((await sendState(pool, refund.refundId)).attempts, 1);

      // Support presses 「もう一度送る」 while the job holds it: nothing for support to send, and the command is still recorded.
      const commandId = randomUUID();
      const blocked = await cancellations.retryRefund(support, refund.refundId, { commandId });
      assert.equal(blocked.outcome, "REFUND_RETRIED");
      assert.deepEqual(blocked.refunds, []);
      // Its lease is the job's: once it ran out, the same command sends it, and the job waits behind support.
      await setSendState(pool, refund.refundId, 1, BOOKING_CANCELLATION_LIMITS.refundSendLeaseSeconds + 5);
      const again = await cancellations.retryRefund(support, refund.refundId, { commandId });
      assert.equal(again.repeated, true);
      assert.deepEqual(again.refunds, [refund]);
      assert.deepEqual((await cancellations.retryRefund(support, refund.refundId, { commandId })).refunds, []);
      assert.deepEqual(await cancellations.claimRefundsToSend({ ...AUTO, leaseSeconds: 30 }), []);
      assert.equal((await sendState(pool, refund.refundId)).attempts, 1);

      // Many rounds of the job against support's click: exactly one of them gets the refund each time.
      for (let round = 0; round < 10; round += 1) {
        await setSendState(pool, refund.refundId, 0, null);
        const [fromJob, fromSupport] = await Promise.all([
          cancellations.claimRefundsToSend(AUTO),
          cancellations.retryRefund(support, refund.refundId, { commandId: randomUUID() }),
        ]);
        assert.equal(fromJob.length + fromSupport.refunds.length, 1, `round ${round}`);
      }

      // A second click and a second job run after one another are held too.
      await setSendState(pool, refund.refundId, 0, null);
      assert.equal((await cancellations.retryRefund(support, refund.refundId, { commandId: randomUUID() })).refunds.length, 1);
      assert.equal((await cancellations.retryRefund(support, refund.refundId, { commandId: randomUUID() })).refunds.length, 0);
      assert.deepEqual(await cancellations.claimRefundsToSend(AUTO), []);

      // Money moves once whatever the order: the answer is recorded once, and what Stripe accepted is not sent again.
      assert.equal(await cancellations.recordRefundSubmission(refund.refundId, { kind: "accepted", stripeRefundRef: "re_test_F1", status: "pending" }), "PENDING");
      await setSendState(pool, refund.refundId, 0, null);
      assert.deepEqual(await cancellations.claimRefundsToSend(AUTO), []);
      assert.deepEqual((await cancellations.retryRefund(support, refund.refundId, { commandId: randomUUID() })).outcome, "NOT_CANCELLABLE");
    }, "FREE_UNTIL_48H", undefined, true);
  });
});

/* ---------- the Admin's in-app notices (#121, migration 0052 triggers) ---------- */

const byRow = (left: string[], right: string[]): number => {
  const a = left.join("\u0000");
  const b = right.join("\u0000");
  return a < b ? -1 : a > b ? 1 : 0;
};
const sorted = (rows: string[][]): string[][] => [...rows].sort(byRow);

/** [topic, key, public booking id] of the notices, in an order that does not depend on the database collation. */
async function notices(pool: Pool, topic?: string): Promise<string[][]> {
  const found = await pool.query(
    `SELECT n.topic, n.dedupe_key, b.public_booking_id::text AS public_booking_id
       FROM experience_support_admin_notifications n JOIN bookings b ON b.provider_id=n.provider_id AND b.id=n.booking_id
      WHERE ($1::text IS NULL OR n.topic=$1)`,
    [topic ?? null],
  );
  return sorted(found.rows.map((row) => [String(row.topic), String(row.dedupe_key), String(row.public_booking_id)]));
}

const FREE_TERMS = {
  childPricing: { priceYen: 0, minAge: 4, maxAge: 12, adultRequired: false }, minimumParticipants: 1, maxPartySize: 6,
  cancellationPolicy: "FREE_UNTIL_48H", bookingQuestions: [], conditionsVersion: null,
} as const;

/*
 * The notices are written by the triggers of migration 0052, in the transaction of the event itself. Nothing here
 * reads application code: each case runs the real flow and looks at the rows.
 */
describe("PostgreSQL Admin notices from the booking events (#121)", { skip: databaseUrl === undefined }, () => {
  it("writes BOOKING_RECEIVED when a payment confirms the booking, and a repeated Stripe event leaves one", async () => {
    await withSchema(async (context) => {
      const { pool, store } = context;
      const made = await paid(context);
      assert.deepEqual(await notices(pool), [["BOOKING_RECEIVED", `booking-confirmed:${made.publicBookingId}`, made.publicBookingId]]);
      const repeated = await store.confirmBookingPayment({ providerId: "provider-a" }, {
        publicBookingId: made.publicBookingId, connectedAccountId: ACCOUNT, stripePaymentRef: `pi_sample_${events}`,
        stripeEventId: `evt_sample_${events}`, stripeEventType: "checkout.session.completed", eventOccurredAtUtc: new Date().toISOString(),
        amount: made.totalAmount, currency: "JPY",
      });
      assert.equal(repeated.duplicateEvent, true);
      assert.equal((await notices(pool)).length, 1);
    }, "FREE_UNTIL_48H", undefined, true);
  });

  it("writes BOOKING_RECEIVED for a free booking, which is confirmed without a payment event", async () => {
    await withSchema(async (context) => {
      const { pool, guests } = context;
      await pool.query("UPDATE experience_products SET unit_amount=0 WHERE provider_id='provider-a' AND id='walk'");
      await guests.setSaleTerms(ownerA, "walk", FREE_TERMS, 1);
      await seedTestPublications(pool);
      const made = await guests.startGuestBooking(request({ adultCount: 1, childCount: 1, expectedTotalYen: 0 }));
      assert.equal(made.status, "CONFIRMED");
      assert.deepEqual(await notices(pool), [["BOOKING_RECEIVED", `booking-confirmed:${made.publicBookingId}`, made.publicBookingId]]);
    }, "FREE_UNTIL_48H", undefined, true);
  });

  it("writes PAYMENT_REVIEW for a payment that needs review, instead of BOOKING_RECEIVED", async () => {
    await withSchema(async (context) => {
      const late = await paid(context, { guestEmail: "late@example.com" }, 100);
      assert.deepEqual(await notices(context.pool), [["PAYMENT_REVIEW", `payment-review:${late.publicBookingId}`, late.publicBookingId]]);
    }, "FREE_UNTIL_48H", undefined, true);
  });

  it("writes BOOKING_CANCELLED once for a cancellation by the guest, the host or the Admin, and a replayed command adds none", async () => {
    await withSchema(async (context) => {
      const { pool, cancellations } = context;
      const byGuest = await paid(context, { guestEmail: "guest@example.com" });
      const start = await startsIn(pool, byGuest.publicBookingId, 49 * HOUR_MS);
      const session = await sessionFor(context, byGuest.publicBookingId);
      const input = { commandId: randomUUID(), choice: "FULL_REFUND", shownDeadlineUtc: deadline48(start) } as const;
      assert.equal((await cancellations.cancelAsGuest(session, byGuest.publicBookingId, input))?.outcome, "CANCELLED");
      assert.equal((await cancellations.cancelAsGuest(session, byGuest.publicBookingId, input))?.repeated, true);
      const byHost = await paid(context, { guestEmail: "host@example.com" });
      await cancellations.cancelAsHost(ownerA, byHost.publicBookingId, { commandId: randomUUID(), reason: "WEATHER" });
      const bySupport = await paid(context, { guestEmail: "support@example.com" });
      await cancellations.cancelAsSupport(support, bySupport.publicBookingId, { commandId: randomUUID(), reason: "OTHER", refund: { kind: "FULL" } });
      assert.deepEqual(await notices(pool, "BOOKING_CANCELLED"), sorted([byGuest, byHost, bySupport].map((made) => ["BOOKING_CANCELLED", `booking-cancelled:${made.publicBookingId}`, made.publicBookingId])));
    }, "FREE_UNTIL_48H", undefined, true);
  });

  it("writes CANCELLATION_REQUEST once for a guest's request, and asking again adds none", async () => {
    await withSchema(async (context) => {
      const { pool, cancellations } = context;
      const made = await paid(context);
      const session = await sessionFor(context, made.publicBookingId);
      const start = await startsIn(pool, made.publicBookingId, 3 * HOUR_MS);
      const ask = () => cancellations.cancelAsGuest(session, made.publicBookingId, { commandId: randomUUID(), choice: "REQUEST", shownDeadlineUtc: deadline48(start) });
      assert.equal((await ask())?.outcome, "REQUESTED");
      assert.equal((await ask())?.outcome, "REQUESTED");
      const requests = await notices(pool, "CANCELLATION_REQUEST");
      assert.equal(requests.length, 1);
      assert.match(requests[0]![1]!, /^cancellation-request:[0-9a-f-]{36}$/);
      assert.equal(requests[0]![2], made.publicBookingId);
    }, "FREE_UNTIL_48H", undefined, true);
  });

  it("writes REFUND_UPDATED once per refund status, and a repeated Stripe event adds none", async () => {
    await withSchema(async (context) => {
      const { pool, cancellations } = context;
      const made = await paid(context);
      const refund = (await cancellations.cancelAsHost(ownerA, made.publicBookingId, { commandId: randomUUID(), reason: "WEATHER" })).refunds[0]!;
      const key = (status: string) => ["REFUND_UPDATED", `refund:${refund.refundId}:${status}`, made.publicBookingId];
      assert.deepEqual(await notices(pool, "REFUND_UPDATED"), [key("REQUESTED")]);
      await cancellations.applyRefundEvent(refundEvent(refund, "pending"));
      const succeeded = refundEvent(refund, "succeeded");
      assert.equal((await cancellations.applyRefundEvent(succeeded)).duplicateEvent, false);
      assert.equal((await cancellations.applyRefundEvent(succeeded)).duplicateEvent, true);
      assert.deepEqual(await notices(pool, "REFUND_UPDATED"), sorted([key("REQUESTED"), key("PENDING"), key("SUCCEEDED")]));
      // A refund can fail after it succeeded: that is a new status, so a new notice.
      await cancellations.applyRefundEvent(refundEvent(refund, "failed"));
      assert.deepEqual(await notices(pool, "REFUND_UPDATED"), sorted([key("REQUESTED"), key("PENDING"), key("SUCCEEDED"), key("FAILED")]));
    }, "FREE_UNTIL_48H", undefined, true);
  });

  it("writes GUEST_MESSAGE for each message the guest sends, and none for the Admin's reply", async () => {
    await withSchema(async (context) => {
      const { pool } = context;
      const messages = new GuestBookingMessages(pool);
      const made = await paid(context);
      const session = await sessionFor(context, made.publicBookingId);
      const key = randomUUID();
      await messages.sendMessage(session, made.publicBookingId, { message: "Is there parking nearby?", clientRequestKey: key });
      assert.equal((await messages.sendMessage(session, made.publicBookingId, { message: "Is there parking nearby?", clientRequestKey: key }))?.repeated, true);
      assert.equal((await notices(pool, "GUEST_MESSAGE")).length, 1);
      await messages.sendMessage(session, made.publicBookingId, { message: "One more thing", clientRequestKey: randomUUID() });
      const sent = await notices(pool, "GUEST_MESSAGE");
      assert.equal(sent.length, 2);
      assert.ok(sent.every((notice) => /^guest-message:[0-9a-f-]{36}$/.test(notice[1]!) && notice[2] === made.publicBookingId));
      await messages.sendSupportMessage(support, made.publicBookingId, { commandId: randomUUID(), message: "We can help with that." });
      assert.equal((await notices(pool, "GUEST_MESSAGE")).length, 2);
    }, "FREE_UNTIL_48H", undefined, true);
  });

  it("writes no GUEST_MESSAGE for a booking accepted with support OFF", async () => {
    await withSchema(async (context) => {
      const { pool } = context;
      const made = await paid(context);
      const session = await sessionFor(context, made.publicBookingId);
      await new GuestBookingMessages(pool).sendMessage(session, made.publicBookingId, { message: "Hello", clientRequestKey: randomUUID() });
      assert.deepEqual(await notices(pool, "GUEST_MESSAGE"), []);
    });
  });

  it("is what the Admin's list reads, with the read state kept per Admin", async () => {
    await withSchema(async (context) => {
      const { pool } = context;
      const made = await paid(context);
      const session = await sessionFor(context, made.publicBookingId);
      await new GuestBookingMessages(pool).sendMessage(session, made.publicBookingId, { message: "Hello", clientRequestKey: randomUUID() });
      const reader = new ExperienceSupportRepository(pool);
      const first = { nihoUserId: "admin-1" };
      const second = { nihoUserId: "admin-2" };
      const listed = await reader.listNotifications(first);
      assert.deepEqual(listed.map((notice) => notice.topic).sort(), ["BOOKING_RECEIVED", "GUEST_MESSAGE"]);
      assert.ok(listed.every((notice) => notice.publicBookingId === made.publicBookingId && notice.read === false));
      await reader.markNotificationRead(first, listed[0]!.id);
      await reader.markNotificationRead(first, listed[0]!.id);
      assert.equal((await reader.listNotifications(first, { unreadOnly: true })).length, 1);
      assert.equal((await reader.listNotifications(second, { unreadOnly: true })).length, 2);
      await assert.rejects(reader.markNotificationRead(first, randomUUID()), StoreNotFoundError);
    }, "FREE_UNTIL_48H", undefined, true);
  });
});

/* ---------- the case timeline an Admin sees again after the screen was opened anew ---------- */

describe("PostgreSQL Admin case timeline: what survives a reload", { skip: databaseUrl === undefined }, () => {
  it("carries the command and the email's delivery state of a contact, and never the words", async () => {
    await withSchema(async (context) => {
      const { pool } = context;
      const made = await paid(context);
      const messages = new GuestBookingMessages(pool);
      const reader = new ExperienceSupportRepository(pool);
      const commandId = randomUUID();
      const words = "We can refund you on Friday.";
      await messages.sendSupportMessage(support, made.publicBookingId, { commandId, message: words });

      const contactOf = async () => (await reader.getCase(support, made.publicBookingId))!.events.filter((event) => event.type === "GUEST_CONTACT_SENT");
      const [queued] = await contactOf();
      assert.deepEqual([queued?.commandId, queued?.delivery, queued?.actorAdminUserId], [commandId, "PENDING", support.nihoUserId]);

      // The mail job moves the message on; the same read shows where it is.
      await pool.query("UPDATE guest_question_messages SET delivery_status='SENT', delivered_at=clock_timestamp(), lease_until=NULL WHERE command_id=$1::uuid", [commandId]);
      assert.equal((await contactOf())[0]?.delivery, "SENT");
      await pool.query("UPDATE guest_question_messages SET delivery_status='FAILED', delivered_at=NULL, lease_until=NULL WHERE command_id=$1::uuid", [commandId]);
      assert.equal((await contactOf())[0]?.delivery, "FAILED");

      // The same command again is the same contact: one event, and the words are not in anything the Admin is sent.
      assert.equal((await messages.sendSupportMessage(support, made.publicBookingId, { commandId, message: words })).repeated, true);
      assert.equal((await contactOf()).length, 1);
      assert.equal(JSON.stringify(await reader.getCase(support, made.publicBookingId)).includes(words), false);
    }, "FREE_UNTIL_48H", undefined, true);
  });

  it("carries the command of an Admin's operation and of a change to the case, without a delivery state", async () => {
    await withSchema(async (context) => {
      const { pool, cancellations } = context;
      const made = await paid(context);
      const reader = new ExperienceSupportRepository(pool);
      const operation = randomUUID();
      await cancellations.cancelAsSupport(support, made.publicBookingId, { commandId: operation, reason: "OTHER", refund: { kind: "FULL" } });
      const change = randomUUID();
      const changed = await reader.updateCase(support, made.publicBookingId, { commandId: change, expectedRevision: 1, assignedAdminUserId: null, internalMemo: "Called the host." });

      // The answer to a change and a plain read are the same timeline.
      const read = await reader.getCase(support, made.publicBookingId);
      assert.deepEqual(changed.events, read!.events);
      const action = read!.events.find((event) => event.type === "SUPPORT_ACTION");
      assert.deepEqual([action?.commandId, action?.delivery, action?.outcome], [operation, null, "CANCELLED"]);
      const memo = read!.events.find((event) => event.type === "INTERNAL_MEMO_CHANGED");
      assert.deepEqual([memo?.commandId, memo?.delivery], [change, null]);
    }, "FREE_UNTIL_48H", undefined, true);
  });

  it("shows no delivery state when the message is gone, instead of failing the read", async () => {
    await withSchema(async (context) => {
      const { pool } = context;
      const made = await paid(context);
      const reader = new ExperienceSupportRepository(pool);
      const commandId = randomUUID();
      await new GuestBookingMessages(pool).sendSupportMessage(support, made.publicBookingId, { commandId, message: "Hello again." });
      await pool.query("DELETE FROM guest_question_messages WHERE command_id=$1::uuid", [commandId]);
      const [event] = (await reader.getCase(support, made.publicBookingId))!.events.filter((item) => item.type === "GUEST_CONTACT_SENT");
      assert.deepEqual([event?.commandId, event?.delivery], [commandId, null]);
    }, "FREE_UNTIL_48H", undefined, true);
  });
});

describe("PostgreSQL support-ON bookings for the Admin (#121/#128)", { skip: databaseUrl === undefined }, () => {
  /** Rewrites a booking's snapshot (the snapshot trigger is off for this test schema only). */
  async function rewriteFee(pool: Pool, publicBookingId: string, sql: string): Promise<void> {
    await pool.query("ALTER TABLE bookings DISABLE TRIGGER bookings_protect_snapshots");
    await pool.query(`UPDATE bookings SET pricing_snapshot = ${sql} WHERE public_booking_id=$1`, [publicBookingId]);
    await pool.query("ALTER TABLE bookings ENABLE TRIGGER bookings_protect_snapshots");
  }

  it("tells support which bookings have an address the guest's mail server refused (#375), as a kind only", async () => {
    await withSchema(async (context) => {
      const { pool, cancellations } = context;
      const refused = await paid(context, { guestEmail: "refused@example.com", occurrenceDate: day(5) });
      const fine = await paid(context, { guestEmail: "fine@example.com", occurrenceDate: day(6) });
      await pool.query(
        `UPDATE booking_guests SET mail_suppressed_at=clock_timestamp(), mail_suppression_classification='NO_SUCH_DOMAIN'
          WHERE booking_id=(SELECT id FROM bookings WHERE public_booking_id=$1::uuid)`,
        [refused.publicBookingId],
      );
      const page = await cancellations.supportEnabledBookings();
      const byId = new Map(page.bookings.map((booking) => [booking.publicBookingId, booking]));
      assert.equal(byId.get(refused.publicBookingId)!.mailUndeliverable, "NO_SUCH_DOMAIN");
      assert.equal("mailUndeliverable" in byId.get(fine.publicBookingId)!, false);
      assert.ok(!JSON.stringify(page).includes("@example.com"));
    }, "FREE_UNTIL_48H", undefined, true);
  });

  it("lists only paid bookings whose own snapshot records current support ON consent, newest first", async () => {
    await withSchema(async (context) => {
      const { pool, guests, cancellations } = context;
      const first = await paid(context, { guestEmail: "on-1@example.com", occurrenceDate: day(5) });
      const second = await paid(context, { guestEmail: "on-2@example.com", occurrenceDate: day(6) });
      const review = await paid(context, { guestEmail: "on-review@example.com", occurrenceDate: day(7) }, 500);
      const cancelled = await paid(context, { guestEmail: "on-cancelled@example.com", occurrenceDate: day(8) });
      await cancellations.cancelAsSupport(support, cancelled.publicBookingId, { commandId: randomUUID(), reason: "OTHER", refund: { kind: "FULL" } });
      const hold = await guests.startGuestBooking(request({ guestEmail: "on-hold@example.com", occurrenceDate: day(9) }));
      const legacy = await paid(context, { guestEmail: "legacy@example.com", occurrenceDate: day(10) });
      await rewriteFee(pool, legacy.publicBookingId, "pricing_snapshot #- '{platformFee,supportConsentVersion}' #- '{platformFee,supportAgreementRevision}'");
      const textFee = await paid(context, { guestEmail: "text-fee@example.com", occurrenceDate: day(11) });
      await rewriteFee(pool, textFee.publicBookingId, `jsonb_set(jsonb_set(pricing_snapshot, '{platformFee,basisPoints}', '"1500"'), '{platformFee,supportAgreementRevision}', '"abc"')`);
      const fraction = await paid(context, { guestEmail: "fraction@example.com", occurrenceDate: day(12) });
      await rewriteFee(pool, fraction.publicBookingId, `jsonb_set(pricing_snapshot, '{platformFee,supportAgreementRevision}', '1.5')`);
      const emptyVersion = await paid(context, { guestEmail: "empty-version@example.com", occurrenceDate: day(13) });
      await rewriteFee(pool, emptyVersion.publicBookingId, `jsonb_set(pricing_snapshot, '{platformFee,supportConsentVersion}', '""')`);
      const notObject = await paid(context, { guestEmail: "not-object@example.com", occurrenceDate: day(14) });
      await rewriteFee(pool, notObject.publicBookingId, `jsonb_set(pricing_snapshot, '{platformFee}', '"ON"')`);

      // The host turns support OFF afterwards: earlier bookings stay listed, a booking made now is not.
      const settings = await guests.getProviderSupportSettings(ownerA);
      await guests.setProviderSupportSettings(ownerA, { supportEnabled: false, consentVersion: EXPERIENCE_SUPPORT_CONSENT_VERSION, expectedVersion: settings!.version });
      const off = await paid(context, { guestEmail: "off@example.com", occurrenceDate: day(15) });

      const page = await cancellations.supportEnabledBookings();
      assert.deepEqual(page.bookings.map((booking) => booking.publicBookingId), [cancelled, review, second, first].map((made) => made.publicBookingId));
      assert.deepEqual(page.bookings.map((booking) => booking.status), ["CANCELLED", "PAYMENT_REVIEW", "CONFIRMED", "CONFIRMED"]);
      assert.equal(page.nextCursor, null);
      assert.ok(page.bookings.every((booking) => booking.supportEligible));
      for (const excluded of [hold, legacy, textFee, fraction, emptyVersion, notObject, off]) {
        assert.ok(!page.bookings.some((booking) => booking.publicBookingId === excluded.publicBookingId));
        assert.equal((await cancellations.supportEnabledBookings({ publicBookingId: excluded.publicBookingId })).bookings.length, 0);
      }
      // The guest's name only: no email, phone, Stripe reference or internal memo.
      const keys = new Set(page.bookings.flatMap((booking) => Object.keys(booking)));
      for (const forbidden of ["guestEmail", "email", "guestPhone", "phone", "stripePaymentRef", "connectedAccountId", "internalMemo", "note"]) assert.ok(!keys.has(forbidden), forbidden);
      assert.ok(!JSON.stringify(page).includes("@example.com"));
      assert.ok(!JSON.stringify(page).includes("pi_sample_"));
      assert.equal(page.bookings[0]!.guestName, "Sample Guest");

      // Turning it ON again does not bring back the booking made while OFF.
      await guests.setProviderSupportSettings(ownerA, { supportEnabled: true, consentVersion: EXPERIENCE_SUPPORT_CONSENT_VERSION, expectedVersion: settings!.version + 1 });
      assert.deepEqual((await cancellations.supportEnabledBookings()).bookings.map((booking) => booking.publicBookingId), page.bookings.map((booking) => booking.publicBookingId));
    }, "FREE_UNTIL_48H", undefined, true);
  });

  it("walks every page once by cursor, finds one booking by ID, and validates its input", async () => {
    await withSchema(async (context) => {
      const { cancellations } = context;
      const made: string[] = [];
      for (let index = 0; index < 5; index += 1) made.push((await paid(context, { guestEmail: `page-${index}@example.com`, occurrenceDate: day(5 + index) })).publicBookingId);
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: Awaited<ReturnType<typeof cancellations.supportEnabledBookings>> = await cancellations.supportEnabledBookings({ limit: 2, cursor });
        seen.push(...page.bookings.map((booking) => booking.publicBookingId));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 10);
      assert.equal(pages, 3);
      assert.deepEqual(seen, [...made].reverse());
      // An exact page leaves no cursor behind it.
      assert.equal((await cancellations.supportEnabledBookings({ limit: 5 })).nextCursor, null);
      assert.ok((await cancellations.supportEnabledBookings({ limit: 4 })).nextCursor);

      const one = await cancellations.supportEnabledBookings({ publicBookingId: made[2]!.toUpperCase() });
      assert.deepEqual(one.bookings.map((booking) => booking.publicBookingId), [made[2]]);
      assert.equal(one.nextCursor, null);
      assert.equal((await cancellations.supportEnabledBookings({ publicBookingId: randomUUID() })).bookings.length, 0);

      assert.equal((await cancellations.supportEnabledBookings({ limit: 1 })).bookings.length, 1);
      assert.equal((await cancellations.supportEnabledBookings({ limit: BOOKING_CANCELLATION_LIMITS.supportBookingsLimitMax })).bookings.length, 5);
      for (const limit of [0, -1, 1.5, BOOKING_CANCELLATION_LIMITS.supportBookingsLimitMax + 1, Number.NaN, "10" as unknown as number]) {
        await assert.rejects(() => cancellations.supportEnabledBookings({ limit }), StoreValidationError);
      }
      await assert.rejects(() => cancellations.supportEnabledBookings({ cursor: "not-a-uuid" }), StoreValidationError);
      await assert.rejects(() => cancellations.supportEnabledBookings({ cursor: randomUUID() }), StoreValidationError);
      await assert.rejects(() => cancellations.supportEnabledBookings({ publicBookingId: "1 OR 1=1" }), StoreValidationError);
      await assert.rejects(() => cancellations.supportEnabledBookings({ publicBookingId: made[0]!, cursor: made[1]! }), StoreValidationError);
    }, "FREE_UNTIL_48H", undefined, true);
  });
});
