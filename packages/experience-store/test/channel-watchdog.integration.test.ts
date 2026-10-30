import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { occurrenceIdFor, type ScheduleRule } from "@niho-experience/experience-domain";
import type { Pool } from "pg";
import { ChannelRuntime, type ChannelCapabilities, type ClaimedChannelJob, type WorkerIdentity } from "../src/channels.ts";
import { StoreConflictError, StoreNotFoundError, StoreValidationError } from "../src/errors.ts";
import { ExperienceStore } from "../src/repository.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const T0 = "2099-01-01T00:00:00.000Z";
const owner = { providerId: "provider-a", nihoUserId: "owner-a" };
const admin = { nihoUserId: "admin-a" };
const otherAdmin = { nihoUserId: "admin-b" };
const supported: Readonly<Record<string, ChannelCapabilities>> = {
  "Airbnb/browser-v1@1": { canObserve: true, canReadReservations: true, canClose: true, canOpen: true },
  "GetYourGuide/gyg-browser@1": { canObserve: true, canClose: true, canOpen: true },
};

interface Fixture {
  readonly pool: Pool;
  readonly runtime: ChannelRuntime;
  readonly store: ExperienceStore;
  readonly clock: { now: Date };
  readonly workerA: WorkerIdentity;
}

async function withFixture(name: string, work: (fixture: Fixture) => Promise<void>): Promise<void> {
  const { Pool } = await import("pg");
  const schema = `${name}_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema}` });
  let created = false;
  const clock = { now: new Date(T0) };
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    const migrations = (await readdir(new URL("../migrations/", import.meta.url))).filter((file) => /^\d{4}.*\.sql$/.test(file)).sort();
    for (const file of migrations) await pool.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
    await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a')");
    await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES ('provider-a','owner-a','OWNER')");
    await pool.query(
      `INSERT INTO experience_products
        (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,
         seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
       VALUES ('provider-a','tea','provider-a-tea','PUBLISHED','Synthetic tea','{}','JPY',1000,'terms','seller','acct_synthetic','Synthetic Seller')`,
    );
    const store = new ExperienceStore(pool);
    const rule: ScheduleRule = {
      id: "tea-am", timeZone: "Asia/Tokyo", startsOn: "2099-01-01", endsOn: "2099-01-10", localStartTime: "10:00",
      durationMinutes: 60, capacity: 4, bookingCutoffMinutes: 0, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0,
      recurrence: { kind: "DAILY" },
    };
    await store.saveScheduleRule(owner, "tea", rule, null, randomUUID());
    const runtime = new ChannelRuntime(pool, { now: () => clock.now, supportedAdapters: supported });
    await runtime.createExternalAccount(admin, {
      id: "account-a", providerId: "provider-a", site: "Airbnb", externalAccountId: "external-a", displayName: "Synthetic Airbnb",
      operatingModel: 2, active: true, delegatedUntilUtc: "2099-03-01T00:00:00.000Z",
    }, randomUUID());
    await runtime.createListing(admin, {
      id: "listing-a", providerId: "provider-a", accountId: "account-a", productId: "tea", externalProductId: "tea-external",
      externalOptionId: "morning", adapter: "browser-v1", adapterVersion: "1", connectionMode: "BROWSER",
      capabilities: { canObserve: true, canReadReservations: true, canClose: true, canOpen: true }, active: true,
    }, randomUUID());
    await runtime.reconcileListing(admin, "listing-a", randomUUID());
    await runtime.consumeCalendarOutbox();
    const credential = await runtime.mintWorkerCredential(admin, "worker-a", "Synthetic Studio A", "2099-03-01T00:00:00.000Z", null, randomUUID());
    await runtime.assignWorkerAccount(admin, "worker-a", "account-a", null, randomUUID());
    const workerA = await runtime.authenticateWorker(credential.bearerToken);
    await work({ pool, runtime, store, clock, workerA });
  } finally {
    if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
}

