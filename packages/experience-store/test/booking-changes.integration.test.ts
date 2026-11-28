import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { addLocalDays, type ScheduleRule } from "@niho-experience/experience-domain";
import type { Pool } from "pg";
import { GuestBookingAccess } from "../src/booking-access.ts";
import { BookingCancellations, GUEST_NOTICE_TOPICS } from "../src/booking-cancellations.ts";
import { BookingChanges, type BookingChangeOption, type GuestBookingChangeInput } from "../src/booking-changes.ts";
import { StoreConflictError } from "../src/errors.ts";
import { GoogleBookingCalendarEvents } from "../src/google-booking-calendar.ts";
import { GuestBookingRepository, type GuestBookingStart, type StartGuestBookingInput } from "../src/guest-bookings.ts";
import { GuestMailOutbox } from "../src/guest-mail-outbox.ts";
import { HOST_NOTIFICATION_TOPICS, parseBookingChangedPayload } from "../src/host-notification-outbox.ts";
import { ExperienceStore } from "../src/repository.ts";
import { consentSupportOffForTest, seedTestPublications } from "./helpers/experience-publication-fixtures.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";

/** 予約の日時変更 (#720 stage 1) against a real schema, synthetic data only. */
const databaseUrl = process.env.TEST_DATABASE_URL;
const ownerA = { providerId: "provider-a", nihoUserId: "owner-a" } as const;
const CONSENT = "sample-terms-2026-10";
const NO_QUESTIONS = createHash("sha256").update("[]", "utf8").digest("hex");
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const ACCOUNT = "acct_SampleA0001";

function day(offset: number): string {
  return addLocalDays(new Date(Date.now() + 9 * HOUR_MS).toISOString().slice(0, 10), offset);
}

/** 10:00 in Japan on a date, as the rule's occurrences start. */
const tenAm = (date: string) => new Date(`${date}T01:00:00.000Z`).toISOString();
const deadline48 = (startUtc: string) => new Date(Date.parse(startUtc) - 48 * HOUR_MS).toISOString();

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
  readonly changes: BookingChanges;
  readonly cancellations: BookingCancellations;
  readonly outbox: GuestMailOutbox;
}

async function withSchema(run: (context: Context) => Promise<void>, policy: "FREE_UNTIL_48H" | "NONE" = "FREE_UNTIL_48H"): Promise<void> {
  const db = await createIsolatedDatabase(databaseUrl, "booking_changes", { max: 8 });
  const pool = db.pool;
  try {
    await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a')");
    await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES ('provider-a','owner-a','OWNER',true)");
    await pool.query(
      `INSERT INTO experience_products
         (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
       VALUES ('provider-a','walk','sample-walk','PUBLISHED','Synthetic walk','{}','JPY',3000,'terms-v1','seller-provider-a','${ACCOUNT}','Sample Seller A')`,
    );
    const store = new ExperienceStore(pool);
    const guests = new GuestBookingRepository(pool);
    await consentSupportOffForTest(guests, ownerA);
    await guests.setSaleTerms(ownerA, "walk", {
      childPricing: { priceYen: 1500, minAge: 4, maxAge: 12, adultRequired: true }, minimumParticipants: 1, maxPartySize: 6,
      cancellationPolicy: policy, bookingQuestions: [], conditionsVersion: null,
    });
    await store.saveScheduleRule(ownerA, "walk", RULE, null, randomUUID());
    await seedTestPublications(pool);
    await run({
      pool, store, guests, access: new GuestBookingAccess(pool), changes: new BookingChanges(pool),
      cancellations: new BookingCancellations(pool), outbox: new GuestMailOutbox(pool),
    });
  } finally {
    await db.dispose();
  }
}

let events = 0;
async function paid(context: Context, overrides: Partial<StartGuestBookingInput> = {}): Promise<GuestBookingStart> {
  const start = await context.guests.startGuestBooking(request(overrides));
  events += 1;
  await context.store.confirmBookingPayment({ providerId: "provider-a" }, {
    publicBookingId: start.publicBookingId, connectedAccountId: ACCOUNT, stripePaymentRef: `pi_sample_change_${events}`,
    stripeEventId: `evt_sample_change_${events}`, stripeEventType: "checkout.session.completed", eventOccurredAtUtc: new Date().toISOString(),
    amount: start.totalAmount, currency: "JPY",
  });
  return start;
}

