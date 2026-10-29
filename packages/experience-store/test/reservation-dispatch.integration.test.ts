import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import type { ScheduleRule } from "@niho-experience/experience-domain";
import { ChannelRuntime, type ClaimedChannelJob } from "../src/channels.ts";
import { StoreValidationError } from "../src/errors.ts";
import { ExperienceStore } from "../src/repository.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe("PostgreSQL reservation read dispatch", { skip: databaseUrl === undefined }, () => {
  it("runs repeated cycles, keeps worker scope, and applies terminal evidence and backoff atomically", { timeout: 60_000 }, async () => {
    const { Pool } = await import("pg");
    const schema = `reservation_dispatch_test_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema}` });
    let schemaCreated = false;
    let now = new Date("2099-01-01T00:00:00.000Z");
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      schemaCreated = true;
      const migrations = (await readdir(new URL("../migrations/", import.meta.url)))
        .filter((name) => /^\d{4}.*\.sql$/.test(name)).sort();
      for (const name of migrations) await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));

      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a'),('provider-b')");
      await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES ('provider-a','owner-a','OWNER'),('provider-b','owner-b','OWNER')");
      for (const [providerId, productId] of [
        ["provider-a", "tea"], ["provider-a", "no-anchor"], ["provider-a", "unsupported"], ["provider-b", "walk"],
      ] as const) {
        await pool.query(
          `INSERT INTO experience_products
            (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,
             seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
           VALUES ($1,$2,$3,'PUBLISHED',$2,'{}','JPY',1000,'terms','seller','acct_synthetic','Synthetic Seller')`,
          [providerId, productId, `${providerId}-${productId}`],
        );
      }
      const store = new ExperienceStore(pool);
      const rule = (id: string): ScheduleRule => ({
        id, timeZone: "Asia/Tokyo", startsOn: "2099-01-01", endsOn: "2099-01-10", localStartTime: "10:00",
        durationMinutes: 60, capacity: 4, bookingCutoffMinutes: 0, busyBufferBeforeMinutes: 0,
        busyBufferAfterMinutes: 0, recurrence: { kind: "DAILY" },
      });
      await store.saveScheduleRule({ providerId: "provider-a", nihoUserId: "owner-a" }, "tea", rule("tea-rule"), null, randomUUID());
      await store.saveScheduleRule({ providerId: "provider-b", nihoUserId: "owner-b" }, "walk", rule("walk-rule"), null, randomUUID());

      const runtime = new ChannelRuntime(pool, {
        now: () => now,
        supportedAdapters: {
          "Airbnb/browser-v1@1": { canObserve: true, canReadReservations: true },
        },
      });
      const admin = { nihoUserId: "admin-a" };
      for (const [providerId, accountId, externalAccountId] of [
        ["provider-a", "account-a", "external-a"], ["provider-b", "account-b", "external-b"],
      ] as const) {
        await runtime.createExternalAccount(admin, {
          id: accountId, providerId, site: "Airbnb", externalAccountId, displayName: `Synthetic ${accountId}`,
          operatingModel: 2, active: true, delegatedUntilUtc: "2099-03-01T00:00:00.000Z",
        }, randomUUID());
      }
      const createListing = (input: {
        id: string; providerId: string; accountId: string; productId: string; externalProductId: string; canReadReservations: boolean;
      }) => runtime.createListing(admin, {
        id: input.id, providerId: input.providerId, accountId: input.accountId, productId: input.productId,
        externalProductId: input.externalProductId,
        externalOptionId: "morning", adapter: "browser-v1", adapterVersion: "1", connectionMode: "BROWSER",
        capabilities: { canObserve: true, canReadReservations: input.canReadReservations }, active: true,
      }, randomUUID());
      await createListing({ id: "listing-a", providerId: "provider-a", accountId: "account-a", productId: "tea", externalProductId: "tea-external", canReadReservations: true });
      await createListing({ id: "listing-no-anchor", providerId: "provider-a", accountId: "account-a", productId: "no-anchor", externalProductId: "none", canReadReservations: true });
      await createListing({ id: "listing-unsupported", providerId: "provider-a", accountId: "account-a", productId: "unsupported", externalProductId: "unsupported", canReadReservations: false });
      await createListing({ id: "listing-b", providerId: "provider-b", accountId: "account-b", productId: "walk", externalProductId: "walk-external", canReadReservations: true });
      // Undeployed readers must be filtered before the bounded candidate limit;
      // otherwise these four earlier IDs starve the actual limit=1 reader.
      for (let index = 0; index < 4; index += 1) {
        const id = `aaa-undeployed-${index}`;
        await createListing({ id, providerId: "provider-a", accountId: "account-a", productId: "unsupported", externalProductId: id, canReadReservations: true });
        await pool.query("UPDATE channel_listings SET adapter_version='unreleased' WHERE id=$1", [id]);
      }
      await runtime.reconcileListing(admin, "listing-a", randomUUID());
      await runtime.reconcileListing(admin, "listing-b", randomUUID());
      await store.saveScheduleRule({ providerId: "provider-a", nihoUserId: "owner-a" }, "tea",
        { ...rule("tea-rule"), startsOn: "2099-01-02" }, 1, randomUUID());
      await runtime.reconcileListing(admin, "listing-a", randomUUID());
      assert.equal((await pool.query(
        "SELECT count(*)::int AS count FROM channel_desired_states WHERE listing_id='listing-a' AND source_start_at='2099-01-01T01:00:00Z'",
      )).rows[0]?.count, 1);

      const credentialA = await runtime.mintWorkerCredential(admin, "worker-a", "Synthetic A", "2099-03-01T00:00:00.000Z", null, randomUUID());
      const credentialB = await runtime.mintWorkerCredential(admin, "worker-b", "Synthetic B", "2099-03-01T00:00:00.000Z", null, randomUUID());
      await runtime.assignWorkerAccount(admin, "worker-a", "account-a", null, randomUUID());
      await runtime.assignWorkerAccount(admin, "worker-b", "account-b", null, randomUUID());
      const workerA = await runtime.authenticateWorker(credentialA.bearerToken);
      const workerB = await runtime.authenticateWorker(credentialB.bearerToken);

      const initial = await Promise.all([
        runtime.enqueueDueReservationReads(workerA, 1),
        runtime.enqueueDueReservationReads(workerA, 1),
        runtime.enqueueDueReservationReads(workerB, 10),
      ]);
      assert.equal(initial[0]!.enqueued + initial[1]!.enqueued, 1);
      assert.equal(initial[2]!.enqueued, 1);
      assert.equal(new Date((await pool.query(
        "SELECT source_start_at FROM channel_jobs WHERE listing_id='listing-a' AND purpose='RESERVATION_WINDOW'",
      )).rows[0]?.source_start_at).toISOString(), "2099-01-02T01:00:00.000Z");
      assert.equal((await pool.query(
        "SELECT count(*)::int AS count FROM channel_jobs WHERE listing_id='listing-a' AND purpose='RESERVATION_WINDOW'",
      )).rows[0]?.count, 1);
      assert.equal((await pool.query(
        "SELECT last_error FROM external_reservation_read_dispatch_states WHERE listing_id='listing-no-anchor'",
      )).rows[0]?.last_error, "NO_CANONICAL_ANCHOR");
      assert.equal((await pool.query(
        "SELECT count(*)::int AS count FROM external_reservation_read_dispatch_states WHERE listing_id='listing-unsupported'",
      )).rows[0]?.count, 0);
      assert.equal((await pool.query(
        "SELECT count(*)::int AS count FROM external_reservation_read_dispatch_states WHERE listing_id LIKE 'aaa-undeployed-%'",
      )).rows[0]?.count, 0);

      // A stale job owned exclusively by worker B is outside worker A's mutation scope.
      await pool.query("UPDATE channel_listings SET external_option_id='changed' WHERE id='listing-b'");
      await runtime.enqueueDueReservationReads(workerA, 10);
      assert.equal((await pool.query(
        "SELECT status FROM channel_jobs WHERE listing_id='listing-b' AND purpose='RESERVATION_WINDOW'",
      )).rows[0]?.status, "QUEUED");
      await pool.query("UPDATE channel_listings SET external_option_id='morning' WHERE id='listing-b'");
      const listingB = (await runtime.listListings(admin, "provider-b"))[0]!;
      await runtime.updateListing(admin, listingB.id, {
        externalProductId: listingB.externalProductId,
        ...(listingB.externalOptionId === undefined ? {} : { externalOptionId: listingB.externalOptionId }),
        adapter: listingB.adapter, adapterVersion: listingB.adapterVersion, connectionMode: listingB.connectionMode,
        capabilities: listingB.capabilities, active: true,
      }, listingB.mappingVersion, randomUUID());
      await runtime.reconcileListing(admin, listingB.id, randomUUID());
      assert.equal((await pool.query(
        "SELECT pending_job_id FROM external_reservation_read_dispatch_states WHERE listing_id='listing-b'",
      )).rows[0]?.pending_job_id, null);
      assert.equal((await runtime.enqueueDueReservationReads(workerB, 10)).enqueued, 1);
      assert.equal((await pool.query(
        "SELECT count(*)::int AS count FROM channel_jobs WHERE listing_id='listing-b' AND purpose='RESERVATION_WINDOW'",
      )).rows[0]?.count, 2);
      await runtime.revokeWorkerAccount(admin, "worker-b", "account-b", 1, randomUUID());
      assert.equal((await runtime.enqueueDueReservationReads(workerB, 10)).enqueued, 0);
      assert.equal((await pool.query(
        "SELECT pending_job_id FROM external_reservation_read_dispatch_states WHERE listing_id='listing-b'",
      )).rows[0]?.pending_job_id, null);
      assert.equal((await pool.query(
        "SELECT status FROM channel_jobs WHERE listing_id='listing-b' AND purpose='RESERVATION_WINDOW' ORDER BY dispatch_sequence DESC LIMIT 1",
      )).rows[0]?.status, "FINISHED");

      // Availability work is independent; remove it only from this isolated dispatch fixture.
      await pool.query("UPDATE channel_jobs SET status='FINISHED',outcome='SUPERSEDED' WHERE purpose='AVAILABILITY' AND status='QUEUED'");
      const first = await runtime.claim(workerA);
      assertReservationJob(first);
      const firstCycle = await runtime.beginReservationWindowRead(workerA, first.id, first.leaseToken);
      const firstPage = {
        receiptId: firstCycle.receiptId, readId: firstCycle.readId, leaseToken: first.leaseToken, pageNumber: 0,
        observations: [], terminal: { status: "COMPLETE" as const, completedAtUtc: now.toISOString(),
          allPagesRead: true, allStatusesIncluded: true, coverageComplete: true },
      };
      const firstReceipt = await runtime.submitReservationWindowPage(workerA, first.id, firstPage);
      assert.equal(firstReceipt.healthUpdated, true);
      assert.deepEqual(await runtime.submitReservationWindowPage(workerA, first.id, firstPage), { ...firstReceipt, repeated: true });
      await assert.rejects(() => runtime.submitReservationWindowPage(workerA, first.id, {
        ...firstPage, snapshotToken: "changed-replay",
      }));
      const firstResult = {
        resultId: randomUUID(), leaseToken: first.leaseToken, outcome: "RESERVATION_VERIFIED" as const, stopped: true,
        target: first.target, reservationReadId: firstCycle.readId, reservationReceiptId: firstReceipt.receiptId,
      };
      assert.deepEqual(await runtime.submitResult(workerA, first.id, firstResult), { acceptedAsCurrent: true, repeated: false });
      assert.deepEqual(await runtime.submitResult(workerA, first.id, firstResult), { acceptedAsCurrent: true, repeated: true });
      const observedBefore = await pool.query(
        "SELECT occurrence_id,observed_state,last_verified_at FROM channel_desired_states WHERE listing_id='listing-a' ORDER BY occurrence_id",
      );

      now = new Date(now.getTime() + 14 * 60_000 + 59_000);
      assert.equal((await runtime.enqueueDueReservationReads(workerA, 10)).enqueued, 0);
      now = new Date(now.getTime() + 1_000);
      assert.equal((await runtime.enqueueDueReservationReads(workerA, 10)).enqueued, 1);
      const second = await runtime.claim(workerA);
      assertReservationJob(second);
      await assert.rejects(() => runtime.submitResult(workerA, second.id, {
        resultId: randomUUID(), leaseToken: second.leaseToken, outcome: "VERIFIED", stopped: true, target: second.target,
        occurrenceId: second.occurrenceId, sourceStartAtUtc: second.sourceStartAtUtc, sourceEndAtUtc: second.sourceEndAtUtc,
        observedState: "OPEN", observedBookable: true, observedManuallyBlocked: false, observedAtUtc: now.toISOString(),
      }), StoreValidationError);
      assert.equal((await pool.query("SELECT status FROM channel_jobs WHERE id=$1::uuid", [second.id])).rows[0]?.status, "LEASED");
      const retryResult = { resultId: randomUUID(), leaseToken: second.leaseToken, outcome: "RETRY_WAIT" as const,
        stopped: true, target: second.target };
      assert.deepEqual(await runtime.submitResult(workerA, second.id, retryResult), { acceptedAsCurrent: false, repeated: false });
      assert.deepEqual(await runtime.submitResult(workerA, second.id, retryResult), { acceptedAsCurrent: false, repeated: true });
      const retryState = (await pool.query(
        "SELECT retry_count,next_due_at FROM external_reservation_read_dispatch_states WHERE listing_id='listing-a'",
      )).rows[0];
      assert.equal(retryState?.retry_count, 1);
      assert.equal(new Date(String(retryState?.next_due_at)).toISOString(), new Date(now.getTime() + 60_000).toISOString());

      now = new Date(now.getTime() + 59_000);
      assert.equal((await runtime.enqueueDueReservationReads(workerA, 10)).enqueued, 0);
      now = new Date(now.getTime() + 1_000);
      assert.equal((await runtime.enqueueDueReservationReads(workerA, 10)).enqueued, 1);
      const third = await runtime.claim(workerA);
      assertReservationJob(third);
      assert.equal((await runtime.enqueueDueReservationReads(workerA, 10)).enqueued, 0);
      assert.equal((await pool.query(
        "SELECT pending_job_id::text FROM external_reservation_read_dispatch_states WHERE listing_id='listing-a'",
      )).rows[0]?.pending_job_id, third.id);

      const thirdCycle = await runtime.beginReservationWindowRead(workerA, third.id, third.leaseToken);
      // A synthetic higher health generation makes this otherwise COMPLETE page unable to advance health.
      await pool.query("UPDATE external_reservation_listing_health SET read_generation=999 WHERE listing_id='listing-a'");
      const falseComplete = await runtime.submitReservationWindowPage(workerA, third.id, {
        receiptId: thirdCycle.receiptId, readId: thirdCycle.readId, leaseToken: third.leaseToken, pageNumber: 0,
        observations: [], terminal: { status: "COMPLETE", completedAtUtc: now.toISOString(),
          allPagesRead: true, allStatusesIncluded: true, coverageComplete: true },
      });
      assert.equal(falseComplete.healthUpdated, false);
      const rejectedComplete = await runtime.submitResult(workerA, third.id, {
        resultId: randomUUID(), leaseToken: third.leaseToken, outcome: "RESERVATION_VERIFIED", stopped: true,
        target: third.target, reservationReadId: thirdCycle.readId, reservationReceiptId: falseComplete.receiptId,
      });
      assert.equal(rejectedComplete.acceptedAsCurrent, false);
      const halted = (await pool.query(
        "SELECT pending_job_id,halted_at,last_error FROM external_reservation_read_dispatch_states WHERE listing_id='listing-a'",
      )).rows[0];
      assert.equal(halted?.pending_job_id, null);
      assert.ok(halted?.halted_at);
      assert.equal(halted?.last_error, "INVALID_COMPLETE_PROOF");
      assert.ok((await pool.query(
        "SELECT quarantined_at FROM channel_external_accounts WHERE id='account-a'",
      )).rows[0]?.quarantined_at);

      const sequences = await pool.query(
        "SELECT dispatch_sequence FROM channel_jobs WHERE listing_id='listing-a' AND purpose='RESERVATION_WINDOW' ORDER BY dispatch_sequence",
      );
      assert.deepEqual(sequences.rows.map((row) => Number(row.dispatch_sequence)), [1, 2, 3]);
      const observedAfter = await pool.query(
        "SELECT occurrence_id,observed_state,last_verified_at FROM channel_desired_states WHERE listing_id='listing-a' ORDER BY occurrence_id",
      );
      assert.deepEqual(observedAfter.rows, observedBefore.rows);

      // Deployment support, delegation, and revocation each gate a fresh listing.
      await runtime.createExternalAccount(admin, {
        id: "account-c", providerId: "provider-a", site: "Airbnb", externalAccountId: "external-c",
        displayName: "Synthetic C", operatingModel: 2, active: true, delegatedUntilUtc: "2099-03-01T00:00:00.000Z",
      }, randomUUID());
      await createListing({ id: "listing-c", providerId: "provider-a", accountId: "account-c", productId: "tea", externalProductId: "tea-c", canReadReservations: true });
      await runtime.reconcileListing(admin, "listing-c", randomUUID());
      await runtime.assignWorkerAccount(admin, "worker-a", "account-c", null, randomUUID());
      await pool.query("UPDATE channel_jobs SET status='FINISHED',outcome='SUPERSEDED' WHERE listing_id='listing-c' AND purpose='AVAILABILITY' AND status='QUEUED'");
      const observeOnlyDeployment = new ChannelRuntime(pool, {
        now: () => now, supportedAdapters: { "Airbnb/browser-v1@1": { canObserve: true } },
      });
      assert.equal((await observeOnlyDeployment.enqueueDueReservationReads(workerA, 10)).enqueued, 0);
      assert.equal((await runtime.enqueueDueReservationReads(workerA, 10)).enqueued, 1);
      await pool.query("UPDATE channel_external_accounts SET delegated_until=$2 WHERE id=$1", ["account-c", now]);
      assert.equal((await runtime.enqueueDueReservationReads(workerA, 10)).enqueued, 0);
      assert.equal((await pool.query(
        "SELECT pending_job_id FROM external_reservation_read_dispatch_states WHERE listing_id='listing-c'",
      )).rows[0]?.pending_job_id, null);
      await pool.query("UPDATE channel_external_accounts SET delegated_until='2099-03-01T00:00:00.000Z' WHERE id='account-c'");
      assert.equal((await runtime.enqueueDueReservationReads(workerA, 10)).enqueued, 1);
      const accountC = (await runtime.listExternalAccounts(admin, "provider-a")).find((account) => account.id === "account-c")!;
      await runtime.updateExternalAccount(admin, accountC.id, {
        site: accountC.site, externalAccountId: accountC.externalAccountId, displayName: accountC.displayName,
        operatingModel: accountC.operatingModel, active: true,
        delegatedUntilUtc: "2099-03-01T00:00:00.000Z", revokedAtUtc: now.toISOString(),
      }, accountC.version, randomUUID());
      assert.equal((await pool.query(
        "SELECT pending_job_id FROM external_reservation_read_dispatch_states WHERE listing_id='listing-c'",
      )).rows[0]?.pending_job_id, null);
      assert.equal((await runtime.enqueueDueReservationReads(workerA, 10)).enqueued, 0);

      // stopped=false and lease expiry retain the existing lease until a stopped late result proves shutdown.
      await runtime.createExternalAccount(admin, {
        id: "account-d", providerId: "provider-a", site: "Airbnb", externalAccountId: "external-d",
        displayName: "Synthetic D", operatingModel: 2, active: true, delegatedUntilUtc: "2099-03-01T00:00:00.000Z",
      }, randomUUID());
      await createListing({ id: "listing-d", providerId: "provider-a", accountId: "account-d", productId: "tea", externalProductId: "tea-d", canReadReservations: true });
      await runtime.reconcileListing(admin, "listing-d", randomUUID());
      await runtime.assignWorkerAccount(admin, "worker-a", "account-d", null, randomUUID());
      await pool.query("UPDATE channel_jobs SET status='FINISHED',outcome='SUPERSEDED' WHERE listing_id='listing-d' AND purpose='AVAILABILITY' AND status='QUEUED'");
      assert.equal((await runtime.enqueueDueReservationReads(workerA, 10)).enqueued, 1);
      const unsafe = await runtime.claim(workerA);
      assertReservationJob(unsafe);
      assert.equal((await runtime.submitResult(workerA, unsafe.id, {
        resultId: randomUUID(), leaseToken: unsafe.leaseToken, outcome: "RETRY_WAIT", stopped: false, target: unsafe.target,
      })).acceptedAsCurrent, false);
      assert.equal((await runtime.enqueueDueReservationReads(workerA, 10)).enqueued, 0);
      assert.equal((await pool.query("SELECT status FROM channel_jobs WHERE id=$1::uuid", [unsafe.id])).rows[0]?.status, "LEASED");
      assert.equal((await pool.query(
        "SELECT pending_job_id::text FROM external_reservation_read_dispatch_states WHERE listing_id='listing-d'",
      )).rows[0]?.pending_job_id, unsafe.id);
      now = new Date(now.getTime() + 121_000);
      assert.equal((await runtime.submitResult(workerA, unsafe.id, {
        resultId: randomUUID(), leaseToken: unsafe.leaseToken, outcome: "RETRY_WAIT", stopped: true, target: unsafe.target,
      })).acceptedAsCurrent, false);
      const late = (await pool.query(
        "SELECT pending_job_id,halted_at,last_error FROM external_reservation_read_dispatch_states WHERE listing_id='listing-d'",
      )).rows[0];
      assert.equal(late?.pending_job_id, null);
      assert.ok(late?.halted_at);
      assert.equal(late?.last_error, "LATE_RESULT");

      // Staff confirms the old executor stopped, then the existing availability
      // observer verifies the recovered session. Only that explicit recovery
      // resumes readers; their inventory health is still stale until re-read.
      async function recoverAndObserve(accountId: string) {
        await pool.query("UPDATE channel_jobs SET status='FINISHED',outcome='SUPERSEDED' WHERE purpose='AVAILABILITY' AND status='QUEUED'");
        const recovery = await runtime.recoverQuarantinedLease(admin, accountId, true, randomUUID());
        const waiting = (await pool.query(
          "SELECT pending_job_id,halted_at FROM external_reservation_read_dispatch_states WHERE account_id=$1", [accountId],
        )).rows[0];
        assert.equal(waiting?.pending_job_id, null);
        assert.ok(waiting?.halted_at);
        const recoveryJob = await runtime.claim(workerA);
        assert.ok(recoveryJob);
        assert.equal(recoveryJob.id, recovery.observeJobId);
        assert.equal(recoveryJob.purpose, undefined);
        assert.equal((await runtime.submitResult(workerA, recoveryJob.id, {
          resultId: randomUUID(), leaseToken: recoveryJob.leaseToken, outcome: "VERIFIED", stopped: true, target: recoveryJob.target,
          occurrenceId: recoveryJob.occurrenceId, sourceStartAtUtc: recoveryJob.sourceStartAtUtc, sourceEndAtUtc: recoveryJob.sourceEndAtUtc,
          observedState: "OPEN", observedBookable: true, observedManuallyBlocked: false, observedAtUtc: now.toISOString(),
        })).acceptedAsCurrent, true);
      }
      await recoverAndObserve("account-d");
      const recovered = (await pool.query(
        "SELECT pending_job_id,halted_at,last_error FROM external_reservation_read_dispatch_states WHERE listing_id='listing-d'",
      )).rows[0];
      assert.equal(recovered?.pending_job_id, null);
      assert.equal(recovered?.halted_at, null);
      assert.equal(recovered?.last_error, null);
      assert.ok((await runtime.enqueueDueReservationReads(workerA, 10)).enqueued >= 1);
      const lostResultJob = await runtime.claim(workerA);
      assertReservationJob(lostResultJob);
      await runtime.submitResult(workerA, lostResultJob.id, {
        resultId: randomUUID(), leaseToken: lostResultJob.leaseToken, outcome: "RETRY_WAIT", stopped: false, target: lostResultJob.target,
      });
      // No later stopped=true response ever arrives from this worker. Staff's
      // explicit stop confirmation must release the old pending reference.
      assert.equal((await pool.query(
        "SELECT pending_job_id::text FROM external_reservation_read_dispatch_states WHERE listing_id='listing-d'",
      )).rows[0]?.pending_job_id, lostResultJob.id);
      await recoverAndObserve("account-d");
      assert.equal((await pool.query(
        "SELECT halted_at FROM external_reservation_read_dispatch_states WHERE listing_id='listing-d'",
      )).rows[0]?.halted_at, null);
      assert.equal((await runtime.enqueueDueReservationReads(workerA, 10)).enqueued, 1);
    } finally {
      if (schemaCreated) await pool.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => {});
      await pool.end();
    }
  });
});

function assertReservationJob(job: ClaimedChannelJob | null): asserts job is ClaimedChannelJob {
  assert.ok(job);
  assert.equal(job.purpose, "RESERVATION_WINDOW");
  assert.equal(job.action, "OBSERVE");
}