async function closeOccurrence(fixture: Fixture, date: string): Promise<string> {
  const occurrenceId = occurrenceIdFor("tea-am", date);
  await fixture.store.setOccurrenceSalesState(owner, "tea", "tea-am", { occurrenceId, desiredState: "CLOSED" }, null, randomUUID());
  await fixture.runtime.consumeCalendarOutbox();
  return occurrenceId;
}

async function verify(fixture: Fixture, worker: WorkerIdentity, job: ClaimedChannelJob, observedState: "OPEN" | "CLOSED"): Promise<void> {
  assert.equal((await fixture.runtime.preflight(worker, job.id, job.leaseToken)).ready, true);
  const result = await fixture.runtime.submitResult(worker, job.id, {
    resultId: randomUUID(), leaseToken: job.leaseToken, outcome: "VERIFIED", stopped: true, target: job.target,
    occurrenceId: job.occurrenceId, sourceStartAtUtc: job.sourceStartAtUtc, sourceEndAtUtc: job.sourceEndAtUtc,
    observedState, observedBookable: observedState === "OPEN", observedManuallyBlocked: observedState === "CLOSED",
    observedAtUtc: fixture.clock.now.toISOString(),
  });
  assert.equal(result.acceptedAsCurrent, true);
}

async function completeReservationRead(fixture: Fixture, worker: WorkerIdentity, job: ClaimedChannelJob | null): Promise<void> {
  assert.ok(job);
  assert.equal(job.purpose, "RESERVATION_WINDOW");
  const cycle = await fixture.runtime.beginReservationWindowRead(worker, job.id, job.leaseToken);
  const receipt = await fixture.runtime.submitReservationWindowPage(worker, job.id, {
    receiptId: cycle.receiptId, readId: cycle.readId, leaseToken: job.leaseToken, pageNumber: 0, observations: [],
    terminal: { status: "COMPLETE", completedAtUtc: fixture.clock.now.toISOString(), allPagesRead: true, allStatusesIncluded: true, coverageComplete: true },
  });
  assert.equal(receipt.healthUpdated, true);
  assert.deepEqual(await fixture.runtime.submitResult(worker, job.id, {
    resultId: randomUUID(), leaseToken: job.leaseToken, outcome: "RESERVATION_VERIFIED", stopped: true, target: job.target,
    reservationReadId: cycle.readId, reservationReceiptId: receipt.receiptId,
  }), { acceptedAsCurrent: true, repeated: false });
}

async function holdSince(pool: Pool, workerId: string): Promise<string | null> {
  const value = (await pool.query("SELECT open_hold_since FROM channel_workers WHERE id=$1", [workerId])).rows[0]?.open_hold_since;
  return value === null || value === undefined ? null : new Date(value).toISOString();
}

async function openIncidents(pool: Pool, kind: string): Promise<number> {
  return Number((await pool.query("SELECT count(*)::int AS count FROM channel_runtime_incidents WHERE kind=$1 AND resolved_at IS NULL", [kind])).rows[0]?.count);
}

