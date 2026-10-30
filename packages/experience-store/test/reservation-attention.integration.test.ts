import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { occurrenceIdFor, type ScheduleRule } from "@niho-experience/experience-domain";
import type { Pool } from "pg";
import { ChannelRuntime, type ExternalReservationObservation, type WorkerIdentity } from "../src/channels.ts";
import { StoreConflictError, StoreNotFoundError, StoreValidationError } from "../src/errors.ts";
import { ExperienceStore } from "../src/repository.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const T0 = Date.parse("2099-01-01T00:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1_000).toISOString();
const owner = { providerId: "provider-a", nihoUserId: "owner-a" };
const admin = { nihoUserId: "admin-a" };
const otherAdmin = { nihoUserId: "admin-b" };
const listings = {
  air: { externalProductId: "tea-air", externalOptionId: "morning" },
  gyg: { externalProductId: "tea-gyg", externalOptionId: "" },
  solo: { externalProductId: "solo-air", externalOptionId: "" },
} as const;

const observation = (
  listing: keyof typeof listings, id: string, date: string, seats: number, sourceUpdatedAtUtc: string,
  status: ExternalReservationObservation["status"] = "CONFIRMED",
): ExternalReservationObservation => ({
  externalReservationId: id, externalProductId: listings[listing].externalProductId,
  ...(listings[listing].externalOptionId ? { externalOptionId: listings[listing].externalOptionId } : {}),
  sourceStartAtUtc: `${date}T01:00:00.000Z`, sourceEndAtUtc: `${date}T02:00:00.000Z`,
  status, seats, sourceUpdatedAtUtc, sourceRevision: `rev-${id}-${status}-${sourceUpdatedAtUtc}`,
});

