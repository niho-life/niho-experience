import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { addLocalDays, type ScheduleRule } from "@niho-experience/experience-domain";
import type { Pool } from "pg";
import { BOOKING_ACCESS_LIMITS, BOOKING_LINK_TOPIC, GuestBookingAccess } from "../src/booking-access.ts";
import { StoreValidationError } from "../src/errors.ts";
import { GuestBookingRepository, type GuestBookingStart, type StartGuestBookingInput } from "../src/guest-bookings.ts";
import { GUEST_MAIL_LIMITS, GuestMailOutbox } from "../src/guest-mail-outbox.ts";
import { ExperienceStore } from "../src/repository.ts";

/** 予約者の予約ページ (#285 slice 6): links, sessions and "Find your booking" against a real schema, synthetic data only. */
const databaseUrl = process.env.TEST_DATABASE_URL;
const ownerA = { providerId: "provider-a", nihoUserId: "owner-a" } as const;
const CONSENT = "sample-terms-2026-10";
const NO_QUESTIONS = createHash("sha256").update("[]", "utf8").digest("hex");
const DAY_MS = 86_400_000;

function day(offset: number): string {
  return addLocalDays(new Date(Date.now() + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10), offset);
}

const RULE: ScheduleRule = {
  id: "sample-walk-am", timeZone: "Asia/Tokyo", startsOn: day(1), localStartTime: "10:00", durationMinutes: 90, capacity: 12,
  bookingCutoffMinutes: 60, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "DAILY" },
};

function request(overrides: Partial<StartGuestBookingInput> = {}): StartGuestBookingInput {
  return {
    slug: "sample-walk", offerId: "sample-walk-am", occurrenceDate: day(2), adultCount: 2, childCount: 1, expectedTotalYen: 7500,
    bookingQuestionsFingerprint: NO_QUESTIONS, answers: [], termsConsentVersion: CONSENT, currentConsentVersion: CONSENT,
    conditionsConsentVersion: null, guestName: "Sample Guest", guestEmail: "Guest@Example.com", guestLanguage: "EN",
    clientRequestKey: randomUUID(), ...overrides,
  };
}

interface Context {
  readonly pool: Pool;
  readonly store: ExperienceStore;
  readonly guests: GuestBookingRepository;
  readonly access: GuestBookingAccess;
  readonly outbox: GuestMailOutbox;
}

