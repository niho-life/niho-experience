import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { addLocalDays, type ScheduleRule } from "@niho-experience/experience-domain";
import type { Pool } from "pg";
import { BookingCancellations } from "../src/booking-cancellations.ts";
import { StoreAccessDeniedError, StoreValidationError } from "../src/errors.ts";
import { HostCalendarSettings } from "../src/host-calendar-settings.ts";
import { enqueueGoogleCalendarAttentionNotification } from "../src/host-notification-outbox.ts";
import { GuestBookingRepository, type GuestBookingStart, type StartGuestBookingInput } from "../src/guest-bookings.ts";
import { ExperienceStore } from "../src/repository.ts";

/** 設定 › カレンダー (#109): the Google connection's state and the bookings feed, against a real schema, synthetic data only. */
const databaseUrl = process.env.TEST_DATABASE_URL;
const ownerA = { providerId: "provider-a", nihoUserId: "owner-a" } as const;
const secondOwnerA = { providerId: "provider-a", nihoUserId: "owner-a2" } as const;
const editorA = { providerId: "provider-a", nihoUserId: "editor-a" } as const;
const ownerB = { providerId: "provider-b", nihoUserId: "owner-b" } as const;
const CONSENT = "sample-terms-2026-10";
const NO_QUESTIONS = createHash("sha256").update("[]", "utf8").digest("hex");
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const ACCOUNT = "acct_SampleA0001";

function day(offset: number): string {
  return addLocalDays(new Date(Date.now() + 9 * HOUR_MS).toISOString().slice(0, 10), offset);
}

const RULE: ScheduleRule = {
  id: "sample-walk-am", timeZone: "Asia/Tokyo", startsOn: day(1), localStartTime: "10:00", durationMinutes: 90, capacity: 30,
  bookingCutoffMinutes: 60, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "DAILY" },
};

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
  readonly settings: HostCalendarSettings;
}

