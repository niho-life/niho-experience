import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { expandOccurrences, occurrenceIdFor, type ScheduleRule } from "@niho-experience/experience-domain";
import { ChannelRuntime, type ClaimedChannelJob, type ExternalReservationObservation } from "../src/channels.ts";
import { StoreAccessDeniedError, StoreConflictError } from "../src/errors.ts";
import { evaluateStoredInventory } from "../src/inventory.ts";
import { ExperienceStore } from "../src/repository.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const target = {
  site: "Airbnb", externalAccountId: "synthetic-account", externalProductId: "synthetic-tea", externalOptionId: "morning",
  timeZone: "Asia/Tokyo" as const, adapter: "browser-v1", adapterVersion: "1", connectionMode: "BROWSER" as const,
};

describe("PostgreSQL external reservation ledger", { skip: databaseUrl === undefined }, () => {
  it("keeps read generations, receipts, tombstones, movement, and shared inventory atomic", { timeout: 60_000 }, async () => {
    const { Pool } = await import("pg");
    const schema = `external_reservation_test_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: databaseUrl, max: 6, options: `-c search_path=${schema}` });
    let schemaCreated = false;
    const now = new Date("2099-01-01T00:00:00.000Z");
    let releasePausedHold = () => {};
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      schemaCreated = true;
      const migrations = (await readdir(new URL("../migrations/", import.meta.url))).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort();
      for (const name of migrations) await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a')");
      await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES ('provider-a','owner-a','OWNER')");
      for (const [id, slug] of [["tea", "tea"], ["craft", "craft"], ["remote", "remote"], ["empty", "empty"]] as const) {
        await pool.query(
          `INSERT INTO experience_products
            (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
           VALUES ('provider-a',$1,$2,'PUBLISHED',$1,'{}','JPY',1000,'terms','seller','acct_synthetic','Synthetic Seller')`,
          [id, slug],
        );
      }
      const store = new ExperienceStore(pool);
      const owner = { providerId: "provider-a", nihoUserId: "owner-a" };
      const admin = { nihoUserId: "admin-a" };
      const rule = (id: string): ScheduleRule => ({
        id: `${id}-rule`, timeZone: "Asia/Tokyo", startsOn: "2099-01-01", endsOn: "2099-01-10", localStartTime: "10:00",
        durationMinutes: 60, capacity: 4, bookingCutoffMinutes: 0, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0,
        recurrence: { kind: "DAILY" },
      });
      for (const productId of ["tea", "craft", "remote", "empty"]) await store.saveScheduleRule(owner, productId, rule(productId), null, randomUUID());
      await store.saveScheduleRule(owner, "empty", {
        ...rule("empty-overnight"), localStartTime: "23:30", durationMinutes: 120,
      }, null, randomUUID());
      await store.saveInventoryResourceAsAdmin(admin, "provider-a", { id: "shared-room", kind: "VENUE", displayName: "Shared room", active: true }, null, randomUUID());
      await store.saveInventoryResourceAsAdmin(admin, "provider-a", { id: "remote-room", kind: "VENUE", displayName: "Remote room", active: true }, null, randomUUID());
      await store.saveInventoryResourceAsAdmin(admin, "provider-a", { id: "empty-room", kind: "VENUE", displayName: "Empty room", active: true }, null, randomUUID());
      for (const productId of ["tea", "craft"]) await store.saveProductInventorySettingAsAdmin(admin, "provider-a", productId, {
        bookingMode: "SEAT", resources: [{ resourceId: "shared-room", prepareMinutes: 15, cleanupMinutes: 15 }],
      }, null, randomUUID());
      await store.saveProductInventorySettingAsAdmin(admin, "provider-a", "remote", {
        bookingMode: "PRIVATE_GROUP", resources: [{ resourceId: "remote-room", prepareMinutes: 0, cleanupMinutes: 0 }],
      }, null, randomUUID());
      await store.saveProductInventorySettingAsAdmin(admin, "provider-a", "empty", {
        bookingMode: "SEAT", resources: [{ resourceId: "empty-room", prepareMinutes: 15, cleanupMinutes: 15 }],
      }, null, randomUUID());

      const runtime = new ChannelRuntime(pool, {
        now: () => now,
        supportedAdapters: { "Airbnb/browser-v1@1": { canObserve: true, canReadReservations: true, canClose: true, canOpen: true } },
      });
      await runtime.createExternalAccount(admin, {
        id: "account-a", providerId: "provider-a", site: "Airbnb", externalAccountId: target.externalAccountId,
        displayName: "Synthetic account", operatingModel: 2, active: true, delegatedUntilUtc: "2099-02-01T00:00:00.000Z",
      }, randomUUID());
      await runtime.createListing(admin, {
        id: "listing-tea", providerId: "provider-a", accountId: "account-a", productId: "tea",
        externalProductId: target.externalProductId, externalOptionId: target.externalOptionId, adapter: target.adapter,
        adapterVersion: target.adapterVersion, connectionMode: "BROWSER",
        capabilities: { canObserve: true, canReadReservations: true, canClose: true, canOpen: true }, active: true,
      }, randomUUID());
      await runtime.createListing(admin, {
        id: "listing-remote", providerId: "provider-a", accountId: "account-a", productId: "remote",
        externalProductId: "synthetic-remote", externalOptionId: "private", adapter: target.adapter,
        adapterVersion: target.adapterVersion, connectionMode: "BROWSER",
        capabilities: { canObserve: true, canReadReservations: true }, active: true,
      }, randomUUID());
      await runtime.createListing(admin, {
        id: "listing-empty", providerId: "provider-a", accountId: "account-a", productId: "empty",
        externalProductId: "synthetic-empty", externalOptionId: "empty", adapter: target.adapter,
        adapterVersion: target.adapterVersion, connectionMode: "BROWSER",
        capabilities: { canObserve: true, canReadReservations: true }, active: true,
      }, randomUUID());
      const credential = await runtime.mintWorkerCredential(admin, "worker-a", "Synthetic worker", "2099-02-01T00:00:00.000Z", null, randomUUID());
      await runtime.assignWorkerAccount(admin, "worker-a", "account-a", null, randomUUID());
      const worker = await runtime.authenticateWorker(credential.bearerToken);
      let desiredVersion = 0;

      async function claim(date: string, mapping: { listingId: string; productId: string; externalProductId: string; externalOptionId: string } = {
        listingId: "listing-tea", productId: "tea", externalProductId: target.externalProductId, externalOptionId: target.externalOptionId,
      }): Promise<ClaimedChannelJob> {
        // This ledger test explicitly selects the next read cycle. Leave jobs
        // produced by reconciliation queued, with lower priority than this read.
        await pool.query("UPDATE channel_jobs SET priority=1 WHERE status='QUEUED'");
        desiredVersion += 1;
        const occurrenceId = occurrenceIdFor(`${mapping.productId}-rule`, date);
        const start = `${date}T01:00:00.000Z`;
        const end = `${date}T02:00:00.000Z`;
        await pool.query(
          `INSERT INTO channel_desired_states
            (listing_id,provider_id,occurrence_id,desired_state,reason,desired_version,mapping_version,source_start_at,source_end_at)
           VALUES ($5,'provider-a',$1,'OPEN','SYNTHETIC',$2,1,$3,$4)
           ON CONFLICT (listing_id,occurrence_id) DO UPDATE SET desired_version=EXCLUDED.desired_version,
             desired_state='OPEN',source_start_at=EXCLUDED.source_start_at,source_end_at=EXCLUDED.source_end_at`,
          [occurrenceId, desiredVersion, start, end, mapping.listingId],
        );
        await pool.query(
          `INSERT INTO channel_jobs
            (id,provider_id,account_id,listing_id,occurrence_id,action,account_version,desired_version,mapping_version,
             target_site,target_external_account_id,target_external_product_id,target_external_option_id,target_time_zone,target_adapter,
             target_adapter_version,target_connection_mode,source_start_at,source_end_at,priority)
           VALUES ($1::uuid,'provider-a','account-a',$11,$2,'OBSERVE',1,$3,1,'Airbnb',$4,$5,$6,'Asia/Tokyo',$7,$8,'BROWSER',$9,$10,100)`,
          [randomUUID(), occurrenceId, desiredVersion, target.externalAccountId, mapping.externalProductId, mapping.externalOptionId,
            target.adapter, target.adapterVersion, start, end, mapping.listingId],
        );
        const leased = await runtime.claim(worker);
        assert.ok(leased);
        assert.equal(leased.action, "OBSERVE");
        return leased;
      }

      async function finish(job: ClaimedChannelJob): Promise<void> {
        await runtime.submitResult(worker, job.id, {
          resultId: randomUUID(), leaseToken: job.leaseToken, outcome: "VERIFIED", stopped: true, target: job.target,
          occurrenceId: job.occurrenceId, sourceStartAtUtc: job.sourceStartAtUtc, sourceEndAtUtc: job.sourceEndAtUtc,
          observedState: "OPEN", observedBookable: true, observedManuallyBlocked: false, observedAtUtc: now.toISOString(),
        });
      }

      async function submit(job: ClaimedChannelJob, observation: ExternalReservationObservation | undefined, receiptId = randomUUID()) {
        const read = await runtime.beginReservationRead(worker, job.id, job.leaseToken);
        assert.deepEqual(await runtime.beginReservationRead(worker, job.id, job.leaseToken), { ...read, repeated: true });
        const payload = {
          receiptId, readId: read.readId, leaseToken: job.leaseToken, batchStatus: "COMPLETE" as const,
          observations: observation ? [observation] : [],
        };
        const receipt = await runtime.submitReservationRead(worker, job.id, payload);
        return { read, payload, receipt };
      }

      const confirmed = (id: string, date: string, seats: number, sourceUpdatedAtUtc: string): ExternalReservationObservation => ({
        externalReservationId: id, externalProductId: target.externalProductId, externalOptionId: target.externalOptionId,
        sourceStartAtUtc: `${date}T01:00:00.000Z`, sourceEndAtUtc: `${date}T02:00:00.000Z`,
        status: "CONFIRMED", seats, sourceUpdatedAtUtc, sourceRevision: `opaque-${date}-${seats}-${sourceUpdatedAtUtc}`,
      });

      async function completeEmptyWindow(mapping: {
        listingId: string; productId: string; externalProductId: string; externalOptionId: string;
      }) {
        const job = await claim("2099-01-01", mapping);
        const read = await runtime.beginReservationWindowRead(worker, job.id, job.leaseToken);
        const receipt = await runtime.submitReservationWindowPage(worker, job.id, {
          receiptId: read.receiptId, readId: read.readId, leaseToken: job.leaseToken, pageNumber: 0, observations: [],
          terminal: { status: "COMPLETE", completedAtUtc: now.toISOString(), allPagesRead: true,
            allStatusesIncluded: true, coverageComplete: true },
        });
        assert.equal(receipt.healthUpdated, true);
        assert.equal(receipt.missingActiveReservations, 0);
        await finish(job);
        return { read, receipt };
      }

      const emptyMapping = {
        listingId: "listing-empty", productId: "empty", externalProductId: "synthetic-empty", externalOptionId: "empty",
      };
      const emptyOccurrence = expandOccurrences({ rule: rule("empty"), overrides: [], salesStates: [],
        fromDate: "2099-01-02", toDate: "2099-01-02" })[0]!;
      assert.equal((await evaluateStoredInventory(pool, "provider-a", "empty", emptyOccurrence,
        now.toISOString(), 1)).availability.reason, "EXTERNAL_RESERVATION_READ_UNAVAILABLE");
      const emptyHealthSeed = await completeEmptyWindow(emptyMapping);
      assert.equal(emptyHealthSeed.read.coverageFromUtc, "2098-12-28T15:00:00.000Z");
      assert.equal(emptyHealthSeed.read.coverageToUtc, "2099-02-28T15:00:00.000Z");
      assert.equal(Date.parse(emptyHealthSeed.read.coverageToUtc) - Date.parse(emptyHealthSeed.read.coverageFromUtc), 62 * 86_400_000);
      const overnightOccurrence = emptyHealthSeed.read.manifest.find((item) => item.occurrenceId.startsWith("empty-overnight-rule@"));
      assert.ok(overnightOccurrence);
      const jstDate = (utc: string) => new Date(Date.parse(utc) + 9 * 60 * 60_000).toISOString().slice(0, 10);
      assert.ok(jstDate(overnightOccurrence.sourceEndAtUtc) > jstDate(overnightOccurrence.sourceStartAtUtc));
      assert.equal((await evaluateStoredInventory(pool, "provider-a", "empty", emptyOccurrence,
        now.toISOString(), 1)).availability.bookable, true);
      await completeEmptyWindow({
        listingId: "listing-tea", productId: "tea", externalProductId: target.externalProductId, externalOptionId: target.externalOptionId,
      });
      await completeEmptyWindow({
        listingId: "listing-remote", productId: "remote", externalProductId: "synthetic-remote", externalOptionId: "private",
      });

      const firstJob = await claim("2099-01-01");
      const first = await submit(firstJob, confirmed("external-1", "2099-01-01", 2, "2099-01-01T00:30:00.000Z"));
      assert.equal(first.receipt.applied, 1);
      assert.equal((await runtime.submitReservationRead(worker, firstJob.id, first.payload)).repeated, true);
      const reorderedFirst = Object.fromEntries(Object.entries(first.payload.observations[0]!).reverse()) as unknown as ExternalReservationObservation;
      assert.equal((await runtime.submitReservationRead(worker, firstJob.id, { ...first.payload, observations: [reorderedFirst] })).repeated, true);
      await assert.rejects(() => runtime.submitReservationRead(worker, firstJob.id, {
        ...first.payload, observations: [{ ...first.payload.observations[0]!, seats: 3 }],
      }), StoreConflictError);
      await assert.rejects(() => runtime.submitReservationRead(worker, firstJob.id, { ...first.payload, receiptId: randomUUID() }), StoreConflictError);
      await finish(firstJob);
      const revisionCount = (await pool.query("SELECT count(*) FROM external_reservation_revisions")).rows[0]?.count;
      assert.equal((await runtime.submitReservationRead(worker, firstJob.id, first.payload)).repeated, true);
      assert.equal((await pool.query("SELECT count(*) FROM external_reservation_revisions")).rows[0]?.count, revisionCount);

      const emptyJob = await claim("2099-01-01");
      await submit(emptyJob, undefined);
      assert.equal((await pool.query("SELECT status FROM external_reservations WHERE external_reservation_id='external-1'")).rows[0]?.status, "CONFIRMED");
      await finish(emptyJob);

      const reorderedJob = await claim("2099-01-01");
      const reorderedRead = await submit(reorderedJob, reorderedFirst);
      assert.equal(reorderedRead.receipt.duplicates, 1);
      assert.equal(reorderedRead.receipt.needsReview, 0);
      assert.equal((await pool.query("SELECT needs_review FROM external_reservations WHERE external_reservation_id='external-1'")).rows[0]?.needs_review, false);
      await finish(reorderedJob);

      const generationSeedJob = await claim("2099-01-01");
      await submit(generationSeedJob, confirmed("generation-guard", "2099-01-01", 1, "2099-01-01T00:20:00.000Z"));
      await finish(generationSeedJob);
      const oldGenerationJob = await claim("2099-01-01");
      const oldGenerationRead = await runtime.beginReservationRead(worker, oldGenerationJob.id, oldGenerationJob.leaseToken);
      await pool.query("UPDATE external_reservations SET last_read_generation=$2 WHERE external_reservation_id=$1", ["generation-guard", oldGenerationRead.generation + 1]);
      const oldGenerationReceipt = await runtime.submitReservationRead(worker, oldGenerationJob.id, {
        receiptId: randomUUID(), readId: oldGenerationRead.readId, leaseToken: oldGenerationJob.leaseToken, batchStatus: "COMPLETE",
        observations: [confirmed("generation-guard", "2099-01-01", 4, "2099-01-01T00:40:00.000Z")],
      });
      assert.equal(oldGenerationReceipt.stale, 1);
      assert.equal(Number((await pool.query("SELECT seats FROM external_reservations WHERE external_reservation_id='generation-guard'")).rows[0]?.seats), 1);
      await finish(oldGenerationJob);

      const cancelJob = await claim("2099-01-01");
      const cancelled = { ...confirmed("cancel-first", "2099-01-01", 1, "2099-01-01T00:50:00.000Z"), status: "CANCELLED" as const };
      await submit(cancelJob, cancelled);
      await finish(cancelJob);
      const staleJob = await claim("2099-01-01");
      const staleReceipt = await submit(staleJob, confirmed("cancel-first", "2099-01-01", 1, "2099-01-01T00:40:00.000Z"));
      assert.equal(staleReceipt.receipt.stale, 1);
      assert.equal((await pool.query("SELECT status FROM external_reservations WHERE external_reservation_id='cancel-first'")).rows[0]?.status, "CANCELLED");
      await finish(staleJob);

      const conflictJob = await claim("2099-01-01");
      const conflict = await submit(conflictJob, confirmed("external-1", "2099-01-01", 3, "2099-01-01T00:30:00.000Z"));
      assert.equal(conflict.receipt.needsReview, 1);
      assert.equal((await pool.query("SELECT seats FROM external_reservations WHERE external_reservation_id='external-1'")).rows[0]?.seats, 2);
      await finish(conflictJob);

      const moveJob = await claim("2099-01-02");
      await submit(moveJob, confirmed("external-1", "2099-01-02", 3, "2099-01-02T00:30:00.000Z"));
      await finish(moveJob);
      const moved = (await pool.query("SELECT occurrence_id,seats,local_revision FROM external_reservations WHERE external_reservation_id='external-1'")).rows[0];
      assert.equal(moved?.occurrence_id, occurrenceIdFor("tea-rule", "2099-01-02"));
      assert.equal(Number(moved?.seats), 3);
      assert.equal(Number(moved?.local_revision), 2);
      assert.equal(Number((await pool.query("SELECT count(*) FROM external_reservation_inventory_snapshots WHERE external_reservation_id='external-1'")).rows[0]?.count), 2);
      const outboxIds = (await pool.query("SELECT aggregate_id FROM calendar_outbox_events WHERE payload->>'cause'='external_reservation_changed'")).rows.map((row) => row.aggregate_id);
      assert.ok(outboxIds.includes(occurrenceIdFor("tea-rule", "2099-01-01")));
      assert.ok(outboxIds.includes(occurrenceIdFor("tea-rule", "2099-01-02")));
      const mismatchedCancelJob = await claim("2099-01-02");
      const mismatchedCancel = await submit(mismatchedCancelJob, {
        ...confirmed("external-1", "2099-01-02", 3, "2099-01-02T00:40:00.000Z"),
        externalProductId: "wrong-product", status: "CANCELLED",
      });
      assert.equal(mismatchedCancel.receipt.needsReview, 1);
      const stillOccupied = (await pool.query("SELECT status,occurrence_id,local_revision FROM external_reservations WHERE external_reservation_id='external-1'")).rows[0];
      assert.equal(stillOccupied?.status, "CONFIRMED");
      assert.equal(stillOccupied?.occurrence_id, occurrenceIdFor("tea-rule", "2099-01-02"));
      assert.equal(Number(stillOccupied?.local_revision), 2);
      await finish(mismatchedCancelJob);
      const uncertainClient = await pool.connect();
      try {
        const remote = expandOccurrences({ rule: rule("remote"), overrides: [], salesStates: [], fromDate: "2099-01-02", toDate: "2099-01-02" })[0]!;
        assert.equal((await evaluateStoredInventory(uncertainClient, "provider-a", "remote", remote, now.toISOString(), 1)).availability.reason, "EXTERNAL_RESERVATION_UNRESOLVED");
      } finally { uncertainClient.release(); }
      const resolveJob = await claim("2099-01-02");
      await submit(resolveJob, confirmed("external-1", "2099-01-02", 3, "2099-01-02T00:50:00.000Z"));
      await finish(resolveJob);
      await assert.rejects(() => store.saveProductInventorySettingAsAdmin(admin, "provider-a", "tea", {
        bookingMode: "SEAT", resources: [{ resourceId: "shared-room", prepareMinutes: 0, cleanupMinutes: 0 }],
      }, 1, randomUUID()), StoreConflictError);
      await assert.rejects(() => store.saveScheduleRule(owner, "tea", { ...rule("tea"), capacity: 5 }, 1, randomUUID()), StoreConflictError);

      const teaOccurrence = expandOccurrences({ rule: rule("tea"), overrides: [], salesStates: [], fromDate: "2099-01-02", toDate: "2099-01-02" })[0]!;
      const craftOccurrence = expandOccurrences({ rule: rule("craft"), overrides: [], salesStates: [], fromDate: "2099-01-02", toDate: "2099-01-02" })[0]!;
      const remoteOccurrence = expandOccurrences({ rule: rule("remote"), overrides: [], salesStates: [], fromDate: "2099-01-02", toDate: "2099-01-02" })[0]!;
      const client = await pool.connect();
      try {
        assert.equal((await evaluateStoredInventory(client, "provider-a", "tea", teaOccurrence, now.toISOString(), 2)).availability.bookable, false);
        assert.equal((await evaluateStoredInventory(client, "provider-a", "craft", craftOccurrence, now.toISOString(), 1)).availability.bookable, false);
        assert.equal((await evaluateStoredInventory(client, "provider-a", "remote", remoteOccurrence, now.toISOString(), 1)).availability.bookable, true);
      } finally { client.release(); }

      const privateJob = await claim("2099-01-02", {
        listingId: "listing-remote", productId: "remote", externalProductId: "synthetic-remote", externalOptionId: "private",
      });
      const privateObservation: ExternalReservationObservation = {
        externalReservationId: "private-1", externalProductId: "synthetic-remote", externalOptionId: "private",
        sourceStartAtUtc: "2099-01-02T01:00:00.000Z", sourceEndAtUtc: "2099-01-02T02:00:00.000Z",
        status: "PENDING", seats: 3, sourceUpdatedAtUtc: "2099-01-02T00:10:00.000Z",
      };
      await submit(privateJob, privateObservation);
      await finish(privateJob);
      const privateClient = await pool.connect();
      try {
        const privateAvailability = await evaluateStoredInventory(privateClient, "provider-a", "remote", remoteOccurrence, now.toISOString(), 1);
        assert.equal(privateAvailability.bookingMode, "PRIVATE_GROUP");
        assert.equal(privateAvailability.availability.bookable, false);
      } finally { privateClient.release(); }

      const racingJob = await claim("2099-01-03");
      const racingRead = await runtime.beginReservationRead(worker, racingJob.id, racingJob.leaseToken);
      let resumeHold!: () => void;
      let holdInserted!: () => void;
      const holdPaused = new Promise<void>((resolve) => { holdInserted = resolve; });
      const holdResume = new Promise<void>((resolve) => { resumeHold = resolve; });
      releasePausedHold = () => resumeHold();
      let armed = true;
      const holdPool = new Proxy(pool, { get(targetPool, key) {
        if (key === "connect") return async () => {
          const connection = await targetPool.connect();
          return new Proxy(connection, { get(targetConnection, field) {
            if (field === "query") return async (...args: unknown[]) => {
              // Align only this fixture's INSERT expiry with the synthetic
              // runtime clock. Never mutate the immutable stored snapshot.
              if (typeof args[0] === "string" && args[0].includes("INSERT INTO bookings")) {
                args[0] = args[0].replace("clock_timestamp()+($7*interval '1 second')", "'2099-01-01T00:00:00.000Z'::timestamptz+($7*interval '1 second')");
              }
              const result = await Reflect.apply(targetConnection.query, targetConnection, args);
              if (armed && typeof args[0] === "string" && args[0].includes("INSERT INTO bookings")) {
                armed = false;
                holdInserted();
                await holdResume;
              }
              return result;
            };
            const value = Reflect.get(targetConnection, field);
            return typeof value === "function" ? value.bind(targetConnection) : value;
          } });
        };
        const value = Reflect.get(targetPool, key);
        return typeof value === "function" ? value.bind(targetPool) : value;
      } });
      const holdPending = new ExperienceStore(holdPool).createBookingHold({ providerId: "provider-a" }, {
        productId: "craft", occurrenceId: occurrenceIdFor("craft-rule", "2099-01-03"), seats: 1,
        idempotencyKey: "synthetic-direct-hold", holdSeconds: 3600,
      });
      await holdPaused;
      const racingPending = runtime.submitReservationRead(worker, racingJob.id, {
        receiptId: randomUUID(), readId: racingRead.readId, leaseToken: racingJob.leaseToken, batchStatus: "COMPLETE",
        observations: [confirmed("external-race", "2099-01-03", 1, "2099-01-03T00:10:00.000Z")],
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      resumeHold();
      const [, racingReceipt] = await Promise.all([holdPending, racingPending]);
      const racing = { receipt: racingReceipt };
      assert.equal(racing.receipt.applied, 1);
      assert.equal(racing.receipt.needsReview, 1);
      assert.equal(Number((await pool.query("SELECT count(*) FROM bookings WHERE idempotency_key='synthetic-direct-hold' AND status='HOLD'")).rows[0]?.count), 1);
      assert.equal((await pool.query("SELECT needs_review FROM external_reservations WHERE external_reservation_id='external-race'")).rows[0]?.needs_review, true);
      await finish(racingJob);
      const cancelRaceJob = await claim("2099-01-03");
      await submit(cancelRaceJob, { ...confirmed("external-race", "2099-01-03", 1, "2099-01-03T00:20:00.000Z"), status: "CANCELLED" });
      await finish(cancelRaceJob);
      const jan3Tea = expandOccurrences({ rule: rule("tea"), overrides: [], salesStates: [], fromDate: "2099-01-03", toDate: "2099-01-03" })[0]!;
      const afterCancelClient = await pool.connect();
      try {
        assert.equal((await evaluateStoredInventory(afterCancelClient, "provider-a", "tea", jan3Tea, now.toISOString(), 1)).availability.bookable, false);
      } finally { afterCancelClient.release(); }

      await pool.query(`CREATE FUNCTION fail_synthetic_external_revision() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.external_reservation_id='explode' THEN RAISE EXCEPTION 'synthetic mid-batch failure'; END IF; RETURN NEW; END $$`);
      await pool.query("CREATE TRIGGER fail_synthetic_external_revision BEFORE INSERT ON external_reservation_revisions FOR EACH ROW EXECUTE FUNCTION fail_synthetic_external_revision()");
      const rollbackJob = await claim("2099-01-04");
      const rollbackRead = await runtime.beginReservationRead(worker, rollbackJob.id, rollbackJob.leaseToken);
      await assert.rejects(() => runtime.submitReservationRead(worker, rollbackJob.id, {
        receiptId: randomUUID(), readId: rollbackRead.readId, leaseToken: rollbackJob.leaseToken, batchStatus: "COMPLETE",
        observations: [
          confirmed("rollback-first", "2099-01-04", 1, "2099-01-04T00:10:00.000Z"),
          confirmed("explode", "2099-01-04", 1, "2099-01-04T00:10:00.000Z"),
        ],
      }));
      assert.equal(Number((await pool.query("SELECT count(*) FROM external_reservations WHERE external_reservation_id IN ('rollback-first','explode')")).rows[0]?.count), 0);
      assert.equal(Number((await pool.query("SELECT count(*) FROM external_reservation_receipts WHERE read_id=$1", [rollbackRead.readId])).rows[0]?.count), 0);
      await finish(rollbackJob);

      await assert.rejects(() => runtime.updateExternalAccount(admin, "account-a", {
        site: "Airbnb", externalAccountId: "changed-account", displayName: "Synthetic account", operatingModel: 2,
        active: true, delegatedUntilUtc: "2099-02-01T00:00:00.000Z",
      }, 1, randomUUID()), StoreConflictError);

      const unmatchedJob = await claim("2099-01-06");
      const unmatched = await submit(unmatchedJob, confirmed("unmatched-new", "2099-01-07", 1, "2099-01-07T00:10:00.000Z"));
      assert.equal(unmatched.receipt.needsReview, 1);
      assert.equal((await pool.query("SELECT occurrence_id FROM external_reservations WHERE external_reservation_id='unmatched-new'")).rows[0]?.occurrence_id, null);
      await finish(unmatchedJob);
      await assert.rejects(() => store.saveOccurrenceOverride(owner, "remote", "remote-rule", {
        occurrenceId: occurrenceIdFor("remote-rule", "2099-01-09"), kind: "RESCHEDULE", localDate: "2099-01-09", localStartTime: "12:00",
      }, null, randomUUID()), StoreConflictError);
      const unresolvedClient = await pool.connect();
      try {
        const remote = expandOccurrences({ rule: rule("remote"), overrides: [], salesStates: [], fromDate: "2099-01-07", toDate: "2099-01-07" })[0]!;
        assert.equal((await evaluateStoredInventory(unresolvedClient, "provider-a", "remote", remote, now.toISOString(), 1)).availability.reason, "EXTERNAL_RESERVATION_UNRESOLVED");
      } finally { unresolvedClient.release(); }
      const matchingJob = await claim("2099-01-07");
      const matching = await submit(matchingJob, confirmed("unmatched-new", "2099-01-07", 1, "2099-01-07T00:10:00.000Z"));
      assert.equal(matching.receipt.applied, 1);
      assert.equal((await pool.query("SELECT occurrence_id FROM external_reservations WHERE external_reservation_id='unmatched-new'")).rows[0]?.occurrence_id, occurrenceIdFor("tea-rule", "2099-01-07"));
      await finish(matchingJob);

      const partialJob = await claim("2099-01-08");
      const partialRead = await runtime.beginReservationRead(worker, partialJob.id, partialJob.leaseToken);
      const partial = await runtime.submitReservationRead(worker, partialJob.id, {
        receiptId: randomUUID(), readId: partialRead.readId, leaseToken: partialJob.leaseToken, batchStatus: "PARTIAL",
        observations: [confirmed("partial-fact", "2099-01-08", 2, "2099-01-08T00:10:00.000Z")],
      });
      assert.equal(partial.batchStatus, "PARTIAL");
      assert.equal(partial.applied, 1);
      await finish(partialJob);
      const failedJob = await claim("2099-01-08");
      const failedRead = await runtime.beginReservationRead(worker, failedJob.id, failedJob.leaseToken);
      const failed = await runtime.submitReservationRead(worker, failedJob.id, {
        receiptId: randomUUID(), readId: failedRead.readId, leaseToken: failedJob.leaseToken, batchStatus: "FAILED", observations: [],
      });
      assert.equal(failed.batchStatus, "FAILED");
      assert.equal((await pool.query("SELECT status FROM external_reservations WHERE external_reservation_id='partial-fact'")).rows[0]?.status, "CONFIRMED");
      await finish(failedJob);

      const opaqueOnly: ExternalReservationObservation = {
        externalReservationId: "opaque-only", externalProductId: target.externalProductId, externalOptionId: target.externalOptionId,
        sourceStartAtUtc: "2099-01-09T01:00:00.000Z", sourceEndAtUtc: "2099-01-09T02:00:00.000Z",
        status: "CONFIRMED", seats: 1, sourceRevision: "source-version-one",
      };
      const opaqueSeed = await claim("2099-01-09");
      await submit(opaqueSeed, opaqueOnly);
      await finish(opaqueSeed);
      const opaqueConflict = await claim("2099-01-09");
      const contradictory = await submit(opaqueConflict, { ...opaqueOnly, status: "CANCELLED" });
      assert.equal(contradictory.receipt.needsReview, 1);
      assert.equal((await pool.query("SELECT status FROM external_reservations WHERE external_reservation_id='opaque-only'")).rows[0]?.status, "CONFIRMED");
      await finish(opaqueConflict);
      const opaqueRecovery = await claim("2099-01-09");
      assert.equal((await submit(opaqueRecovery, opaqueOnly)).receipt.applied, 1);
      assert.equal((await pool.query("SELECT needs_review FROM external_reservations WHERE external_reservation_id='opaque-only'")).rows[0]?.needs_review, false);
      await finish(opaqueRecovery);
      const wrongTarget = await claim("2099-01-09");
      assert.equal((await submit(wrongTarget, { ...opaqueOnly, externalProductId: "wrong-product", sourceRevision: "bad-target-version" })).receipt.needsReview, 1);
      assert.equal((await pool.query("SELECT review_reason FROM external_reservations WHERE external_reservation_id='opaque-only'")).rows[0]?.review_reason, "TARGET_MISMATCH");
      await finish(wrongTarget);
      const targetRecovery = await claim("2099-01-09");
      assert.equal((await submit(targetRecovery, opaqueOnly)).receipt.applied, 1);
      assert.equal((await pool.query("SELECT needs_review FROM external_reservations WHERE external_reservation_id='opaque-only'")).rows[0]?.needs_review, false);
      await finish(targetRecovery);
      const legitimateCancel = await claim("2099-01-09");
      assert.equal((await submit(legitimateCancel, { ...opaqueOnly, status: "CANCELLED", sourceRevision: "source-version-two" })).receipt.applied, 1);
      assert.equal((await pool.query("SELECT status FROM external_reservations WHERE external_reservation_id='opaque-only'")).rows[0]?.status, "CANCELLED");
      await finish(legitimateCancel);

      const teaHealthBeforePartial = (await pool.query(
        "SELECT read_id FROM external_reservation_listing_health WHERE listing_id='listing-tea'",
      )).rows[0]?.read_id;
      const windowJob = await claim("2099-01-10");
      const windowRead = await runtime.beginReservationWindowRead(worker, windowJob.id, windowJob.leaseToken);
      assert.equal(windowRead.scope, "WINDOW");
      assert.equal(windowRead.manifest.length, 10);
      assert.deepEqual(await runtime.beginReservationWindowRead(worker, windowJob.id, windowJob.leaseToken), { ...windowRead, repeated: true });
      const cancelledWindowFacts = Array.from({ length: 32 }, (_, index): ExternalReservationObservation => ({
        externalReservationId: `window-cancelled-${index}`,
        externalProductId: target.externalProductId,
        externalOptionId: target.externalOptionId,
        sourceStartAtUtc: "2099-01-01T01:00:00.000Z",
        sourceEndAtUtc: "2099-01-01T02:00:00.000Z",
        status: "CANCELLED",
        seats: 1,
        sourceRevision: `window-revision-${index}`,
      }));
      const firstWindowPage = {
        receiptId: windowRead.receiptId, readId: windowRead.readId, leaseToken: windowJob.leaseToken,
        pageNumber: 0, nextSourceCursor: "synthetic-page-two", snapshotToken: "opaque-snapshot-a", observations: cancelledWindowFacts,
      };
      const firstWindowReceipt = await runtime.submitReservationWindowPage(worker, windowJob.id, firstWindowPage);
      assert.equal(firstWindowReceipt.applied, 32);
      assert.ok(firstWindowReceipt.nextReceiptId);
      assert.equal((await runtime.submitReservationWindowPage(worker, windowJob.id, firstWindowPage)).repeated, true);
      const duplicateFact = cancelledWindowFacts[0]!;
      const terminalWindowPage = {
        receiptId: firstWindowReceipt.nextReceiptId!, readId: windowRead.readId, leaseToken: windowJob.leaseToken,
        pageNumber: 1, previousReceiptId: windowRead.receiptId, sourceCursor: "synthetic-page-two",
        snapshotToken: "opaque-snapshot-a",
        observations: [duplicateFact],
        terminal: { status: "PARTIAL" as const, completedAtUtc: now.toISOString(), allPagesRead: false,
          allStatusesIncluded: false, coverageComplete: false },
      };
      await assert.rejects(() => runtime.submitReservationWindowPage(worker, windowJob.id, {
        ...terminalWindowPage, observations: [{ ...duplicateFact, seats: 2 }],
      }), StoreConflictError);
      await assert.rejects(() => runtime.submitReservationWindowPage(worker, windowJob.id, {
        ...terminalWindowPage, sourceCursor: "wrong-page",
      }), StoreConflictError);
      await assert.rejects(() => runtime.submitReservationWindowPage(worker, windowJob.id, {
        ...firstWindowPage, receiptId: firstWindowReceipt.nextReceiptId!, pageNumber: 1,
        previousReceiptId: windowRead.receiptId, sourceCursor: terminalWindowPage.sourceCursor,
        nextSourceCursor: terminalWindowPage.sourceCursor,
      }), StoreConflictError);
      const terminalWindowReceipt = await runtime.submitReservationWindowPage(worker, windowJob.id, terminalWindowPage);
      assert.equal(terminalWindowReceipt.duplicateFacts, 1);
      assert.equal(terminalWindowReceipt.healthUpdated, false);
      assert.equal((await pool.query(
        "SELECT read_id FROM external_reservation_listing_health WHERE listing_id='listing-tea'",
      )).rows[0]?.read_id, teaHealthBeforePartial);
      await finish(windowJob);
      assert.equal((await runtime.submitReservationWindowPage(worker, windowJob.id, terminalWindowPage)).repeated, true);
      await assert.rejects(() => runtime.submitReservationWindowPage(worker, windowJob.id, {
        ...terminalWindowPage, snapshotToken: "changed-snapshot",
      }), StoreConflictError);

      const windowRollbackJob = await claim("2099-01-10");
      const windowRollback = await runtime.beginReservationWindowRead(worker, windowRollbackJob.id, windowRollbackJob.leaseToken);
      await assert.rejects(() => runtime.submitReservationWindowPage(worker, windowRollbackJob.id, {
        receiptId: windowRollback.receiptId, readId: windowRollback.readId, leaseToken: windowRollbackJob.leaseToken,
        pageNumber: 0, observations: [
          { ...cancelledWindowFacts[0]!, externalReservationId: "window-rollback" },
          { ...cancelledWindowFacts[0]!, externalReservationId: "explode" },
        ], terminal: { status: "PARTIAL", completedAtUtc: now.toISOString(), allPagesRead: false,
          allStatusesIncluded: false, coverageComplete: false },
      }));
      assert.equal((await pool.query("SELECT 1 FROM external_reservations WHERE external_reservation_id='window-rollback'")).rowCount, 0);
      assert.equal((await pool.query("SELECT 1 FROM external_reservation_window_facts WHERE read_id=$1", [windowRollback.readId])).rowCount, 0);
      assert.equal((await pool.query("SELECT request_fingerprint FROM external_reservation_window_page_receipts WHERE receipt_id=$1",
        [windowRollback.receiptId])).rows[0]?.request_fingerprint, null);
      await finish(windowRollbackJob);

      const failedWindowJob = await claim("2099-01-10");
      const failedWindow = await runtime.beginReservationWindowRead(worker, failedWindowJob.id, failedWindowJob.leaseToken);
      const failedWindowReceipt = await runtime.submitReservationWindowPage(worker, failedWindowJob.id, {
        receiptId: failedWindow.receiptId, readId: failedWindow.readId, leaseToken: failedWindowJob.leaseToken,
        pageNumber: 0, observations: [], terminal: {
          status: "FAILED", completedAtUtc: now.toISOString(), allPagesRead: false,
          allStatusesIncluded: false, coverageComplete: false,
        },
      });
      assert.equal(failedWindowReceipt.terminalStatus, "FAILED");
      assert.equal(failedWindowReceipt.healthUpdated, false);
      assert.equal((await pool.query(
        "SELECT read_id FROM external_reservation_listing_health WHERE listing_id='listing-tea'",
      )).rows[0]?.read_id, teaHealthBeforePartial);
      await finish(failedWindowJob);

      const missingWindowJob = await claim("2099-01-10");
      const missingWindow = await runtime.beginReservationWindowRead(worker, missingWindowJob.id, missingWindowJob.leaseToken);
      const missingComplete = await runtime.submitReservationWindowPage(worker, missingWindowJob.id, {
        receiptId: missingWindow.receiptId, readId: missingWindow.readId, leaseToken: missingWindowJob.leaseToken,
        pageNumber: 0, observations: [], terminal: {
          status: "COMPLETE", completedAtUtc: now.toISOString(), allPagesRead: true,
          allStatusesIncluded: true, coverageComplete: true,
        },
      });
      assert.ok(missingComplete.missingActiveReservations > 0);
      assert.equal(missingComplete.healthUpdated, false);
      await finish(missingWindowJob);

      const remoteWindowJob = await claim("2099-01-10", {
        listingId: "listing-remote", productId: "remote", externalProductId: "synthetic-remote", externalOptionId: "private",
      });
      const remoteWindow = await runtime.beginReservationWindowRead(worker, remoteWindowJob.id, remoteWindowJob.leaseToken);
      const remoteHealthBeforeStale = (await pool.query(
        "SELECT read_id FROM external_reservation_listing_health WHERE listing_id='listing-remote'",
      )).rows[0]?.read_id;
      const staleRemoteComplete = await runtime.submitReservationWindowPage(worker, remoteWindowJob.id, {
        receiptId: remoteWindow.receiptId, readId: remoteWindow.readId, leaseToken: remoteWindowJob.leaseToken,
        pageNumber: 0, observations: [{ ...privateObservation, sourceUpdatedAtUtc: "2099-01-02T00:00:00.000Z" }], terminal: {
          status: "COMPLETE", completedAtUtc: now.toISOString(), allPagesRead: true,
          allStatusesIncluded: true, coverageComplete: true,
        },
      });
      assert.equal(staleRemoteComplete.stale, 1);
      assert.equal(staleRemoteComplete.missingActiveReservations, 0);
      assert.equal(staleRemoteComplete.healthUpdated, false);
      assert.equal((await pool.query(
        "SELECT read_id FROM external_reservation_listing_health WHERE listing_id='listing-remote'",
      )).rows[0]?.read_id, remoteHealthBeforeStale);
      await finish(remoteWindowJob);

      const outboxBeforeRemoteHealth = Number((await pool.query(
        "SELECT count(*) FROM calendar_outbox_events WHERE payload->>'cause' IN ('external_reservation_read_health_changed','external_reservation_read_health_expired')",
      )).rows[0]?.count);
      const freshRemoteWindowJob = await claim("2099-01-10", {
        listingId: "listing-remote", productId: "remote", externalProductId: "synthetic-remote", externalOptionId: "private",
      });
      const freshRemoteWindow = await runtime.beginReservationWindowRead(worker, freshRemoteWindowJob.id, freshRemoteWindowJob.leaseToken);
      const freshRemotePage = {
        receiptId: freshRemoteWindow.receiptId, readId: freshRemoteWindow.readId, leaseToken: freshRemoteWindowJob.leaseToken,
        pageNumber: 0, observations: [privateObservation], terminal: {
          status: "COMPLETE" as const, completedAtUtc: now.toISOString(), allPagesRead: true,
          allStatusesIncluded: true, coverageComplete: true,
        },
      };
      const remoteComplete = await runtime.submitReservationWindowPage(worker, freshRemoteWindowJob.id, freshRemotePage);
      assert.equal(remoteComplete.healthUpdated, true);
      assert.equal(remoteComplete.missingActiveReservations, 0);
      const health = (await pool.query(
        "SELECT next_due_at,fresh_until,coverage_from,coverage_to FROM external_reservation_listing_health WHERE listing_id='listing-remote'",
      )).rows[0];
      assert.equal(new Date(health.next_due_at).toISOString(), "2099-01-01T00:15:00.000Z");
      assert.equal(new Date(health.fresh_until).toISOString(), "2099-01-01T00:45:00.000Z");
      assert.equal(Number((await pool.query(
        "SELECT count(*) FROM calendar_outbox_events WHERE payload->>'cause' IN ('external_reservation_read_health_changed','external_reservation_read_health_expired')",
      )).rows[0]?.count), outboxBeforeRemoteHealth + 2);
      const remoteHealthOccurrence = expandOccurrences({ rule: rule("remote"), overrides: [], salesStates: [], fromDate: "2099-01-02", toDate: "2099-01-02" })[0]!;
      assert.equal((await evaluateStoredInventory(pool, "provider-a", "remote", remoteHealthOccurrence, now.toISOString(), 1)).availability.bookable, false);
      const remoteUnoccupiedOccurrence = expandOccurrences({ rule: rule("remote"), overrides: [], salesStates: [],
        fromDate: "2099-01-04", toDate: "2099-01-04" })[0]!;
      assert.equal((await evaluateStoredInventory(pool, "provider-a", "remote", remoteUnoccupiedOccurrence,
        now.toISOString(), 1)).availability.bookable, true);
      assert.equal((await evaluateStoredInventory(pool, "provider-a", "remote", remoteUnoccupiedOccurrence,
        "2099-01-01T00:46:00.000Z", 1)).availability.reason, "EXTERNAL_RESERVATION_READ_UNAVAILABLE");
      await finish(freshRemoteWindowJob);

      const scopeCancelled: ExternalReservationObservation = {
        ...confirmed("scope-duplicate", "2099-01-10", 1, "2099-01-01T00:10:00.000Z"), status: "CANCELLED",
      };
      const scopeSeedJob = await claim("2099-01-10");
      await submit(scopeSeedJob, scopeCancelled);
      await finish(scopeSeedJob);
      const wrongScopeJob = await claim("2099-01-10", {
        listingId: "listing-remote", productId: "remote", externalProductId: "synthetic-remote", externalOptionId: "private",
      });
      const wrongScopeRead = await runtime.beginReservationWindowRead(worker, wrongScopeJob.id, wrongScopeJob.leaseToken);
      const wrongScopeReceipt = await runtime.submitReservationWindowPage(worker, wrongScopeJob.id, {
        receiptId: wrongScopeRead.receiptId, readId: wrongScopeRead.readId, leaseToken: wrongScopeJob.leaseToken,
        pageNumber: 0, observations: [privateObservation, scopeCancelled], terminal: {
          status: "COMPLETE", completedAtUtc: now.toISOString(), allPagesRead: true,
          allStatusesIncluded: true, coverageComplete: true,
        },
      });
      assert.equal(wrongScopeReceipt.missingActiveReservations, 0);
      assert.equal(wrongScopeReceipt.needsReview, 1);
      assert.equal(wrongScopeReceipt.healthUpdated, false);
      await finish(wrongScopeJob);
      const scopeRecoveryJob = await claim("2099-01-10");
      assert.equal((await submit(scopeRecoveryJob, scopeCancelled)).receipt.applied, 1);
      assert.equal((await pool.query("SELECT needs_review FROM external_reservations WHERE external_reservation_id='scope-duplicate'")).rows[0]?.needs_review, false);
      await finish(scopeRecoveryJob);

      const emptyHealth = (await pool.query(
        "SELECT coverage_from,coverage_to FROM external_reservation_listing_health WHERE listing_id='listing-empty'",
      )).rows[0];
      await pool.query("UPDATE external_reservation_listing_health SET coverage_from='2099-01-01T00:31:00.000Z' WHERE listing_id='listing-empty'");
      assert.equal((await evaluateStoredInventory(pool, "provider-a", "empty", emptyOccurrence,
        now.toISOString(), 1)).availability.reason, "EXTERNAL_RESERVATION_READ_UNAVAILABLE");
      await pool.query("UPDATE external_reservation_listing_health SET coverage_from=$1 WHERE listing_id='listing-empty'", [emptyHealth.coverage_from]);
      await pool.query("UPDATE external_reservation_listing_health SET coverage_to='2099-01-02T02:29:00.000Z' WHERE listing_id='listing-empty'");
      assert.equal((await evaluateStoredInventory(pool, "provider-a", "empty", emptyOccurrence,
        now.toISOString(), 1)).availability.reason, "EXTERNAL_RESERVATION_READ_UNAVAILABLE");
      await pool.query("UPDATE external_reservation_listing_health SET coverage_to=$1 WHERE listing_id='listing-empty'", [emptyHealth.coverage_to]);

      await pool.query("UPDATE channel_listings SET can_observe=false WHERE id='listing-tea'");
      assert.equal((await evaluateStoredInventory(pool, "provider-a", "empty", emptyOccurrence,
        now.toISOString(), 1)).availability.bookable, true);
      await pool.query("UPDATE channel_listings SET can_observe=true WHERE id='listing-tea'");
      await pool.query("UPDATE channel_listings SET can_observe=false WHERE id='listing-empty'");
      assert.equal((await evaluateStoredInventory(pool, "provider-a", "empty", emptyOccurrence,
        now.toISOString(), 1)).availability.reason, "EXTERNAL_RESERVATION_READ_UNAVAILABLE");
      await pool.query("UPDATE channel_listings SET can_observe=true WHERE id='listing-empty'");
      for (const [unavailableSql, restoreSql] of [
        ["UPDATE channel_external_accounts SET active=false WHERE id='account-a'", "UPDATE channel_external_accounts SET active=true WHERE id='account-a'"],
        ["UPDATE channel_external_accounts SET revoked_at='2099-01-01T00:00:00.000Z' WHERE id='account-a'", "UPDATE channel_external_accounts SET revoked_at=NULL WHERE id='account-a'"],
        ["UPDATE channel_external_accounts SET delegated_until='2099-01-01T00:00:00.000Z' WHERE id='account-a'", "UPDATE channel_external_accounts SET delegated_until='2099-02-01T00:00:00.000Z' WHERE id='account-a'"],
      ] as const) {
        await pool.query(unavailableSql);
        assert.equal((await evaluateStoredInventory(pool, "provider-a", "empty", emptyOccurrence,
          now.toISOString(), 1)).availability.reason, "EXTERNAL_RESERVATION_READ_UNAVAILABLE");
        await pool.query(restoreSql);
      }
      await pool.query("UPDATE channel_listings SET can_read_reservations=false WHERE id='listing-empty'");
      assert.equal((await evaluateStoredInventory(pool, "provider-a", "empty", emptyOccurrence,
        now.toISOString(), 1)).availability.bookable, true);
      await pool.query("UPDATE channel_listings SET can_read_reservations=true,active=false WHERE id='listing-empty'");
      assert.equal((await evaluateStoredInventory(pool, "provider-a", "empty", emptyOccurrence,
        now.toISOString(), 1)).availability.bookable, true);
      await pool.query("UPDATE channel_listings SET active=true WHERE id='listing-empty'");

      await pool.query("UPDATE channel_listings SET mapping_version=mapping_version+1 WHERE id='listing-remote'");
      assert.equal((await evaluateStoredInventory(pool, "provider-a", "remote", remoteUnoccupiedOccurrence,
        now.toISOString(), 1)).availability.reason, "EXTERNAL_RESERVATION_READ_UNAVAILABLE");
      await assert.rejects(() => runtime.submitReservationWindowPage(worker, freshRemoteWindowJob.id,
        freshRemotePage), StoreAccessDeniedError);

      const expiredCredential = { ...worker, credentialVersion: worker.credentialVersion + 1 };
      await assert.rejects(() => runtime.submitReservationRead(expiredCredential, firstJob.id, first.payload), StoreAccessDeniedError);

      const deniedJob = await claim("2099-01-05");
      const deniedRead = await runtime.beginReservationRead(worker, deniedJob.id, deniedJob.leaseToken);
      await pool.query("UPDATE channel_listings SET can_read_reservations=false WHERE id='listing-tea'");
      await assert.rejects(() => runtime.submitReservationRead(worker, deniedJob.id, {
        receiptId: randomUUID(), readId: deniedRead.readId, leaseToken: deniedJob.leaseToken, batchStatus: "COMPLETE", observations: [],
      }), StoreConflictError);
      await assert.rejects(() => runtime.beginReservationRead(worker, deniedJob.id, deniedJob.leaseToken), StoreConflictError);
      await assert.rejects(() => runtime.beginReservationWindowRead(worker, deniedJob.id, deniedJob.leaseToken), StoreConflictError);
      await pool.query("UPDATE channel_listings SET can_read_reservations=true WHERE id='listing-tea'");
      const expiredWindow = await runtime.beginReservationWindowRead(worker, deniedJob.id, deniedJob.leaseToken);
      await pool.query("UPDATE schedule_rules SET local_start_time='10:30',version=version+1 WHERE provider_id='provider-a' AND id='tea-rule'");
      await assert.rejects(() => runtime.submitReservationWindowPage(worker, deniedJob.id, {
        receiptId: expiredWindow.receiptId, readId: expiredWindow.readId, leaseToken: deniedJob.leaseToken,
        pageNumber: 0, observations: [], terminal: {
          status: "FAILED", completedAtUtc: now.toISOString(), allPagesRead: false,
          allStatusesIncluded: false, coverageComplete: false,
        },
      }), StoreConflictError);
      await pool.query("UPDATE schedule_rules SET local_start_time='10:00',version=version+1 WHERE provider_id='provider-a' AND id='tea-rule'");
      await pool.query("UPDATE channel_jobs SET lease_expires_at=$2 WHERE id=$1::uuid", [deniedJob.id, now.toISOString()]);
      await assert.rejects(() => runtime.submitReservationWindowPage(worker, deniedJob.id, {
        receiptId: expiredWindow.receiptId, readId: expiredWindow.readId, leaseToken: deniedJob.leaseToken,
        pageNumber: 0, observations: [], terminal: {
          status: "FAILED", completedAtUtc: now.toISOString(), allPagesRead: false,
          allStatusesIncluded: false, coverageComplete: false,
        },
      }), StoreConflictError);
      await runtime.revokeWorkerAccount(admin, "worker-a", "account-a", 1, randomUUID());
      await runtime.assignWorkerAccount(admin, "worker-a", "account-a", 2, randomUUID());
      await assert.rejects(() => runtime.beginReservationRead(worker, deniedJob.id, deniedJob.leaseToken), StoreAccessDeniedError);
      await assert.rejects(() => runtime.submitReservationRead(worker, firstJob.id, first.payload), StoreAccessDeniedError);
      await pool.query("UPDATE channel_external_accounts SET version=version+1 WHERE id='account-a'");
      assert.equal((await evaluateStoredInventory(pool, "provider-a", "empty", emptyOccurrence,
        now.toISOString(), 1)).availability.reason, "EXTERNAL_RESERVATION_READ_UNAVAILABLE");
    } finally {
      releasePausedHold();
      if (schemaCreated) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });
});
