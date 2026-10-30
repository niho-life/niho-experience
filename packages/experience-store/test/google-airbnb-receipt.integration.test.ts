import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import type { ScheduleRule } from "@niho-experience/experience-domain";
import { ChannelRuntime } from "../src/channels.ts";
import { GoogleChannelDeliveryRepository } from "../src/google-channel-delivery.ts";
import { ExperienceStore } from "../src/repository.ts";
import { StoreConflictError } from "../src/errors.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const command = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const scopes = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.app.created",
];

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture(desiredState: "OPEN" | "CLOSED" = "CLOSED") {
  const { Pool } = await import("pg");
  const schema = `google_airbnb_receipt_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 6, options: `-c search_path=${schema}` });
  const now = new Date();
  let clockOffsetMs = 0;
  const occurrenceParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(now.getTime() + 24 * 60 * 60 * 1_000));
  const occurrenceValues = Object.fromEntries(occurrenceParts.map((part) => [part.type, part.value]));
  const occurrenceDate = `${occurrenceValues.year}-${occurrenceValues.month}-${occurrenceValues.day}`;
  const authorityExpiresAtUtc = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000).toISOString();
  await pool.query(`CREATE SCHEMA "${schema}"`);
  for (const name of (await readdir(new URL("../migrations/", import.meta.url))).filter((item) => /^\d{4}.*\.sql$/.test(item)).sort()) {
    await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a')");
  await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES ('provider-a','owner-a','OWNER')");
  await pool.query(`INSERT INTO experience_products
    (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
    VALUES ('provider-a','tea','tea','PUBLISHED','Synthetic tea','{}','JPY',1000,'terms','seller','acct_synthetic','Synthetic Seller')`);
  const store = new ExperienceStore(pool);
  const rule: ScheduleRule = {
    id: "tea-once", timeZone: "Asia/Tokyo", startsOn: occurrenceDate, endsOn: occurrenceDate,
    localStartTime: "10:00", durationMinutes: 60, capacity: 1, bookingCutoffMinutes: 30,
    busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "DAILY" },
  };
  await store.saveScheduleRule({ providerId: "provider-a", nihoUserId: "owner-a" }, "tea", rule, null, command(1));
  if (desiredState === "CLOSED") {
    await store.setOccurrenceSalesState(
      { providerId: "provider-a", nihoUserId: "owner-a" }, "tea", rule.id,
      { occurrenceId: `${rule.id}@${occurrenceDate}`, desiredState: "CLOSED" }, null, command(2),
    );
  }
  const options = {
    now: () => new Date(Date.now() + clockOffsetMs),
    supportedAdapters: { "Airbnb/airbnb-google-busy@1": { canOpen: true, canClose: true, canObserve: true } },
  };
  const disabledRuntime = new ChannelRuntime(pool, options);
  const runtime = new ChannelRuntime(pool, { ...options, googleAirbnbObservationEnabled: true });
  const admin = { nihoUserId: "admin-a" };
  const account = await runtime.createExternalAccount(admin, {
    id: "account-a", providerId: "provider-a", site: "Airbnb", externalAccountId: "12345",
    displayName: "Synthetic account", operatingModel: 2, active: true, delegatedUntilUtc: authorityExpiresAtUtc,
  }, command(3));
  const listing = await runtime.createListing(admin, {
    id: "listing-a", providerId: "provider-a", accountId: account.id, productId: "tea", externalProductId: "67890",
    adapter: "airbnb-google-busy", adapterVersion: "1", connectionMode: "GOOGLE",
    capabilities: { canOpen: true, canClose: true, canObserve: true }, active: true,
  }, command(4));
  await pool.query(
    `INSERT INTO provider_google_connections
      (provider_id,connected_by_niho_user_id,encrypted_refresh_token,granted_scopes,busy_calendar_id,booking_calendar_id)
     VALUES ('provider-a','owner-a',$1,$2,'provider-busy','booking-input')`,
    ["synthetic-ciphertext-".padEnd(48, "x"), scopes],
  );
  const generation = (await pool.query("SELECT connection_generation FROM provider_google_connections WHERE provider_id='provider-a'"))
    .rows[0].connection_generation;
  await pool.query(
    `INSERT INTO google_channel_output_bindings
      (provider_id,listing_id,mapping_version,connection_generation,opaque_calendar_id)
     VALUES ('provider-a','listing-a',$1,$2,'airbnb-output')`, [listing.mappingVersion, generation],
  );
  await runtime.reconcileListing(admin, listing.id, command(5));
  const credential = await runtime.mintWorkerCredential(admin, "studio-1", "Synthetic Studio", authorityExpiresAtUtc, null, command(6));
  await runtime.assignWorkerAccount(admin, credential.workerId, account.id, null, command(7));
  const worker = await runtime.authenticateWorker(credential.bearerToken);
  const consumed = await runtime.consumeCalendarOutbox(50, worker);
  assert.ok(consumed.events > 0);
  const claimed = await runtime.claim(worker); assert.ok(claimed);
  const repository = new GoogleChannelDeliveryRepository(pool, runtime);
  const dispatch = await repository.prepareDispatch(worker, claimed.id, claimed.leaseToken);
  assert.equal(dispatch.operation, "dispatch");
  const delivery = await repository.saveResult(
    worker, claimed.id, claimed.leaseToken, dispatch.record.deliveryId, dispatch.operationNonce, "dispatch", {
      phase: "GOOGLE_VERIFIED", changed: true, writeAcknowledged: true,
      metadata: {
        eventId: "synthetic-event", etag: '"synthetic-etag"', bindingHash: "synthetic-binding",
        mappingVersion: claimed.mappingVersion, desiredVersion: claimed.desiredVersion,
        startAtUtc: claimed.sourceStartAtUtc, endAtUtc: claimed.sourceEndAtUtc,
        desiredState, transparency: desiredState === "CLOSED" ? "opaque" : "transparent",
      },
    },
  );
  const result = (resultId = command(20), overrides: Record<string, unknown> = {}) => ({
    resultId, leaseToken: claimed.leaseToken, outcome: "VERIFIED" as const, stopped: true, target: claimed.target,
    occurrenceId: claimed.occurrenceId, sourceStartAtUtc: claimed.sourceStartAtUtc, sourceEndAtUtc: claimed.sourceEndAtUtc,
    observedState: desiredState, observedBookable: desiredState === "OPEN", observedAtUtc: new Date().toISOString(),
    googleAirbnbProof: { deliveryId: delivery.deliveryId, evidence: "EXACT_SLOT_V1" as const, partySize: 1 as const },
    ...overrides,
  });
  return { schema, pool, runtime, disabledRuntime, worker, claimed, delivery, generation, result, desiredState,
    restartRuntime: () => new ChannelRuntime(pool, { ...options, googleAirbnbObservationEnabled: true }),
    setNow: (value: Date) => { clockOffsetMs = value.getTime() - Date.now(); } };
}

async function cleanup(value: Fixture) {
  await value.pool.query(`DROP SCHEMA IF EXISTS "${value.schema}" CASCADE`).catch(() => undefined);
  await value.pool.end();
}

function mismatch(value: Fixture, resultId: string, job = value.claimed) {
  const observedState = value.desiredState === "OPEN" ? "CLOSED" : "OPEN";
  return value.result(resultId, {
    leaseToken: job.leaseToken,
    outcome: "RETRY_WAIT" as const,
    target: job.target,
    occurrenceId: job.occurrenceId,
    sourceStartAtUtc: job.sourceStartAtUtc,
    sourceEndAtUtc: job.sourceEndAtUtc,
    observedState,
    observedBookable: observedState === "OPEN",
    observedAtUtc: new Date().toISOString(),
  });
}

describe("PostgreSQL Google/Airbnb typed result receipt", { skip: databaseUrl === undefined }, () => {
  for (const scenario of [
    { name: "retains verification milliseconds after a same-second lease start", desired: "CLOSED", leaseOffset: 100, observedOffset: 700, accepted: true },
    { name: "rejects a same-second observation preceding Google verification", desired: "OPEN", leaseOffset: -100, observedOffset: 400, accepted: false },
  ] as const) it(scenario.name, async () => {
    const value = await fixture(scenario.desired);
    try {
      const base = Math.floor(Date.now() / 1_000) * 1_000 + 2_000;
      const googleAt = new Date(base + 500).toISOString();
      await value.pool.query("UPDATE channel_jobs SET lease_started_at=$2 WHERE id=$1::uuid", [value.claimed.id, new Date(base + scenario.leaseOffset).toISOString()]);
      await value.pool.query("UPDATE google_channel_deliveries SET operation_verified_at=$2 WHERE id=$1::uuid", [value.delivery.deliveryId, googleAt]);
      value.setNow(new Date(base + 900));
      const selected = (await value.pool.query("SELECT operation_verified_at FROM google_channel_deliveries WHERE id=$1::uuid", [value.delivery.deliveryId])).rows[0];
      assert.ok(selected.operation_verified_at instanceof Date, "exercise the actual pg timestamptz Date representation");
      const input = value.result(command(200), { observedAtUtc: new Date(base + scenario.observedOffset).toISOString() });
      if (scenario.accepted) {
        assert.equal((await value.runtime.submitResult(value.worker, value.claimed.id, input)).acceptedAsCurrent, true);
        const stored = (await value.pool.query("SELECT google_airbnb_verified_at FROM channel_job_results WHERE result_id=$1::uuid", [input.resultId])).rows[0];
        assert.equal(stored.google_airbnb_verified_at.toISOString(), googleAt);
      } else {
        await assert.rejects(() => value.runtime.submitResult(value.worker, value.claimed.id, input), StoreConflictError);
        assert.equal((await value.pool.query("SELECT count(*)::int AS count FROM channel_job_results WHERE result_id=$1::uuid", [input.resultId])).rows[0].count, 0);
      }
    } finally { await cleanup(value); }
  });

  it("accepts fresh exact-slot OPEN and CLOSED observations, persists the selected proof, and replays immutably", async () => {
    for (const desiredState of ["OPEN", "CLOSED"] as const) {
      const value = await fixture(desiredState);
      try {
        const input = value.result();
        assert.deepEqual(await value.runtime.submitResult(value.worker, value.claimed.id, input), { acceptedAsCurrent: true, repeated: false });
        assert.deepEqual(await value.runtime.submitResult(value.worker, value.claimed.id, input), { acceptedAsCurrent: true, repeated: true });
        await assert.rejects(() => value.runtime.submitResult(value.worker, value.claimed.id, {
          ...input, googleAirbnbProof: { ...input.googleAirbnbProof, deliveryId: command(99) },
        }));
        const stored = (await value.pool.query(
          `SELECT accepted_as_current,observed_manually_blocked,google_airbnb_delivery_id,google_airbnb_evidence,
                  google_airbnb_party_size,google_airbnb_verified_at
             FROM channel_job_results WHERE result_id=$1::uuid`, [input.resultId],
        )).rows[0];
        assert.equal(stored.accepted_as_current, true);
        assert.equal(stored.observed_manually_blocked, null);
        assert.equal(stored.google_airbnb_delivery_id, value.delivery.deliveryId);
        assert.equal(stored.google_airbnb_evidence, "EXACT_SLOT_V1");
        assert.equal(Number(stored.google_airbnb_party_size), 1);
        // SQL CHECK must reject partial proof, including UNKNOWN comparisons
        // caused by NULL; route validation alone cannot protect stored receipts.
        for (const column of ["google_airbnb_evidence", "google_airbnb_party_size", "google_airbnb_verified_at"] as const) {
          await assert.rejects(
            () => value.pool.query(`UPDATE channel_job_results SET ${column}=NULL WHERE result_id=$1::uuid`, [input.resultId]),
            { code: "23514" },
          );
        }
        await assert.rejects(
          () => value.pool.query(
            "UPDATE google_channel_deliveries SET first_verified_at=NULL WHERE id=$1::uuid",
            [value.delivery.deliveryId],
          ),
          { code: "23514" },
        );
        await assert.rejects(
          () => value.pool.query(
            "UPDATE google_channel_deliveries SET operation_verified_at=first_verified_at-interval '1 millisecond' WHERE id=$1::uuid",
            [value.delivery.deliveryId],
          ),
          { code: "23514" },
        );
        const desired = (await value.pool.query(
          "SELECT observed_state,last_verified_at FROM channel_desired_states WHERE listing_id='listing-a' AND occurrence_id=$1",
          [value.claimed.occurrenceId],
        )).rows[0];
        assert.equal(desired.observed_state, desiredState);
        assert.ok(desired.last_verified_at);
        assert.equal((await value.runtime.hostStatuses({ providerId: "provider-a", nihoUserId: "owner-a" }))[0]?.label, "SYNCED");
      } finally { await cleanup(value); }
    }
  });

  it("keeps the flag closed and rejects foreign, stale, or no-longer-authoritative proof without a result receipt", async () => {
    const value = await fixture("CLOSED");
    const assertRejected = async (input = value.result()) => {
      await assert.rejects(() => value.runtime.submitResult(value.worker, value.claimed.id, input));
      assert.equal((await value.pool.query("SELECT count(*)::int AS count FROM channel_job_results")).rows[0].count, 0);
      assert.equal((await value.pool.query("SELECT observed_state FROM channel_desired_states WHERE listing_id='listing-a'")).rows[0].observed_state, null);
    };
    try {
      await assert.rejects(() => value.disabledRuntime.submitResult(value.worker, value.claimed.id, value.result()));
      const legacy = value.result(command(80), { googleAirbnbProof: undefined, observedManuallyBlocked: false });
      await assert.rejects(() => value.runtime.submitResult(value.worker, value.claimed.id, legacy));
      await assertRejected(value.result(command(81), {
        googleAirbnbProof: { deliveryId: value.delivery.deliveryId, evidence: "OTHER", partySize: 1 },
      }));
      await assertRejected(value.result(command(82), {
        googleAirbnbProof: { deliveryId: value.delivery.deliveryId, evidence: "EXACT_SLOT_V1", partySize: 2 },
      }));
      await assertRejected(value.result(command(21), {
        googleAirbnbProof: { deliveryId: command(98), evidence: "EXACT_SLOT_V1", partySize: 1 },
      }));
      await assertRejected(value.result(command(22), { observedAtUtc: new Date(Date.now() - 60_000).toISOString() }));

      const otherJobId = command(90);
      await value.pool.query(
        `INSERT INTO channel_jobs
          (id,provider_id,account_id,listing_id,occurrence_id,action,account_version,desired_version,mapping_version,
           target_site,target_external_account_id,target_external_product_id,target_external_option_id,target_time_zone,
           target_adapter,target_adapter_version,target_connection_mode,source_start_at,source_end_at,status,priority,
           attempt_count,next_attempt_at,job_deadline_at,lease_epoch,outcome,purpose,dispatch_sequence,created_at,updated_at)
         SELECT $2::uuid,provider_id,account_id,listing_id,occurrence_id,'OBSERVE',account_version,desired_version,mapping_version,
           target_site,target_external_account_id,target_external_product_id,target_external_option_id,target_time_zone,
           target_adapter,target_adapter_version,target_connection_mode,source_start_at,source_end_at,'FINISHED',priority,
           attempt_count,next_attempt_at,job_deadline_at,lease_epoch,'NEEDS_REVIEW','AVAILABILITY',0,created_at,updated_at
          FROM channel_jobs WHERE id=$1::uuid`, [value.claimed.id, otherJobId],
      );
      await value.pool.query("UPDATE google_channel_deliveries SET job_id=$2::uuid WHERE id=$1::uuid", [value.delivery.deliveryId, otherJobId]);
      await assertRejected(value.result(command(83)));
      await value.pool.query("UPDATE google_channel_deliveries SET job_id=$2::uuid WHERE id=$1::uuid", [value.delivery.deliveryId, value.claimed.id]);
      await value.pool.query("UPDATE google_channel_deliveries SET operation_job_id=$2::uuid WHERE id=$1::uuid", [value.delivery.deliveryId, otherJobId]);
      await assertRejected(value.result(command(84)));
      await value.pool.query("UPDATE google_channel_deliveries SET operation_job_id=$2::uuid WHERE id=$1::uuid", [value.delivery.deliveryId, value.claimed.id]);

      await value.pool.query("UPDATE google_channel_deliveries SET operation_kind='RECONCILE' WHERE id=$1::uuid", [value.delivery.deliveryId]);
      await assertRejected(value.result(command(841)));
      await value.pool.query("UPDATE google_channel_deliveries SET operation_kind='DISPATCH' WHERE id=$1::uuid", [value.delivery.deliveryId]);
      await value.pool.query("UPDATE google_channel_deliveries SET operation_lease_epoch=operation_lease_epoch+1 WHERE id=$1::uuid", [value.delivery.deliveryId]);
      await assertRejected(value.result(command(842)));
      await value.pool.query("UPDATE google_channel_deliveries SET operation_lease_epoch=operation_lease_epoch-1 WHERE id=$1::uuid", [value.delivery.deliveryId]);
      const verifiedTimes = (await value.pool.query("SELECT operation_verified_at,first_verified_at FROM google_channel_deliveries WHERE id=$1::uuid", [value.delivery.deliveryId])).rows[0];
      await value.pool.query(`UPDATE google_channel_deliveries d SET operation_verified_at=j.lease_started_at-interval '1 second',
          first_verified_at=j.lease_started_at-interval '1 second',
          updated_at=clock_timestamp()+interval '1 day'
        FROM channel_jobs j WHERE d.id=$1::uuid AND j.id=$2::uuid`, [value.delivery.deliveryId, value.claimed.id]);
      await assertRejected(value.result(command(843)));
      await value.pool.query(
        "UPDATE google_channel_deliveries SET operation_verified_at=$2,first_verified_at=$3 WHERE id=$1::uuid",
        [value.delivery.deliveryId, verifiedTimes.operation_verified_at, verifiedTimes.first_verified_at],
      );

      await value.pool.query("UPDATE google_channel_deliveries SET lease_epoch=lease_epoch+1 WHERE id=$1::uuid", [value.delivery.deliveryId]);
      await assertRejected(value.result(command(23)));
      await value.pool.query("UPDATE google_channel_deliveries SET lease_epoch=lease_epoch-1 WHERE id=$1::uuid", [value.delivery.deliveryId]);

      await value.pool.query("INSERT INTO channel_workers SELECT 'studio-2',display_name,credential_digest,credential_expires_at,revoked_at,last_heartbeat_at,version,created_at,updated_at FROM channel_workers WHERE id='studio-1'");
      await value.pool.query("UPDATE google_channel_deliveries SET operation_worker_id='studio-2' WHERE id=$1::uuid", [value.delivery.deliveryId]);
      await assertRejected(value.result(command(24)));
      await value.pool.query("UPDATE google_channel_deliveries SET operation_worker_id='studio-1' WHERE id=$1::uuid", [value.delivery.deliveryId]);

      await value.pool.query("UPDATE channel_worker_accounts SET version=version+1 WHERE worker_id='studio-1' AND account_id='account-a'");
      await assertRejected(value.result(command(25)));
      await value.pool.query("UPDATE channel_worker_accounts SET version=version-1 WHERE worker_id='studio-1' AND account_id='account-a'");

      await value.pool.query("UPDATE channel_listings SET mapping_version=mapping_version+1 WHERE id='listing-a'");
      await assertRejected(value.result(command(251)));
      await value.pool.query("UPDATE channel_listings SET mapping_version=mapping_version-1 WHERE id='listing-a'");

      await value.pool.query("UPDATE channel_desired_states SET desired_version=desired_version+1 WHERE listing_id='listing-a'");
      await assertRejected(value.result(command(26)));
      await value.pool.query("UPDATE channel_desired_states SET desired_version=desired_version-1 WHERE listing_id='listing-a'");

      await value.pool.query("UPDATE channel_desired_states SET source_start_at=source_start_at+interval '1 minute' WHERE listing_id='listing-a'");
      await assertRejected(value.result(command(27)));
      await value.pool.query("UPDATE channel_desired_states SET source_start_at=source_start_at-interval '1 minute' WHERE listing_id='listing-a'");

      await value.pool.query("UPDATE schedule_occurrence_sales_states SET desired_state='OPEN' WHERE provider_id='provider-a' AND occurrence_id=$1", [value.claimed.occurrenceId]);
      await assertRejected(value.result(command(271)));
      await value.pool.query("UPDATE schedule_occurrence_sales_states SET desired_state='CLOSED' WHERE provider_id='provider-a' AND occurrence_id=$1", [value.claimed.occurrenceId]);

      await value.pool.query("UPDATE google_channel_output_bindings SET binding_version=binding_version+1 WHERE listing_id='listing-a'");
      await assertRejected(value.result(command(28)));
      await value.pool.query("UPDATE google_channel_output_bindings SET binding_version=binding_version-1 WHERE listing_id='listing-a'");

      await value.pool.query("UPDATE google_channel_output_bindings SET active=false WHERE listing_id='listing-a'");
      await assertRejected(value.result(command(280)));
      await value.pool.query("UPDATE google_channel_output_bindings SET active=true WHERE listing_id='listing-a'");

      await value.pool.query("UPDATE google_channel_output_bindings SET opaque_calendar_id='changed-output' WHERE listing_id='listing-a'");
      await assertRejected(value.result(command(281)));
      await value.pool.query("UPDATE google_channel_output_bindings SET opaque_calendar_id='airbnb-output' WHERE listing_id='listing-a'");

      await value.pool.query("UPDATE google_channel_output_bindings SET connection_generation=connection_generation+1 WHERE listing_id='listing-a'");
      await assertRejected(value.result(command(282)));
      await value.pool.query("UPDATE google_channel_output_bindings SET connection_generation=$1 WHERE listing_id='listing-a'", [value.generation]);

      await value.pool.query("UPDATE provider_google_connections SET granted_scopes=ARRAY[$1] WHERE provider_id='provider-a'", [scopes[2]]);
      await assertRejected(value.result(command(29)));
      await value.pool.query("UPDATE provider_google_connections SET granted_scopes=$1 WHERE provider_id='provider-a'", [scopes]);

      await value.pool.query("UPDATE provider_memberships SET active=false WHERE provider_id='provider-a' AND niho_user_id='owner-a'");
      await assertRejected(value.result(command(30)));
      await value.pool.query("UPDATE provider_memberships SET active=true WHERE provider_id='provider-a' AND niho_user_id='owner-a'");

      const unresolvedId = command(91);
      await value.pool.query(
        `INSERT INTO google_channel_deliveries
         SELECT (jsonb_populate_record(NULL::google_channel_deliveries,
           to_jsonb(d) || jsonb_build_object('id',$2::text,'intent_fingerprint',repeat('f',64),'phase','UNCERTAIN',
             'operation_verified_at',NULL,'first_verified_at',NULL))).*
           FROM google_channel_deliveries d WHERE d.id=$1::uuid`,
        [value.delivery.deliveryId, unresolvedId],
      );
      await assertRejected(value.result(command(301)));
      await value.pool.query("DELETE FROM google_channel_deliveries WHERE id=$1::uuid", [unresolvedId]);

      await value.pool.query("INSERT INTO provider_google_calendars (provider_id,opaque_calendar_id) VALUES ('provider-a','airbnb-output')");
      await assertRejected(value.result(command(302)));
      await value.pool.query("DELETE FROM provider_google_calendars WHERE provider_id='provider-a'");

      await value.pool.query("INSERT INTO inventory_resources (provider_id,id,kind,display_name) VALUES ('provider-a','resource-a','VENUE','Synthetic')");
      await value.pool.query("INSERT INTO resource_google_calendars (provider_id,resource_id,opaque_calendar_id,connection_generation,enabled) VALUES ('provider-a','resource-a','airbnb-output',(SELECT connection_generation FROM provider_google_connections WHERE provider_id='provider-a'),false)");
      await assertRejected(value.result(command(31)));
      await value.pool.query("DELETE FROM resource_google_calendars WHERE provider_id='provider-a' AND resource_id='resource-a'");
      await value.pool.query("UPDATE provider_google_connections SET booking_calendar_id='airbnb-output' WHERE provider_id='provider-a'");
      await assertRejected(value.result(command(303)));
    } finally { await cleanup(value); }
  });

  it("records stopped=false and expired receipts as non-current without marking the host SYNCED", async () => {
    for (const kind of ["stopped", "expired"] as const) {
      const value = await fixture("CLOSED");
      try {
        const input = kind === "stopped" ? value.result(command(40), { stopped: false }) : value.result(command(41));
        if (kind === "expired") value.setNow(new Date(Date.now() + 10 * 60_000));
        assert.deepEqual(await value.runtime.submitResult(value.worker, value.claimed.id, input), { acceptedAsCurrent: false, repeated: false });
        assert.equal((await value.pool.query("SELECT accepted_as_current FROM channel_job_results")).rows[0].accepted_as_current, false);
        assert.equal((await value.pool.query("SELECT observed_state FROM channel_desired_states WHERE listing_id='listing-a'")).rows[0].observed_state, null);
      } finally { await cleanup(value); }
    }
  });

  it("uses RETRY_WAIT proof only for an exact OPEN mismatch and keeps the feature flag closed", async () => {
    const value = await fixture("OPEN");
    try {
      await assert.rejects(() => value.disabledRuntime.submitResult(
        value.worker, value.claimed.id, mismatch(value, command(410)),
      ));
      assert.deepEqual(await value.disabledRuntime.enqueueDueGoogleAirbnbObservations(value.worker, 1), { enqueued: 0 });
      const input = mismatch(value, command(411));
      assert.deepEqual(await value.runtime.submitResult(value.worker, value.claimed.id, input), {
        acceptedAsCurrent: false, repeated: false,
      });
      const wait = (await value.pool.query(
        "SELECT desired_state,status FROM google_airbnb_propagation_waits WHERE delivery_id=$1::uuid",
        [value.delivery.deliveryId],
      )).rows[0];
      assert.deepEqual(wait, { desired_state: "OPEN", status: "WAITING" });
      assert.equal((await value.pool.query(
        "SELECT observed_state FROM channel_desired_states WHERE listing_id='listing-a'",
      )).rows[0].observed_state, null);
    } finally { await cleanup(value); }
  });

  it("never creates a wait for stopped=false or late mismatch receipts", async () => {
    for (const kind of ["stopped", "late"] as const) {
      const value = await fixture("CLOSED");
      try {
        const input = mismatch(value, kind === "stopped" ? command(412) : command(413));
        if (kind === "stopped") input.stopped = false;
        else value.setNow(new Date(Date.now() + 10 * 60_000));
        assert.deepEqual(await value.runtime.submitResult(value.worker, value.claimed.id, input), {
          acceptedAsCurrent: false, repeated: false,
        });
        assert.equal((await value.pool.query(
          "SELECT count(*)::int AS count FROM google_airbnb_propagation_waits",
        )).rows[0].count, 0);
        assert.equal((await value.pool.query(
          "SELECT observed_state FROM channel_desired_states WHERE listing_id='listing-a'",
        )).rows[0].observed_state, null);
      } finally { await cleanup(value); }
    }
  });

  it("expires at the immutable boundary and invalidates changed authority or inventory before enqueue", async () => {
    for (const kind of ["deadline", "binding", "manual", "assignment", "desired", "mapping", "connection", "scope", "owner", "input", "inventory"] as const) {
      const value = await fixture(kind === "inventory" ? "OPEN" : "CLOSED");
      try {
        await value.runtime.submitResult(value.worker, value.claimed.id, mismatch(value, kind === "deadline" ? command(414) : command(415)));
        const wait = (await value.pool.query(
          "SELECT first_verified_at,deadline_at FROM google_airbnb_propagation_waits WHERE delivery_id=$1::uuid",
          [value.delivery.deliveryId],
        )).rows[0];
        await value.pool.query(
          "UPDATE google_airbnb_propagation_waits SET next_due_at=clock_timestamp()-interval '1 second' WHERE delivery_id=$1::uuid",
          [value.delivery.deliveryId],
        );
        if (kind === "deadline") value.setNow(wait.deadline_at);
        else if (kind === "binding") await value.pool.query(
          "UPDATE google_channel_output_bindings SET binding_version=binding_version+1 WHERE listing_id='listing-a'",
        );
        else if (kind === "manual") await value.pool.query(
          "UPDATE channel_external_accounts SET quarantined_at=clock_timestamp(),quarantine_reason='MANUAL_HANDLING' WHERE id='account-a'",
        );
        else if (kind === "assignment") await value.pool.query("UPDATE channel_worker_accounts SET version=version+1 WHERE account_id='account-a'");
        else if (kind === "desired") await value.pool.query("UPDATE channel_desired_states SET desired_version=desired_version+1 WHERE listing_id='listing-a'");
        else if (kind === "mapping") await value.pool.query("UPDATE channel_listings SET mapping_version=mapping_version+1 WHERE id='listing-a'");
        else if (kind === "connection") await value.pool.query("UPDATE provider_google_connections SET connection_generation=connection_generation+1 WHERE provider_id='provider-a'");
        else if (kind === "scope") await value.pool.query("UPDATE provider_google_connections SET granted_scopes=ARRAY['synthetic.revoked.scope'] WHERE provider_id='provider-a'");
        else if (kind === "owner") await value.pool.query("UPDATE provider_memberships SET active=false WHERE provider_id='provider-a' AND niho_user_id='owner-a'");
        else if (kind === "input") await value.pool.query("UPDATE provider_google_connections SET busy_calendar_id='airbnb-output' WHERE provider_id='provider-a'");
        else await new ExperienceStore(value.pool).setOccurrenceSalesState(
          { providerId: "provider-a", nihoUserId: "owner-a" }, "tea", "tea-once",
          { occurrenceId: value.claimed.occurrenceId, desiredState: "CLOSED" }, null, command(416),
        );
        assert.deepEqual(await value.runtime.enqueueDueGoogleAirbnbObservations(value.worker, 1), { enqueued: 0 });
        const terminal = (await value.pool.query(
          "SELECT status,latest_reason,pending_job_id,first_verified_at,deadline_at FROM google_airbnb_propagation_waits WHERE delivery_id=$1::uuid",
          [value.delivery.deliveryId],
        )).rows[0];
        assert.equal(terminal.status, kind === "deadline" ? "NEEDS_REVIEW" : "SUPERSEDED");
        assert.equal(terminal.latest_reason, kind === "deadline" ? "PROPAGATION_DEADLINE"
          : kind === "inventory" ? "LIVE_AVAILABILITY_CHANGED" : "AUTHORITY_CHANGED");
        assert.equal(terminal.pending_job_id, null);
        assert.equal(terminal.first_verified_at.toISOString(), wait.first_verified_at.toISOString());
        assert.equal(terminal.deadline_at.toISOString(), wait.deadline_at.toISOString());
        assert.equal((await value.pool.query(
          "SELECT count(*)::int AS count FROM channel_jobs WHERE google_propagation_delivery_id=$1::uuid",
          [value.delivery.deliveryId],
        )).rows[0].count, 0);
      } finally { await cleanup(value); }
    }
  });

  it("does not show expired, stale, disabled, or manually held propagation as pending", async () => {
    const actor = { providerId: "provider-a", nihoUserId: "owner-a" };
    for (const kind of ["deadline", "desired", "mapping", "disabled", "manual", "worker"] as const) {
      const value = await fixture("CLOSED");
      try {
        await value.runtime.submitResult(value.worker, value.claimed.id, mismatch(value, command(380)));
        const pending = (await value.runtime.hostStatuses(actor))[0];
        assert.equal(pending?.label, "PENDING");
        assert.equal(pending?.error, undefined);
        if (kind === "deadline") value.setNow((await value.pool.query("SELECT deadline_at FROM google_airbnb_propagation_waits"))
          .rows[0].deadline_at);
        else if (kind === "desired") await value.pool.query("UPDATE channel_desired_states SET desired_version=desired_version+1,last_error=NULL WHERE listing_id='listing-a'");
        else if (kind === "mapping") await value.pool.query("UPDATE channel_listings SET mapping_version=mapping_version+1 WHERE id='listing-a'");
        else if (kind === "manual") await value.pool.query("UPDATE channel_external_accounts SET quarantined_at=clock_timestamp(),quarantine_reason='MANUAL_HANDLING' WHERE id='account-a'");
        else if (kind === "worker") {
          await value.pool.query(`UPDATE channel_desired_states SET observed_state='CLOSED',
            observed_desired_version=desired_version,observed_mapping_version=mapping_version,last_verified_at=clock_timestamp()
            WHERE listing_id='listing-a'`);
          await value.pool.query("UPDATE channel_workers SET last_heartbeat_at=clock_timestamp()-interval '1 day' WHERE id=$1", [value.worker.workerId]);
        }
        const statuses = await (kind === "disabled" ? value.disabledRuntime : value.runtime).hostStatuses(actor);
        assert.equal(statuses[0]?.label, kind === "desired" ? "UNVERIFIED" : "ERROR");
      } finally { await cleanup(value); }
    }
  });

  it("keeps queue time inside the propagation window and caps browser execution when claimed", async () => {
    const value = await fixture("CLOSED");
    try {
      await value.runtime.submitResult(value.worker, value.claimed.id, mismatch(value, command(390)));
      await value.pool.query("UPDATE google_airbnb_propagation_waits SET next_due_at=clock_timestamp()-interval '1 second' WHERE delivery_id=$1::uuid",
        [value.delivery.deliveryId]);
      assert.deepEqual(await value.runtime.enqueueDueGoogleAirbnbObservations(value.worker), { enqueued: 1 });
      const queued = (await value.pool.query(
        `SELECT j.job_deadline_at,w.deadline_at FROM google_airbnb_propagation_waits w
           JOIN channel_jobs j ON j.id=w.pending_job_id WHERE w.delivery_id=$1::uuid`, [value.delivery.deliveryId],
      )).rows[0];
      assert.equal(queued.job_deadline_at.getTime(), queued.deadline_at.getTime());
      const beforeClaimMs = Date.now() + 4 * 60_000;
      value.setNow(new Date(beforeClaimMs));
      assert.deepEqual(await value.runtime.enqueueDueGoogleAirbnbObservations(value.worker), { enqueued: 0 });
      const claimed = await value.runtime.claim(value.worker);
      assert.ok(claimed);
      assert.equal(claimed.googleDeliveryOperation, "observe");
      const remainingMs = Date.parse(claimed.deadlineAtUtc) - beforeClaimMs;
      assert.ok(remainingMs > 0 && remainingMs <= 181_000);
      assert.ok(Date.parse(claimed.deadlineAtUtc) < queued.deadline_at.getTime());
      assert.equal((await value.pool.query("SELECT job_deadline_at FROM channel_jobs WHERE id=$1::uuid", [claimed.id]))
        .rows[0].job_deadline_at.toISOString(), claimed.deadlineAtUtc);
    } finally { await cleanup(value); }
  });

  it("persists a known mismatch, survives restart, deduplicates due polls, and matches after fresh GET-only observations", async () => {
    const value = await fixture("CLOSED");
    try {
      const initial = mismatch(value, command(400));
      assert.deepEqual(await value.runtime.submitResult(value.worker, value.claimed.id, initial), {
        acceptedAsCurrent: false, repeated: false,
      });
      assert.equal((await value.runtime.hostStatuses({ providerId: "provider-a", nihoUserId: "owner-a" }))[0]?.label, "PENDING");
      assert.deepEqual(await value.runtime.submitResult(value.worker, value.claimed.id, initial), {
        acceptedAsCurrent: false, repeated: true,
      });
      await assert.rejects(
        () => value.pool.query(
          "UPDATE channel_job_results SET google_airbnb_evidence=NULL WHERE result_id=$1::uuid", [initial.resultId],
        ),
        { code: "23514" },
      );
      const source = (await value.pool.query(
        "SELECT status,outcome,lease_digest,lease_expires_at FROM channel_jobs WHERE id=$1::uuid", [value.claimed.id],
      )).rows[0];
      assert.deepEqual(source, { status: "FINISHED", outcome: "RETRY_WAIT", lease_digest: null, lease_expires_at: null });
      assert.equal((await value.pool.query(
        "SELECT quarantined_at FROM channel_external_accounts WHERE id='account-a'",
      )).rows[0].quarantined_at, null);
      const firstWait = (await value.pool.query(
        "SELECT status,first_verified_at,deadline_at,pending_job_id FROM google_airbnb_propagation_waits WHERE delivery_id=$1::uuid",
        [value.delivery.deliveryId],
      )).rows[0];
      assert.equal(firstWait.status, "WAITING");
      assert.equal(firstWait.pending_job_id, null);
      assert.equal((await value.pool.query(
        "SELECT last_error FROM channel_desired_states WHERE listing_id='listing-a' AND occurrence_id=$1",
        [value.claimed.occurrenceId],
      )).rows[0].last_error, "GOOGLE_PROPAGATION_PENDING");

      // Finishing the source lease must make the global executor available to
      // a separately assigned account before this wait becomes due.
      const admin = { nihoUserId: "admin-a" };
      const accountB = await value.runtime.createExternalAccount(admin, {
        id: "account-b", providerId: "provider-a", site: "Airbnb", externalAccountId: "other-account",
        displayName: "Other synthetic account", operatingModel: 2, active: true,
      }, command(401));
      const listingB = await value.runtime.createListing(admin, {
        id: "listing-b", providerId: "provider-a", accountId: accountB.id, productId: "tea",
        externalProductId: "other-product", adapter: "airbnb-google-busy", adapterVersion: "1",
        connectionMode: "GOOGLE", capabilities: { canOpen: true, canClose: true, canObserve: true }, active: true,
      }, command(402));
      await value.runtime.assignWorkerAccount(admin, value.worker.workerId, accountB.id, null, command(403));
      await value.runtime.reconcileListing(admin, listingB.id, command(404));
      await value.runtime.consumeCalendarOutbox(50, value.worker);
      const other = await value.runtime.claim(value.worker);
      assert.ok(other);
      assert.equal(other.target.externalAccountId, "other-account");
      await value.runtime.submitResult(value.worker, other.id, {
        resultId: command(405), leaseToken: other.leaseToken, outcome: "SUPERSEDED", stopped: true, target: other.target,
      });

      // An ordinary OBSERVE identity may coexist with the delivery-keyed job.
      await value.pool.query(
        `INSERT INTO channel_jobs
          (id,provider_id,account_id,listing_id,occurrence_id,action,account_version,desired_version,mapping_version,
           target_site,target_external_account_id,target_external_product_id,target_external_option_id,target_time_zone,
           target_adapter,target_adapter_version,target_connection_mode,source_start_at,source_end_at,status,priority,outcome)
         SELECT $2::uuid,provider_id,account_id,listing_id,occurrence_id,'OBSERVE',account_version,desired_version,mapping_version,
           target_site,target_external_account_id,target_external_product_id,target_external_option_id,target_time_zone,
           target_adapter,target_adapter_version,target_connection_mode,source_start_at,source_end_at,'FINISHED',1,'SUPERSEDED'
           FROM channel_jobs WHERE id=$1::uuid`,
        [value.claimed.id, command(406)],
      );
      await value.pool.query(
        "UPDATE google_airbnb_propagation_waits SET next_due_at=clock_timestamp()-interval '1 second' WHERE delivery_id=$1::uuid",
        [value.delivery.deliveryId],
      );
      const restarted = value.restartRuntime();
      const due = await Promise.all([
        restarted.enqueueDueGoogleAirbnbObservations(value.worker, 1),
        restarted.enqueueDueGoogleAirbnbObservations(value.worker, 1),
      ]);
      assert.equal(due.reduce((sum, item) => sum + item.enqueued, 0), 1);
      assert.equal((await value.pool.query(
        "SELECT count(*)::int AS count FROM channel_jobs WHERE google_propagation_delivery_id=$1::uuid AND status='QUEUED'",
        [value.delivery.deliveryId],
      )).rows[0].count, 1);
      const observe = await restarted.claim(value.worker);
      assert.ok(observe);
      assert.equal(observe.googleDeliveryOperation, "observe");
      assert.equal((await restarted.hostStatuses({ providerId: "provider-a", nihoUserId: "owner-a" }))[0]?.label, "CHECKING");
      const repository = new GoogleChannelDeliveryRepository(value.pool, restarted);
      const observation = await repository.prepareObservation(value.worker, observe.id, observe.leaseToken);
      assert.equal(observation.operation, "observe");
      await repository.saveResult(
        value.worker, observe.id, observe.leaseToken, observation.record.deliveryId,
        observation.operationNonce, "observe", {
          phase: "GOOGLE_VERIFIED", changed: false, writeAcknowledged: false,
          metadata: {
            eventId: "synthetic-event", etag: '"synthetic-observe-etag"', bindingHash: "synthetic-binding",
            mappingVersion: observe.mappingVersion, desiredVersion: observe.desiredVersion,
            startAtUtc: observe.sourceStartAtUtc, endAtUtc: observe.sourceEndAtUtc,
            desiredState: "CLOSED", transparency: "opaque",
          },
        },
      );
      assert.deepEqual(await restarted.submitResult(value.worker, observe.id, mismatch(value, command(407), observe)), {
        acceptedAsCurrent: false, repeated: false,
      });
      const secondWait = (await value.pool.query(
        "SELECT status,first_verified_at,deadline_at,pending_job_id FROM google_airbnb_propagation_waits WHERE delivery_id=$1::uuid",
        [value.delivery.deliveryId],
      )).rows[0];
      assert.equal(secondWait.status, "WAITING");
      assert.equal(secondWait.pending_job_id, null);
      assert.equal(secondWait.first_verified_at.toISOString(), firstWait.first_verified_at.toISOString());
      assert.equal(secondWait.deadline_at.toISOString(), firstWait.deadline_at.toISOString());

      await value.pool.query(
        "UPDATE google_airbnb_propagation_waits SET next_due_at=clock_timestamp()-interval '1 second' WHERE delivery_id=$1::uuid",
        [value.delivery.deliveryId],
      );
      assert.deepEqual(await restarted.enqueueDueGoogleAirbnbObservations(value.worker, 1), { enqueued: 1 });
      const matchingObserve = await restarted.claim(value.worker); assert.ok(matchingObserve);
      const matchingOperation = await repository.prepareObservation(value.worker, matchingObserve.id, matchingObserve.leaseToken);
      await repository.saveResult(
        value.worker, matchingObserve.id, matchingObserve.leaseToken, matchingOperation.record.deliveryId,
        matchingOperation.operationNonce, "observe", {
          phase: "GOOGLE_VERIFIED", changed: false, writeAcknowledged: false,
          metadata: {
            eventId: "synthetic-event", etag: '"synthetic-match-etag"', bindingHash: "synthetic-binding",
            mappingVersion: matchingObserve.mappingVersion, desiredVersion: matchingObserve.desiredVersion,
            startAtUtc: matchingObserve.sourceStartAtUtc, endAtUtc: matchingObserve.sourceEndAtUtc,
            desiredState: "CLOSED", transparency: "opaque",
          },
        },
      );
      const verifiedAt = (await value.pool.query(
        "SELECT operation_verified_at FROM google_channel_deliveries WHERE id=$1::uuid", [value.delivery.deliveryId],
      )).rows[0].operation_verified_at as Date;
      const matchedInput = value.result(command(408), {
        leaseToken: matchingObserve.leaseToken, target: matchingObserve.target,
        occurrenceId: matchingObserve.occurrenceId, sourceStartAtUtc: matchingObserve.sourceStartAtUtc,
        sourceEndAtUtc: matchingObserve.sourceEndAtUtc, observedAtUtc: new Date(verifiedAt.getTime() + 1).toISOString(),
      });
      // Even identical selected metadata cannot substitute another delivery
      // for the delivery that owns this durable wait.
      await value.pool.query(
        `INSERT INTO google_channel_deliveries
           SELECT (jsonb_populate_record(NULL::google_channel_deliveries,
             to_jsonb(d)||jsonb_build_object('id',$2::text,'intent_fingerprint',repeat('c',64)))).*
           FROM google_channel_deliveries d WHERE id=$1::uuid`, [value.delivery.deliveryId, command(409)],
      );
      await assert.rejects(() => restarted.submitResult(value.worker, matchingObserve.id, {
        ...matchedInput, resultId: command(410),
        googleAirbnbProof: { ...matchedInput.googleAirbnbProof, deliveryId: command(409) },
      }), StoreConflictError);
      assert.equal((await value.pool.query("SELECT count(*)::int AS count FROM channel_job_results WHERE result_id=$1::uuid", [command(410)]))
        .rows[0].count, 0);
      assert.deepEqual(await restarted.submitResult(value.worker, matchingObserve.id, matchedInput), {
        acceptedAsCurrent: true, repeated: false,
      });
      assert.equal((await restarted.hostStatuses({ providerId: "provider-a", nihoUserId: "owner-a" }))[0]?.label, "SYNCED");
      assert.equal((await value.pool.query(
        "SELECT status,pending_job_id FROM google_airbnb_propagation_waits WHERE delivery_id=$1::uuid",
        [value.delivery.deliveryId],
      )).rows[0].status, "MATCHED");
      assert.equal((await value.pool.query(
        "SELECT last_error FROM channel_desired_states WHERE listing_id='listing-a' AND occurrence_id=$1",
        [value.claimed.occurrenceId],
      )).rows[0].last_error, null);
    } finally { await cleanup(value); }
  });
});
