import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { ChannelRuntime, type ClaimedChannelJob, type WorkerIdentity } from "../src/channels.ts";
import { StoreConflictError, StoreValidationError } from "../src/errors.ts";
import { ExperienceStore } from "../src/repository.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const WARNING = "旧日時の掲載枠を停止できていません。掲載先で確認してください。";
const now = new Date("2099-01-01T00:00:00.000Z");
// Only the started-slot case moves the runtime clock; every other case uses `now`.
let clock = now;
const admin = { nihoUserId: "synthetic-admin" };
const actor = { providerId: "provider", nihoUserId: "owner" };

type ListingKind = "BROWSER" | "GOOGLE" | "NO_CLOSE";
interface Context {
  readonly pool: Pool;
  readonly runtime: ChannelRuntime;
  readonly store: ExperienceStore;
  readonly worker: WorkerIdentity;
}

/** Tokyo local time to UTC ISO (Asia/Tokyo has no DST). */
const utc = (date: string, time: string) => new Date(`${date}T${time}:00.000+09:00`).toISOString();
const hourAfter = (iso: string) => new Date(Date.parse(iso) + 3_600_000).toISOString();

async function withRuntime(prefix: string, listings: Readonly<Record<string, ListingKind>>, body: (context: Context) => Promise<void>): Promise<void> {
  const { Pool } = await import("pg");
  const schema = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
  let created = false;
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    const names = (await readdir(new URL("../migrations/", import.meta.url))).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort();
    for (const name of names) await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    await pool.query("INSERT INTO experience_providers (id) VALUES ('provider')");
    await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES ('provider','owner','OWNER')");
    await pool.query(`INSERT INTO experience_products
      (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
      VALUES ('provider','tea','synthetic-tea','PUBLISHED','Synthetic tea','{}','JPY',1000,'terms','seller','acct_synthetic','Synthetic')`);
    const store = new ExperienceStore(pool);
    await store.saveScheduleRule(actor, "tea", {
      id: "morning", timeZone: "Asia/Tokyo", startsOn: "2099-01-01", localStartTime: "10:00", durationMinutes: 60,
      capacity: 1, bookingCutoffMinutes: 30, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "DAILY" },
    }, null, randomUUID());
    const runtime = new ChannelRuntime(pool, {
      now: () => clock,
      supportedAdapters: { "GetYourGuide/gyg-browser@1": { canObserve: true, canClose: true, canOpen: true } },
    });
    await runtime.createExternalAccount(admin, { id: "account", providerId: "provider", site: "GetYourGuide",
      externalAccountId: "synthetic-account", displayName: "Synthetic account", operatingModel: 4, active: true }, randomUUID());
    for (const [id, kind] of Object.entries(listings)) {
      await runtime.createListing(admin, { id, providerId: "provider", accountId: "account", productId: "tea",
        externalProductId: `synthetic-${id}`, adapter: "gyg-browser", adapterVersion: "1", connectionMode: "BROWSER",
        capabilities: kind === "NO_CLOSE" ? { canObserve: true, canOpen: true } : { canObserve: true, canClose: true, canOpen: true },
        active: true }, randomUUID());
      if (kind === "GOOGLE") await pool.query("UPDATE channel_listings SET connection_mode='GOOGLE' WHERE id=$1", [id]);
    }
    const credential = await runtime.mintWorkerCredential(admin, "studio", "Synthetic Studio", "2099-02-01T00:00:00.000Z", null, randomUUID());
    await runtime.assignWorkerAccount(admin, "studio", "account", null, randomUUID());
    const worker = await runtime.authenticateWorker(credential.bearerToken);
    await runtime.consumeCalendarOutbox();
    // Every listed slot starts synchronized: OPEN, verified at the current versions.
    await pool.query("UPDATE channel_jobs SET status='FINISHED',outcome='VERIFIED' WHERE status='QUEUED'");
    await pool.query(`UPDATE channel_desired_states SET observed_state=desired_state,observed_desired_version=desired_version,
      observed_mapping_version=mapping_version,last_verified_at=$1`, [now.toISOString()]);
    await body({ pool, runtime, store, worker });
  } finally {
    if (created) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
}

async function reschedule(context: Context, occurrenceId: string, localDate: string, localStartTime: string, expectedVersion: number | null): Promise<void> {
  await context.store.saveOccurrenceOverride(actor, "tea", "morning", { kind: "RESCHEDULE", occurrenceId, localDate, localStartTime },
    expectedVersion, randomUUID());
  await context.runtime.consumeCalendarOutbox();
}

