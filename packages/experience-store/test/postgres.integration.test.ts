import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { occurrenceIdFor, type ScheduleRule } from "@niho-experience/experience-domain";
import { BookingUnavailableError, StoreAccessDeniedError, StoreConflictError, StoreNotFoundError } from "../src/errors.ts";
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
      for (const name of ["0004_host_push_subscriptions.sql", "0005_guide_cms.sql", "0006_calendar_commands_and_sales_state.sql", "0010_shared_inventory.sql", "0013_product_operators.sql"]) {
        await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      }
      await pool.query("INSERT INTO experience_providers (id) VALUES ($1)", ["provider-a"]);
      await pool.query("INSERT INTO experience_providers (id) VALUES ($1)", ["provider-b"]);
      await pool.query(
        "INSERT INTO provider_memberships (provider_id, niho_user_id, role) VALUES ($1,$2,'OWNER')",
        ["provider-a", "user-a"],
      );
      await pool.query("INSERT INTO provider_memberships (provider_id, niho_user_id, role) VALUES ($1,$2,'VIEWER')", ["provider-a", "user-viewer"]);
      await pool.query("INSERT INTO provider_memberships (provider_id, niho_user_id, role) VALUES ('provider-b','user-b','OWNER')");

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
      const ruleResults = await Promise.all([
        store.saveScheduleRule(actor, "tea", rule, null, "00000000-0000-4000-8000-000000000001"),
        store.saveScheduleRule(actor, "tea", rule, null, "00000000-0000-4000-8000-000000000001"),
      ]);
      assert.deepEqual(ruleResults.map((result) => result.repeated).sort(), [false, true]);
      await assert.rejects(
        () => store.saveScheduleRule(actor, "tea", { ...rule, capacity: 3 }, null, "00000000-0000-4000-8000-000000000001"),
        StoreConflictError,
      );
      assert.equal((await pool.query("SELECT 1 FROM schedule_rules WHERE provider_id='provider-a' AND id='tea-am'")).rowCount, 1);
      assert.equal((await pool.query("SELECT 1 FROM calendar_outbox_events WHERE provider_id='provider-a' AND command_id='00000000-0000-4000-8000-000000000001'")).rowCount, 1);
      await assert.rejects(
        () => store.saveScheduleRule({ providerId: "provider-a", nihoUserId: "user-viewer" }, "tea", { ...rule, id: "viewer-rule" }, null, "00000000-0000-4000-8000-000000000099"),
        StoreAccessDeniedError,
      );
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
      const freshnessDelivery = await pool.query<{ available_at: Date }>(
        "SELECT available_at FROM calendar_outbox_events WHERE payload->>'cause'='google_freshness_expired' ORDER BY id DESC LIMIT 1",
      );
      assert.ok(freshnessDelivery.rows[0]);
      assert.ok(freshnessDelivery.rows[0].available_at.getTime() > Date.now());
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
      await assert.rejects(
        () => store.setOccurrenceSalesState({ providerId: "provider-a", nihoUserId: "user-viewer" }, "tea", rule.id, { occurrenceId: nextOccurrenceId, desiredState: "CLOSED" }, null, "00000000-0000-4000-8000-000000000090"),
        StoreAccessDeniedError,
      );
      await assert.rejects(
        () => store.setOccurrenceSalesState({ providerId: "provider-a", nihoUserId: "user-b" }, "tea", rule.id, { occurrenceId: nextOccurrenceId, desiredState: "CLOSED" }, null, "00000000-0000-4000-8000-000000000091"),
        StoreAccessDeniedError,
      );
      await store.setOccurrenceSalesState(actor, "tea", rule.id, { occurrenceId: nextOccurrenceId, desiredState: "CLOSED" }, null, "00000000-0000-4000-8000-000000000006");
      await assert.rejects(
        () => store.createBookingHold(actor, { productId: "tea", occurrenceId: nextOccurrenceId, seats: 1, idempotencyKey: "closed-with-confirmed" }),
        (error: unknown) => error instanceof BookingUnavailableError && error.reason === "MANUALLY_CLOSED",
      );
      const bookedAfterClose = await pool.query<{ status: string; occurrence_snapshot: unknown }>(
        "SELECT status, occurrence_snapshot FROM bookings WHERE provider_id=$1 AND public_booking_id=$2::uuid",
        [actor.providerId, confirmed.booking.publicBookingId],
      );
      assert.equal(bookedAfterClose.rows[0]?.status, "CONFIRMED");
      assert.deepEqual(bookedAfterClose.rows[0]?.occurrence_snapshot, confirmed.booking.occurrenceSnapshot);
      const fourthOccurrenceId = occurrenceIdFor(rule.id, "2099-01-04");
      await assert.rejects(
        () => store.saveOccurrenceOverride(actor, "tea", rule.id, { kind: "RESCHEDULE", occurrenceId: occurrenceIdFor(rule.id, "2098-12-31"), localDate: "2099-01-05", localStartTime: "11:00" }, null, "00000000-0000-4000-8000-000000000098"),
        StoreNotFoundError,
      );
      const firstOverride = await store.saveOccurrenceOverride(actor, "tea", rule.id, { kind: "RESCHEDULE", occurrenceId: fourthOccurrenceId, localDate: "2099-01-05", localStartTime: "11:00" }, null, "00000000-0000-4000-8000-000000000002");
      const closed = await store.setOccurrenceSalesState(actor, "tea", rule.id, { occurrenceId: fourthOccurrenceId, desiredState: "CLOSED" }, null, "00000000-0000-4000-8000-000000000003");
      const reopened = await store.setOccurrenceSalesState(actor, "tea", rule.id, { occurrenceId: fourthOccurrenceId, desiredState: "OPEN" }, closed.version, "00000000-0000-4000-8000-000000000004");
      assert.equal(reopened.version, closed.version + 1);
      await assert.rejects(() => store.setOccurrenceSalesState(actor, "tea", rule.id, { occurrenceId: fourthOccurrenceId, desiredState: "CLOSED" }, closed.version, "00000000-0000-4000-8000-000000000005"), StoreConflictError);
      const views = await store.listSchedule(actor, "tea");
      assert.equal(views[0]?.overrides[0]?.override.kind, "RESCHEDULE");
      const reopenedState = views[0]?.salesStates.find((entry) => entry.state.occurrenceId === fourthOccurrenceId);
      assert.equal(reopenedState?.state.desiredState, "OPEN");
      assert.equal(reopenedState?.version, reopened.version);
      assert.equal(firstOverride.version, 1);

      const repeated = await store.setOccurrenceSalesState(actor, "tea", rule.id, { occurrenceId: fourthOccurrenceId, desiredState: "OPEN" }, closed.version, "00000000-0000-4000-8000-000000000004");
      assert.equal(repeated.repeated, true);
      const events = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM calendar_commands WHERE action<>'inventory.recalculate'");
      assert.equal(events.rows[0]?.count, "5");
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      await pool.end();
    }
  });

  it("migrates seeded legacy CLOSE rows without losing version history", async () => {
    const { Pool } = await import("pg");
    const schema = `experience_close_migration_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: databaseUrl, max: 1, options: `-c search_path=${schema}` });
    const quotedSchema = `"${schema}"`;
    try {
      await pool.query(`CREATE SCHEMA ${quotedSchema}`);
      for (const name of ["0001_experience_store.sql", "0002_google_oauth.sql", "0003_google_busy_coverage.sql", "0004_host_push_subscriptions.sql", "0005_guide_cms.sql"]) {
        await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      }
      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-legacy')");
      await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES ('provider-legacy','legacy-owner','OWNER')");
      await pool.query(`INSERT INTO experience_products
        (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
        VALUES ('provider-legacy','tea','tea','PUBLISHED','Synthetic tea','{}','JPY',1000,'terms','seller','acct_synthetic','Synthetic Seller')`);
      await pool.query(`INSERT INTO schedule_rules
        (provider_id,id,product_id,time_zone,starts_on,local_start_time,duration_minutes,capacity,booking_cutoff_minutes,busy_buffer_before_minutes,busy_buffer_after_minutes,recurrence)
        VALUES ('provider-legacy','tea-am','tea','Asia/Tokyo','2099-01-01','10:00',60,4,60,0,0,'{"kind":"DAILY"}')`);
      await pool.query(`INSERT INTO schedule_occurrence_overrides
        (provider_id,rule_id,occurrence_id,kind,version,created_at,updated_at)
        VALUES ('provider-legacy','tea-am','tea-am@2099-01-02','CLOSE',7,'2026-01-01T00:00:00Z','2026-01-02T00:00:00Z')`);

      await pool.query(await readFile(new URL("../migrations/0006_calendar_commands_and_sales_state.sql", import.meta.url), "utf8"));
      const migrated = await pool.query<{ desired_state: string; version: string; created_at: Date; updated_at: Date }>(
        "SELECT desired_state, version::text, created_at, updated_at FROM schedule_occurrence_sales_states WHERE provider_id='provider-legacy' AND occurrence_id='tea-am@2099-01-02'",
      );
      assert.equal(migrated.rows[0]?.desired_state, "CLOSED");
      assert.equal(migrated.rows[0]?.version, "7");
      assert.equal(migrated.rows[0]?.created_at.toISOString(), "2026-01-01T00:00:00.000Z");
      assert.equal(migrated.rows[0]?.updated_at.toISOString(), "2026-01-02T00:00:00.000Z");
      assert.equal((await pool.query("SELECT 1 FROM schedule_occurrence_overrides WHERE kind='CLOSE'")).rowCount, 0);
      const [view] = await new ExperienceStore(pool).listSchedule({ providerId: "provider-legacy", nihoUserId: "legacy-owner" }, "tea");
      assert.equal(view?.overrides.length, 0);
      assert.equal(view?.salesStates[0]?.state.desiredState, "CLOSED");
      assert.equal(view?.salesStates[0]?.version, 7);
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
      for (const name of ["0001_experience_store.sql", "0002_google_oauth.sql", "0003_google_busy_coverage.sql", "0004_host_push_subscriptions.sql", "0005_guide_cms.sql", "0006_calendar_commands_and_sales_state.sql"]) {
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
