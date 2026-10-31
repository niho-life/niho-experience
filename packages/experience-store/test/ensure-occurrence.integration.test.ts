import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { ChannelRuntime, type ChannelAction, type ChannelCapabilities, type ChannelResultInput, type ClaimedChannelJob, type WorkerIdentity } from "../src/channels.ts";
import { StoreConflictError, StoreValidationError } from "../src/errors.ts";
import { ExperienceStore } from "../src/repository.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const now = new Date("2099-01-01T00:00:00.000Z");
const admin = { nihoUserId: "synthetic-admin" };
const actor = { providerId: "provider", nihoUserId: "owner" };
const ADAPTER = "GetYourGuide/gyg-browser@1";
const WITH_CREATE: ChannelCapabilities = { canObserve: true, canClose: true, canOpen: true, canCreate: true };
const WITHOUT_CREATE: ChannelCapabilities = { canObserve: true, canClose: true, canOpen: true };

/**
 * CREATE: can_create on a BROWSER listing. NO_CREATE: the listing lacks can_create. GOOGLE: can_create on a GOOGLE listing.
 * CREATE_NO_OPEN: can_create without can_open; a created slot is bookable at once, so it must not ensure.
 */
type ListingKind = "CREATE" | "NO_CREATE" | "GOOGLE" | "CREATE_NO_OPEN";
interface Context {
  readonly pool: Pool;
  readonly runtime: ChannelRuntime;
  readonly store: ExperienceStore;
  readonly worker: WorkerIdentity;
}
type MutableResult = { -readonly [K in keyof ChannelResultInput]?: ChannelResultInput[K] };

/** Tokyo local time to UTC ISO (Asia/Tokyo has no DST). */
const utc = (date: string, time: string) => new Date(`${date}T${time}:00.000+09:00`).toISOString();
const hourAfter = (iso: string) => new Date(Date.parse(iso) + 3_600_000).toISOString();

/** `deployedCreate: false` runs the runtime under a deployment whose adapter has no canCreate. */
async function withRuntime(prefix: string, listings: Readonly<Record<string, ListingKind>>, body: (context: Context) => Promise<void>, deployedCreate = true): Promise<void> {
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
    const setup = new ChannelRuntime(pool, { now: () => now, supportedAdapters: { [ADAPTER]: WITH_CREATE } });
    const runtime = deployedCreate ? setup : new ChannelRuntime(pool, { now: () => now, supportedAdapters: { [ADAPTER]: WITHOUT_CREATE } });
    await setup.createExternalAccount(admin, { id: "account", providerId: "provider", site: "GetYourGuide",
      externalAccountId: "synthetic-account", displayName: "Synthetic account", operatingModel: 4, active: true }, randomUUID());
    for (const [id, kind] of Object.entries(listings)) {
      await setup.createListing(admin, { id, providerId: "provider", accountId: "account", productId: "tea",
        externalProductId: `synthetic-${id}`, adapter: "gyg-browser", adapterVersion: "1", connectionMode: "BROWSER",
        capabilities: kind === "NO_CREATE" ? WITHOUT_CREATE : kind === "CREATE_NO_OPEN" ? { canObserve: true, canClose: true, canCreate: true } : WITH_CREATE,
        active: true }, randomUUID());
      if (kind === "GOOGLE") await pool.query("UPDATE channel_listings SET connection_mode='GOOGLE' WHERE id=$1", [id]);
    }
    const credential = await setup.mintWorkerCredential(admin, "studio", "Synthetic Studio", "2099-02-01T00:00:00.000Z", null, randomUUID());
    await setup.assignWorkerAccount(admin, "studio", "account", null, randomUUID());
    const worker = await setup.authenticateWorker(credential.bearerToken);
    await runtime.consumeCalendarOutbox();
    await body({ pool, runtime, store, worker });
  } finally {
    if (created) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
}

async function jobs(pool: Pool, occurrenceId: string, listingId = "listing") {
  const result = await pool.query(
    `SELECT id,purpose,action,status,outcome,desired_version::int AS desired_version,mapping_version::int AS mapping_version,source_start_at
       FROM channel_jobs WHERE listing_id=$1 AND occurrence_id=$2 ORDER BY created_at,id`, [listingId, occurrenceId],
  );
  return result.rows.map((row) => ({ id: String(row.id), purpose: String(row.purpose), action: String(row.action), status: String(row.status),
    outcome: row.outcome as string | null, desiredVersion: Number(row.desired_version), mappingVersion: Number(row.mapping_version),
    start: (row.source_start_at as Date).toISOString() }));
}