async function retirements(pool: Pool, occurrenceId: string, listingId = "listing") {
  const result = await pool.query(
    `SELECT id,status,reason,retirement_version::int AS version,source_start_at,source_end_at FROM channel_slot_retirements
      WHERE listing_id=$1 AND occurrence_id=$2 ORDER BY source_start_at`, [listingId, occurrenceId],
  );
  return result.rows.map((row) => ({ id: String(row.id), status: String(row.status), reason: row.reason as string | null, version: Number(row.version),
    start: (row.source_start_at as Date).toISOString(), end: (row.source_end_at as Date).toISOString() }));
}

async function jobs(pool: Pool, occurrenceId: string, listingId = "listing") {
  const result = await pool.query(
    `SELECT id,purpose,action,status,outcome,slot_retirement_id,desired_version::int AS desired_version,priority,source_start_at
       FROM channel_jobs WHERE listing_id=$1 AND occurrence_id=$2 ORDER BY created_at,id`, [listingId, occurrenceId],
  );
  return result.rows.map((row) => ({ id: String(row.id), purpose: String(row.purpose), action: String(row.action), status: String(row.status),
    outcome: row.outcome as string | null, retirementId: row.slot_retirement_id as string | null, desiredVersion: Number(row.desired_version),
    priority: Number(row.priority), start: (row.source_start_at as Date).toISOString() }));
}

async function desired(pool: Pool, occurrenceId: string, listingId = "listing") {
  const result = await pool.query(
    `SELECT source_start_at,observed_state,observed_desired_version::int AS observed_desired_version,
            observed_mapping_version::int AS observed_mapping_version,last_verified_at,last_error
       FROM channel_desired_states WHERE listing_id=$1 AND occurrence_id=$2`, [listingId, occurrenceId],
  );
  const row = result.rows[0]!;
  return {
    start: (row.source_start_at as Date).toISOString(), observedState: row.observed_state as string | null,
    observedDesiredVersion: row.observed_desired_version as number | null, observedMappingVersion: row.observed_mapping_version as number | null,
    lastVerifiedAt: row.last_verified_at === null ? null : (row.last_verified_at as Date).toISOString(), lastError: row.last_error as string | null,
  };
}

function closedReadback(job: ClaimedChannelJob, overrides: Record<string, unknown> = {}) {
  return {
    resultId: randomUUID(), leaseToken: job.leaseToken, outcome: "VERIFIED" as const, stopped: true, target: job.target,
    occurrenceId: job.occurrenceId, sourceStartAtUtc: job.sourceStartAtUtc, sourceEndAtUtc: job.sourceEndAtUtc,
    observedState: "CLOSED" as const, observedBookable: false, observedManuallyBlocked: true, observedAtUtc: now.toISOString(),
    ...overrides,
  };
}

async function recover(context: Context): Promise<void> {
  const recovery = await context.runtime.recoverQuarantinedLease(admin, "account", true, randomUUID());
  const observe = await context.runtime.claim(context.worker);
  assert.equal(observe?.id, recovery.observeJobId);
  assert.ok(observe);
  assert.equal((await context.runtime.submitResult(context.worker, observe.id, {
    resultId: randomUUID(), leaseToken: observe.leaseToken, outcome: "VERIFIED", stopped: true, target: observe.target,
    occurrenceId: observe.occurrenceId, sourceStartAtUtc: observe.sourceStartAtUtc, sourceEndAtUtc: observe.sourceEndAtUtc,
    observedState: "OPEN", observedBookable: true, observedManuallyBlocked: false, observedAtUtc: now.toISOString(),
  })).acceptedAsCurrent, true);
}