describe("PostgreSQL external reservation attention", { skip: databaseUrl === undefined }, () => {
  it("queues conflicts for staff and measures detection-to-verified-close without touching reservations", { timeout: 120_000 }, async () => {
    const { Pool } = await import("pg");
    const schema = `reservation_attention_${randomUUID().replaceAll("-", "")}`;
    const pool: Pool = new Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema}` });
    let created = false;
    const clock = { now: new Date(T0) };
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      created = true;
      const migrations = (await readdir(new URL("../migrations/", import.meta.url))).filter((file) => /^\d{4}.*\.sql$/.test(file)).sort();
      for (const file of migrations) await pool.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a')");
      await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES ('provider-a','owner-a','OWNER')");
      for (const id of ["tea", "solo"]) {
        await pool.query(
          `INSERT INTO experience_products
            (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,
             seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
           VALUES ('provider-a',$1,$1,'PUBLISHED',$2,'{}','JPY',1000,'terms','seller','acct_synthetic','Synthetic Seller')`,
          [id, id === "tea" ? "Synthetic tea" : "Synthetic solo"],
        );
      }
      const store = new ExperienceStore(pool);
      const rule = (id: string): ScheduleRule => ({
        id, timeZone: "Asia/Tokyo", startsOn: "2099-01-01", endsOn: "2099-01-10", localStartTime: "10:00", durationMinutes: 60,
        capacity: 2, bookingCutoffMinutes: 0, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "DAILY" },
      });
      await store.saveScheduleRule(owner, "tea", rule("tea-am"), null, randomUUID());
      await store.saveScheduleRule(owner, "solo", rule("solo-am"), null, randomUUID());
      const runtime = new ChannelRuntime(pool, {
        now: () => clock.now,
        supportedAdapters: {
          "Airbnb/browser-v1@1": { canObserve: true, canReadReservations: true, canClose: true, canOpen: true },
          "GetYourGuide/gyg-browser@1": { canObserve: true, canReadReservations: true, canClose: true, canOpen: true },
        },
      });
      const caps = { canObserve: true, canReadReservations: true, canClose: true, canOpen: true };
      await runtime.createExternalAccount(admin, {
        id: "account-air", providerId: "provider-a", site: "Airbnb", externalAccountId: "ext-air", displayName: "Synthetic Airbnb",
        operatingModel: 2, active: true, delegatedUntilUtc: "2099-03-01T00:00:00.000Z",
      }, randomUUID());
      await runtime.createExternalAccount(admin, {
        id: "account-gyg", providerId: "provider-a", site: "GetYourGuide", externalAccountId: "ext-gyg", displayName: "Synthetic GYG",
        operatingModel: 2, active: true, delegatedUntilUtc: "2099-03-01T00:00:00.000Z",
      }, randomUUID());
      await runtime.createListing(admin, {
        id: "listing-air", providerId: "provider-a", accountId: "account-air", productId: "tea", ...listings.air,
        adapter: "browser-v1", adapterVersion: "1", connectionMode: "BROWSER", capabilities: caps, active: true,
      }, randomUUID());
      await runtime.createListing(admin, {
        id: "listing-gyg", providerId: "provider-a", accountId: "account-gyg", productId: "tea", externalProductId: listings.gyg.externalProductId,
        adapter: "gyg-browser", adapterVersion: "1", connectionMode: "BROWSER", capabilities: caps, active: true,
      }, randomUUID());
      await runtime.createListing(admin, {
        id: "listing-solo", providerId: "provider-a", accountId: "account-air", productId: "solo", externalProductId: listings.solo.externalProductId,
        adapter: "browser-v1", adapterVersion: "1", connectionMode: "BROWSER", capabilities: caps, active: true,
      }, randomUUID());
      const credential = await runtime.mintWorkerCredential(admin, "worker-a", "Synthetic Studio", "2099-03-01T00:00:00.000Z", null, randomUUID());
      await runtime.assignWorkerAccount(admin, "worker-a", "account-air", null, randomUUID());
      await runtime.assignWorkerAccount(admin, "worker-a", "account-gyg", null, randomUUID());
      const worker: WorkerIdentity = await runtime.authenticateWorker(credential.bearerToken);

      const consumeAll = async () => { while ((await runtime.consumeCalendarOutbox(200)).events > 0) { /* drain */ } };
      const claimExactly = async (jobId: string) => {
        await pool.query("UPDATE channel_jobs SET priority=CASE WHEN id=$1::uuid THEN 100 ELSE 0 END WHERE status='QUEUED'", [jobId]);
        await pool.query("UPDATE channel_jobs SET next_attempt_at='2000-01-01T00:00:00Z' WHERE id=$1::uuid", [jobId]);
        const job = await runtime.claim(worker);
        assert.equal(job?.id, jobId);
        return job;
      };
      /** One complete reservation-window read of a listing, with every active reservation of that listing included. */
      const windowRead = async (listingId: string, observations: ExternalReservationObservation[]) => {
        await pool.query(
          "UPDATE external_reservation_read_dispatch_states SET next_due_at=$2 WHERE listing_id=$1 AND pending_job_id IS NULL AND halted_at IS NULL",
          [listingId, clock.now],
        );
        await runtime.enqueueDueReservationReads(worker, 10);
        const queued = (await pool.query(
          "SELECT id::text FROM channel_jobs WHERE listing_id=$1 AND purpose='RESERVATION_WINDOW' AND status='QUEUED'", [listingId],
        )).rows[0]?.id as string | undefined;
        assert.ok(queued);
        const job = await claimExactly(queued);
        const cycle = await runtime.beginReservationWindowRead(worker, job.id, job.leaseToken);
        const page = {
          receiptId: cycle.receiptId, readId: cycle.readId, leaseToken: job.leaseToken, pageNumber: 0, observations,
          terminal: { status: "COMPLETE" as const, completedAtUtc: clock.now.toISOString(), allPagesRead: true, allStatusesIncluded: true, coverageComplete: true },
        };
        const receipt = await runtime.submitReservationWindowPage(worker, job.id, page);
        assert.equal(receipt.healthUpdated, true);
        await runtime.submitResult(worker, job.id, {
          resultId: randomUUID(), leaseToken: job.leaseToken, outcome: "RESERVATION_VERIFIED", stopped: true, target: job.target,
          reservationReadId: cycle.readId, reservationReceiptId: receipt.receiptId,
        });
        return { job, page, receipt };
      };
      const measurement = async (reservationId: string) => (await pool.query(
        `SELECT status,target_count,detected_at,source_updated_at,closed_verified_at,completed_at FROM channel_propagation_measurements
          WHERE external_reservation_id=$1 ORDER BY local_revision DESC LIMIT 1`, [reservationId],
      )).rows[0];
      const targetsOf = async (reservationId: string) => (await pool.query(
        `SELECT t.listing_id,t.site,t.outcome,t.job_created_at,t.job_claimed_at,t.verified_closed_at FROM channel_propagation_targets t
           JOIN channel_propagation_measurements m ON m.id=t.measurement_id WHERE m.external_reservation_id=$1 ORDER BY t.listing_id`, [reservationId],
      )).rows;
      const iso = (value: unknown) => value === null || value === undefined ? null : new Date(value as string).toISOString();
      const conflictTransitions = (run: Awaited<ReturnType<typeof runtime.runWatchdog>>) => run.transitions
        .filter((item) => item.kind === "EXTERNAL_RESERVATION_CONFLICT").map((item) => item.transition);
      const counts = async () => (await pool.query(
        `SELECT (SELECT count(*) FROM external_reservation_conflict_cases)::int AS cases,
                (SELECT count(*) FROM external_reservation_conflict_members)::int AS members,
                (SELECT count(*) FROM channel_propagation_measurements)::int AS measurements,
                (SELECT count(*) FROM channel_runtime_incidents WHERE kind='EXTERNAL_RESERVATION_CONFLICT')::int AS incidents`,
      )).rows[0];

      // Desired states anchor the reads; fresh reservation health then lets desired states be OPEN.
      for (const id of ["listing-air", "listing-gyg", "listing-solo"]) await runtime.reconcileListing(admin, id, randomUUID());
      await consumeAll();
      await windowRead("listing-air", []);
      await windowRead("listing-gyg", []);
      await windowRead("listing-solo", []);
      for (const id of ["listing-air", "listing-gyg", "listing-solo"]) await runtime.reconcileListing(admin, id, randomUUID());
      await consumeAll();
      const d1 = occurrenceIdFor("tea-am", "2099-01-03");
      const d2 = occurrenceIdFor("tea-am", "2099-01-04");
      const d5 = occurrenceIdFor("tea-am", "2099-01-06");
      assert.equal((await pool.query("SELECT desired_state FROM channel_desired_states WHERE listing_id='listing-gyg' AND occurrence_id=$1", [d5])).rows[0]?.desired_state, "OPEN");

      // A direct booking fills 2099-01-04.
      const hold = await store.createBookingHold({ providerId: "provider-a" }, {
        productId: "tea", occurrenceId: d2, seats: 2, idempotencyKey: "attention-direct", holdSeconds: 3600,
      });
      await pool.query("UPDATE bookings SET status='CONFIRMED',confirmed_at=clock_timestamp() WHERE public_booking_id=$1::uuid", [hold.publicBookingId]);
      const directBookingId = String((await pool.query("SELECT id FROM bookings WHERE public_booking_id=$1::uuid", [hold.publicBookingId])).rows[0]?.id);
      await consumeAll();

      // Airbnb: R1 fills 2099-01-03 and R5 leaves a seat on 2099-01-06. A product without another listing needs no propagation.
      clock.now = new Date(at(60));
      await windowRead("listing-air", [observation("air", "R1", "2099-01-03", 2, at(30)), observation("air", "R5", "2099-01-06", 1, at(30))]);
      await windowRead("listing-solo", [observation("solo", "R6", "2099-01-05", 1, at(30))]);
      for (const id of ["R1", "R5"]) {
        const row = await measurement(id);
        assert.deepEqual([row?.status, row?.target_count, iso(row?.detected_at), iso(row?.source_updated_at)], ["OPEN", 1, at(60), at(30)]);
        assert.deepEqual((await targetsOf(id)).map((target) => [target.listing_id, target.site, target.outcome]), [["listing-gyg", "GetYourGuide", "PENDING"]]);
      }
      const solo = await measurement("R6");
      assert.deepEqual([solo?.status, solo?.target_count, iso(solo?.completed_at)], ["NOT_REQUIRED", 0, at(60)]);
      // Their calendar event is not processed yet: an OPEN desired state cannot count as "seats remain".
      await runtime.runWatchdog();
      assert.equal((await measurement("R5"))?.status, "OPEN");
      await consumeAll();
      clock.now = new Date(at(90));
      await runtime.runWatchdog();
      assert.equal((await measurement("R5"))?.status, "NOT_REQUIRED");
      assert.deepEqual((await targetsOf("R5")).map((target) => target.outcome), ["NOT_REQUIRED"]);
      assert.equal((await measurement("R1"))?.status, "OPEN");

      // The second site closes 2099-01-03: claim, then verify CLOSED after the reservation was detected.
      const closeJob = String((await pool.query(
        "SELECT id::text FROM channel_jobs WHERE listing_id='listing-gyg' AND occurrence_id=$1 AND action='SET_CLOSED' AND status='QUEUED'", [d1],
      )).rows[0]?.id);
      // Job creation uses the database clock; pin it to the injected timeline for exact interval checks.
      await pool.query("UPDATE channel_jobs SET created_at=$2 WHERE id=$1::uuid", [closeJob, at(150)]);
      clock.now = new Date(at(240));
      const claimedClose = await claimExactly(closeJob);
      clock.now = new Date(at(250));
      assert.equal((await runtime.preflight(worker, claimedClose.id, claimedClose.leaseToken)).ready, true);
      assert.equal((await runtime.submitResult(worker, claimedClose.id, {
        resultId: randomUUID(), leaseToken: claimedClose.leaseToken, outcome: "VERIFIED", stopped: true, target: claimedClose.target,
        occurrenceId: claimedClose.occurrenceId, sourceStartAtUtc: claimedClose.sourceStartAtUtc, sourceEndAtUtc: claimedClose.sourceEndAtUtc,
        observedState: "CLOSED", observedBookable: false, observedManuallyBlocked: true, observedAtUtc: at(250),
      })).acceptedAsCurrent, true);
      clock.now = new Date(at(300));
      await runtime.runWatchdog();
      const completed = await measurement("R1");
      assert.deepEqual([completed?.status, iso(completed?.closed_verified_at), iso(completed?.completed_at)], ["COMPLETED", at(250), at(300)]);
      assert.deepEqual((await targetsOf("R1")).map((target) => [target.outcome, iso(target.job_created_at), iso(target.job_claimed_at), iso(target.verified_closed_at)]),
        [["VERIFIED", at(150), at(240), at(250)]]);

      // GetYourGuide sells 2099-01-03 a second time (R2); Airbnb overbooks the direct booking (R3).
      // The ledger keeps both sides; the existing reader quarantines each account for review.
      clock.now = new Date(at(330));
      const gygRead = await windowRead("listing-gyg", [observation("gyg", "R2", "2099-01-03", 1, at(300))]);
      assert.equal((await runtime.submitReservationWindowPage(worker, gygRead.job.id, gygRead.page)).repeated, true);
      await windowRead("listing-air", [
        observation("air", "R1", "2099-01-03", 2, at(30)), observation("air", "R5", "2099-01-06", 1, at(30)),
        observation("air", "R3", "2099-01-04", 1, at(300)),
      ]);
      assert.deepEqual((await pool.query("SELECT id,quarantine_reason FROM channel_external_accounts ORDER BY id")).rows.map((row) => [row.id, row.quarantine_reason]),
        [["account-air", "NEEDS_REVIEW"], ["account-gyg", "NEEDS_REVIEW"]]);
      for (const id of ["R2", "R3"]) assert.deepEqual([(await measurement(id))?.status, iso((await measurement(id))?.detected_at)], ["OPEN", at(330)]);
      assert.equal(Number((await pool.query("SELECT count(*) FROM channel_propagation_measurements WHERE external_reservation_id IN ('R1','R5')")).rows[0]?.count), 2);
      const caseRows = (await pool.query("SELECT id::text,occurrence_id,status FROM external_reservation_conflict_cases ORDER BY occurrence_id")).rows;
      assert.deepEqual(caseRows.map((row) => [row.occurrence_id, row.status]), [[d1, "OPEN"], [d2, "OPEN"]]);
      const caseA = String(caseRows[0]!.id);
      const caseB = String(caseRows[1]!.id);
      const members = async (caseId: string) => (await pool.query(
        `SELECT member_kind,external_reservation_id,booking_id::text,seats FROM external_reservation_conflict_members
          WHERE case_id=$1::uuid ORDER BY member_kind,external_reservation_id`, [caseId],
      )).rows.map((row) => [row.member_kind, row.external_reservation_id ?? row.booking_id, row.seats]);
      assert.deepEqual(await members(caseA), [["EXTERNAL", "R1", 2], ["EXTERNAL", "R2", 1]]);
      assert.deepEqual(await members(caseB), [["DIRECT", directBookingId, 2], ["EXTERNAL", "R3", 1]]);

      const firstRun = await runtime.runWatchdog();
      assert.deepEqual(conflictTransitions(firstRun), ["opened", "escalated", "opened", "escalated"]);
      assert.ok(firstRun.transitions.filter((item) => item.kind === "EXTERNAL_RESERVATION_CONFLICT").every((item) => item.providerId === "provider-a"));
      assert.doesNotMatch(JSON.stringify(firstRun.transitions), /ext-air|ext-gyg|R1|R2|R3/);
      assert.equal(conflictTransitions(await runtime.runWatchdog()).length, 0);

      // Synthetic stand-in for staff recovery, so the same facts can be read again.
      const release = async (accountId: string) => {
        await pool.query("UPDATE channel_external_accounts SET quarantined_at=NULL,quarantine_reason=NULL WHERE id=$1", [accountId]);
        await pool.query("UPDATE external_reservation_read_dispatch_states SET halted_at=NULL,last_error=NULL,retry_count=0 WHERE account_id=$1", [accountId]);
      };
      await release("account-gyg");

      // Re-reading the same facts is DUPLICATE: no new case, member, measurement, or incident.
      const before = await counts();
      clock.now = new Date(at(360));
      await windowRead("listing-gyg", [observation("gyg", "R2", "2099-01-03", 1, at(300))]);
      assert.equal(conflictTransitions(await runtime.runWatchdog()).length, 0);
      assert.deepEqual(await counts(), before);
      assert.equal(before?.incidents, 2);

      // R2 is cancelled at its source: the conflict clears itself and the measurement is abandoned.
      clock.now = new Date(at(390));
      await windowRead("listing-gyg", [observation("gyg", "R2", "2099-01-03", 1, at(375), "CANCELLED")]);
      const cleared = await runtime.runWatchdog();
      assert.deepEqual(conflictTransitions(cleared), ["resolved"]);
      const caseAState = (await pool.query("SELECT status,resolution,resolved_by_niho_user_id FROM external_reservation_conflict_cases WHERE id=$1::uuid", [caseA])).rows[0];
      assert.deepEqual({ ...caseAState }, { status: "RESOLVED", resolution: "CONFLICT_CLEARED", resolved_by_niho_user_id: null });
      assert.equal((await pool.query("SELECT resolved_at IS NOT NULL AS resolved FROM channel_runtime_incidents WHERE subject_id=$1", [caseA])).rows[0]?.resolved, true);
      assert.equal((await measurement("R2"))?.status, "ABANDONED");
      assert.deepEqual((await targetsOf("R2")).map((target) => target.outcome), ["UNVERIFIED"]);

      // Staff view: members without the external account ID; ownership and handling are commands only.
      const view = await runtime.conflictCases(admin, "provider-a");
      assert.deepEqual(view.map((item) => [item.id, item.status, item.resolution ?? null]), [[caseB, "OPEN", null], [caseA, "RESOLVED", "CONFLICT_CLEARED"]]);
      const openView = view[0]!;
      assert.equal(openView.productTitle, "Synthetic tea");
      assert.equal(openView.occurrenceStartAtUtc, "2099-01-04T01:00:00.000Z");
      assert.deepEqual(openView.members.map((member) => [member.kind, member.site ?? null, member.externalReservationId ?? member.bookingId, member.seats, member.status]),
        [["EXTERNAL", "Airbnb", "R3", 1, "CONFIRMED"], ["DIRECT", null, directBookingId, 2, "CONFIRMED"]]);
      assert.deepEqual(view[1]!.members.map((member) => [member.externalReservationId, member.status]), [["R2", "CANCELLED"], ["R1", "CONFIRMED"]]);
      // A partner found through a shared resource belongs to another occurrence than the case: that is not a move.
      // Only a change from the occurrence it had when it joined is.
      const viewOf = async () => (await runtime.conflictCases(admin, "provider-a")).find((item) => item.id === caseB)!.members.find((member) => member.externalReservationId === "R3")?.status;
      const caseOccurrence = (await pool.query("SELECT occurrence_id FROM external_reservation_conflict_cases WHERE id=$1::uuid", [caseB])).rows[0]?.occurrence_id;
      const joined = (await pool.query("SELECT occurrence_id FROM external_reservations WHERE external_reservation_id='R3'")).rows[0]?.occurrence_id;
      assert.equal((await pool.query("SELECT occurrence_id FROM external_reservation_conflict_members WHERE case_id=$1::uuid AND external_reservation_id='R3'", [caseB])).rows[0]?.occurrence_id, joined);
      await pool.query("UPDATE external_reservation_conflict_cases SET occurrence_id='shared-resource-other-occurrence' WHERE id=$1::uuid", [caseB]);
      assert.equal(await viewOf(), "CONFIRMED");
      await pool.query("UPDATE external_reservation_conflict_cases SET occurrence_id=$2 WHERE id=$1::uuid", [caseB, caseOccurrence]);
      await pool.query("UPDATE external_reservations SET occurrence_id='moved-to-another-occurrence' WHERE external_reservation_id='R3'");
      assert.equal(await viewOf(), "MOVED");
      await pool.query("UPDATE external_reservations SET occurrence_id=$1 WHERE external_reservation_id='R3'", [joined]);
      assert.equal(await viewOf(), "CONFIRMED");
      assert.doesNotMatch(JSON.stringify(view), /ext-air|ext-gyg|externalAccountId|public/);
      await assert.rejects(() => runtime.acknowledgeConflictCase(admin, randomUUID(), randomUUID()), StoreNotFoundError);
      await assert.rejects(() => runtime.acknowledgeConflictCase(admin, "not-a-uuid", randomUUID()), StoreValidationError);
      const ackCommand = randomUUID();
      const ack = await runtime.acknowledgeConflictCase(admin, caseB, ackCommand);
      assert.deepEqual(await runtime.acknowledgeConflictCase(admin, caseB, ackCommand), ack);
      assert.deepEqual((await runtime.conflictCases(otherAdmin, "provider-a"))[0]?.assignedToMe, false);
      assert.deepEqual((await runtime.conflictCases(admin, "provider-a"))[0]?.assignedToMe, true);

      const reservationsBefore = (await pool.query("SELECT * FROM external_reservations ORDER BY external_reservation_id")).rows;
      const bookingsBefore = (await pool.query("SELECT id,status,seats,updated_at FROM bookings ORDER BY id")).rows;
      const jobsBefore = (await pool.query("SELECT id,status FROM channel_jobs ORDER BY id")).rows;
      await assert.rejects(() => runtime.resolveConflictCase(admin, caseB, "CONFLICT_CLEARED" as never, randomUUID()), StoreValidationError);
      const resolveCommand = randomUUID();
      const resolved = await runtime.resolveConflictCase(admin, caseB, "ACCEPTED_BOTH", resolveCommand);
      assert.equal(resolved.resolution, "ACCEPTED_BOTH");
      assert.deepEqual(await runtime.resolveConflictCase(admin, caseB, "ACCEPTED_BOTH", resolveCommand), resolved);
      await assert.rejects(() => runtime.resolveConflictCase(otherAdmin, caseB, "ACCEPTED_BOTH", resolveCommand), StoreConflictError);
      await assert.rejects(() => runtime.resolveConflictCase(admin, caseB, "CUSTOMER_CONTACTED", resolveCommand), StoreConflictError);
      await assert.rejects(() => runtime.resolveConflictCase(admin, caseB, "CUSTOMER_CONTACTED", randomUUID()), StoreConflictError);
      await assert.rejects(() => runtime.acknowledgeConflictCase(admin, caseB, randomUUID()), StoreConflictError);
      assert.deepEqual((await pool.query("SELECT * FROM external_reservations ORDER BY external_reservation_id")).rows, reservationsBefore);
      assert.deepEqual((await pool.query("SELECT id,status,seats,updated_at FROM bookings ORDER BY id")).rows, bookingsBefore);
      assert.deepEqual((await pool.query("SELECT id,status FROM channel_jobs ORDER BY id")).rows, jobsBefore);
      const caseBState = (await pool.query("SELECT resolution,resolved_by_niho_user_id FROM external_reservation_conflict_cases WHERE id=$1::uuid", [caseB])).rows[0];
      assert.deepEqual({ ...caseBState }, { resolution: "ACCEPTED_BOTH", resolved_by_niho_user_id: "admin-a" });
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM channel_audit_events WHERE resource_type='conflict_case' AND resource_id=$1", [caseB])).rows[0]?.count, 2);
      assert.deepEqual(conflictTransitions(await runtime.runWatchdog()), ["resolved"]);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM channel_runtime_incidents WHERE kind='EXTERNAL_RESERVATION_CONFLICT' AND resolved_at IS NULL")).rows[0]?.count, 0);

      // R3's other site is never verified closed: after 24 hours the measurement times out.
      clock.now = new Date(at(330 + 24 * 3600 - 1));
      await runtime.runWatchdog();
      assert.equal((await measurement("R3"))?.status, "OPEN");
      clock.now = new Date(at(330 + 24 * 3600 + 1));
      await runtime.runWatchdog();
      assert.equal((await measurement("R3"))?.status, "TIMED_OUT");
      assert.deepEqual((await targetsOf("R3")).map((target) => target.outcome), ["UNVERIFIED"]);

      const metrics = await runtime.propagationMetrics(admin, "provider-a");
      assert.deepEqual(metrics.counts, { OPEN: 0, COMPLETED: 1, NOT_REQUIRED: 2, ABANDONED: 1, TIMED_OUT: 1 });
      assert.deepEqual(metrics.closeVerified, { count: 1, p50Seconds: 190, p95Seconds: 190, maxSeconds: 190, over60Minutes: 0 });
      assert.deepEqual(metrics.detectionLag, { count: 5, p50Seconds: 30, p95Seconds: 30 });
      assert.deepEqual(metrics.queueWait, { count: 1, p50Seconds: 90, p95Seconds: 90 });
      assert.deepEqual(metrics.bySite, [{ site: "Airbnb", count: 4, closeVerifiedP95Seconds: 190 }, { site: "GetYourGuide", count: 1 }]);
      assert.deepEqual(metrics.open, { count: 0 });
      assert.equal(metrics.truncated, false);
      assert.doesNotMatch(JSON.stringify(metrics), /ext-air|ext-gyg|R\d/);
    } finally {
      if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await pool.end();
    }
  });
});