async function queued(pool: Pool, occurrenceId: string, listingId = "listing") {
  return (await jobs(pool, occurrenceId, listingId)).filter((job) => job.status === "QUEUED")
    .map(({ purpose, action, desiredVersion, mappingVersion, start }) => ({ purpose, action, desiredVersion, mappingVersion, start }))
    .sort((left, right) => left.purpose.localeCompare(right.purpose));
}

async function ensuredSlots(pool: Pool, occurrenceId: string, listingId = "listing") {
  const result = await pool.query(
    `SELECT created,job_id,source_start_at,source_end_at,mapping_version::int AS mapping_version,verified_at
       FROM channel_ensured_slots WHERE listing_id=$1 AND occurrence_id=$2 ORDER BY source_start_at,mapping_version`, [listingId, occurrenceId],
  );
  return result.rows.map((row) => ({ created: row.created as boolean, jobId: String(row.job_id), start: (row.source_start_at as Date).toISOString(),
    end: (row.source_end_at as Date).toISOString(), mappingVersion: Number(row.mapping_version), verifiedAt: (row.verified_at as Date).toISOString() }));
}

async function desired(pool: Pool, occurrenceId: string, listingId = "listing") {
  const result = await pool.query(
    `SELECT desired_state,desired_version::int AS desired_version,observed_state,observed_desired_version::int AS observed_desired_version,
            observed_mapping_version::int AS observed_mapping_version,last_verified_at,last_error
       FROM channel_desired_states WHERE listing_id=$1 AND occurrence_id=$2`, [listingId, occurrenceId],
  );
  const row = result.rows[0]!;
  return {
    desiredState: String(row.desired_state), desiredVersion: Number(row.desired_version), observedState: row.observed_state as string | null,
    observedDesiredVersion: row.observed_desired_version as number | null, observedMappingVersion: row.observed_mapping_version as number | null,
    lastVerifiedAt: row.last_verified_at === null ? null : (row.last_verified_at as Date).toISOString(), lastError: row.last_error as string | null,
  };
}

async function results(pool: Pool, jobId: string) {
  const result = await pool.query("SELECT outcome,accepted_as_current,ensure_created FROM channel_job_results WHERE job_id=$1::uuid ORDER BY created_at", [jobId]);
  return result.rows.map((row) => ({ outcome: String(row.outcome), acceptedAsCurrent: row.accepted_as_current as boolean, ensureCreated: row.ensure_created as boolean | null }));
}

async function quarantineReason(pool: Pool): Promise<string | null> {
  return (await pool.query("SELECT quarantine_reason FROM channel_external_accounts WHERE id='account'")).rows[0]!.quarantine_reason as string | null;
}

/** Only this occurrence's job with this action is due, so the next claim takes it without finishing the others. */
async function claimFor(context: Context, occurrenceId: string, action: ChannelAction, listingId = "listing"): Promise<ClaimedChannelJob> {
  await context.pool.query(
    `UPDATE channel_jobs SET next_attempt_at=CASE WHEN listing_id=$1 AND occurrence_id=$2 AND action=$3 THEN $4::timestamptz
       ELSE '2100-01-01T00:00:00Z'::timestamptz END WHERE status='QUEUED'`,
    [listingId, occurrenceId, action, now.toISOString()],
  );
  const job = await context.runtime.claim(context.worker);
  assert.ok(job);
  assert.equal(job.occurrenceId, occurrenceId);
  assert.equal(job.action, action);
  return job;
}

function readback(job: ClaimedChannelJob, overrides: Partial<ChannelResultInput> = {}): ChannelResultInput {
  return {
    resultId: randomUUID(), leaseToken: job.leaseToken, outcome: "VERIFIED", stopped: true, target: job.target,
    occurrenceId: job.occurrenceId, sourceStartAtUtc: job.sourceStartAtUtc, sourceEndAtUtc: job.sourceEndAtUtc,
    observedState: "OPEN", observedBookable: true, observedManuallyBlocked: false, observedAtUtc: now.toISOString(),
    ...overrides,
  };
}

function stoppedWithout(job: ClaimedChannelJob, outcome: "SUPERSEDED" | "UNKNOWN_AFTER_SAVE"): ChannelResultInput {
  return { resultId: randomUUID(), leaseToken: job.leaseToken, outcome, stopped: true, target: job.target };
}

