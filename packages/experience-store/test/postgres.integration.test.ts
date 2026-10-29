import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { occurrenceIdFor, type ScheduleRule } from "@niho-experience/experience-domain";
import { BookingUnavailableError, StoreConflictError } from "../src/errors.ts";
import { HostPushSubscriptions } from "../src/push-subscriptions.ts";
import { ExperienceStore } from "../src/repository.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe("PostgreSQL booking transaction", { skip: databaseUrl === undefined }, () => {
  it("serializes concurrent holds and never exceeds occurrence capacity", async () => {
    const { Pool } = await import("pg");
    const schema = `experience_store_test_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
    const quotedSchema = `"${schema}"`;
    try {
      await pool.query(`CREATE SCHEMA ${quotedSchema}`);
      const migration = await readFile(new URL("../migrations/0001_experience_store.sql", import.meta.url), "utf8");
      await pool.query(migration);
      const oauthMigration = await readFile(new URL("../migrations/0002_google_oauth.sql", import.meta.url), "utf8");
      await pool.query(oauthMigration);
      const coverageMigration = await readFile(new URL("../migrations/0003_google_busy_coverage.sql", import.meta.url), "utf8");
      await pool.query(coverageMigration);
      const pushMigration = await readFile(new URL("../migrations/0004_host_push_subscriptions.sql", import.meta.url), "utf8");
      await pool.query(pushMigration);
      await pool.query("INSERT INTO experience_providers (id) VALUES ($1)", ["provider-a"]);
      await pool.query(
        "INSERT INTO provider_memberships (provider_id, niho_user_id, role) VALUES ($1,$2,'OWNER')",
        ["provider-a", "user-a"],
      );

      const store = new ExperienceStore(pool);
      const actor = { providerId: "provider-a", nihoUserId: "user-a" } as const;
      await store.createProduct(actor, {
        id: "tea",
        slug: "tea",
        status: "PUBLISHED",
        publicTitle: "Synthetic tea",
        content: {},
        currency: "JPY",
        unitAmount: 1000,
        cancellationTermsRef: "terms-v1",
        sellerNihoAccountRef: "niho-user-synthetic",
        stripeConnectAccountRef: "acct_synthetic",
        sellerDisplayName: "Synthetic Seller",
      });
      const rule: ScheduleRule = {
        id: "tea-am",
        timeZone: "Asia/Tokyo",
        startsOn: "2099-01-01",
        localStartTime: "10:00",
        durationMinutes: 60,
        capacity: 2,
        bookingCutoffMinutes: 60,
        busyBufferBeforeMinutes: 0,
        busyBufferAfterMinutes: 0,
        recurrence: { kind: "DAILY" },
      };
      await store.saveScheduleRule(actor, "tea", rule, null);
      const occurrenceId = occurrenceIdFor(rule.id, "2099-01-01");
      const attempts = await Promise.allSettled([
        store.createBookingHold(actor, { productId: "tea", occurrenceId, seats: 2, idempotencyKey: "hold-a" }),
        store.createBookingHold(actor, { productId: "tea", occurrenceId, seats: 2, idempotencyKey: "hold-b" }),
      ]);
      assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
      const rejection = attempts.find((item): item is PromiseRejectedResult => item.status === "rejected");
      assert.ok(rejection?.reason instanceof BookingUnavailableError);
      const seatCount = await pool.query<{ seats: string }>(
        "SELECT sum(seats)::text AS seats FROM bookings WHERE provider_id=$1 AND status='HOLD'",
        ["provider-a"],
      );
      assert.equal(seatCount.rows[0]?.seats, "2");

      const nextOccurrenceId = occurrenceIdFor(rule.id, "2099-01-02");
      await store.configureGoogleCalendar(actor, { opaqueCalendarId: "synthetic-calendar", blockingEnabled: true }, null);
      await assert.rejects(
        () => store.createBookingHold(actor, { productId: "tea", occurrenceId: nextOccurrenceId, seats: 1, idempotencyKey: "stale-busy" }),
        (error: unknown) => error instanceof BookingUnavailableError && error.reason === "GOOGLE_SYNC_UNAVAILABLE",
      );
      const attemptedAtUtc = new Date(Date.now() - 1_000).toISOString();
      await store.recordGoogleBusySync({ providerId: actor.providerId }, {
        opaqueCalendarId: "synthetic-calendar", attemptedAtUtc,
        freshUntilUtc: new Date(Date.now() + 120_000).toISOString(),
        coverageStartUtc: "2099-01-01T00:00:00.000Z", coverageEndUtc: "2099-01-03T00:00:00.000Z",
        busyIntervals: [{ startUtc: "2099-01-02T01:00:00.000Z", endUtc: "2099-01-02T02:00:00.000Z" }],
      });
      await assert.rejects(
        () => store.createBookingHold(actor, { productId: "tea", occurrenceId: nextOccurrenceId, seats: 1, idempotencyKey: "overlap-busy" }),
        (error: unknown) => error instanceof BookingUnavailableError && error.reason === "GOOGLE_BUSY",
      );
      await store.recordGoogleBusySync({ providerId: actor.providerId }, {
        opaqueCalendarId: "synthetic-calendar", attemptedAtUtc: new Date().toISOString(),
        freshUntilUtc: new Date(Date.now() + 120_000).toISOString(),
        coverageStartUtc: "2099-01-01T00:00:00.000Z", coverageEndUtc: "2099-01-03T00:00:00.000Z", busyIntervals: [],
      });
      await assert.rejects(
        () => store.createBookingHold(actor, { productId: "tea", occurrenceId: occurrenceIdFor(rule.id, "2099-01-03"), seats: 1, idempotencyKey: "outside-coverage" }),
        (error: unknown) => error instanceof BookingUnavailableError && error.reason === "GOOGLE_SYNC_UNAVAILABLE",
      );
      const unblocked = await store.createBookingHold(actor, { productId: "tea", occurrenceId: nextOccurrenceId, seats: 1, idempotencyKey: "open-again" });
      assert.equal(unblocked.status, "HOLD");
      const payment = {
        publicBookingId: unblocked.publicBookingId, connectedAccountId: "acct_synthetic",
        stripePaymentRef: "pi_synthetic", stripeEventId: "evt_synthetic", stripeEventType: "checkout.session.completed",
        eventOccurredAtUtc: new Date().toISOString(), amount: 1000, currency: "JPY",
      };
      await assert.rejects(
        () => store.confirmBookingPayment({ providerId: actor.providerId }, { ...payment, connectedAccountId: "acct_other" }),
        StoreConflictError,
      );
      const confirmed = await store.confirmBookingPayment({ providerId: actor.providerId }, payment);
      assert.equal(confirmed.booking.status, "CONFIRMED");
      assert.equal((await store.confirmBookingPayment({ providerId: actor.providerId }, payment)).duplicateEvent, true);
      const fourthOccurrenceId = occurrenceIdFor(rule.id, "2099-01-04");
      const firstOverride = await store.saveOccurrenceOverride(actor, "tea", rule.id, { kind: "RESCHEDULE", occurrenceId: fourthOccurrenceId, localDate: "2099-01-05", localStartTime: "11:00" }, null);
      const secondOverride = await store.saveOccurrenceOverride(actor, "tea", rule.id, { kind: "CLOSE", occurrenceId: fourthOccurrenceId }, firstOverride.version);
      assert.equal(secondOverride.version, firstOverride.version + 1);
      await assert.rejects(() => store.saveOccurrenceOverride(actor, "tea", rule.id, { kind: "CLOSE", occurrenceId: fourthOccurrenceId }, firstOverride.version), StoreConflictError);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      await pool.end();
    }
  });

  it("keeps host push subscriptions per endpoint and per connection (#177)", async () => {
    const { Pool } = await import("pg");
    const schema = `experience_push_test_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${schema}` });
    const quotedSchema = `"${schema}"`;
    try {
      await pool.query(`CREATE SCHEMA ${quotedSchema}`);
      for (const name of ["0001_experience_store.sql", "0002_google_oauth.sql", "0003_google_busy_coverage.sql", "0004_host_push_subscriptions.sql"]) {
        await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      }
      await pool.query("INSERT INTO experience_providers (id) VALUES ($1)", ["provider-a"]);
      await pool.query("INSERT INTO provider_memberships (provider_id, niho_user_id, role) VALUES ($1,'user-a','OWNER'), ($1,'user-b','EDITOR')", ["provider-a"]);
      const store = new HostPushSubscriptions(pool);
      const keys = { p256dh: `B${"A".repeat(86)}`, auth: "A".repeat(22) };
      const phone = "https://web.push.apple.com/synthetic-phone";
      await store.save({ nihoUserId: "user-a", connectionId: "conn-a", endpoint: phone, ...keys, deviceLabel: "iphone" });
      await store.save({ nihoUserId: "user-b", connectionId: "conn-b", endpoint: "https://fcm.googleapis.com/fcm/send/synthetic", ...keys, deviceLabel: "android" });
      assert.equal(await store.has("user-a", phone), true);
      assert.equal(await store.has("user-b", phone), false);
      // A later sign-in on the same device takes the row over; another user's endpoint stays theirs.
      assert.equal(await store.claim("user-a", phone, "conn-a2"), true);
      assert.equal(await store.claim("user-b", phone, "conn-b"), false);
      assert.equal(await store.removeConnection("conn-a"), 0);
      assert.equal(await store.claim("user-a", phone, "conn-a"), true);

      const recent = new Date(Date.now() - 60_000);
      const [first] = await store.recipients("provider-a", recent);
      assert.ok(first);
      await store.recordFailure(first.id);
      await store.recordFailure(first.id);
      // The same device subscribed again by another user: it is theirs now, failures forgotten.
      await store.save({ nihoUserId: "user-b", connectionId: "conn-b", endpoint: phone, ...keys, deviceLabel: "iphone" });
      assert.equal(await store.has("user-a", phone), false);
      const rows = await pool.query<{ failure_count: number; niho_user_id: string }>("SELECT failure_count, niho_user_id FROM host_push_subscriptions WHERE endpoint=$1", [phone]);
      assert.deepEqual(rows.rows[0], { failure_count: 0, niho_user_id: "user-b" });

      assert.equal((await store.recipients("provider-a", recent)).length, 2);
      assert.equal((await store.recipients("provider-a", new Date(Date.now() + 60_000))).length, 0);
      await store.touchConnection("conn-b");
      await pool.query("UPDATE provider_memberships SET active=false WHERE niho_user_id='user-b'");
      assert.equal((await store.recipients("provider-a", recent)).length, 0);

      assert.equal(await store.remove("user-a", phone), false);
      assert.equal(await store.removeConnection("conn-b"), 2);
      assert.equal((await pool.query("SELECT 1 FROM host_push_subscriptions")).rowCount, 0);
      await assert.rejects(() => store.save({ nihoUserId: "user-a", connectionId: "conn-a", endpoint: "http://web.push.apple.com/x", ...keys, deviceLabel: "iphone" }));
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      await pool.end();
    }
  });
});