describe("PostgreSQL channel runtime watchdog and OPEN hold", { skip: databaseUrl === undefined }, () => {
  it("holds only new OPEN after a heartbeat gap until reservations are re-read, and keeps staff actions guarded and idempotent", { timeout: 60_000 }, async () => {
    await withFixture("channel_hold_test", async (fixture) => {
      const { pool, runtime, clock, workerA } = fixture;
      // Until a fresh reservation read exists every desired state is CLOSED (existing inventory gate).
      // First claim ever: no heartbeat starts the OPEN hold, and CLOSE still proceeds.
      const firstClose = await runtime.claim(workerA);
      assert.ok(firstClose);
      assert.equal(firstClose.action, "SET_CLOSED");
      assert.equal(await holdSince(pool, "worker-a"), T0);
      await verify(fixture, workerA, firstClose, "CLOSED");
      // Isolated fixture: the remaining initial CLOSE backlog is not part of this check.
      await pool.query("UPDATE channel_jobs SET status='FINISHED',outcome='SUPERSEDED' WHERE status='QUEUED'");

      // The read starts after the hold, but the Studio goes silent again before its next claim:
      // the newer gap restarts the hold, so the earlier read cannot release it.
      assert.equal((await runtime.enqueueDueReservationReads(workerA, 1)).enqueued, 1);
      await completeReservationRead(fixture, workerA, await runtime.claim(workerA));
      clock.now = new Date(Date.parse(T0) + 91_000);
      await runtime.reconcileListing(admin, "listing-a", randomUUID());
      assert.ok(Number((await pool.query("SELECT count(*)::int AS count FROM channel_jobs WHERE action='SET_OPEN' AND status='QUEUED'")).rows[0]?.count) > 0);
      assert.equal(await runtime.claim(workerA), null);
      assert.equal(await holdSince(pool, "worker-a"), clock.now.toISOString());
      const pulled = (await pool.query("SELECT next_due_at FROM external_reservation_read_dispatch_states WHERE listing_id='listing-a'")).rows[0];
      assert.equal(new Date(pulled?.next_due_at).toISOString(), clock.now.toISOString());
      const queuedOpen = (await pool.query(
        `SELECT count(*)::int AS count, max(attempt_count)::int AS attempts, count(job_deadline_at)::int AS deadlines
           FROM channel_jobs WHERE action='SET_OPEN' AND status='QUEUED'`,
      )).rows[0];
      assert.ok(Number(queuedOpen?.count) > 0);
      assert.equal(queuedOpen?.attempts, 0);
      assert.equal(queuedOpen?.deadlines, 0);
      const held = await runtime.hostStatuses(owner);
      assert.ok(held.filter((item) => item.desired === "OPEN").length > 0);
      assert.ok(held.filter((item) => item.desired === "OPEN").every((item) => item.label === "HELD"));

      // CLOSE is never held.
      const closedOccurrence = await closeOccurrence(fixture, "2099-01-03");
      const close = await runtime.claim(workerA);
      assert.ok(close);
      assert.equal(close.action, "SET_CLOSED");
      assert.equal(close.occurrenceId, closedOccurrence);
      await verify(fixture, workerA, close, "CLOSED");
      assert.equal((await runtime.hostStatuses(owner)).find((item) => item.occurrenceId === closedOccurrence)?.label, "SYNCED");

      // A read that started after the latest gap releases this Studio's hold at its next claim.
      assert.equal((await runtime.enqueueDueReservationReads(workerA, 1)).enqueued, 1);
      await completeReservationRead(fixture, workerA, await runtime.claim(workerA));

      // A second live Studio of the provider that has never sent a heartbeat keeps OPEN held.
      const credentialB = await runtime.mintWorkerCredential(admin, "worker-b", "Synthetic Studio B", "2099-03-01T00:00:00.000Z", null, randomUUID());
      await runtime.assignWorkerAccount(admin, credentialB.workerId, "account-a", null, randomUUID());
      assert.equal(await runtime.claim(workerA), null);
      assert.equal(await holdSince(pool, "worker-a"), null);
      await runtime.revokeWorkerAccount(admin, "worker-b", "account-a", 1, randomUUID());
      const open = await runtime.claim(workerA);
      assert.ok(open);
      assert.equal(open.action, "SET_OPEN");
      assert.equal((await runtime.hostStatuses(owner)).some((item) => item.label === "HELD"), false);

      // Re-authentication is accepted only for AUTH_REQUIRED and shares the observe-first recovery.
      assert.equal((await runtime.preflight(workerA, open.id, open.leaseToken)).ready, true);
      await runtime.submitResult(workerA, open.id, {
        resultId: randomUUID(), leaseToken: open.leaseToken, outcome: "AUTH_REQUIRED", stopped: true, target: open.target,
        occurrenceId: open.occurrenceId, sourceStartAtUtc: open.sourceStartAtUtc, sourceEndAtUtc: open.sourceEndAtUtc,
      });
      const quarantined = (await runtime.runtimeOverview(admin, "provider-a")).accounts.find((item) => item.id === "account-a");
      assert.equal(quarantined?.quarantineReason, "AUTH_REQUIRED");
      await assert.rejects(() => runtime.confirmReauth(admin, "account-a", true, false as unknown as true, randomUUID()), StoreValidationError);
      const reauthCommand = randomUUID();
      const reauth = await runtime.confirmReauth(admin, "account-a", true, true, reauthCommand);
      assert.deepEqual(await runtime.confirmReauth(admin, "account-a", true, true, reauthCommand), reauth);
      await assert.rejects(() => runtime.confirmReauth(otherAdmin, "account-a", true, true, reauthCommand), StoreConflictError);
      const afterReauth = (await pool.query("SELECT quarantine_reason FROM channel_external_accounts WHERE id='account-a'")).rows[0];
      assert.equal(afterReauth?.quarantine_reason, "MANUAL_RECOVERY_OBSERVE_REQUIRED");
      const observeJob = (await pool.query("SELECT action,status FROM channel_jobs WHERE id=$1::uuid", [reauth.observeJobId])).rows[0];
      assert.deepEqual({ ...observeJob }, { action: "OBSERVE", status: "QUEUED" });
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM channel_audit_events WHERE action='account.reauth' AND resource_id='account-a'")).rows[0]?.count, 1);
      await assert.rejects(() => runtime.confirmReauth(admin, "account-a", true, true, randomUUID()), /re-authentication/);

      // Manual handling is versioned and idempotent, and it is not a re-authentication state.
      const version = Number((await pool.query("SELECT version FROM channel_external_accounts WHERE id='account-a'")).rows[0]?.version);
      await assert.rejects(() => runtime.pauseAccount(admin, "account-a", version + 1, randomUUID()), StoreConflictError);
      await assert.rejects(() => runtime.pauseAccount(admin, "missing-account", 1, randomUUID()), StoreNotFoundError);
      const pauseCommand = randomUUID();
      assert.deepEqual(await runtime.pauseAccount(admin, "account-a", version, pauseCommand), { accountId: "account-a", quarantineReason: "MANUAL_HANDLING" });
      assert.deepEqual(await runtime.pauseAccount(admin, "account-a", version, pauseCommand), { accountId: "account-a", quarantineReason: "MANUAL_HANDLING" });
      assert.equal((await pool.query("SELECT quarantine_reason FROM channel_external_accounts WHERE id='account-a'")).rows[0]?.quarantine_reason, "MANUAL_HANDLING");
      assert.equal((await pool.query("SELECT status FROM channel_jobs WHERE id=$1::uuid", [reauth.observeJobId])).rows[0]?.status, "QUEUED");
      // Staff own the profile: even the highest-priority recovery OBSERVE is not claimed.
      assert.notEqual((await runtime.claim(workerA))?.id, reauth.observeJobId);
      assert.equal((await pool.query("SELECT status FROM channel_jobs WHERE id=$1::uuid", [reauth.observeJobId])).rows[0]?.status, "QUEUED");
      await assert.rejects(() => runtime.confirmReauth(admin, "account-a", true, true, randomUUID()), /re-authentication/);

      // A halted reader restarts only with live authority, and only once.
      await assert.rejects(() => runtime.retryReservationReads(admin, "listing-a", randomUUID()), /not halted/);
      await pool.query("UPDATE external_reservation_read_dispatch_states SET halted_at=$1,last_error='READ_INCOMPLETE',retry_count=5 WHERE listing_id='listing-a'", [clock.now]);
      await assert.rejects(() => runtime.retryReservationReads(admin, "listing-a", randomUUID()), /not quarantined/);
      await pool.query("UPDATE channel_external_accounts SET quarantined_at=NULL,quarantine_reason=NULL WHERE id='account-a'");
      await pool.query("UPDATE channel_listings SET can_read_reservations=false WHERE id='listing-a'");
      await assert.rejects(() => runtime.retryReservationReads(admin, "listing-a", randomUUID()), /allowed to read/);
      await pool.query("UPDATE channel_listings SET can_read_reservations=true WHERE id='listing-a'");
      await assert.rejects(() => runtime.retryReservationReads(admin, "missing-listing", randomUUID()), StoreNotFoundError);
      const retryCommand = randomUUID();
      const retried = await runtime.retryReservationReads(admin, "listing-a", retryCommand);
      assert.deepEqual(retried, { listingId: "listing-a", nextDueAtUtc: clock.now.toISOString() });
      assert.deepEqual(await runtime.retryReservationReads(admin, "listing-a", retryCommand), retried);
      const resumed = (await pool.query("SELECT halted_at,last_error,retry_count,next_due_at FROM external_reservation_read_dispatch_states WHERE listing_id='listing-a'")).rows[0];
      assert.equal(resumed?.halted_at, null);
      assert.equal(resumed?.last_error, null);
      assert.equal(resumed?.retry_count, 0);
      await assert.rejects(() => runtime.retryReservationReads(admin, "listing-a", randomUUID()), /not halted/);
    });
  });

  it("opens one incident per condition, escalates, auto-resolves, and changes no job, lease, or quarantine", { timeout: 60_000 }, async () => {
    await withFixture("channel_watchdog_test", async (fixture) => {
      const { pool, runtime, clock, workerA } = fixture;
      await runtime.createExternalAccount(admin, {
        id: "account-b", providerId: "provider-a", site: "GetYourGuide", externalAccountId: "external-b", displayName: "Synthetic GYG",
        operatingModel: 2, active: true,
      }, randomUUID());
      await runtime.createListing(admin, {
        id: "listing-b", providerId: "provider-a", accountId: "account-b", productId: "tea", externalProductId: "tea-gyg",
        adapter: "gyg-browser", adapterVersion: "1", connectionMode: "BROWSER",
        capabilities: { canObserve: true, canClose: true, canOpen: true }, active: true,
      }, randomUUID());
      await runtime.reconcileListing(admin, "listing-b", randomUUID());
      // A retired adapter cannot execute anything: its backlog is not SYNC_OVERDUE.
      await pool.query("UPDATE channel_listings SET adapter_version='retired' WHERE id='listing-b'");

      // Never-seen Studio: a pending CLOSE has no fresh executor and needs staff, not waiting.
      // (Without a fresh reservation read, every desired state is CLOSED.)
      const initial = (await runtime.hostStatuses(owner)).filter((item) => item.site === "Airbnb");
      assert.ok(initial.length > 0);
      assert.ok(initial.every((item) => item.desired === "CLOSED" && item.label === "ERROR" && item.error === "WORKER_STALE"));

      const first = await runtime.runWatchdog();
      assert.deepEqual({ skipped: first.skipped, opened: first.opened, openIncidents: first.openIncidents }, { skipped: false, opened: 0, openIncidents: 0 });
      assert.equal((await runtime.runtimeOverview(admin, "provider-a")).watchdogStale, false);

      const jobsBefore = (await pool.query("SELECT id,status,attempt_count,lease_epoch FROM channel_jobs ORDER BY id")).rows;
      const accountsBefore = (await pool.query("SELECT id,quarantined_at,quarantine_reason,version FROM channel_external_accounts ORDER BY id")).rows;
      clock.now = new Date(Date.parse(T0) + 91_000);
      const concurrent = await Promise.all([runtime.runWatchdog(), runtime.runWatchdog(), runtime.runWatchdog()]);
      const staleOpened = concurrent.flatMap((run) => run.transitions).filter((item) => item.kind === "WORKER_STALE" && item.transition === "opened");
      assert.equal(staleOpened.length, 1);
      assert.equal(staleOpened[0]?.providerId, undefined);
      assert.equal(await openIncidents(pool, "WORKER_STALE"), 1);
      assert.equal(await holdSince(pool, "worker-a"), clock.now.toISOString());
      assert.deepEqual((await pool.query("SELECT id,status,attempt_count,lease_epoch FROM channel_jobs ORDER BY id")).rows, jobsBefore);
      assert.deepEqual((await pool.query("SELECT id,quarantined_at,quarantine_reason,version FROM channel_external_accounts ORDER BY id")).rows, accountsBefore);
      const repeated = await runtime.runWatchdog();
      assert.deepEqual([repeated.opened, repeated.escalated, repeated.resolved, repeated.openIncidents], [0, 0, 0, 1]);

      clock.now = new Date(Date.parse(T0) + 61 * 60_000);
      const escalation = await runtime.runWatchdog();
      assert.deepEqual(escalation.transitions.filter((item) => item.kind === "WORKER_STALE").map((item) => item.transition), ["escalated"]);
      const overdue = escalation.transitions.filter((item) => item.kind === "SYNC_OVERDUE");
      assert.deepEqual(overdue.map((item) => item.transition), ["opened", "escalated"]);
      assert.equal(overdue[0]?.providerId, "provider-a");
      assert.ok(Number(overdue[0]?.detail.closePending) > 0);
      assert.equal(overdue[0]?.detail.openPending, 0);
      assert.equal(overdue[0]?.detail.oldestChangedAtUtc, T0);
      assert.equal((await pool.query("SELECT subject_id FROM channel_runtime_incidents WHERE kind='SYNC_OVERDUE'")).rows.map((row) => row.subject_id).join(), "account-a");
      assert.doesNotMatch(JSON.stringify(escalation.transitions), /external-a|external-b|tea-external|tea-gyg/);

      const overview = await runtime.runtimeOverview(admin, "provider-a");
      assert.equal(overview.openHold, true);
      assert.equal(overview.unclosedOccurrences >= 1, true);
      assert.deepEqual(overview.workers.map((worker) => [worker.id, worker.health, worker.openHold]), [["worker-a", "NEVER", true]]);
      const accountA = overview.accounts.find((item) => item.id === "account-a");
      assert.ok(Number(accountA?.sync.closePending) > 0);
      assert.equal(accountA?.sync.heldOpen, accountA?.sync.openPending);
      assert.equal(overview.unclosedOccurrences, overview.accounts.reduce((sum, item) => sum + item.sync.closePending, 0));
      assert.ok(Number(accountA?.sync.overdue) > 0);
      assert.deepEqual(overview.incidents.filter((item) => item.subjectType === "worker").map((item) => [item.kind, item.escalated]), [["WORKER_STALE", true]]);
      assert.doesNotMatch(JSON.stringify(overview), /external-a|external-b|credential|digest|profile/i);

      // The Studio returns: the stale incident resolves, but the hold stays until reservations are re-read.
      const claimed = await runtime.claim(workerA);
      if (claimed) {
        await runtime.submitResult(workerA, claimed.id, { resultId: randomUUID(), leaseToken: claimed.leaseToken, outcome: "SUPERSEDED", stopped: true, target: claimed.target });
      }
      assert.equal((await runtime.hostStatuses(owner)).some((item) => item.site === "Airbnb" && item.error === "WORKER_STALE"), false);
      const recovered = await runtime.runWatchdog();
      assert.deepEqual(recovered.transitions.filter((item) => item.kind === "WORKER_STALE").map((item) => item.transition), ["resolved"]);
      assert.equal((await pool.query("SELECT resolution FROM channel_runtime_incidents WHERE kind='WORKER_STALE'")).rows[0]?.resolution, "AUTO_RECOVERED");
      assert.notEqual(await holdSince(pool, "worker-a"), null);

      await pool.query(
        `UPDATE channel_desired_states SET observed_state=desired_state,observed_desired_version=desired_version,
           observed_mapping_version=mapping_version,last_verified_at=$1 WHERE listing_id='listing-a'`, [clock.now],
      );
      assert.deepEqual((await runtime.runWatchdog()).transitions.map((item) => [item.kind, item.transition]), [["SYNC_OVERDUE", "resolved"]]);

      // Quarantine opens, escalates after 60 minutes, takes an owner, and resolves when cleared.
      const version = Number((await pool.query("SELECT version FROM channel_external_accounts WHERE id='account-a'")).rows[0]?.version);
      await runtime.pauseAccount(admin, "account-a", version, randomUUID());
      const paused = await runtime.runWatchdog();
      assert.deepEqual(paused.transitions.map((item) => [item.kind, item.transition, item.detail.reason]), [["ACCOUNT_QUARANTINED", "opened", "MANUAL_HANDLING"]]);
      const incidentId = paused.transitions[0]!.incidentId;
      await assert.rejects(() => runtime.acknowledgeIncident(admin, "not-a-number", randomUUID()), StoreValidationError);
      await assert.rejects(() => runtime.acknowledgeIncident(admin, "999999", randomUUID()), StoreNotFoundError);
      const ackCommand = randomUUID();
      const acknowledged = await runtime.acknowledgeIncident(admin, incidentId, ackCommand);
      assert.deepEqual(await runtime.acknowledgeIncident(admin, incidentId, ackCommand), acknowledged);
      await assert.rejects(() => runtime.acknowledgeIncident(otherAdmin, incidentId, ackCommand), StoreConflictError);
      const mine = (await runtime.runtimeOverview(admin, "provider-a")).incidents.find((item) => item.id === incidentId);
      const theirs = (await runtime.runtimeOverview(otherAdmin, "provider-a")).incidents.find((item) => item.id === incidentId);
      assert.deepEqual([mine?.acknowledged, mine?.assignedToMe, theirs?.acknowledged, theirs?.assignedToMe], [true, true, true, false]);
      clock.now = new Date(clock.now.getTime() + 61 * 60_000);
      const later = await runtime.runWatchdog();
      assert.ok(later.transitions.some((item) => item.kind === "ACCOUNT_QUARANTINED" && item.transition === "escalated" && item.incidentId === incidentId));
      assert.equal(await openIncidents(pool, "ACCOUNT_QUARANTINED"), 1);
      await pool.query("UPDATE channel_external_accounts SET quarantined_at=NULL,quarantine_reason=NULL WHERE id='account-a'");
      assert.ok((await runtime.runWatchdog()).transitions.some((item) => item.kind === "ACCOUNT_QUARANTINED" && item.transition === "resolved"));
      await assert.rejects(() => runtime.acknowledgeIncident(admin, incidentId, randomUUID()), StoreConflictError);
      const notified = (await pool.query("SELECT notified_open_at,notified_escalated_at,notified_resolved_at FROM channel_runtime_incidents WHERE id=$1::bigint", [incidentId])).rows[0];
      assert.ok(notified?.notified_open_at && notified.notified_escalated_at && notified.notified_resolved_at);

      // A halted reservation reader is overdue until the listing stops reading reservations.
      await pool.query(
        `INSERT INTO external_reservation_read_dispatch_states (provider_id,listing_id,account_id,product_id,next_due_at,last_error,halted_at,created_at,updated_at)
         VALUES ('provider-a','listing-a','account-a','tea',$1,'READ_INCOMPLETE',$1,$1,$1)`, [clock.now],
      );
      const reads = await runtime.runWatchdog();
      const readIncident = reads.transitions.find((item) => item.kind === "RESERVATION_READ_OVERDUE");
      assert.deepEqual([readIncident?.transition, readIncident?.detail.halted], ["opened", 1]);
      await pool.query("UPDATE channel_listings SET can_read_reservations=false WHERE id='listing-a'");
      assert.ok((await runtime.runWatchdog()).transitions.some((item) => item.kind === "RESERVATION_READ_OVERDUE" && item.transition === "resolved"));
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM channel_watchdog_state")).rows[0]?.count, 1);

      clock.now = new Date(clock.now.getTime() + 6 * 60_000);
      assert.equal((await runtime.runtimeOverview(admin, "provider-a")).watchdogStale, true);
    });
  });
});