describe("PostgreSQL ENSURE_OCCURRENCE for creatable browser listings", { skip: databaseUrl === undefined }, () => {
  it("ensures the slot before opening it, records the readback, and continues with SET_OPEN at the same desired version", async () => {
    await withRuntime("ensure_main", { listing: "CREATE" }, async (context) => {
      const { pool, runtime, worker } = context;
      const createdHere = "morning@2099-01-03";
      const alreadyThere = "morning@2099-01-04";
      for (const occurrenceId of [createdHere, alreadyThere]) {
        const date = occurrenceId.slice(occurrenceId.indexOf("@") + 1);
        assert.deepEqual(await queued(pool, occurrenceId), [
          { purpose: "AVAILABILITY", action: "ENSURE_OCCURRENCE", desiredVersion: 1, mappingVersion: 1, start: utc(date, "10:00") },
        ]);
      }
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM channel_jobs WHERE action='SET_OPEN'")).rows[0]!.n, 0);

      const ensure = await claimFor(context, createdHere, "ENSURE_OCCURRENCE");
      assert.equal("purpose" in ensure, false);
      assert.equal("googleDeliveryOperation" in ensure, false);
      assert.equal(ensure.desiredVersion, 1);
      assert.equal(ensure.target.connectionMode, "BROWSER");
      assert.deepEqual(await runtime.preflight(worker, ensure.id, ensure.leaseToken), { ready: true, desiredState: "OPEN" });
      const createdResult = readback(ensure, { ensureCreated: true });
      assert.deepEqual(await runtime.submitResult(worker, ensure.id, createdResult), { acceptedAsCurrent: true, repeated: false });
      // The same result ID is idempotent, and a different ensureCreated under it is refused.
      assert.deepEqual(await runtime.submitResult(worker, ensure.id, createdResult), { acceptedAsCurrent: true, repeated: true });
      await assert.rejects(() => runtime.submitResult(worker, ensure.id, { ...createdResult, ensureCreated: false }), StoreConflictError);

      const start = utc("2099-01-03", "10:00");
      assert.deepEqual(await ensuredSlots(pool, createdHere), [
        { created: true, jobId: ensure.id, start, end: hourAfter(start), mappingVersion: 1, verifiedAt: now.toISOString() },
      ]);
      assert.deepEqual(await results(pool, ensure.id), [{ outcome: "VERIFIED", acceptedAsCurrent: true, ensureCreated: true }]);
      assert.deepEqual(await desired(pool, createdHere), {
        desiredState: "OPEN", desiredVersion: 1, observedState: "OPEN", observedDesiredVersion: 1, observedMappingVersion: 1,
        lastVerifiedAt: now.toISOString(), lastError: null,
      });
      assert.deepEqual((await jobs(pool, createdHere)).map(({ action, status, outcome, desiredVersion }) => ({ action, status, outcome, desiredVersion })), [
        { action: "ENSURE_OCCURRENCE", status: "FINISHED", outcome: "VERIFIED", desiredVersion: 1 },
        { action: "SET_OPEN", status: "QUEUED", outcome: null, desiredVersion: 1 },
      ]);

      // A slot that already existed is not written; a CLOSED existence readback is still accepted.
      const existing = await claimFor(context, alreadyThere, "ENSURE_OCCURRENCE");
      assert.deepEqual(await runtime.preflight(worker, existing.id, existing.leaseToken), { ready: true, desiredState: "OPEN" });
      assert.deepEqual(await runtime.submitResult(worker, existing.id, readback(existing, {
        ensureCreated: false, observedState: "CLOSED", observedBookable: false, observedManuallyBlocked: true,
      })), { acceptedAsCurrent: true, repeated: false });
      assert.deepEqual((await ensuredSlots(pool, alreadyThere)).map(({ created, jobId }) => ({ created, jobId })), [{ created: false, jobId: existing.id }]);
      assert.deepEqual(await results(pool, existing.id), [{ outcome: "VERIFIED", acceptedAsCurrent: true, ensureCreated: false }]);
      assert.equal((await desired(pool, alreadyThere)).observedState, "CLOSED");
      assert.deepEqual(await queued(pool, alreadyThere), [
        { purpose: "AVAILABILITY", action: "SET_OPEN", desiredVersion: 1, mappingVersion: 1, start: utc("2099-01-04", "10:00") },
      ]);

      // Reconciling again does not ensure the verified slots a second time.
      const totalJobs = async () => Number((await pool.query("SELECT count(*)::int AS n FROM channel_jobs")).rows[0]!.n);
      const before = await totalJobs();
      assert.equal((await runtime.reconcileListing(admin, "listing", randomUUID())).jobs, 0);
      assert.equal(await totalJobs(), before);

      // The ordinary SET_OPEN follows and is verified as before.
      const open = await claimFor(context, createdHere, "SET_OPEN");
      assert.equal(open.desiredVersion, 1);
      assert.deepEqual(await runtime.preflight(worker, open.id, open.leaseToken), { ready: true, desiredState: "OPEN" });
      assert.deepEqual(await runtime.submitResult(worker, open.id, readback(open)), { acceptedAsCurrent: true, repeated: false });
      assert.deepEqual(await results(pool, open.id), [{ outcome: "VERIFIED", acceptedAsCurrent: true, ensureCreated: null }]);
      assert.equal((await runtime.reconcileListing(admin, "listing", randomUUID())).jobs, 0);
      assert.deepEqual(await queued(pool, createdHere), []);
      assert.equal((await ensuredSlots(pool, createdHere)).length, 1);
    });
  });

  it("keeps SET_OPEN without a create capability or on GOOGLE, and SET_CLOSED for a closed occurrence", async () => {
    await withRuntime("ensure_plain", { listing: "CREATE", "listing-no-create": "NO_CREATE", "listing-google": "GOOGLE",
      "listing-create-no-open": "CREATE_NO_OPEN" }, async (context) => {
      const { pool, runtime, store } = context;
      const occurrenceId = "morning@2099-01-05";
      const start = utc("2099-01-05", "10:00");
      assert.deepEqual(await queued(pool, occurrenceId), [
        { purpose: "AVAILABILITY", action: "ENSURE_OCCURRENCE", desiredVersion: 1, mappingVersion: 1, start },
      ]);
      for (const listingId of ["listing-no-create", "listing-google"]) {
        assert.deepEqual(await queued(pool, occurrenceId, listingId), [
          { purpose: "AVAILABILITY", action: "SET_OPEN", desiredVersion: 1, mappingVersion: 1, start },
        ]);
      }
      const ensureListings = await pool.query("SELECT DISTINCT listing_id FROM channel_jobs WHERE action='ENSURE_OCCURRENCE'");
      assert.deepEqual(ensureListings.rows.map((row) => row.listing_id), ["listing"]);
      // Without can_open the listing neither ensures nor opens; the existing unsupported error stays visible.
      assert.deepEqual(await queued(pool, occurrenceId, "listing-create-no-open"), []);
      const noOpen = await pool.query("SELECT last_error FROM channel_desired_states WHERE listing_id='listing-create-no-open' AND occurrence_id=$1", [occurrenceId]);
      assert.equal(noOpen.rows[0]?.last_error, "SET_OPEN is unsupported by this mapping.");

      await store.setOccurrenceSalesState(actor, "tea", "morning", { occurrenceId, desiredState: "CLOSED" }, null, randomUUID());
      await runtime.consumeCalendarOutbox();
      for (const listingId of ["listing", "listing-no-create", "listing-google"]) {
        assert.deepEqual(await queued(pool, occurrenceId, listingId), [
          { purpose: "AVAILABILITY", action: "SET_CLOSED", desiredVersion: 2, mappingVersion: 1, start },
        ]);
        assert.equal((await jobs(pool, occurrenceId, listingId))[0]?.outcome, "SUPERSEDED");
      }
    });

    // The listing allows creation, but this deployment's adapter does not.
    await withRuntime("ensure_undeployed", { listing: "CREATE" }, async (context) => {
      const { pool, runtime, worker } = context;
      const occurrenceId = "morning@2099-01-05";
      assert.deepEqual(await queued(pool, occurrenceId), [
        { purpose: "AVAILABILITY", action: "SET_OPEN", desiredVersion: 1, mappingVersion: 1, start: utc("2099-01-05", "10:00") },
      ]);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM channel_jobs WHERE action='ENSURE_OCCURRENCE'")).rows[0]!.n, 0);
      // An ENSURE job left from an earlier deployment is not claimed once canCreate is off.
      await pool.query(`UPDATE channel_jobs SET action='ENSURE_OCCURRENCE',next_attempt_at=$2
        WHERE listing_id='listing' AND occurrence_id=$1`, [occurrenceId, now.toISOString()]);
      await pool.query("UPDATE channel_jobs SET next_attempt_at='2100-01-01T00:00:00Z' WHERE status='QUEUED' AND occurrence_id<>$1", [occurrenceId]);
      assert.equal(await runtime.claim(worker), null);
      await pool.query("UPDATE channel_jobs SET action='SET_OPEN' WHERE listing_id='listing' AND occurrence_id=$1", [occurrenceId]);
      assert.equal((await runtime.claim(worker))?.action, "SET_OPEN");
    }, false);
  });

  it("ensures again after a mapping change and at a rescheduled time, while the old time still retires", async () => {
    await withRuntime("ensure_moves", { listing: "CREATE" }, async (context) => {
      const { pool, runtime, store, worker } = context;
      const remapped = "morning@2099-01-06";
      const moved = "morning@2099-01-07";
      for (const occurrenceId of [remapped, moved]) {
        const job = await claimFor(context, occurrenceId, "ENSURE_OCCURRENCE");
        await runtime.preflight(worker, job.id, job.leaseToken);
        assert.equal((await runtime.submitResult(worker, job.id, readback(job, { ensureCreated: true }))).acceptedAsCurrent, true);
      }

      const oldStart = utc("2099-01-07", "10:00");
      const newStart = utc("2099-01-07", "15:00");
      await store.saveOccurrenceOverride(actor, "tea", "morning", { kind: "RESCHEDULE", occurrenceId: moved, localDate: "2099-01-07", localStartTime: "15:00" },
        null, randomUUID());
      await runtime.consumeCalendarOutbox();
      assert.deepEqual(await queued(pool, moved), [
        { purpose: "AVAILABILITY", action: "ENSURE_OCCURRENCE", desiredVersion: 2, mappingVersion: 1, start: newStart },
        { purpose: "SLOT_RETIREMENT", action: "SET_CLOSED", desiredVersion: 1, mappingVersion: 1, start: oldStart },
      ]);
      const atNewTime = await claimFor(context, moved, "ENSURE_OCCURRENCE");
      assert.equal(atNewTime.sourceStartAtUtc, newStart);
      assert.deepEqual(await runtime.preflight(worker, atNewTime.id, atNewTime.leaseToken), { ready: true, desiredState: "OPEN" });
      assert.equal((await runtime.submitResult(worker, atNewTime.id, readback(atNewTime, { ensureCreated: true }))).acceptedAsCurrent, true);
      assert.deepEqual((await ensuredSlots(pool, moved)).map(({ start, mappingVersion }) => ({ start, mappingVersion })), [
        { start: oldStart, mappingVersion: 1 }, { start: newStart, mappingVersion: 1 },
      ]);
      assert.deepEqual(await queued(pool, moved), [
        { purpose: "AVAILABILITY", action: "SET_OPEN", desiredVersion: 2, mappingVersion: 1, start: newStart },
        { purpose: "SLOT_RETIREMENT", action: "SET_CLOSED", desiredVersion: 1, mappingVersion: 1, start: oldStart },
      ]);

      await runtime.updateListing(admin, "listing", { externalProductId: "synthetic-listing", adapter: "gyg-browser", adapterVersion: "1",
        connectionMode: "BROWSER", capabilities: WITH_CREATE, active: true }, 1, randomUUID());
      await runtime.reconcileListing(admin, "listing", randomUUID());
      assert.deepEqual(await queued(pool, remapped), [
        { purpose: "AVAILABILITY", action: "ENSURE_OCCURRENCE", desiredVersion: 2, mappingVersion: 2, start: utc("2099-01-06", "10:00") },
      ]);
    });
  });

  it("refuses misplaced or incomplete ENSURE readbacks and quarantines an unknown save without an ensured slot", async () => {
    await withRuntime("ensure_results", { listing: "CREATE", "listing-no-create": "NO_CREATE" }, async (context) => {
      const { pool, runtime, worker } = context;
      const occurrenceId = "morning@2099-01-08";

      // ensureCreated never rides a SET_OPEN result.
      const open = await claimFor(context, occurrenceId, "SET_OPEN", "listing-no-create");
      await runtime.preflight(worker, open.id, open.leaseToken);
      await assert.rejects(() => runtime.submitResult(worker, open.id, readback(open, { ensureCreated: false })), StoreValidationError);
      assert.deepEqual(await results(pool, open.id), []);
      assert.equal((await runtime.submitResult(worker, open.id, readback(open))).acceptedAsCurrent, true);

      const ensure = await claimFor(context, occurrenceId, "ENSURE_OCCURRENCE");
      await runtime.preflight(worker, ensure.id, ensure.leaseToken);
      await assert.rejects(() => runtime.submitResult(worker, ensure.id, { ...stoppedWithout(ensure, "UNKNOWN_AFTER_SAVE"), ensureCreated: true }),
        StoreValidationError);
      await assert.rejects(() => runtime.submitResult(worker, ensure.id, readback(ensure)), StoreValidationError);
      const incomplete: MutableResult = readback(ensure, { ensureCreated: true });
      delete incomplete.observedBookable;
      await assert.rejects(() => runtime.submitResult(worker, ensure.id, incomplete as ChannelResultInput), StoreValidationError);
      assert.equal((await jobs(pool, occurrenceId)).find((job) => job.id === ensure.id)?.status, "LEASED");
      assert.deepEqual(await results(pool, ensure.id), []);

      assert.deepEqual(await runtime.submitResult(worker, ensure.id, stoppedWithout(ensure, "UNKNOWN_AFTER_SAVE")), { acceptedAsCurrent: false, repeated: false });
      assert.deepEqual(await ensuredSlots(pool, occurrenceId), []);
      assert.deepEqual(await results(pool, ensure.id), [{ outcome: "UNKNOWN_AFTER_SAVE", acceptedAsCurrent: false, ensureCreated: null }]);
      assert.equal((await jobs(pool, occurrenceId)).find((job) => job.id === ensure.id)?.outcome, "UNKNOWN_AFTER_SAVE");
      assert.equal(await quarantineReason(pool), "UNKNOWN_AFTER_SAVE");
      assert.deepEqual(await queued(pool, occurrenceId), []);
      assert.equal((await desired(pool, occurrenceId)).observedState, null);
    });
  });

  it("stops at preflight when the desired state, live availability, or create capability changed", async () => {
    await withRuntime("ensure_preflight", { listing: "CREATE" }, async (context) => {
      const { pool, runtime, store, worker } = context;
      const release = async (job: ClaimedChannelJob) => assert.deepEqual(
        await runtime.submitResult(worker, job.id, stoppedWithout(job, "SUPERSEDED")), { acceptedAsCurrent: false, repeated: false });

      const desiredClosed = "morning@2099-01-09";
      const first = await claimFor(context, desiredClosed, "ENSURE_OCCURRENCE");
      await pool.query("UPDATE channel_desired_states SET desired_state='CLOSED' WHERE listing_id='listing' AND occurrence_id=$1", [desiredClosed]);
      await assert.rejects(() => runtime.preflight(worker, first.id, first.leaseToken), StoreConflictError);
      assert.equal(await quarantineReason(pool), null);
      await release(first);

      const liveClosed = "morning@2099-01-10";
      const second = await claimFor(context, liveClosed, "ENSURE_OCCURRENCE");
      await store.setOccurrenceSalesState(actor, "tea", "morning", { occurrenceId: liveClosed, desiredState: "CLOSED" }, null, randomUUID());
      await assert.rejects(() => runtime.preflight(worker, second.id, second.leaseToken), StoreConflictError);
      assert.equal(await quarantineReason(pool), null);
      await release(second);
      assert.deepEqual(await ensuredSlots(pool, liveClosed), []);

      const createRemoved = "morning@2099-01-11";
      const third = await claimFor(context, createRemoved, "ENSURE_OCCURRENCE");
      await pool.query("UPDATE channel_listings SET can_create=false WHERE id='listing'");
      await assert.rejects(() => runtime.preflight(worker, third.id, third.leaseToken), StoreConflictError);
      assert.equal(await quarantineReason(pool), "PREFLIGHT_AUTHORITY_STALE");
      // A readback without the capability is recorded but not accepted, and ensures nothing.
      assert.deepEqual(await runtime.submitResult(worker, third.id, readback(third, { ensureCreated: true })), { acceptedAsCurrent: false, repeated: false });
      assert.deepEqual(await ensuredSlots(pool, createRemoved), []);
      assert.equal((await jobs(pool, createRemoved)).find((job) => job.id === third.id)?.outcome, "SUPERSEDED");

      // A quarantined account never runs an ENSURE.
      await pool.query("UPDATE channel_listings SET can_create=true WHERE id='listing'");
      await pool.query(`UPDATE channel_jobs SET next_attempt_at=CASE WHEN occurrence_id=$1 THEN $2::timestamptz ELSE '2100-01-01T00:00:00Z'::timestamptz END
        WHERE status='QUEUED'`, ["morning@2099-01-12", now.toISOString()]);
      assert.equal((await queued(pool, "morning@2099-01-12"))[0]?.action, "ENSURE_OCCURRENCE");
      assert.equal(await runtime.claim(worker), null);
    });
  });
});
