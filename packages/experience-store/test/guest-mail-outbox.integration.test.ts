import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { addLocalDays, occurrenceIdFor, type ScheduleRule } from "@niho-experience/experience-domain";
import type { Pool } from "pg";
import { StoreValidationError } from "../src/errors.ts";
import { GuestBookingRepository, type GuestBookingStart, type StartGuestBookingInput } from "../src/guest-bookings.ts";
import { GUEST_MAIL_LIMITS, GuestMailOutbox } from "../src/guest-mail-outbox.ts";
import { ExperienceStore } from "../src/repository.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const ownerA = { providerId: "provider-a", nihoUserId: "owner-a" } as const;
const CONSENT = "sample-terms-2026-10";
const NO_QUESTIONS = createHash("sha256").update("[]", "utf8").digest("hex");

function day(offset: number): string {
  return addLocalDays(new Date(Date.now() + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10), offset);
}

const RULE: ScheduleRule = {
  id: "sample-walk-am", timeZone: "Asia/Tokyo", startsOn: day(1), localStartTime: "10:00", durationMinutes: 90, capacity: 12,
  bookingCutoffMinutes: 60, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "DAILY" },
};

/** One adult on the synthetic walk on day 2. */
function request(overrides: Partial<StartGuestBookingInput> = {}): StartGuestBookingInput {
  return {
    slug: "sample-walk", offerId: "sample-walk-am", occurrenceDate: day(2), adultCount: 1, childCount: 0, expectedTotalYen: 3000,
    bookingQuestionsFingerprint: NO_QUESTIONS, answers: [], termsConsentVersion: CONSENT, currentConsentVersion: CONSENT,
    conditionsConsentVersion: null, guestName: "Sample Guest", guestEmail: "guest@example.com", guestLanguage: "EN",
    clientRequestKey: randomUUID(), ...overrides,
  };
}

interface Context {
  readonly pool: Pool;
  readonly store: ExperienceStore;
  readonly guests: GuestBookingRepository;
  readonly outbox: GuestMailOutbox;
}

/** A fresh schema with every migration, a synthetic provider selling a walk (children half price) on a daily rule. */
async function withSchema(run: (context: Context) => Promise<void>): Promise<void> {
  const { Pool } = await import("pg");
  const schema = `guest_mail_outbox_${randomUUID().replaceAll("-", "")}`;
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
    await run({ pool, store, guests, outbox: new GuestMailOutbox(pool) });
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
}

async function payFor(store: ExperienceStore, start: { publicBookingId: string }, amount: number, event: string) {
  return store.confirmBookingPayment({ providerId: "provider-a" }, {
    publicBookingId: start.publicBookingId, connectedAccountId: "acct_SampleA0001", stripePaymentRef: `pi_sample_${event}`,
    stripeEventId: `evt_sample_${event}`, stripeEventType: "checkout.session.completed", eventOccurredAtUtc: new Date().toISOString(),
    amount, currency: "JPY",
  });
}

async function confirmedGuest(context: Context, event: string, overrides: Partial<StartGuestBookingInput> = {}): Promise<GuestBookingStart> {
  const start = await context.guests.startGuestBooking(request(overrides));
  assert.equal((await payFor(context.store, start, start.totalAmount, event)).booking.status, "CONFIRMED");
  return start;
}

async function outboxRows(pool: Pool, where = "TRUE") {
  return (await pool.query(
    `SELECT id::text AS id, aggregate_id, topic, attempts, available_at, processed_at
       FROM outbox_messages WHERE ${where} ORDER BY id`,
  )).rows;
}

/** As if the lease or the backoff of every pending row had already run out. */
async function makeDue(pool: Pool): Promise<void> {
  await pool.query("UPDATE outbox_messages SET available_at = clock_timestamp() - interval '1 second' WHERE processed_at IS NULL");
}