async function withSchema(run: (context: Context) => Promise<void>): Promise<void> {
  const { Pool } = await import("pg");
  const schema = `calendar_settings_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const migrations = (await readdir(new URL("../migrations/", import.meta.url))).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort();
    for (const name of migrations) await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a'), ('provider-b')");
    await pool.query(
      `INSERT INTO provider_memberships (provider_id,niho_user_id,role,active)
       VALUES ('provider-a','owner-a','OWNER',true), ('provider-a','owner-a2','OWNER',true), ('provider-a','editor-a','EDITOR',true),
              ('provider-a','former-a','OWNER',false), ('provider-b','owner-b','OWNER',true)`,
    );
    await pool.query(
      `INSERT INTO experience_products
         (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
       VALUES ('provider-a','walk','sample-walk','PUBLISHED','Synthetic walk','{}','JPY',3000,'terms-v1','seller-provider-a','${ACCOUNT}','Sample Seller A'),
              ('provider-b','tea','sample-tea','PUBLISHED','Synthetic tea','{}','JPY',3000,'terms-v1','seller-provider-b','acct_SampleB0001','Sample Seller B')`,
    );
    const store = new ExperienceStore(pool);
    const guests = new GuestBookingRepository(pool);
    await guests.setProviderSaleSettings("provider-a", { supportEnabled: false });
    await guests.setSaleTerms(ownerA, "walk", {
      childPricing: null, minimumParticipants: 1, maxPartySize: 6, cancellationPolicy: "FREE_UNTIL_48H", bookingQuestions: [], conditionsVersion: null,
    });
    await store.saveScheduleRule(ownerA, "walk", RULE, null, randomUUID());
    await run({ pool, store, guests, settings: new HostCalendarSettings(pool) });
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

const hashOf = (token: string) => createHash("sha256").update(token).digest();
/** The route's check of the address against the issue found (calendar-server.ts derives it again under the key). */
const accept = () => true;
const window = (fromDays: number, toDays: number) => ({
  fromUtc: new Date(Date.now() + fromDays * DAY_MS).toISOString(),
  toUtc: new Date(Date.now() + toDays * DAY_MS).toISOString(),
});

describe("PostgreSQL host calendar settings (#109)", { skip: databaseUrl === undefined }, () => {
  it("issues, replaces and stops the bookings feed for the OWNER only", async () => {
    await withSchema(async ({ pool, settings }) => {
      assert.equal(await settings.getFeed(ownerA), null);
      const firstSalt = randomBytes(32);
      const first = await settings.issueFeed(ownerA, { salt: firstSalt, tokenHash: hashOf("first-token") });
      assert.equal(first.replaced, false);
      assert.deepEqual(await settings.getFeed(ownerA), { salt: firstSalt, tokenHash: hashOf("first-token"), issuedAtUtc: first.issuedAtUtc });
      assert.notEqual(await settings.readFeed(hashOf("first-token"), window(-1, 30), accept), null);
      // Found by the digest, the address is handed to the check with its issue; refused, it answers nothing.
      const seen: unknown[] = [];
      assert.equal(await settings.readFeed(hashOf("first-token"), window(-1, 30), (issue) => (seen.push(issue), false)), null);
      assert.deepEqual(seen.slice(), [{ providerId: "provider-a", salt: firstSalt }]);
      // An unknown address is not checked at all.
      assert.equal(await settings.readFeed(hashOf("unknown-token"), window(-1, 30), (issue) => (seen.push(issue), true)), null);
      assert.equal(seen.length, 1);

      // Issuing again replaces the address: the old one answers nothing.
      const secondSalt = randomBytes(32);
      const second = await settings.issueFeed(secondOwnerA, { salt: secondSalt, tokenHash: hashOf("second-token") });
      assert.equal(second.replaced, true);
      assert.deepEqual(await settings.getFeed(ownerA), { salt: secondSalt, tokenHash: hashOf("second-token"), issuedAtUtc: second.issuedAtUtc });
      assert.equal(await settings.readFeed(hashOf("first-token"), window(-1, 30), accept), null);
      assert.equal((await settings.readFeed(hashOf("second-token"), window(-1, 30), accept))?.providerId, "provider-a");
      const stored = await pool.query("SELECT issued_by_niho_user_id FROM provider_calendar_feeds");
      assert.deepEqual(stored.rows, [{ issued_by_niho_user_id: "owner-a2" }]);

      // Not the OWNER, an inactive OWNER, another provider's OWNER, NIHO capping the role, a product operator.
      for (const actor of [
        editorA,
        { providerId: "provider-a", nihoUserId: "former-a" },
        { providerId: "provider-a", nihoUserId: "owner-b" },
        { ...ownerA, calendarRoleCeiling: "EDITOR" as const },
        { ...ownerA, calendarScope: "OPERATOR" as const },
      ]) {
        await assert.rejects(() => settings.getFeed(actor), StoreAccessDeniedError);
        await assert.rejects(() => settings.issueFeed(actor, { salt: randomBytes(32), tokenHash: hashOf("other") }), StoreAccessDeniedError);
        await assert.rejects(() => settings.revokeFeed(actor), StoreAccessDeniedError);
        await assert.rejects(() => settings.googleConnection(actor), StoreAccessDeniedError);
      }
      assert.notEqual(await settings.readFeed(hashOf("second-token"), window(-1, 30), accept), null);

      // The issuer stops being the provider's OWNER: the address answers nothing, though the row stays.
      await pool.query("UPDATE provider_memberships SET active=false WHERE niho_user_id='owner-a2'");
      assert.equal(await settings.readFeed(hashOf("second-token"), window(-1, 30), accept), null);
      await pool.query("UPDATE provider_memberships SET active=true WHERE niho_user_id='owner-a2'");

      assert.equal(await settings.revokeFeed(ownerA), true);
      assert.equal(await settings.revokeFeed(ownerA), false);
      assert.equal(await settings.getFeed(ownerA), null);
      assert.equal(await settings.readFeed(hashOf("second-token"), window(-1, 30), accept), null);

      // Only 32-byte values, and a window that moves forward.
      await assert.rejects(() => settings.issueFeed(ownerA, { salt: randomBytes(16), tokenHash: hashOf("x") }), StoreValidationError);
      await assert.rejects(() => settings.issueFeed(ownerA, { salt: randomBytes(32), tokenHash: Buffer.from("short") }), StoreValidationError);
      await assert.rejects(() => settings.readFeed(Buffer.alloc(8), window(-1, 30), accept), StoreValidationError);
      await assert.rejects(() => settings.readFeed(hashOf("x"), window(30, -1), accept), StoreValidationError);
      await assert.rejects(() => settings.readFeed(hashOf("x"), { fromUtc: "yesterday", toUtc: new Date().toISOString() }, accept), StoreValidationError);
      await assert.rejects(() => settings.readFeed(hashOf("x"), window(-1, 30), undefined as unknown as () => boolean), StoreValidationError);
    });
  });

  it("answers this site's confirmed bookings in the window, the nearest first, without anything about the guest", async () => {
    await withSchema(async (context) => {
      const { pool, guests, settings } = context;
      const soon = await paid(context, { occurrenceDate: day(5), adultCount: 3, expectedTotalYen: 9000, guestName: "Soon Guest", guestEmail: "soon@example.com" });
      const later = await paid(context, { occurrenceDate: day(9), guestEmail: "later@example.com" });
      const cancelled = await paid(context, { occurrenceDate: day(5), guestEmail: "cancelled@example.com" });
      await new BookingCancellations(pool).cancelAsHost(ownerA, cancelled.publicBookingId, { commandId: randomUUID(), reason: "WEATHER" });
      await paid(context, { occurrenceDate: day(5), guestEmail: "review@example.com" }, 1);
      await guests.startGuestBooking(request({ occurrenceDate: day(5), guestEmail: "held@example.com" }));
      const statuses = await pool.query("SELECT status, count(*)::int AS n FROM bookings GROUP BY status ORDER BY status");
      assert.deepEqual(statuses.rows, [
        { status: "CANCELLED", n: 1 }, { status: "CONFIRMED", n: 2 }, { status: "HOLD", n: 1 }, { status: "PAYMENT_REVIEW", n: 1 },
      ]);
      await settings.issueFeed(ownerA, { salt: randomBytes(32), tokenHash: hashOf("feed-a") });
      await settings.issueFeed(ownerB, { salt: randomBytes(32), tokenHash: hashOf("feed-b") });

      const all = await settings.readFeed(hashOf("feed-a"), window(-1, 30), accept);
      assert.equal(all?.providerId, "provider-a");
      const ids = await pool.query<{ public_booking_id: string; id: string }>("SELECT public_booking_id::text, id::text FROM bookings");
      const internal = (publicId: string) => ids.rows.find((row) => row.public_booking_id === publicId)?.id;
      assert.deepEqual(all?.bookings.map((booking) => booking.bookingId), [internal(soon.publicBookingId), internal(later.publicBookingId)]);
      const first = all!.bookings[0]!;
      assert.deepEqual(Object.keys(first).sort(), ["bookingId", "endUtc", "localDate", "localStartTime", "offerId", "productId", "productTitle", "seats", "startUtc"]);
      assert.deepEqual({ ...first, bookingId: "x" }, {
        bookingId: "x", productId: "walk", offerId: "sample-walk-am", productTitle: "Synthetic walk",
        startUtc: new Date(`${day(5)}T10:00:00+09:00`).toISOString(), endUtc: new Date(`${day(5)}T11:30:00+09:00`).toISOString(),
        localDate: day(5), localStartTime: "10:00", seats: 3,
      });
      assert.doesNotMatch(JSON.stringify(all), /Soon Guest|@example\.com|Sample Guest/);

      // The window: only the sessions it overlaps.
      const near = await settings.readFeed(hashOf("feed-a"), window(-1, 7), accept);
      assert.deepEqual(near?.bookings.map((booking) => booking.localDate), [day(5)]);
      assert.deepEqual((await settings.readFeed(hashOf("feed-a"), window(20, 30), accept))?.bookings, []);
      // Another provider's feed reads only its own (none here).
      assert.deepEqual(await settings.readFeed(hashOf("feed-b"), window(-1, 30), accept), { providerId: "provider-b", bookings: [] });

    });
  });

  it("says whether Google Calendar is connected, connected but failing, or refused by Google", async () => {
    await withSchema(async ({ pool, settings }) => {
      assert.equal(await settings.googleConnection(ownerA), null);
      await pool.query(
        `INSERT INTO provider_google_connections (provider_id, connected_by_niho_user_id, encrypted_refresh_token, granted_scopes, busy_calendar_id, booking_calendar_id)
         VALUES ('provider-a', 'owner-a2', $1, ARRAY['https://www.googleapis.com/auth/calendar.freebusy'], 'primary-sample', 'booking-sample')`,
        [`v1.${"a".repeat(40)}`],
      );
      await pool.query("INSERT INTO provider_google_calendars (provider_id, opaque_calendar_id, blocking_enabled, sync_status) VALUES ('provider-a', 'primary-sample', true, 'STALE')");
      assert.deepEqual(await settings.googleConnection(ownerA), { revoked: false, blockingEnabled: true, syncStatus: "STALE", lastSucceededAtUtc: null });

      const succeeded = new Date(Date.now() - 10 * 60_000).toISOString();
      await pool.query("UPDATE provider_google_calendars SET sync_status='FRESH', last_succeeded_at=$1, fresh_until=$2", [succeeded, new Date(Date.now() + 15 * 60_000).toISOString()]);
      assert.deepEqual(await settings.googleConnection(ownerA), { revoked: false, blockingEnabled: true, syncStatus: "FRESH", lastSucceededAtUtc: succeeded });

      // Reads failing without Google refusing the token: still connected.
      await pool.query("UPDATE provider_google_calendars SET sync_status='FAILED', fresh_until=NULL, blocking_enabled=false");
      assert.deepEqual(await settings.googleConnection(ownerA), { revoked: false, blockingEnabled: false, syncStatus: "FAILED", lastSucceededAtUtc: succeeded });

      // Google refused this connection's token: told once (the outbox row), revoked while reads fail.
      const generation = Number((await pool.query("SELECT connection_generation FROM provider_google_connections")).rows[0].connection_generation);
      const client = await pool.connect();
      try {
        await enqueueGoogleCalendarAttentionNotification(client, {
          providerId: "provider-a", input: "PROVIDER", inputId: "provider-a", reason: "REVOKED", connectionGeneration: generation, failingSinceUtc: new Date().toISOString(),
        });
      } finally {
        client.release();
      }
      assert.equal((await settings.googleConnection(ownerA))?.revoked, true);
      // The notice of an earlier connection says nothing about a new one.
      await pool.query("UPDATE provider_google_connections SET connection_generation=nextval('provider_google_connection_generation_seq')");
      assert.equal((await settings.googleConnection(ownerA))?.revoked, false);

      // Whoever connected it is no longer the OWNER: the connection is not read any more.
      await pool.query("UPDATE provider_memberships SET active=false WHERE niho_user_id='owner-a2'");
      assert.equal(await settings.googleConnection(ownerA), null);
      assert.equal(await settings.googleConnection(ownerB), null);
    });
  });
});
