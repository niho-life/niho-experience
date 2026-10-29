import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { it } from "node:test";
import { addLocalDays, type ScheduleRule } from "@niho-experience/experience-domain";
import type { Pool } from "pg";
import { ChannelRuntime } from "../src/channels.ts";
import { ExperienceStore } from "../src/repository.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

it("serializes an OPEN result with a concurrent group hold before accepting its observation", { skip: !databaseUrl, timeout: 15_000 }, async () => {
  const { Pool: PgPool } = await import("pg");
  const schema = `inventory_result_race_${randomUUID().replaceAll("-", "")}`;
  const pool = new PgPool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema}` });
  let resumeRead!: () => void;
  let readReached!: () => void;
  const paused = new Promise<void>((resolve) => { readReached = resolve; });
  const resume = new Promise<void>((resolve) => { resumeRead = resolve; });
  let resultPending: Promise<unknown> | undefined;
  let holdPending: Promise<unknown> | undefined;
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    for (const name of (await readdir(new URL("../migrations/", import.meta.url))).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort()) {
      await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    }
    await pool.query("INSERT INTO experience_providers(id) VALUES ('provider')");
    await pool.query("INSERT INTO provider_memberships(provider_id,niho_user_id,role) VALUES ('provider','owner','OWNER')");
    const actor = { providerId: "provider", nihoUserId: "owner" };
    const admin = { nihoUserId: "synthetic-admin" };
    const store = new ExperienceStore(pool);
    await store.createProduct(actor, { id: "group", slug: "synthetic-group", status: "PUBLISHED", publicTitle: "Synthetic group",
      content: {}, currency: "JPY", unitAmount: 1000, cancellationTermsRef: "terms", sellerNihoAccountRef: "synthetic",
      stripeConnectAccountRef: "acct_synthetic", sellerDisplayName: "Synthetic seller" });
    const date = addLocalDays(new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date()), 1);
    const rule: ScheduleRule = { id: "once", timeZone: "Asia/Tokyo", startsOn: date, endsOn: date, localStartTime: "18:00",
      durationMinutes: 60, capacity: 8, bookingCutoffMinutes: 0, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "DAILY" } };
    await store.saveScheduleRule(actor, "group", rule, null, randomUUID());
    await store.saveProductInventorySetting(actor, "group", { bookingMode: "PRIVATE_GROUP", resources: [] }, null, randomUUID());
    const supportedAdapters = { "Synthetic/browser-v1@1": { canObserve: true, canClose: true, canOpen: true } };
    const runtime = new ChannelRuntime(pool, { supportedAdapters });
    const expires = new Date(Date.now() + 86_400_000).toISOString();
    await runtime.createExternalAccount(admin, { id: "account", providerId: "provider", site: "Synthetic", externalAccountId: "synthetic",
      displayName: "Synthetic", operatingModel: 2, active: true, delegatedUntilUtc: expires }, randomUUID());
    await runtime.createListing(admin, { id: "listing", providerId: "provider", accountId: "account", productId: "group",
      externalProductId: "synthetic-group", adapter: "browser-v1", adapterVersion: "1", connectionMode: "BROWSER",
      capabilities: { canObserve: true, canClose: true, canOpen: true }, active: true }, randomUUID());
    const credential = await runtime.mintWorkerCredential(admin, "worker", "Synthetic", expires, null, randomUUID());
    await runtime.assignWorkerAccount(admin, "worker", "account", null, randomUUID());
    const worker = await runtime.authenticateWorker(credential.bearerToken);
    await runtime.consumeCalendarOutbox(50, worker);
    const job = await runtime.claim(worker);
    assert.ok(job?.action === "SET_OPEN");

    // Execute every SQL statement on PostgreSQL. Pause just after the actual
    // availability read so a racing HOLD gets a chance to request inventory.
    let armed = true;
    const gatedPool = new Proxy(pool, { get(target, key) {
      if (key === "connect") return async () => {
        const client = await target.connect();
        return new Proxy(client, { get(connection, field) {
          if (field === "query") return async (...args: unknown[]) => {
            const result = await Reflect.apply(connection.query, connection, args);
            if (armed && typeof args[0] === "string" && args[0].includes("count(*) FILTER") && args[0].includes("FROM active_reservations GROUP BY")) {
              armed = false; readReached(); await resume;
            }
            return result;
          };
          const value = Reflect.get(connection, field);
          return typeof value === "function" ? value.bind(connection) : value;
        } });
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } }) as Pool;
    const resultId = randomUUID();
    resultPending = new ChannelRuntime(gatedPool, { supportedAdapters }).submitResult(worker, job.id, {
      resultId, leaseToken: job.leaseToken, outcome: "VERIFIED", stopped: true, target: job.target,
      occurrenceId: job.occurrenceId, sourceStartAtUtc: job.sourceStartAtUtc, sourceEndAtUtc: job.sourceEndAtUtc,
      observedState: "OPEN", observedBookable: true, observedManuallyBlocked: false, observedAtUtc: new Date().toISOString(),
    });
    await paused;
    let holdPid: number | undefined;
    let holdSettled = false;
    const holdPool = new Proxy(pool, { get(target, key) {
      if (key === "connect") return async () => {
        const client = await target.connect();
        holdPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
        return client;
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } }) as Pool;
    holdPending = new ExperienceStore(holdPool).createBookingHold(actor, {
      productId: "group", occurrenceId: job.occurrenceId, seats: 2, idempotencyKey: "concurrent-group",
    }).finally(() => { holdSettled = true; });
    let blocked = false;
    const until = Date.now() + 3_000;
    while (!holdSettled && Date.now() < until) {
      if (holdPid) {
        const waiting = await pool.query<{ wait_event_type: string | null }>(
          "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [holdPid],
        );
        if (waiting.rows[0]?.wait_event_type === "Lock") { blocked = true; break; }
      } else await new Promise<void>((resolve) => setImmediate(resolve));
    }
    resumeRead();
    const [result] = await Promise.all([resultPending, holdPending]);
    assert.equal(blocked, true, "The HOLD must wait for the in-flight result transaction");
    assert.deepEqual(result, { acceptedAsCurrent: true, repeated: false });
    const ordering = await pool.query<{ result_before_hold: boolean }>(
      `SELECT r.created_at<=b.created_at AS result_before_hold FROM channel_job_results r
       CROSS JOIN bookings b WHERE r.result_id=$1::uuid AND b.idempotency_key='concurrent-group'`, [resultId],
    );
    assert.equal(ordering.rows[0]?.result_before_hold, true);
    await runtime.consumeCalendarOutbox(50, worker);
    const desired = await pool.query("SELECT desired_state,reason FROM channel_desired_states WHERE listing_id='listing'");
    assert.equal(desired.rows[0]?.desired_state, "CLOSED");
    assert.equal(desired.rows[0]?.reason, "GROUP_RESERVED");
  } finally {
    resumeRead();
    await Promise.allSettled([resultPending, holdPending]);
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
});
