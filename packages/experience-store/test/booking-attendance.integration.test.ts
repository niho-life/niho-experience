import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { addLocalDays, type ScheduleRule } from "@niho-experience/experience-domain";
import type { Pool } from "pg";
import { BookingAttendance } from "../src/booking-attendance.ts";
import { BookingCancellations } from "../src/booking-cancellations.ts";
import { StoreAccessDeniedError, StoreNotFoundError, StoreValidationError } from "../src/errors.ts";
import { GuestBookingRepository, type GuestBookingStart, type StartGuestBookingInput } from "../src/guest-bookings.ts";
import { ExperienceStore } from "../src/repository.ts";

/** 出欠 (#107) against a real schema, synthetic data only. */
const databaseUrl = process.env.TEST_DATABASE_URL;
const ownerA = { providerId: "provider-a", nihoUserId: "owner-a" } as const;
const editorA = { providerId: "provider-a", nihoUserId: "editor-a" } as const;
const ownerB = { providerId: "provider-b", nihoUserId: "owner-b" } as const;
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
const SESSION = { productId: "walk", offerId: "sample-walk-am", localDate: day(5), localStartTime: "10:00" } as const;

function request(overrides: Partial<StartGuestBookingInput> = {}): StartGuestBookingInput {
  return {
    slug: "sample-walk", offerId: "sample-walk-am", occurrenceDate: day(5), adultCount: 2, childCount: 0, expectedTotalYen: 6000,
    bookingQuestionsFingerprint: NO_QUESTIONS, answers: [], termsConsentVersion: CONSENT, currentConsentVersion: CONSENT,
    conditionsConsentVersion: null, guestName: "Sample Guest", guestEmail: "guest@example.com", guestLanguage: "EN",
    clientRequestKey: randomUUID(), ...overrides,
  };
}

interface Context {
  readonly pool: Pool;
  readonly store: ExperienceStore;
  readonly guests: GuestBookingRepository;
  readonly attendance: BookingAttendance;
  readonly cancellations: BookingCancellations;
}