async function sessionFor(context: Context, publicBookingId: string): Promise<string> {
  const grant = await context.access.issueBookingAccessGrant(publicBookingId);
  assert.ok(grant);
  const opened = await context.access.openBookingSession(grant.token);
  assert.ok(opened);
  return opened.sessionId;
}

/** What the page would send for one of the offered dates. */
function moveTo(fromStartUtc: string, option: Pick<BookingChangeOption, "date" | "startAtUtc" | "newDeadlineUtc">, commandId = randomUUID()): GuestBookingChangeInput {
  return { commandId, toDate: option.date, shownFromStartUtc: fromStartUtc, shownToStartUtc: option.startAtUtc, shownNewDeadlineUtc: option.newDeadlineUtc };
}

/** The page's input for a date of the daily rule (10:00 Japan time), whether or not it is offered. */
function moveToDate(fromStartUtc: string, date: string, commandId = randomUUID()): GuestBookingChangeInput {
  return moveTo(fromStartUtc, { date, startAtUtc: tenAm(date), newDeadlineUtc: deadline48(tenAm(date)) }, commandId);
}

async function seatsLeft(context: Context, date: string): Promise<number> {
  const availability = await context.guests.listPublicAvailability("sample-walk");
  return availability!.occurrences.find((occurrence) => occurrence.date === date)!.seatsLeft;
}

async function bookingRow(pool: Pool, publicBookingId: string) {
  return (await pool.query(
    `SELECT id::text AS id, status, occurrence_id, occurrence_snapshot, pricing_snapshot, seller_snapshot, stripe_payment_ref, seats
       FROM bookings WHERE public_booking_id=$1`,
    [publicBookingId],
  )).rows[0];
}

async function ledger(pool: Pool, publicBookingId: string) {
  return (await pool.query(
    `SELECT l.entry_id, l.kind, l.amount::int AS amount FROM payment_ledger_entries l JOIN bookings b ON b.provider_id=l.provider_id AND b.id=l.booking_id
      WHERE b.public_booking_id=$1 ORDER BY l.created_at, l.entry_id`,
    [publicBookingId],
  )).rows;
}

/** Changes a snapshot by hand (the snapshot trigger is off for this test schema only). */
async function patchSnapshots(pool: Pool, publicBookingId: string, sql: string, params: readonly unknown[] = []): Promise<void> {
  await pool.query("ALTER TABLE bookings DISABLE TRIGGER bookings_protect_snapshots");
  try {
    await pool.query(`UPDATE bookings SET ${sql} WHERE public_booking_id=$1`, [publicBookingId, ...params]);
  } finally {
    await pool.query("ALTER TABLE bookings ENABLE TRIGGER bookings_protect_snapshots");
  }
}