describe("PostgreSQL guest mail outbox (#285 slice 5)", { skip: databaseUrl === undefined }, () => {
  it("claims the confirmations of guest bookings only, with what the email needs, and never another row", async () => {
    await withSchema(async (context) => {
      const { pool, store, guests, outbox } = context;
      const family = await confirmedGuest(context, "family", { adultCount: 2, childCount: 1, expectedTotalYen: 7500, guestName: "Sample Parent", guestEmail: "Parent@Example.com" });
      // A booking made without a guest record (not on this site) writes booking.confirmed too: it is not this job's.
      const plain = await store.createBookingHold({ providerId: "provider-a" }, { productId: "walk", occurrenceId: occurrenceIdFor(RULE.id, day(3)), seats: 1, idempotencyKey: "sample-plain" });
      assert.equal((await payFor(store, plain, 3000, "plain")).booking.status, "CONFIRMED");
      // A payment under review writes another topic.
      const review = await guests.startGuestBooking(request({ guestEmail: "review@example.com" }));
      assert.equal((await payFor(store, review, 2000, "review")).booking.status, "PAYMENT_REVIEW");
      await pool.query(
        `INSERT INTO outbox_messages (provider_id, aggregate_type, aggregate_id, topic, deduplication_key, payload)
         VALUES ('provider-a','booking','not-a-uuid','booking.confirmed','sample-foreign','{}'::jsonb)`,
      );
      const before = await outboxRows(pool);
      assert.equal(before.length, 4);

      const claim = await outbox.claimBookingConfirmations({ limit: 10, leaseSeconds: 120 });
      assert.equal(claim.abandoned, 0);
      assert.equal(claim.confirmations.length, 1);
      const [confirmation] = claim.confirmations;
      assert.equal(confirmation!.attempts, 1);
      const snapshot = family.booking.occurrenceSnapshot;
      assert.deepEqual(confirmation!.email, {
        publicBookingId: family.publicBookingId, guestEmail: "Parent@Example.com", guestName: "Sample Parent",
        experienceTitle: "Synthetic walk", experienceSlug: "sample-walk", localDate: day(2), localStartTime: "10:00", timeZone: "Asia/Tokyo",
        startUtc: snapshot.startUtc, adultCount: 2, childCount: 1, totalAmount: 7500, currency: "JPY", cancellationPolicy: "FREE_UNTIL_48H",
        hostDisplayName: "Sample Seller A",
      });

      // The lease holds the row; every other row is exactly as it was.
      assert.deepEqual((await outbox.claimBookingConfirmations({ limit: 10, leaseSeconds: 120 })).confirmations, []);
      const after = await outboxRows(pool);
      const claimed = after.find((row) => row.id === confirmation!.id)!;
      assert.equal(claimed.aggregate_id, family.publicBookingId);
      assert.equal(claimed.attempts, 1);
      assert.ok(claimed.available_at.getTime() > Date.now() + 100_000);
      assert.deepEqual(after.filter((row) => row.id !== confirmation!.id), before.filter((row) => row.id !== confirmation!.id));

      // Done: never claimed again, even when due. Another row's id changes nothing.
      await outbox.completeBookingConfirmation(confirmation!.id);
      const plainRow = before.find((row) => row.aggregate_id === plain.publicBookingId)!;
      await outbox.completeBookingConfirmation(plainRow.id);
      assert.equal(await outbox.retryBookingConfirmation(plainRow.id, 1), "STALE");
      await makeDue(pool);
      assert.deepEqual((await outbox.claimBookingConfirmations({ limit: 10, leaseSeconds: 120 })).confirmations, []);
      const done = await outboxRows(pool);
      assert.ok(done.find((row) => row.id === confirmation!.id)!.processed_at instanceof Date);
      assert.deepEqual(done.filter((row) => row.id !== confirmation!.id).map((row) => [row.attempts, row.processed_at]), before.filter((row) => row.id !== confirmation!.id).map(() => [0, null]));

      for (const bad of [{ limit: 0, leaseSeconds: 120 }, { limit: GUEST_MAIL_LIMITS.claimLimitMax + 1, leaseSeconds: 120 }, { limit: 1, leaseSeconds: 10 }, { limit: 1.5, leaseSeconds: 120 }]) {
        await assert.rejects(() => outbox.claimBookingConfirmations(bad), StoreValidationError);
      }
      await assert.rejects(() => outbox.completeBookingConfirmation("x"), StoreValidationError);
      await assert.rejects(() => outbox.retryBookingConfirmation(confirmation!.id, 0), StoreValidationError);
    });
  });

  it("backs off after a transient failure, gives up at the attempt cap, and closes an abandoned last attempt", async () => {
    await withSchema(async (context) => {
      const { pool, outbox } = context;
      await confirmedGuest(context, "retry");
      const dbNow = async () => (await pool.query("SELECT clock_timestamp() AS now")).rows[0].now.getTime() as number;

      const [first] = (await outbox.claimBookingConfirmations({ limit: 5, leaseSeconds: 60 })).confirmations;
      assert.equal(first!.attempts, 1);
      // Another run's count no longer owns the row.
      assert.equal(await outbox.retryBookingConfirmation(first!.id, 2), "STALE");
      assert.equal(await outbox.retryBookingConfirmation(first!.id, 1), "RETRY");
      let row = (await outboxRows(pool, `id = ${first!.id}`))[0];
      assert.ok(Math.abs(row.available_at.getTime() - (await dbNow()) - 2 * 60_000) < 5_000, "2 minutes after the first attempt");
      assert.equal(row.processed_at, null);

      await makeDue(pool);
      const [second] = (await outbox.claimBookingConfirmations({ limit: 5, leaseSeconds: 60 })).confirmations;
      assert.equal(second!.attempts, 2);
      assert.equal(await outbox.retryBookingConfirmation(second!.id, 2), "RETRY");
      row = (await outboxRows(pool, `id = ${first!.id}`))[0];
      assert.ok(Math.abs(row.available_at.getTime() - (await dbNow()) - 4 * 60_000) < 5_000, "4 minutes after the second");

      // The last attempt fails too: the row is given up.
      await pool.query("UPDATE outbox_messages SET attempts = $1 WHERE id = $2", [GUEST_MAIL_LIMITS.confirmationAttempts - 1, first!.id]);
      await makeDue(pool);
      const [last] = (await outbox.claimBookingConfirmations({ limit: 5, leaseSeconds: 60 })).confirmations;
      assert.equal(last!.attempts, GUEST_MAIL_LIMITS.confirmationAttempts);
      assert.equal(await outbox.retryBookingConfirmation(last!.id, last!.attempts), "FAILED");
      assert.ok((await outboxRows(pool, `id = ${first!.id}`))[0].processed_at instanceof Date);

      // A last attempt whose lease ran out without a report is closed by the next claim, unsent.
      await confirmedGuest(context, "abandoned", { guestEmail: "abandoned@example.com" });
      const [abandoned] = (await outbox.claimBookingConfirmations({ limit: 5, leaseSeconds: 60 })).confirmations;
      await pool.query("UPDATE outbox_messages SET attempts = $1 WHERE id = $2", [GUEST_MAIL_LIMITS.confirmationAttempts, abandoned!.id]);
      const leased = await outbox.claimBookingConfirmations({ limit: 5, leaseSeconds: 60 });
      assert.deepEqual(leased, { confirmations: [], abandoned: 0 });
      await makeDue(pool);
      assert.deepEqual(await outbox.claimBookingConfirmations({ limit: 5, leaseSeconds: 60 }), { confirmations: [], abandoned: 1 });
      assert.ok((await outboxRows(pool, `id = ${abandoned!.id}`))[0].processed_at instanceof Date);
    });
  });

  it("hands over nothing to send for erased guest data or a booking no longer confirmed, and never shares a row", async () => {
    await withSchema(async (context) => {
      const { pool, guests, outbox } = context;
      const erased = await confirmedGuest(context, "erased", { guestEmail: "erased@example.com" });
      const cancelled = await confirmedGuest(context, "cancelled", { guestEmail: "cancelled@example.com" });
      await pool.query("ALTER TABLE bookings DISABLE TRIGGER bookings_protect_snapshots");
      await pool.query(
        "UPDATE bookings SET occurrence_snapshot = jsonb_set(occurrence_snapshot, '{endUtc}', to_jsonb('2020-01-01T01:30:00.000Z'::text)) WHERE public_booking_id=$1",
        [erased.publicBookingId],
      );
      await pool.query("ALTER TABLE bookings ENABLE TRIGGER bookings_protect_snapshots");
      assert.equal(await guests.eraseGuestData({ endedBefore: new Date().toISOString() }), 1);
      await pool.query("UPDATE bookings SET status='CANCELLED', confirmed_at=NULL, cancelled_at=clock_timestamp() WHERE public_booking_id=$1", [cancelled.publicBookingId]);

      // Two claimers at once never get the same row.
      const [one, two] = await Promise.all([
        outbox.claimBookingConfirmations({ limit: 1, leaseSeconds: 60 }),
        outbox.claimBookingConfirmations({ limit: 1, leaseSeconds: 60 }),
      ]);
      const ids = [...one.confirmations, ...two.confirmations].map((row) => row.id);
      assert.equal(new Set(ids).size, ids.length);
      await makeDue(pool);
      const claim = await outbox.claimBookingConfirmations({ limit: 5, leaseSeconds: 60 });
      assert.equal(claim.confirmations.length, 2);
      assert.deepEqual(claim.confirmations.map((row) => row.email), [null, null]);
      assert.doesNotMatch(JSON.stringify(claim), /example\.com|Sample Guest/);
    });
  });
});