async function withSchema(run: (context: Context) => Promise<void>): Promise<void> {
  const { Pool } = await import("pg");
  const schema = `attendance_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const migrations = (await readdir(new URL("../migrations/", import.meta.url))).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort();
    for (const name of migrations) await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a'), ('provider-b')");
    await pool.query(
      `INSERT INTO provider_memberships (provider_id,niho_user_id,role,active)
       VALUES ('provider-a','owner-a','OWNER',true), ('provider-a','editor-a','EDITOR',true), ('provider-b','owner-b','OWNER',true)`,
    );
    await pool.query(
      `INSERT INTO experience_products
         (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
       VALUES ('provider-a','walk','sample-walk','PUBLISHED','Synthetic walk','{}','JPY',3000,'terms-v1','seller-provider-a','${ACCOUNT}','Sample Seller A')`,
    );
    const store = new ExperienceStore(pool);
    const guests = new GuestBookingRepository(pool);
    await guests.setProviderSaleSettings("provider-a", { supportEnabled: false });
    await guests.setSaleTerms(ownerA, "walk", {
      childPricing: null, minimumParticipants: 1, maxPartySize: 6, cancellationPolicy: "FREE_UNTIL_48H", bookingQuestions: [], conditionsVersion: null,
    });
    await store.saveScheduleRule(ownerA, "walk", RULE, null, randomUUID());
    await run({ pool, store, guests, attendance: new BookingAttendance(pool), cancellations: new BookingCancellations(pool) });
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
}

let events = 0;
async function paid(context: Context, overrides: Partial<StartGuestBookingInput> = {}): Promise<GuestBookingStart> {
  const start = await context.guests.startGuestBooking(request(overrides));
  events += 1;
  await context.store.confirmBookingPayment({ providerId: "provider-a" }, {
    publicBookingId: start.publicBookingId, connectedAccountId: ACCOUNT, stripePaymentRef: `pi_sample_${events}`,
    stripeEventId: `evt_sample_${events}`, stripeEventType: "checkout.session.completed", eventOccurredAtUtc: new Date().toISOString(),
    amount: start.totalAmount, currency: "JPY",
  });
  return start;
}

/** Moves the booking's start `ms` from now, keeping its local day and start (the snapshot trigger is off for this schema only). */
async function startsIn(pool: Pool, publicBookingId: string, ms: number): Promise<void> {
  const start = new Date(Date.now() + ms).toISOString();
  const end = new Date(Date.parse(start) + 90 * 60_000).toISOString();
  await pool.query("ALTER TABLE bookings DISABLE TRIGGER bookings_protect_snapshots");
  await pool.query(
    `UPDATE bookings SET occurrence_snapshot = occurrence_snapshot || jsonb_build_object('startUtc', $2::text, 'endUtc', $3::text)
      WHERE public_booking_id=$1`,
    [publicBookingId, start, end],
  );
  await pool.query("ALTER TABLE bookings ENABLE TRIGGER bookings_protect_snapshots");
}

async function stored(pool: Pool, publicBookingId: string) {
  return (await pool.query(
    `SELECT a.status, a.recorded_by, a.version::int AS version
       FROM booking_attendance a JOIN bookings b ON b.provider_id = a.provider_id AND b.id = a.booking_id
      WHERE b.public_booking_id = $1`,
    [publicBookingId],
  )).rows[0] ?? null;
}

describe("PostgreSQL booking attendance (#107)", { skip: databaseUrl === undefined }, () => {
  it("takes no mark before the session starts, and reads the occurrence's capacity", async () => {
    await withSchema(async (context) => {
      const { pool, attendance } = context;
      const made = await paid(context);
      const result = await attendance.recordAsHost(ownerA, made.publicBookingId, "ATTENDED");
      assert.deepEqual(result, { outcome: "NOT_STARTED", mark: null });
      assert.equal(await stored(pool, made.publicBookingId), null);
      assert.deepEqual(await attendance.readSessionForHost(ownerA, SESSION), { capacity: 12, marks: [] });
      // A session the provider has no booking of here: no capacity to show.
      assert.deepEqual(await attendance.readSessionForHost(ownerA, { ...SESSION, localDate: day(6) }), { capacity: null, marks: [] });
    });
  });

  it("marks a confirmed booking once started, keeps the same mark as it is, and lets the host correct it", async () => {
    await withSchema(async (context) => {
      const { pool, attendance } = context;
      const first = await paid(context, { guestName: "First Guest" });
      const second = await paid(context, { guestName: "Second Guest" });
      await startsIn(pool, first.publicBookingId, -10 * 60_000);
      await startsIn(pool, second.publicBookingId, -10 * 60_000);

      const marked = await attendance.recordAsHost(ownerA, first.publicBookingId.toUpperCase(), "ATTENDED");
      assert.equal(marked.outcome, "RECORDED");
      assert.equal(marked.mark?.publicBookingId, first.publicBookingId);
      assert.equal(marked.mark?.status, "ATTENDED");
      assert.deepEqual(await stored(pool, first.publicBookingId), { status: "ATTENDED", recorded_by: "owner-a", version: 1 });

      const again = await attendance.recordAsHost(ownerA, first.publicBookingId, "ATTENDED");
      assert.equal(again.outcome, "RECORDED");
      assert.equal(again.mark?.recordedAtUtc, marked.mark?.recordedAtUtc);
      assert.equal((await stored(pool, first.publicBookingId)).version, 1);

      const corrected = await attendance.recordAsHost(ownerA, first.publicBookingId, "NO_SHOW");
      assert.equal(corrected.mark?.status, "NO_SHOW");
      assert.equal((await stored(pool, first.publicBookingId)).version, 2);

      const read = await attendance.readSessionForHost(ownerA, SESSION);
      assert.equal(read.capacity, 12);
      assert.deepEqual(read.marks.map((mark) => [mark.publicBookingId, mark.status]), [[first.publicBookingId, "NO_SHOW"]]);
      // Still open once the session is over: a mistake can be put right.
      await startsIn(pool, second.publicBookingId, -5 * HOUR_MS);
      assert.equal((await attendance.recordAsHost(ownerA, second.publicBookingId, "ATTENDED")).outcome, "RECORDED");
      assert.deepEqual((await attendance.readSessionForHost(ownerA, SESSION)).marks.map((mark) => mark.status), ["NO_SHOW", "ATTENDED"]);
    });
  });

  it("takes no mark for a cancelled booking, and none for a hold", async () => {
    await withSchema(async (context) => {
      const { pool, attendance, cancellations } = context;
      const cancelled = await paid(context);
      await cancellations.cancelAsHost(ownerA, cancelled.publicBookingId, { commandId: randomUUID(), reason: "WEATHER" });
      await startsIn(pool, cancelled.publicBookingId, -10 * 60_000);
      assert.deepEqual(await attendance.recordAsHost(ownerA, cancelled.publicBookingId, "NO_SHOW"), { outcome: "NOT_CONFIRMED", mark: null });
      assert.equal(await stored(pool, cancelled.publicBookingId), null);

      const hold = await context.guests.startGuestBooking(request({ guestEmail: "hold@example.com" }));
      await startsIn(pool, hold.publicBookingId, -10 * 60_000);
      await assert.rejects(attendance.recordAsHost(ownerA, hold.publicBookingId, "ATTENDED"), StoreNotFoundError);
    });
  });

  it("is the OWNER's only, for the provider's own bookings and the two marks", async () => {
    await withSchema(async (context) => {
      const { pool, attendance } = context;
      const made = await paid(context);
      await startsIn(pool, made.publicBookingId, -10 * 60_000);
      await assert.rejects(attendance.recordAsHost(editorA, made.publicBookingId, "ATTENDED"), StoreAccessDeniedError);
      await assert.rejects(attendance.readSessionForHost(editorA, SESSION), StoreAccessDeniedError);
      await assert.rejects(attendance.recordAsHost({ ...ownerA, calendarRoleCeiling: "EDITOR" }, made.publicBookingId, "ATTENDED"), StoreAccessDeniedError);
      // Another provider's OWNER does not reach it, and reads nothing of the session.
      await assert.rejects(attendance.recordAsHost(ownerB, made.publicBookingId, "ATTENDED"), StoreNotFoundError);
      assert.deepEqual(await attendance.readSessionForHost(ownerB, SESSION), { capacity: null, marks: [] });
      await assert.rejects(attendance.recordAsHost(ownerA, randomUUID(), "ATTENDED"), StoreNotFoundError);
      await assert.rejects(attendance.recordAsHost(ownerA, "not-a-booking", "ATTENDED"), StoreValidationError);
      await assert.rejects(attendance.recordAsHost(ownerA, made.publicBookingId, "LATE" as never), StoreValidationError);
      await assert.rejects(attendance.readSessionForHost(ownerA, { ...SESSION, localStartTime: "10am" }), StoreValidationError);
      assert.equal(await stored(pool, made.publicBookingId), null);
    });
  });
});