describe("PostgreSQL guest booking changes (#720 stage 1)", { skip: databaseUrl === undefined }, () => {
  it("fixes guestChange at booking only for 24/48-hour free cancellation with the product's switch on", async () => {
    await withSchema(async (context) => {
      const made = await paid(context);
      assert.deepEqual((await bookingRow(context.pool, made.publicBookingId)).pricing_snapshot.guestChange, { allowed: true, maxChanges: 2 });
      await context.changes.setGuestChangeAllowed(ownerA, "walk", false);
      const off = await paid(context, { guestEmail: "off@example.com" });
      assert.equal(Object.hasOwn((await bookingRow(context.pool, off.publicBookingId)).pricing_snapshot, "guestChange"), false);
      // A booking made before the switch went off keeps what it fixed.
      assert.deepEqual((await bookingRow(context.pool, made.publicBookingId)).pricing_snapshot.guestChange, { allowed: true, maxChanges: 2 });
      // Without guestChange (not retroactive) the page offers nothing and a move is refused.
      const session = await sessionFor(context, off.publicBookingId);
      assert.deepEqual(await context.changes.listChangeOptions(session, off.publicBookingId), { changeable: false });
      const refused = await context.changes.changeAsGuest(session, off.publicBookingId, moveToDate(tenAm(day(5)), day(6)));
      assert.equal(refused?.outcome, "NOT_CHANGEABLE");
      await assert.rejects(context.changes.setGuestChangeAllowed({ providerId: "provider-a", nihoUserId: "someone-else" }, "walk", true));
    });
    await withSchema(async (context) => {
      const made = await paid(context);
      assert.equal(Object.hasOwn((await bookingRow(context.pool, made.publicBookingId)).pricing_snapshot, "guestChange"), false);
    }, "NONE");
  });

  it("moves a paid booking to another date: seats, history, emails, push, day-before guide, sessions and the Google event follow; the money does not", async () => {
    await withSchema(async (context) => {
      const { pool, changes } = context;
      await pool.query(
        `INSERT INTO provider_google_connections
           (provider_id,connected_by_niho_user_id,encrypted_refresh_token,granted_scopes,busy_calendar_id,booking_calendar_id)
         VALUES ('provider-a','owner-a',$1,ARRAY['scope'],'primary-a','booking-a')`, ["x".repeat(40)],
      );
      const made = await paid(context);
      const google = new GoogleBookingCalendarEvents(pool);
      const [written] = await google.claimDue(10, 60_000);
      assert.equal(written?.startUtc, tenAm(day(5)));
      await google.finish(written!, "WRITTEN");
      // A day-before meeting email waiting for the old date.
      await pool.query(
        `INSERT INTO outbox_messages (provider_id,aggregate_type,aggregate_id,topic,deduplication_key,payload,available_at)
         VALUES ('provider-a','booking',$1,'booking.meeting_guide_day_before','meeting-guide-day-before:'||$1,jsonb_build_object('publicBookingId',$1::text),$2::timestamptz)`,
        [made.publicBookingId, new Date(Date.parse(tenAm(day(5))) - DAY_MS).toISOString()],
      );
      const before = await bookingRow(pool, made.publicBookingId);
      const ledgerBefore = await ledger(pool, made.publicBookingId);
      const session = await sessionFor(context, made.publicBookingId);
      const sessionBefore = (await pool.query("SELECT absolute_expires_at FROM booking_sessions")).rows[0].absolute_expires_at as Date;
      assert.equal(await seatsLeft(context, day(5)), 9);
      assert.equal(await seatsLeft(context, day(6)), 12);

      assert.equal(await changes.isChangeable(session, made.publicBookingId), true, "the page's light check agrees");
      const offered = await changes.listChangeOptions(session, made.publicBookingId);
      assert.ok(offered?.changeable);
      assert.equal(offered.fromStartUtc, tenAm(day(5)));
      assert.deepEqual([offered.changesUsed, offered.maxChanges], [0, 2]);
      const dates = offered.options.map((option) => option.date);
      assert.equal(dates.includes(day(5)), false, "not its own date");
      assert.equal(dates.includes(day(1)), false, "not a date whose free cancellation is already over");
      const target = offered.options.find((option) => option.date === day(6));
      assert.deepEqual(target, { date: day(6), startAtUtc: tenAm(day(6)), endAtUtc: new Date(Date.parse(tenAm(day(6))) + 90 * 60_000).toISOString(), seatsLeft: 12, newDeadlineUtc: deadline48(tenAm(day(6))) });
      assert.doesNotMatch(JSON.stringify(offered), /Sample Guest|example\.com/);

      const input = moveTo(offered.fromStartUtc, target);
      const result = await changes.changeAsGuest(session, made.publicBookingId, input);
      // A move that went through also says where the guest's session now ends: the page sets its cookie to it.
      const { sessionExpiresAtUtc: movedUntil, ...moved } = result!;
      assert.deepEqual(moved, { outcome: "OK", repeated: false, changeNumber: 1 });

      const after = await bookingRow(pool, made.publicBookingId);
      assert.notEqual(after.occurrence_id, before.occurrence_id);
      assert.equal(after.occurrence_snapshot.startUtc, tenAm(day(6)));
      assert.equal(after.occurrence_snapshot.localDate, day(6));
      assert.equal(after.occurrence_snapshot.occurrenceId, after.occurrence_id);
      assert.equal(after.occurrence_snapshot.acceptedAtUtc, before.occurrence_snapshot.acceptedAtUtc);
      assert.deepEqual(Object.keys(after.occurrence_snapshot).sort(), Object.keys(before.occurrence_snapshot).sort());
      // The money stays exactly as it was.
      assert.deepEqual(after.pricing_snapshot, before.pricing_snapshot);
      assert.deepEqual(after.seller_snapshot, before.seller_snapshot);
      assert.equal(after.stripe_payment_ref, before.stripe_payment_ref);
      assert.deepEqual(await ledger(pool, made.publicBookingId), ledgerBefore);
      assert.equal(Number((await pool.query("SELECT count(*) FROM booking_refunds")).rows[0].count), 0);
      // The seats moved.
      assert.equal(await seatsLeft(context, day(5)), 12);
      assert.equal(await seatsLeft(context, day(6)), 9);

      const history = (await pool.query("SELECT * FROM booking_changes")).rows;
      assert.equal(history.length, 1);
      assert.deepEqual(
        [history[0].change_number, history[0].command_id, history[0].from_occurrence_id, history[0].to_occurrence_id, history[0].changed_by],
        [1, input.commandId, before.occurrence_id, after.occurrence_id, "GUEST"],
      );
      assert.deepEqual(history[0].from_snapshot, before.occurrence_snapshot);
      assert.deepEqual(history[0].to_snapshot, after.occurrence_snapshot);

      const recalculated = (await pool.query("SELECT aggregate_id FROM calendar_outbox_events WHERE payload->>'cause'='booking_changed' ORDER BY id")).rows.map((row) => row.aggregate_id);
      assert.deepEqual(recalculated, [before.occurrence_id, after.occurrence_id]);
      const guestMail = (await pool.query("SELECT deduplication_key, payload FROM outbox_messages WHERE topic=$1", [GUEST_NOTICE_TOPICS.changed])).rows;
      assert.deepEqual(guestMail, [{ deduplication_key: `guest-mail:changed:${history[0].id}`, payload: { publicBookingId: made.publicBookingId, changeId: history[0].id } }]);
      const push = (await pool.query("SELECT deduplication_key, payload FROM outbox_messages WHERE topic=$1", [HOST_NOTIFICATION_TOPICS.bookingChanged])).rows;
      assert.equal(push.length, 1);
      assert.equal(push[0].deduplication_key, `host-push:booking-changed:${history[0].id}`);
      assert.deepEqual(parseBookingChangedPayload(push[0].payload), {
        v: 1, bookingId: made.publicBookingId, experienceTitle: "Synthetic walk", startsAt: tenAm(day(6)), previousStartsAt: tenAm(day(5)), seats: 3,
      });
      const guide = (await pool.query("SELECT available_at FROM outbox_messages WHERE deduplication_key=$1", [`meeting-guide-day-before:${made.publicBookingId}`])).rows[0];
      assert.equal((guide.available_at as Date).toISOString(), new Date(Date.parse(tenAm(day(6))) - DAY_MS).toISOString());
      const sessionAfter = (await pool.query("SELECT absolute_expires_at, idle_expires_at FROM booking_sessions")).rows[0];
      assert.equal((sessionAfter.absolute_expires_at as Date).toISOString(), new Date(Date.parse(after.occurrence_snapshot.endUtc) + 30 * DAY_MS).toISOString());
      assert.ok((sessionAfter.absolute_expires_at as Date) > sessionBefore);
      assert.equal(movedUntil, (sessionAfter.absolute_expires_at as Date).toISOString(), "the cookie follows the session's new end");
      assert.ok((sessionAfter.idle_expires_at as Date) <= (sessionAfter.absolute_expires_at as Date));
      // No personal data in the history, the outbox rows of the move or the commands.
      const written2 = JSON.stringify([
        history, (await pool.query("SELECT payload FROM outbox_messages WHERE topic=ANY($1::text[])", [[GUEST_NOTICE_TOPICS.changed, HOST_NOTIFICATION_TOPICS.bookingChanged]])).rows,
        (await pool.query("SELECT * FROM booking_change_commands")).rows,
      ]);
      assert.doesNotMatch(written2, /Sample Guest|example\.com|\+81/);

      // The guest's email says both dates, the same price and the new deadline.
      const notices = (await context.outbox.claimBookingNotices({ limit: 10, leaseSeconds: 120 })).notices;
      const email = notices.find((notice) => notice.email?.kind === "CHANGED")?.email;
      assert.ok(email && email.kind === "CHANGED");
      assert.deepEqual(
        [email.fromLocalDate, email.fromLocalStartTime, email.localDate, email.localStartTime, email.totalAmount, email.currency, email.freeCancellationUntilUtc],
        [day(5), "10:00", day(6), "10:00", 7500, "JPY", deadline48(tenAm(day(6)))],
      );
      // The booking page reads the new date.
      const view = await context.access.readBookingSession(session, made.publicBookingId);
      assert.equal(view?.localDate, day(6));
      assert.equal(view?.freeCancellationUntilUtc, deadline48(tenAm(day(6))));
      // The Google event moves with it.
      const [rewrite] = await google.claimDue(10, 60_000);
      assert.deepEqual([rewrite?.action, rewrite?.publicBookingId, rewrite?.startUtc], ["WRITE", made.publicBookingId, tenAm(day(6))]);

      // The same command again: the first result, no second move.
      const { sessionExpiresAtUtc: repeatedUntil, ...repeated } = (await changes.changeAsGuest(session, made.publicBookingId, input))!;
      assert.deepEqual(repeated, { outcome: "OK", repeated: true, changeNumber: 1 });
      assert.equal(repeatedUntil, movedUntil, "the same command again carries the same session end");
      assert.equal(Number((await pool.query("SELECT count(*) FROM booking_changes")).rows[0].count), 1);
      // The same command with other input is refused.
      await assert.rejects(changes.changeAsGuest(session, made.publicBookingId, { ...input, toDate: day(7) }), StoreConflictError);
    });
  });

  it("moves a free booking too, and stops after the fixed number of moves", async () => {
    await withSchema(async (context) => {
      const { pool, guests, changes } = context;
      await pool.query("UPDATE experience_products SET unit_amount=0 WHERE provider_id='provider-a' AND id='walk'");
      await guests.setSaleTerms(ownerA, "walk", {
        childPricing: { priceYen: 0, minAge: 4, maxAge: 12, adultRequired: false }, minimumParticipants: 1, maxPartySize: 6,
        cancellationPolicy: "FREE_UNTIL_48H", bookingQuestions: [], conditionsVersion: null,
      }, 1);
      await seedTestPublications(pool);
      const made = await guests.startGuestBooking(request({ adultCount: 1, childCount: 1, expectedTotalYen: 0 }));
      assert.equal(made.status, "CONFIRMED");
      const session = await sessionFor(context, made.publicBookingId);
      assert.equal((await changes.changeAsGuest(session, made.publicBookingId, moveToDate(tenAm(day(5)), day(6))))?.outcome, "OK");
      const { sessionExpiresAtUtc: secondUntil, ...second } = (await changes.changeAsGuest(session, made.publicBookingId, moveToDate(tenAm(day(6)), day(7))))!;
      assert.deepEqual(second, { outcome: "OK", repeated: false, changeNumber: 2 });
      assert.ok(typeof secondUntil === "string");
      assert.deepEqual(await changes.listChangeOptions(session, made.publicBookingId), { changeable: false });
      assert.equal(await changes.isChangeable(session, made.publicBookingId), false);
      assert.equal((await changes.changeAsGuest(session, made.publicBookingId, moveToDate(tenAm(day(7)), day(8))))?.outcome, "NOT_CHANGEABLE");
      assert.equal((await bookingRow(pool, made.publicBookingId)).occurrence_snapshot.localDate, day(7));
      assert.equal(Number((await pool.query("SELECT count(*) FROM payment_ledger_entries")).rows[0].count), 0);
    });
  });

  it("refuses what the page no longer shows, a full date, past deadlines, and bookings it does not move", async () => {
    await withSchema(async (context) => {
      const { pool, changes } = context;
      const made = await paid(context);
      const session = await sessionFor(context, made.publicBookingId);
      const from = tenAm(day(5));

      // Shown values that are no longer so: CHANGED, nothing moves.
      assert.equal((await changes.changeAsGuest(session, made.publicBookingId, moveToDate(tenAm(day(4)), day(6))))?.outcome, "CHANGED");
      assert.equal((await changes.changeAsGuest(session, made.publicBookingId, { ...moveToDate(from, day(6)), shownToStartUtc: tenAm(day(7)) }))?.outcome, "CHANGED");
      assert.equal((await changes.changeAsGuest(session, made.publicBookingId, { ...moveToDate(from, day(6)), shownNewDeadlineUtc: tenAm(day(3)) }))?.outcome, "CHANGED");
      // A date whose free cancellation is already over (tomorrow, 48 hours): CHANGED, as the page would no longer offer it.
      assert.equal((await changes.changeAsGuest(session, made.publicBookingId, moveToDate(from, day(1))))?.outcome, "CHANGED");
      // Its own date, a date outside the public window: NOT_CHANGEABLE.
      assert.equal((await changes.changeAsGuest(session, made.publicBookingId, moveToDate(from, day(5))))?.outcome, "NOT_CHANGEABLE");
      assert.equal((await changes.changeAsGuest(session, made.publicBookingId, moveToDate(from, day(120))))?.outcome, "NOT_CHANGEABLE");
      // The command keeps its answer: the same input again is the same refusal.
      const stale = moveToDate(tenAm(day(4)), day(6));
      assert.equal((await changes.changeAsGuest(session, made.publicBookingId, stale))?.outcome, "CHANGED");
      assert.deepEqual(await changes.changeAsGuest(session, made.publicBookingId, stale), { outcome: "CHANGED", repeated: true });

      // A full date.
      for (let index = 0; index < 4; index += 1) await paid(context, { occurrenceDate: day(8), guestEmail: `full-${index}@example.com` });
      assert.equal(await seatsLeft(context, day(8)), 0);
      assert.equal((await changes.changeAsGuest(session, made.publicBookingId, moveToDate(from, day(8))))?.outcome, "FULL");
      assert.equal(Number((await pool.query("SELECT count(*) FROM booking_changes")).rows[0].count), 0);
      assert.equal((await bookingRow(pool, made.publicBookingId)).occurrence_snapshot.localDate, day(5));

      // A day-before meeting email already sent: the guest asks the host instead.
      await pool.query(
        `INSERT INTO outbox_messages (provider_id,aggregate_type,aggregate_id,topic,deduplication_key,payload,processed_at)
         VALUES ('provider-a','booking',$1,'booking.meeting_guide_day_before','meeting-guide-day-before:'||$1,'{}',clock_timestamp())`,
        [made.publicBookingId],
      );
      assert.deepEqual(await changes.listChangeOptions(session, made.publicBookingId), { changeable: false });
      assert.equal((await changes.changeAsGuest(session, made.publicBookingId, moveToDate(from, day(6))))?.outcome, "NOT_CHANGEABLE");

      // The mail job has claimed it (its lease running) or it is due: the email would still go out for the old date.
      const guideKey = `meeting-guide-day-before:${made.publicBookingId}`;
      await pool.query("UPDATE outbox_messages SET processed_at = NULL, attempts = 1, available_at = clock_timestamp() + interval '2 minutes' WHERE deduplication_key = $1", [guideKey]);
      assert.equal((await changes.changeAsGuest(session, made.publicBookingId, moveToDate(from, day(6))))?.outcome, "NOT_CHANGEABLE", "claimed");
      await pool.query("UPDATE outbox_messages SET attempts = 0, available_at = clock_timestamp() - interval '1 minute' WHERE deduplication_key = $1", [guideKey]);
      assert.equal(await changes.isChangeable(session, made.publicBookingId), false, "due");
      assert.equal((await bookingRow(pool, made.publicBookingId)).occurrence_snapshot.localDate, day(5), "nothing moved");
      // Still waiting for its day: it moves with the booking.
      await pool.query("UPDATE outbox_messages SET available_at = clock_timestamp() + interval '2 days' WHERE deduplication_key = $1", [guideKey]);
      assert.equal(await changes.isChangeable(session, made.publicBookingId), true, "waiting");
    });
  });

  it("refuses bookings past their own deadline, with an open request or a refund, on hold for approval, managed, or cancelled", async () => {
    await withSchema(async (context) => {
      const { pool, changes } = context;
      let nextDate = 8;
      const bookingFor = async (email: string) => {
        const date = day(nextDate++);
        const made = await paid(context, { guestEmail: email, occurrenceDate: date });
        return { made, from: tenAm(date), session: await sessionFor(context, made.publicBookingId), row: await bookingRow(pool, made.publicBookingId) };
      };
      const refused = async (publicBookingId: string, session: string, from: string) => {
        assert.deepEqual(await changes.listChangeOptions(session, publicBookingId), { changeable: false }, publicBookingId);
        assert.equal((await changes.changeAsGuest(session, publicBookingId, moveToDate(from, day(6))))?.outcome, "NOT_CHANGEABLE", publicBookingId);
      };

      // Past its own free-cancellation deadline (it starts in 24 hours).
      const late = await bookingFor("late@example.com");
      const lateStart = new Date(Date.now() + 24 * HOUR_MS).toISOString();
      await patchSnapshots(pool, late.made.publicBookingId, "occurrence_snapshot = occurrence_snapshot || jsonb_build_object('startUtc', $2::text, 'endUtc', $3::text)",
        [lateStart, new Date(Date.parse(lateStart) + 90 * 60_000).toISOString()]);
      await refused(late.made.publicBookingId, late.session, lateStart);

      // An open request to cancel.
      const asked = await bookingFor("asked@example.com");
      await pool.query("INSERT INTO booking_cancellation_requests (id, provider_id, booking_id, status) VALUES ($1::uuid, 'provider-a', $2, 'OPEN')", [randomUUID(), asked.row.id]);
      await refused(asked.made.publicBookingId, asked.session, asked.from);

      // Any refund row.
      const refunded = await bookingFor("refunded@example.com");
      await pool.query(
        `INSERT INTO booking_refunds (id, provider_id, booking_id, command_id, kind, amount, currency, refund_application_fee, requested_by, stripe_payment_ref, status)
         VALUES ($1::uuid, 'provider-a', $2, $3::uuid, 'PARTIAL', 100, 'JPY', true, 'SUPPORT', $4, 'REQUESTED')`,
        [randomUUID(), refunded.row.id, randomUUID(), refunded.row.stripe_payment_ref],
      );
      await refused(refunded.made.publicBookingId, refunded.session, refunded.from);

      // Approval and NIHO-managed bookings.
      const approval = await bookingFor("approval@example.com");
      await patchSnapshots(pool, approval.made.publicBookingId, "seller_snapshot = seller_snapshot || '{\"acceptanceMode\":\"APPROVAL\"}'::jsonb");
      await refused(approval.made.publicBookingId, approval.session, approval.from);
      const managed = await bookingFor("managed@example.com");
      await patchSnapshots(pool, managed.made.publicBookingId, "seller_snapshot = seller_snapshot || '{\"chargeMode\":\"PLATFORM\",\"salesPlan\":\"MANAGED_20\"}'::jsonb");
      await refused(managed.made.publicBookingId, managed.session, managed.from);

      // A cancelled booking (its page still opens).
      const cancelled = await bookingFor("cancelled@example.com");
      await context.cancellations.cancelAsHost(ownerA, cancelled.made.publicBookingId, { commandId: randomUUID(), reason: "WEATHER" });
      await refused(cancelled.made.publicBookingId, cancelled.session, cancelled.from);

      // Another session or no session: null, as for a booking the page cannot open.
      assert.equal(await changes.listChangeOptions(asked.session, late.made.publicBookingId), null);
      assert.equal(await changes.changeAsGuest("x".repeat(43), late.made.publicBookingId, moveToDate(lateStart, day(6))), null);
      assert.equal(Number((await pool.query("SELECT count(*) FROM booking_changes")).rows[0].count), 0);
    });
  });

  it("does not move a booking that occupies a shared resource (stage 1)", async () => {
    await withSchema(async (context) => {
      const { pool, store, changes } = context;
      // Resources are assigned before any booking (the store refuses it afterwards).
      await store.saveInventoryResource(ownerA, { id: "room-a", kind: "VENUE", displayName: "Synthetic room A", active: true }, null, randomUUID());
      await store.saveProductInventorySetting(ownerA, "walk", { bookingMode: "SEAT", resources: [{ resourceId: "room-a", prepareMinutes: 0, cleanupMinutes: 0 }] }, null, randomUUID());
      const occupying = await paid(context);
      const count = Number((await pool.query(
        "SELECT count(*) FROM booking_resource_occupancies o JOIN bookings b ON b.provider_id=o.provider_id AND b.id=o.booking_id WHERE b.public_booking_id=$1",
        [occupying.publicBookingId],
      )).rows[0].count);
      assert.equal(count, 1);
      const session = await sessionFor(context, occupying.publicBookingId);
      assert.deepEqual(await changes.listChangeOptions(session, occupying.publicBookingId), { changeable: false });
      assert.equal((await changes.changeAsGuest(session, occupying.publicBookingId, moveToDate(tenAm(day(5)), day(6))))?.outcome, "NOT_CHANGEABLE");
      assert.equal(Number((await pool.query("SELECT count(*) FROM booking_changes")).rows[0].count), 0);
    });
  });

  it("lets only one of two bookings take the last seats of a date at the same time", async () => {
    await withSchema(async (context) => {
      const { changes } = context;
      for (let index = 0; index < 3; index += 1) await paid(context, { occurrenceDate: day(8), guestEmail: `filler-${index}@example.com` });
      assert.equal(await seatsLeft(context, day(8)), 3);
      const first = await paid(context, { guestEmail: "first@example.com" });
      const second = await paid(context, { guestEmail: "second@example.com", occurrenceDate: day(6) });
      const [firstSession, secondSession] = [await sessionFor(context, first.publicBookingId), await sessionFor(context, second.publicBookingId)];
      const results = await Promise.all([
        changes.changeAsGuest(firstSession, first.publicBookingId, moveToDate(tenAm(day(5)), day(8))),
        changes.changeAsGuest(secondSession, second.publicBookingId, moveToDate(tenAm(day(6)), day(8))),
      ]);
      assert.deepEqual(results.map((result) => result?.outcome).sort(), ["FULL", "OK"]);
      assert.equal(await seatsLeft(context, day(8)), 0);
    });
  });

  it("keeps the snapshot trigger refusing every update outside the change path", async () => {
    await withSchema(async (context) => {
      const { pool } = context;
      const made = await paid(context);
      const other = await paid(context, { guestEmail: "other@example.com", occurrenceDate: day(6) });
      const row = await bookingRow(pool, made.publicBookingId);
      const target = await bookingRow(pool, other.publicBookingId);
      const client = await pool.connect();
      const attempt = async (setting: string | null, sql: string, params: readonly unknown[]) => {
        await client.query("BEGIN");
        try {
          if (setting !== null) await client.query("SELECT set_config('experience.booking_move', $1, true)", [setting]);
          await client.query(sql, params as unknown[]);
          return "updated";
        } catch (error) {
          return (error as Error).message;
        } finally {
          await client.query("ROLLBACK");
        }
      };
      const move = "UPDATE bookings SET occurrence_id=$2, occurrence_snapshot=$3::jsonb WHERE id=$1";
      const params = [row.id, target.occurrence_id, JSON.stringify(target.occurrence_snapshot)];
      try {
        assert.match(await attempt(null, move, params), /immutable/);
        assert.match(await attempt(target.id, move, params), /immutable/, "the setting names another booking");
        assert.match(await attempt(row.id, "UPDATE bookings SET occurrence_id=$2, occurrence_snapshot=$3::jsonb, pricing_snapshot=pricing_snapshot||'{\"totalAmount\":1}' WHERE id=$1", params), /immutable/);
        assert.match(await attempt(row.id, "UPDATE bookings SET occurrence_id=$2, occurrence_snapshot=$3::jsonb, seats=seats+1 WHERE id=$1", params), /immutable/);
        assert.match(await attempt(row.id, move, [row.id, target.occurrence_id, JSON.stringify(row.occurrence_snapshot)]), /immutable/, "the snapshot names another occurrence");
        assert.equal(await attempt(row.id, move, params), "updated");
      } finally {
        client.release();
      }
      const session = await sessionFor(context, made.publicBookingId);
      await context.changes.changeAsGuest(session, made.publicBookingId, moveToDate(tenAm(day(5)), day(7)));
      await assert.rejects(pool.query("UPDATE booking_changes SET changed_by='HOST'"), /append-only/);
      await assert.rejects(pool.query("DELETE FROM booking_changes"), /append-only/);
      await assert.rejects(pool.query("DELETE FROM booking_change_commands"), /append-only/);
    });
  });
});