describe("PostgreSQL slot retirement after a reschedule", { skip: databaseUrl === undefined }, () => {
  it("closes the old external slot, reads it back, and leaves the new-time desired observation alone", async () => {
    await withRuntime("slot_retire_main", { listing: "BROWSER" }, async (context) => {
      const { pool, runtime, worker } = context;
      const occurrenceId = "morning@2099-01-03";
      const oldStart = utc("2099-01-03", "10:00");
      const newStart = utc("2099-01-03", "15:00");
      await reschedule(context, occurrenceId, "2099-01-03", "15:00", null);
      const [retirement, ...extraRetirements] = await retirements(pool, occurrenceId);
      assert.equal(extraRetirements.length, 0);
      assert.deepEqual(retirement, { id: retirement!.id, status: "PENDING", reason: null, version: 1, start: oldStart, end: hourAfter(oldStart) });
      const queued = (await jobs(pool, occurrenceId)).filter((job) => job.status === "QUEUED")
        .map(({ purpose, action, retirementId, desiredVersion, priority, start }) => ({ purpose, action, retirementId, desiredVersion, priority, start }))
        .sort((left, right) => left.purpose.localeCompare(right.purpose));
      assert.deepEqual(queued, [
        { purpose: "AVAILABILITY", action: "SET_OPEN", retirementId: null, desiredVersion: 2, priority: 50, start: newStart },
        { purpose: "SLOT_RETIREMENT", action: "SET_CLOSED", retirementId: retirement!.id, desiredVersion: 1, priority: 100, start: oldStart },
      ]);
      const before = await desired(pool, occurrenceId);
      assert.equal(before.start, newStart);
      assert.equal(before.lastError, null);

      const claimed = await runtime.claim(worker);
      assert.ok(claimed);
      assert.equal(claimed.action, "SET_CLOSED");
      assert.equal(claimed.occurrenceId, occurrenceId);
      assert.equal(claimed.sourceStartAtUtc, oldStart);
      assert.equal(claimed.sourceEndAtUtc, hourAfter(oldStart));
      assert.equal(claimed.desiredVersion, 1);
      assert.equal("purpose" in claimed, false);
      assert.deepEqual(await runtime.preflight(worker, claimed.id, claimed.leaseToken), { ready: true, desiredState: "CLOSED" });
      // A leftover warning text is cleared by a verified close; another error text is never touched.
      await pool.query("UPDATE channel_desired_states SET last_error=$2 WHERE occurrence_id=$1", [occurrenceId, WARNING]);
      assert.deepEqual(await runtime.submitResult(worker, claimed.id, closedReadback(claimed)), { acceptedAsCurrent: true, repeated: false });
      assert.equal((await retirements(pool, occurrenceId))[0]?.status, "CLOSED_VERIFIED");
      assert.equal((await jobs(pool, occurrenceId)).find((job) => job.id === claimed.id)?.outcome, "VERIFIED");
      assert.deepEqual(await desired(pool, occurrenceId), before);

      // The new time keeps the ordinary SET_OPEN path.
      const reopen = await runtime.claim(worker);
      assert.equal(reopen?.action, "SET_OPEN");
      assert.equal(reopen?.sourceStartAtUtc, newStart);
    });
  });

  it("creates a retirement only when the old time was not verified CLOSED, never for GOOGLE, and flags unsupported closes", async () => {
    await withRuntime("slot_retire_create", { listing: "BROWSER", "listing-google": "GOOGLE", "listing-no-close": "NO_CLOSE" }, async (context) => {
      const { pool, runtime } = context;
      const [verifiedClosed, unverified, staleObservation, moved] = ["morning@2099-01-05", "morning@2099-01-06", "morning@2099-01-07", "morning@2099-01-08"];
      await pool.query("UPDATE channel_desired_states SET observed_state='CLOSED' WHERE listing_id='listing' AND occurrence_id=$1", [verifiedClosed]);
      await pool.query(`UPDATE channel_desired_states SET observed_state=NULL,observed_desired_version=NULL,observed_mapping_version=NULL,
        last_verified_at=NULL WHERE listing_id='listing' AND occurrence_id=$1`, [unverified]);
      await pool.query(`UPDATE channel_desired_states SET observed_state='CLOSED',desired_version=desired_version+1
        WHERE listing_id='listing' AND occurrence_id=$1`, [staleObservation]);
      for (const occurrenceId of [verifiedClosed, unverified, staleObservation, moved]) {
        const date = occurrenceId.slice(occurrenceId.indexOf("@") + 1);
        await reschedule(context, occurrenceId, date, "16:00", null);
      }
      assert.deepEqual(await retirements(pool, verifiedClosed), []);
      assert.equal((await jobs(pool, verifiedClosed)).some((job) => job.purpose === "SLOT_RETIREMENT"), false);
      for (const occurrenceId of [unverified, staleObservation, moved]) {
        const date = occurrenceId.slice(occurrenceId.indexOf("@") + 1);
        const [retirement] = await retirements(pool, occurrenceId);
        assert.equal(retirement?.status, "PENDING");
        assert.equal(retirement?.start, utc(date, "10:00"));
        assert.equal((await jobs(pool, occurrenceId)).filter((job) => job.purpose === "SLOT_RETIREMENT" && job.status === "QUEUED").length, 1);
      }

      assert.deepEqual(await retirements(pool, moved, "listing-google"), []);
      assert.equal((await jobs(pool, moved, "listing-google")).some((job) => job.purpose === "SLOT_RETIREMENT"), false);
      assert.equal((await desired(pool, moved, "listing-google")).lastError, null);

      const [unsupported] = await retirements(pool, moved, "listing-no-close");
      assert.equal(unsupported?.status, "NEEDS_REVIEW");
      assert.equal(unsupported?.reason, "CLOSE_UNSUPPORTED");
      assert.equal((await jobs(pool, moved, "listing-no-close")).some((job) => job.purpose === "SLOT_RETIREMENT"), false);
      // The new-time SET_OPEN job was enqueued after the warning and did not clear it.
      assert.equal((await jobs(pool, moved, "listing-no-close")).filter((job) => job.purpose === "AVAILABILITY" && job.status === "QUEUED").length, 1);
      assert.equal((await desired(pool, moved, "listing-no-close")).lastError, WARNING);
      const statuses = (await runtime.hostStatuses(actor)).filter((status) => status.occurrenceId === moved);
      assert.deepEqual(statuses.map((status) => status.error), [undefined, undefined, "RUNTIME_ERROR"]);
    });
  });

  it("does not retire an old time that has already started", async () => {
    await withRuntime("slot_retire_started", { listing: "BROWSER" }, async (context) => {
      const occurrenceId = "morning@2099-01-01";
      clock = new Date(Date.parse(utc("2099-01-01", "10:00")) + 60_000);
      try {
        await reschedule(context, occurrenceId, "2099-01-01", "15:00", null);
      } finally {
        clock = now;
      }
      assert.deepEqual(await retirements(context.pool, occurrenceId), []);
      assert.equal((await jobs(context.pool, occurrenceId)).some((job) => job.purpose === "SLOT_RETIREMENT"), false);
      assert.equal((await desired(context.pool, occurrenceId)).start, utc("2099-01-01", "15:00"));
    });
  });

  it("supersedes a retirement when the time returns (A->B->A) and keeps both old times for A->B->C", async () => {
    await withRuntime("slot_retire_moves", { listing: "BROWSER" }, async (context) => {
      const { pool } = context;
      const restored = "morning@2099-01-09";
      const a = utc("2099-01-09", "10:00");
      const b = utc("2099-01-09", "15:00");
      await reschedule(context, restored, "2099-01-09", "15:00", null);
      const [firstA] = await retirements(pool, restored);
      const firstJob = (await jobs(pool, restored)).find((job) => job.purpose === "SLOT_RETIREMENT")!;
      assert.equal(firstJob.status, "QUEUED");
      await reschedule(context, restored, "2099-01-09", "10:00", 1);
      const afterRestore = await retirements(pool, restored);
      assert.deepEqual(afterRestore.map(({ status, reason, start, version }) => ({ status, reason, start, version })), [
        { status: "SUPERSEDED", reason: "TIME_RESTORED", start: a, version: 1 },
        { status: "PENDING", reason: null, start: b, version: 1 },
      ]);
      assert.equal(afterRestore[0]!.id, firstA!.id);
      const restoredJobs = await jobs(pool, restored);
      assert.deepEqual(restoredJobs.find((job) => job.id === firstJob.id)?.outcome, "SUPERSEDED");
      assert.equal(restoredJobs.find((job) => job.id === firstJob.id)?.status, "FINISHED");
      const bJobs = restoredJobs.filter((job) => job.retirementId === afterRestore[1]!.id);
      assert.deepEqual(bJobs.map((job) => [job.status, job.start]), [["QUEUED", b]]);
      assert.equal((await desired(pool, restored)).start, a);

      const chained = "morning@2099-01-10";
      await reschedule(context, chained, "2099-01-10", "15:00", null);
      await reschedule(context, chained, "2099-01-11", "18:00", 1);
      const both = await retirements(pool, chained);
      assert.deepEqual(both.map(({ status, start }) => ({ status, start })), [
        { status: "PENDING", start: utc("2099-01-10", "10:00") },
        { status: "PENDING", start: utc("2099-01-10", "15:00") },
      ]);
      const chainedJobs = (await jobs(pool, chained)).filter((job) => job.purpose === "SLOT_RETIREMENT");
      assert.deepEqual(chainedJobs.map((job) => [job.status, job.start]), [
        ["QUEUED", utc("2099-01-10", "10:00")], ["QUEUED", utc("2099-01-10", "15:00")],
      ]);
      assert.equal((await desired(pool, chained)).start, utc("2099-01-11", "18:00"));
    });
  });

  it("marks failed or unverifiable closes for review with a visible warning that only clears when nothing needs review", async () => {
    await withRuntime("slot_retire_results", { listing: "BROWSER" }, async (context) => {
      const { pool, runtime, worker } = context;
      const occurrenceId = "morning@2099-01-12";
      const a = utc("2099-01-12", "10:00");
      const b = utc("2099-01-12", "15:00");
      const c = utc("2099-01-12", "18:00");
      await reschedule(context, occurrenceId, "2099-01-12", "15:00", null);
      await reschedule(context, occurrenceId, "2099-01-12", "18:00", 1);

      // An observation of another time is never a readback of the retired slot.
      const closeA = await runtime.claim(worker);
      assert.ok(closeA);
      assert.equal(closeA.sourceStartAtUtc, a);
      await assert.rejects(() => runtime.submitResult(worker, closeA.id, closedReadback(closeA, {
        sourceStartAtUtc: c, sourceEndAtUtc: hourAfter(c),
      })), StoreValidationError);
      assert.equal((await retirements(pool, occurrenceId))[0]?.status, "PENDING");

      assert.deepEqual(await runtime.submitResult(worker, closeA.id, {
        resultId: randomUUID(), leaseToken: closeA.leaseToken, outcome: "UNKNOWN_AFTER_SAVE", stopped: true, target: closeA.target,
      }), { acceptedAsCurrent: false, repeated: false });
      let rows = await retirements(pool, occurrenceId);
      assert.deepEqual(rows.map(({ status, reason }) => [status, reason]), [["NEEDS_REVIEW", "UNKNOWN_AFTER_SAVE"], ["PENDING", null]]);
      assert.equal((await desired(pool, occurrenceId)).lastError, WARNING);
      assert.equal((await pool.query("SELECT quarantine_reason FROM channel_external_accounts WHERE id='account'")).rows[0]?.quarantine_reason, "UNKNOWN_AFTER_SAVE");

      // Recovery re-enqueues the new-time job; the warning survives it.
      await recover(context);
      assert.equal((await desired(pool, occurrenceId)).lastError, WARNING);

      const closeB = await runtime.claim(worker);
      assert.ok(closeB);
      assert.equal(closeB.sourceStartAtUtc, b);
      const beforeB = await desired(pool, occurrenceId);
      assert.equal((await runtime.submitResult(worker, closeB.id, closedReadback(closeB))).acceptedAsCurrent, true);
      rows = await retirements(pool, occurrenceId);
      assert.deepEqual(rows.map(({ status }) => status), ["NEEDS_REVIEW", "CLOSED_VERIFIED"]);
      // A is still unconfirmed, so the warning stays; the C-time observation is untouched.
      assert.deepEqual(await desired(pool, occurrenceId), beforeB);
      assert.equal(beforeB.lastError, WARNING);
      assert.equal(beforeB.observedState, "OPEN");

      // Moving back to A supersedes the reviewed retirement and clears the warning.
      await reschedule(context, occurrenceId, "2099-01-12", "10:00", 2);
      rows = await retirements(pool, occurrenceId);
      assert.deepEqual(rows.map(({ status, start }) => [status, start]), [
        ["SUPERSEDED", a], ["CLOSED_VERIFIED", b], ["PENDING", c],
      ]);
      assert.equal((await desired(pool, occurrenceId)).lastError, null);

      // A non-CLOSED readback is not accepted and needs review.
      const closeC = await runtime.claim(worker);
      assert.ok(closeC);
      assert.equal(closeC.sourceStartAtUtc, c);
      assert.equal((await runtime.submitResult(worker, closeC.id, closedReadback(closeC, {
        observedState: "OPEN", observedBookable: true, observedManuallyBlocked: false,
      }))).acceptedAsCurrent, false);
      rows = await retirements(pool, occurrenceId);
      assert.deepEqual(rows[2] && [rows[2].status, rows[2].reason], ["NEEDS_REVIEW", "NEEDS_REVIEW"]);
      const finalDesired = await desired(pool, occurrenceId);
      assert.equal(finalDesired.lastError, WARNING);
      assert.equal(finalDesired.start, a);
    });
  });

  it("fails preflight when the retirement is superseded, re-versioned, or its time is current again", async () => {
    await withRuntime("slot_retire_preflight", { listing: "BROWSER" }, async (context) => {
      const { pool, runtime, worker, store } = context;
      const occurrenceId = "morning@2099-01-13";
      const a = utc("2099-01-13", "10:00");
      await reschedule(context, occurrenceId, "2099-01-13", "15:00", null);
      const stale = await runtime.claim(worker);
      assert.ok(stale);
      assert.equal(stale.sourceStartAtUtc, a);

      // The host moves back to A; the outbox has not been consumed yet.
      await store.saveOccurrenceOverride(actor, "tea", "morning", { kind: "RESCHEDULE", occurrenceId, localDate: "2099-01-13", localStartTime: "10:00" },
        1, randomUUID());
      assert.equal((await retirements(pool, occurrenceId))[0]?.status, "PENDING");
      await assert.rejects(() => runtime.preflight(worker, stale.id, stale.leaseToken), StoreConflictError);
      await runtime.consumeCalendarOutbox();
      assert.equal((await retirements(pool, occurrenceId))[0]?.status, "SUPERSEDED");
      await assert.rejects(() => runtime.preflight(worker, stale.id, stale.leaseToken), StoreConflictError);

      // Away from A again: the same old time is retired under a new version.
      await reschedule(context, occurrenceId, "2099-01-13", "15:00", 2);
      const [retiredA] = await retirements(pool, occurrenceId);
      assert.deepEqual([retiredA?.status, retiredA?.version], ["PENDING", 2]);
      await assert.rejects(() => runtime.preflight(worker, stale.id, stale.leaseToken), StoreConflictError);
      assert.equal((await pool.query("SELECT quarantined_at FROM channel_external_accounts WHERE id='account'")).rows[0]?.quarantined_at, null);
      assert.equal((await runtime.submitResult(worker, stale.id, {
        resultId: randomUUID(), leaseToken: stale.leaseToken, outcome: "SUPERSEDED", stopped: true, target: stale.target,
      })).acceptedAsCurrent, false);
      assert.deepEqual((await retirements(pool, occurrenceId)).map(({ status, version }) => [status, version]), [["PENDING", 2], ["SUPERSEDED", 1]]);

      const current = await runtime.claim(worker);
      assert.ok(current);
      assert.equal(current.sourceStartAtUtc, a);
      assert.equal(current.desiredVersion, 2);
      assert.deepEqual(await runtime.preflight(worker, current.id, current.leaseToken), { ready: true, desiredState: "CLOSED" });
      assert.equal((await runtime.submitResult(worker, current.id, closedReadback(current))).acceptedAsCurrent, true);
      assert.equal((await retirements(pool, occurrenceId))[0]?.status, "CLOSED_VERIFIED");
    });
  });

  it("makes a retirement visible when its job expires or is superseded by an authority change", async () => {
    await withRuntime("slot_retire_orphans", { listing: "BROWSER" }, async (context) => {
      const { pool, runtime, worker } = context;
      const superseded = "morning@2099-01-14";
      await reschedule(context, superseded, "2099-01-14", "15:00", null);
      const [listing] = await runtime.listListings(admin, "provider");
      await runtime.updateListing(admin, "listing", {
        externalProductId: listing!.externalProductId, adapter: listing!.adapter, adapterVersion: listing!.adapterVersion,
        connectionMode: listing!.connectionMode, capabilities: listing!.capabilities, active: true,
      }, listing!.mappingVersion, randomUUID());
      assert.equal((await retirements(pool, superseded))[0]?.status, "PENDING");
      await runtime.reconcileListing(admin, "listing", randomUUID());
      assert.deepEqual((await retirements(pool, superseded)).map(({ status, reason }) => [status, reason]), [["NEEDS_REVIEW", "AUTHORITY_CHANGED"]]);
      assert.equal((await desired(pool, superseded)).lastError, WARNING);

      const expired = "morning@2099-01-15";
      await reschedule(context, expired, "2099-01-15", "15:00", null);
      await pool.query("UPDATE channel_jobs SET attempt_count=5 WHERE purpose='SLOT_RETIREMENT' AND occurrence_id=$1 AND status='QUEUED'", [expired]);
      await runtime.claim(worker);
      assert.deepEqual((await retirements(pool, expired)).map(({ status, reason }) => [status, reason]), [["NEEDS_REVIEW", "RETRY_DEADLINE"]]);
      assert.equal((await jobs(pool, expired)).find((job) => job.purpose === "SLOT_RETIREMENT")?.outcome, "NEEDS_REVIEW");
      assert.equal((await desired(pool, expired)).lastError, WARNING);
    });
  });
});