async function withSchema(run: (context: Context) => Promise<void>): Promise<void> {
  const { Pool } = await import("pg");
  const schema = `booking_access_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const migrations = (await readdir(new URL("../migrations/", import.meta.url))).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort();
    for (const name of migrations) await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a')");
    await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES ('provider-a','owner-a','OWNER',true)");
    await pool.query(
      `INSERT INTO experience_products
         (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
       VALUES ('provider-a','walk','sample-walk','PUBLISHED','Synthetic walk','{}','JPY',3000,'terms-v1','seller-provider-a','acct_SampleA0001','Sample Seller A')`,
    );
    const store = new ExperienceStore(pool);
    const guests = new GuestBookingRepository(pool);
    await guests.setProviderSaleSettings("provider-a", { supportEnabled: false });
    await guests.setSaleTerms(ownerA, "walk", {
      childPricing: { priceYen: 1500, minAge: 4, maxAge: 12, adultRequired: true }, minimumParticipants: 1, maxPartySize: 6,
      cancellationPolicy: "FREE_UNTIL_48H", bookingQuestions: [], conditionsVersion: null,
    });
    await store.saveScheduleRule(ownerA, "walk", RULE, null, randomUUID());
    await run({ pool, store, guests, access: new GuestBookingAccess(pool), outbox: new GuestMailOutbox(pool) });
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
}

let events = 0;
async function confirmed(context: Context, overrides: Partial<StartGuestBookingInput> = {}): Promise<GuestBookingStart> {
  const start = await context.guests.startGuestBooking(request(overrides));
  events += 1;
  const paid = await context.store.confirmBookingPayment({ providerId: "provider-a" }, {
    publicBookingId: start.publicBookingId, connectedAccountId: "acct_SampleA0001", stripePaymentRef: `pi_sample_${events}`,
    stripeEventId: `evt_sample_${events}`, stripeEventType: "checkout.session.completed", eventOccurredAtUtc: new Date().toISOString(),
    amount: start.totalAmount, currency: "JPY",
  });
  assert.equal(paid.booking.status, "CONFIRMED");
  return start;
}

const digest = (secret: string) => createHash("sha256").update(secret, "utf8").digest();

async function cancel(pool: Pool, publicBookingId: string): Promise<void> {
  await pool.query("UPDATE bookings SET status='CANCELLED', confirmed_at=NULL, cancelled_at=clock_timestamp() WHERE public_booking_id=$1", [publicBookingId]);
}

async function erase(pool: Pool, publicBookingId: string): Promise<void> {
  await pool.query(
    `UPDATE booking_guests g SET guest_name=NULL, guest_email=NULL, guest_email_key=NULL, guest_phone=NULL, note=NULL, answers=NULL, utm=NULL, pii_erased_at=clock_timestamp()
       FROM bookings b WHERE b.provider_id=g.provider_id AND b.id=g.booking_id AND b.public_booking_id=$1`,
    [publicBookingId],
  );
}

/** Moves the booking's experience `daysAgo` days into the past (the snapshot trigger is off for this test schema only). */
async function endedDaysAgo(pool: Pool, publicBookingId: string, daysAgo: number): Promise<void> {
  const end = new Date(Date.now() - daysAgo * DAY_MS).toISOString();
  const start = new Date(Date.parse(end) - 90 * 60_000).toISOString();
  await pool.query("ALTER TABLE bookings DISABLE TRIGGER bookings_protect_snapshots");
  await pool.query(
    `UPDATE bookings SET occurrence_snapshot = occurrence_snapshot || jsonb_build_object('startUtc', $2::text, 'endUtc', $3::text)
      WHERE public_booking_id=$1`,
    [publicBookingId, start, end],
  );
  await pool.query("ALTER TABLE bookings ENABLE TRIGGER bookings_protect_snapshots");
}

async function linkRows(pool: Pool) {
  return (await pool.query(
    "SELECT aggregate_type, aggregate_id, payload, processed_at FROM outbox_messages WHERE topic=$1 ORDER BY id",
    [BOOKING_LINK_TOPIC],
  )).rows;
}

describe("PostgreSQL guest booking access (#285 slice 6)", { skip: databaseUrl === undefined }, () => {
  it("issues one-time grants that open one session for one booking, storing hashes only", async () => {
    await withSchema(async (context) => {
      const { pool, access } = context;
      const booking = await confirmed(context);
      const other = await confirmed(context, { guestEmail: "other@example.com", guestName: "Other Guest" });
      const grant = await access.issueBookingAccessGrant(booking.publicBookingId.toUpperCase());
      assert.ok(grant);
      assert.match(grant.token, /^[A-Za-z0-9_-]{43}$/);
      const expires = Date.parse(grant.expiresAtUtc);
      assert.ok(Math.abs(expires - (Date.now() + BOOKING_ACCESS_LIMITS.grantTtlDays * DAY_MS)) < 60_000);

      const opened = await access.openBookingSession(grant.token);
      assert.ok(opened);
      assert.equal(opened.publicBookingId, booking.publicBookingId);
      assert.match(opened.sessionId, /^[A-Za-z0-9_-]{43}$/);
      assert.notEqual(opened.sessionId, grant.token);
      // The session lasts until 30 days after the experience at most.
      assert.equal(opened.expiresAtUtc, new Date(Date.parse(booking.booking.occurrenceSnapshot.endUtc) + 30 * DAY_MS).toISOString());
      // A grant opens one session.
      assert.equal(await access.openBookingSession(grant.token), null);

      const view = await access.readBookingSession(opened.sessionId, booking.publicBookingId);
      const snapshot = booking.booking.occurrenceSnapshot;
      assert.deepEqual(view, {
        publicBookingId: booking.publicBookingId, status: "CONFIRMED", experienceTitle: "Synthetic walk", experienceSlug: "sample-walk",
        localDate: day(2), localStartTime: "10:00", timeZone: "Asia/Tokyo", startUtc: snapshot.startUtc, endUtc: snapshot.endUtc,
        adultCount: 2, childCount: 1, totalAmount: 7500, currency: "JPY", cancellationPolicy: "FREE_UNTIL_48H",
        freeCancellationUntilUtc: new Date(Date.parse(snapshot.startUtc) - 48 * 3_600_000).toISOString(),
        hostDisplayName: "Sample Seller A", guestName: "Sample Guest", bookedAtUtc: booking.booking.createdAtUtc, cancelledAtUtc: null,
      });
      assert.doesNotMatch(JSON.stringify(view), /example\.com/i);

      // The session reads its own booking only; nothing else answers either.
      assert.equal(await access.readBookingSession(opened.sessionId, other.publicBookingId), null);
      assert.equal(await access.readBookingSession(opened.sessionId, randomUUID()), null);
      assert.equal(await access.readBookingSession(grant.token, booking.publicBookingId), null);
      assert.equal(await access.readBookingSession("not-a-session", booking.publicBookingId), null);
      assert.equal(await access.readBookingSession(opened.sessionId, "not-a-booking"), null);
      assert.equal(await access.openBookingSession("short"), null);
      assert.equal(await access.openBookingSession("x".repeat(43)), null);

      // No raw token or session id is stored anywhere in the two tables.
      const grants = (await pool.query("SELECT token_hash, used_at FROM booking_access_grants")).rows;
      const sessions = (await pool.query("SELECT session_hash FROM booking_sessions")).rows;
      assert.deepEqual(grants.map((row) => Buffer.compare(row.token_hash, digest(grant.token))), [0]);
      assert.ok(grants[0].used_at instanceof Date);
      assert.deepEqual(sessions.map((row) => Buffer.compare(row.session_hash, digest(opened.sessionId))), [0]);
      const dump = JSON.stringify((await pool.query("SELECT a.*, s.* FROM booking_access_grants a FULL JOIN booking_sessions s ON false")).rows);
      assert.ok(!dump.includes(grant.token) && !dump.includes(opened.sessionId));

      await assert.rejects(access.issueBookingAccessGrant("not-a-booking"), StoreValidationError);
      assert.equal(await access.issueBookingAccessGrant(randomUUID()), null);
    });
  });

  it("opens a grant once under concurrency", async () => {
    await withSchema(async (context) => {
      const booking = await confirmed(context);
      const grant = (await context.access.issueBookingAccessGrant(booking.publicBookingId))!;
      const results = await Promise.all([context.access.openBookingSession(grant.token), context.access.openBookingSession(grant.token), context.access.openBookingSession(grant.token)]);
      assert.equal(results.filter((result) => result !== null).length, 1);
      assert.equal(Number((await context.pool.query("SELECT count(*) FROM booking_sessions")).rows[0].count), 1);
    });
  });

  it("ends grants and sessions on expiry: grant, idle and absolute, and touches a session at most hourly", async () => {
    await withSchema(async (context) => {
      const { pool, access } = context;
      const booking = await confirmed(context);
      const expired = (await access.issueBookingAccessGrant(booking.publicBookingId))!;
      await pool.query("UPDATE booking_access_grants SET created_at = now() - interval '31 days', expires_at = now() - interval '2 days' WHERE token_hash = $1", [digest(expired.token)]);
      assert.equal(await access.openBookingSession(expired.token), null);

      const idle = (await access.openBookingSession((await access.issueBookingAccessGrant(booking.publicBookingId))!.token))!;
      const absolute = (await access.openBookingSession((await access.issueBookingAccessGrant(booking.publicBookingId))!.token))!;
      const touched = (await access.openBookingSession((await access.issueBookingAccessGrant(booking.publicBookingId))!.token))!;
      const age = async (session: string, interval: string) => pool.query(
        `UPDATE booking_sessions SET created_at = created_at - $2::interval, last_seen_at = last_seen_at - $2::interval WHERE session_hash = $1`,
        [digest(session), interval],
      );
      await pool.query("UPDATE booking_sessions SET idle_expires_at = clock_timestamp() - interval '1 second' WHERE session_hash = $1", [digest(idle.sessionId)]);
      assert.equal(await access.readBookingSession(idle.sessionId, booking.publicBookingId), null);
      await pool.query(
        "UPDATE booking_sessions SET created_at = created_at - interval '2 days', last_seen_at = last_seen_at - interval '2 days', idle_expires_at = now() - interval '1 second', absolute_expires_at = now() - interval '1 second' WHERE session_hash = $1",
        [digest(absolute.sessionId)],
      );
      assert.equal(await access.readBookingSession(absolute.sessionId, booking.publicBookingId), null);

      // Within the hour a read leaves the session as it was; after it, the read moves the last use and the idle end.
      const before = (await pool.query("SELECT last_seen_at, idle_expires_at FROM booking_sessions WHERE session_hash = $1", [digest(touched.sessionId)])).rows[0];
      assert.ok(await access.readBookingSession(touched.sessionId, booking.publicBookingId));
      assert.deepEqual((await pool.query("SELECT last_seen_at, idle_expires_at FROM booking_sessions WHERE session_hash = $1", [digest(touched.sessionId)])).rows[0], before);
      await age(touched.sessionId, "2 hours");
      await pool.query("UPDATE booking_sessions SET idle_expires_at = clock_timestamp() + interval '1 day' WHERE session_hash = $1", [digest(touched.sessionId)]);
      assert.ok(await access.readBookingSession(touched.sessionId, booking.publicBookingId));
      const after = (await pool.query("SELECT last_seen_at, idle_expires_at FROM booking_sessions WHERE session_hash = $1", [digest(touched.sessionId)])).rows[0];
      assert.ok(Date.now() - after.last_seen_at.getTime() < 60_000);
      assert.ok(Math.abs(after.idle_expires_at.getTime() - (Date.now() + BOOKING_ACCESS_LIMITS.sessionIdleDays * DAY_MS)) < 60_000);

      // A grant never outlives 30 days after the experience, and none is issued past it.
      await endedDaysAgo(pool, booking.publicBookingId, 10);
      const late = (await access.issueBookingAccessGrant(booking.publicBookingId))!;
      assert.ok(Math.abs(Date.parse(late.expiresAtUtc) - (Date.now() + 20 * DAY_MS)) < 60_000);
      await endedDaysAgo(pool, booking.publicBookingId, 31);
      assert.equal(await access.issueBookingAccessGrant(booking.publicBookingId), null);
      assert.equal(await access.openBookingSession(late.token), null);
    });
  });

  it("revokes every grant and session of a booking at once, signs out one device, and refuses erased data", async () => {
    await withSchema(async (context) => {
      const { pool, access } = context;
      const booking = await confirmed(context);
      const unused = (await access.issueBookingAccessGrant(booking.publicBookingId))!;
      const phone = (await access.openBookingSession((await access.issueBookingAccessGrant(booking.publicBookingId))!.token))!;
      const laptop = (await access.openBookingSession((await access.issueBookingAccessGrant(booking.publicBookingId))!.token))!;

      await access.endBookingSession(phone.sessionId);
      assert.equal(await access.readBookingSession(phone.sessionId, booking.publicBookingId), null);
      assert.ok(await access.readBookingSession(laptop.sessionId, booking.publicBookingId));
      await access.endBookingSession(phone.sessionId);
      await access.endBookingSession("not-a-session");

      assert.equal(await access.revokeBookingAccess(booking.publicBookingId), true);
      assert.equal(await access.readBookingSession(laptop.sessionId, booking.publicBookingId), null);
      assert.equal(await access.openBookingSession(unused.token), null);
      assert.equal(await access.revokeBookingAccess(randomUUID()), false);
      // A link sent after the revocation works again.
      const fresh = (await access.openBookingSession((await access.issueBookingAccessGrant(booking.publicBookingId))!.token))!;
      assert.ok(await access.readBookingSession(fresh.sessionId, booking.publicBookingId));

      // A cancelled booking still opens (its page says so); erased guest data never does.
      await cancel(pool, booking.publicBookingId);
      const view = await access.readBookingSession(fresh.sessionId, booking.publicBookingId);
      assert.equal(view?.status, "CANCELLED");
      assert.ok(view?.cancelledAtUtc);
      const pending = (await access.issueBookingAccessGrant(booking.publicBookingId))!;
      await erase(pool, booking.publicBookingId);
      assert.equal(await access.readBookingSession(fresh.sessionId, booking.publicBookingId), null);
      assert.equal(await access.openBookingSession(pending.token), null);
      assert.equal(await access.issueBookingAccessGrant(booking.publicBookingId), null);

      // A hold (checkout under way) has no page.
      const hold = await context.guests.startGuestBooking(request({ guestEmail: "hold@example.com" }));
      assert.equal(await access.issueBookingAccessGrant(hold.publicBookingId), null);
    });
  });

  it("queues one link email per open booking of an address, limited per booking and alike whatever matched", async () => {
    await withSchema(async (context) => {
      const { pool, access } = context;
      const first = await confirmed(context);
      const second = await confirmed(context, { occurrenceDate: day(4) });
      const cancelled = await confirmed(context, { occurrenceDate: day(5) });
      await cancel(pool, cancelled.publicBookingId);
      const ended = await confirmed(context, { occurrenceDate: day(6) });
      await endedDaysAgo(pool, ended.publicBookingId, 31);
      const recent = await confirmed(context, { occurrenceDate: day(7) });
      await endedDaysAgo(pool, recent.publicBookingId, 2);
      const someoneElse = await confirmed(context, { guestEmail: "someone@example.com" });

      // The same answer whether the address has bookings, has none, or is past its limit.
      assert.equal(await access.requestBookingLink({ email: " guest@EXAMPLE.com " }), undefined);
      const queued = await linkRows(pool);
      assert.deepEqual(queued.map((row) => row.aggregate_id).sort(), [first.publicBookingId, second.publicBookingId, recent.publicBookingId].sort());
      for (const row of queued) {
        assert.equal(row.aggregate_type, "booking");
        assert.deepEqual(row.payload, {});
        assert.equal(row.processed_at, null);
      }
      // Upcoming first, nearest first; then the one that just ended.
      const rawOrder = (await pool.query("SELECT aggregate_id FROM outbox_messages WHERE topic=$1 ORDER BY id", [BOOKING_LINK_TOPIC])).rows.map((row) => row.aggregate_id);
      assert.deepEqual(rawOrder, [first.publicBookingId, second.publicBookingId, recent.publicBookingId]);
      assert.equal(await access.requestBookingLink({ email: "nobody@example.com" }), undefined);
      assert.equal((await linkRows(pool)).length, 3);

      await access.requestBookingLink({ email: "guest@example.com" });
      await access.requestBookingLink({ email: "guest@example.com" });
      assert.equal((await linkRows(pool)).length, 9);
      assert.equal(await access.requestBookingLink({ email: "guest@example.com" }), undefined);
      assert.equal((await linkRows(pool)).length, 9, "3 an hour per booking");
      await access.requestBookingLink({ email: "someone@example.com" });
      assert.deepEqual((await linkRows(pool)).slice(9).map((row) => row.aggregate_id), [someoneElse.publicBookingId]);
      // An hour later the booking may get another.
      await pool.query("UPDATE outbox_messages SET created_at = created_at - interval '61 minutes' WHERE topic=$1", [BOOKING_LINK_TOPIC]);
      await access.requestBookingLink({ email: "guest@example.com" });
      assert.equal((await linkRows(pool)).length, 13);

      for (const email of ["", "not-an-address", "a@b", `${"x".repeat(250)}@example.com`, "guest@exa\nmple.com"]) {
        await assert.rejects(access.requestBookingLink({ email }), StoreValidationError, JSON.stringify(email));
      }
      // Nothing about the address is kept for a request that matched nothing.
      assert.doesNotMatch(JSON.stringify((await pool.query("SELECT * FROM outbox_messages")).rows), /nobody/);
    });
  });

  it("hands the mail job each link email's facts, and nothing for a booking that can no longer be opened", async () => {
    await withSchema(async (context) => {
      const { pool, access, outbox } = context;
      const booking = await confirmed(context);
      const cancelled = await confirmed(context, { occurrenceDate: day(4) });
      await access.requestBookingLink({ email: "guest@example.com" });
      await cancel(pool, cancelled.publicBookingId);
      // A confirmation row is another consumer's and stays as it is.
      const confirmationsBefore = (await pool.query("SELECT id, attempts, processed_at FROM outbox_messages WHERE topic='booking.confirmed' ORDER BY id")).rows;

      const claim = await outbox.claimBookingLinks({ limit: 10, leaseSeconds: 120 });
      assert.equal(claim.abandoned, 0);
      assert.equal(claim.links.length, 2);
      const [open, closed] = claim.links;
      assert.deepEqual(open!.email, {
        publicBookingId: booking.publicBookingId, guestEmail: "Guest@Example.com", guestName: "Sample Guest", experienceTitle: "Synthetic walk",
        localDate: day(2), localStartTime: "10:00", timeZone: "Asia/Tokyo",
      });
      assert.equal(closed!.email, null);
      assert.deepEqual((await outbox.claimBookingLinks({ limit: 10, leaseSeconds: 120 })).links, []);
      assert.deepEqual((await pool.query("SELECT id, attempts, processed_at FROM outbox_messages WHERE topic='booking.confirmed' ORDER BY id")).rows, confirmationsBefore);
      // The confirmation consumer never takes these rows.
      assert.deepEqual((await outbox.claimBookingConfirmations({ limit: 10, leaseSeconds: 120 })).confirmations.map((row) => row.id).sort(), confirmationsBefore.map((row) => String(row.id)).sort());

      await outbox.completeBookingLink(closed!.id);
      assert.equal(await outbox.retryBookingLink(open!.id, 1), "RETRY");
      await pool.query("UPDATE outbox_messages SET available_at = clock_timestamp() - interval '1 second' WHERE topic=$1 AND processed_at IS NULL", [BOOKING_LINK_TOPIC]);
      await pool.query("UPDATE outbox_messages SET attempts = $1 WHERE id = $2", [GUEST_MAIL_LIMITS.linkAttempts - 1, open!.id]);
      const last = (await outbox.claimBookingLinks({ limit: 10, leaseSeconds: 120 })).links[0]!;
      assert.equal(last.attempts, GUEST_MAIL_LIMITS.linkAttempts);
      assert.equal(await outbox.retryBookingLink(last.id, last.attempts), "FAILED");
      assert.deepEqual((await linkRows(pool)).map((row) => row.processed_at instanceof Date), [true, true]);
      await assert.rejects(outbox.retryBookingLink(last.id, GUEST_MAIL_LIMITS.linkAttempts + 1), StoreValidationError);
    });
  });

  it("purges used and expired grants and ended sessions, bounded per call", async () => {
    await withSchema(async (context) => {
      const { pool, access } = context;
      const booking = await confirmed(context);
      const live = (await access.issueBookingAccessGrant(booking.publicBookingId))!;
      const used = (await access.openBookingSession((await access.issueBookingAccessGrant(booking.publicBookingId))!.token))!;
      const signedOut = (await access.openBookingSession((await access.issueBookingAccessGrant(booking.publicBookingId))!.token))!;
      await access.endBookingSession(signedOut.sessionId);
      const expired = (await access.issueBookingAccessGrant(booking.publicBookingId))!;
      await pool.query("UPDATE booking_access_grants SET created_at = now() - interval '31 days', expires_at = now() - interval '2 days' WHERE token_hash = $1", [digest(expired.token)]);

      // 2 used grants, 1 expired grant and 1 signed-out session can go; the live grant and session stay.
      assert.equal(await access.purgeExpiredAccess({ limit: 1 }), 2);
      assert.equal(await access.purgeExpiredAccess({ limit: 100 }), 2);
      assert.equal(await access.purgeExpiredAccess({ limit: 100 }), 0);
      assert.ok(await access.openBookingSession(live.token));
      assert.ok(await access.readBookingSession(used.sessionId, booking.publicBookingId));
      await assert.rejects(access.purgeExpiredAccess({ limit: 0 }), StoreValidationError);
    });
  });
});
