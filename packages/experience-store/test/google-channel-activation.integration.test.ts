import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { GoogleChannelActivationRepository } from "../src/google-channel-activation.ts";
import { GoogleChannelSetupRepository } from "../src/google-channel-setup.ts";
import { StoreAccessDeniedError, StoreConflictError } from "../src/errors.ts";
import type { HostActor } from "../src/types.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const occurrenceId = "rule-a@2099-01-01";
const owner: HostActor = { providerId: "provider-a", nihoUserId: "owner-a", calendarRoleCeiling: "OWNER" };
const scopes = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.app.created",
] as const;
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const scopeDigest = hash(JSON.stringify([...scopes].sort()));
const command = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const input = (commandId = command(315)) => ({
  listingId: "listing-a", occurrenceId, expectedMappingVersion: 1, expectedBindingVersion: 1,
  expectedDesiredVersion: 7, commandId, connectionConfirmed: true as const,
});

async function fixture() {
  const { Pool } = await import("pg");
  const schema = `google_activation_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const migrationUrl = new URL("../migrations/", import.meta.url);
  for (const name of (await readdir(migrationUrl)).filter((item) => /^\d{4}.*\.sql$/.test(item)).sort()) {
    await pool.query(await readFile(new URL(name, migrationUrl), "utf8"));
  }
  await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a'),('provider-b')");
  await pool.query(`INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES
    ('provider-a','owner-a','OWNER'),('provider-a','owner-b','OWNER'),('provider-a','cohost-a','EDITOR'),
    ('provider-b','owner-b','OWNER')`);
  await pool.query(`INSERT INTO experience_products
    (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,
     seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
    VALUES ('provider-a','tea','tea','DRAFT','Synthetic Tea','{}','JPY',1000,'terms','seller','acct','Seller')`);
  await pool.query(`INSERT INTO schedule_rules
    (provider_id,id,product_id,time_zone,starts_on,ends_on,local_start_time,duration_minutes,capacity,
     booking_cutoff_minutes,busy_buffer_before_minutes,busy_buffer_after_minutes,recurrence)
    VALUES ('provider-a','rule-a','tea','Asia/Tokyo','2099-01-01','2099-01-01','10:00',60,4,0,0,0,'{"kind":"DAILY"}')`);
  await pool.query(`INSERT INTO channel_external_accounts
    (id,provider_id,site,external_account_id,display_name,operating_model,active,delegated_until)
    VALUES ('account-a','provider-a','Airbnb','12345','Synthetic',2,true,'2099-02-01T00:00:00Z')`);
  await pool.query(`INSERT INTO channel_listings
    (id,provider_id,account_id,product_id,external_product_id,external_option_id,adapter,adapter_version,connection_mode,active)
    VALUES ('listing-a','provider-a','account-a','tea','67890','','airbnb-google-busy','1','GOOGLE',true)`);
  await pool.query(`INSERT INTO channel_desired_states
    (listing_id,provider_id,occurrence_id,desired_state,reason,desired_version,mapping_version,source_start_at,source_end_at)
    VALUES ('listing-a','provider-a',$1,'OPEN','SYNTHETIC',7,1,'2099-01-01T01:00:00Z','2099-01-01T02:00:00Z')`, [occurrenceId]);
  await pool.query(`INSERT INTO provider_google_connections
    (provider_id,connected_by_niho_user_id,encrypted_refresh_token,granted_scopes,busy_calendar_id,booking_calendar_id)
    VALUES ('provider-a','owner-a',$1,$2,'busy-a','booking-a')`, ["ciphertext".padEnd(48, "x"), [...scopes]]);
  const generation = (await pool.query("SELECT connection_generation FROM provider_google_connections WHERE provider_id='provider-a'")).rows[0].connection_generation;
  const accountVersion = (await pool.query("SELECT version FROM channel_external_accounts WHERE id='account-a'")).rows[0].version;
  await pool.query(`INSERT INTO google_channel_output_bindings
    (provider_id,listing_id,mapping_version,connection_generation,opaque_calendar_id,active)
    VALUES ('provider-a','listing-a',1,$1,'output-a',false)`, [generation]);
  await pool.query(`INSERT INTO google_channel_setup_journals
    (provider_id,command_id,listing_id,account_id,request_fingerprint,created_by_niho_user_id,operation_nonce,
     expected_mapping_version,account_version,connection_generation,granted_scopes_digest,calendar_summary,phase,created_calendar_id)
    VALUES ('provider-a',$1::uuid,'listing-a','account-a',$2,'owner-a',$3::uuid,1,$4,$5,$6,
      'NIHO Airbnb | Synthetic','READY_FOR_CONNECTION','output-a')`,
  [command(900), "a".repeat(64), randomUUID(), accountVersion, generation, scopeDigest]);
  await pool.query(`INSERT INTO google_channel_anchor_journals
    (provider_id,command_id,account_id,listing_id,occurrence_id,actor_niho_user_id,request_fingerprint,
     operation,operation_nonce,account_version,mapping_version,binding_version,connection_generation,
     binding_calendar_digest,granted_scopes_digest,desired_state,desired_version,source_start_at,source_end_at,
     phase,event_id,event_etag,google_binding_hash,google_mapping_version,google_desired_version,
     google_start_at,google_end_at,google_desired_state,google_transparency,changed,write_acknowledged)
    VALUES ('provider-a',$1::uuid,'account-a','listing-a',$2,'owner-a',$3,'INITIALIZE',$4::uuid,$5,1,1,$6,
      $7,$8,'OPEN',7,'2099-01-01T01:00:00Z','2099-01-01T02:00:00Z','GOOGLE_VERIFIED',
      'event-a','"etag"',$9,1,7,'2099-01-01T01:00:00Z','2099-01-01T02:00:00Z','OPEN','transparent',true,true)`,
  [command(901), occurrenceId, "b".repeat(64), randomUUID(), accountVersion, generation,
    hash("output-a"), scopeDigest, "c".repeat(52)]);
  return { pool, schema };
}

async function cleanup(value: Awaited<ReturnType<typeof fixture>>) {
  await value.pool.query(`DROP SCHEMA IF EXISTS "${value.schema}" CASCADE`).catch(() => undefined);
  await value.pool.end();
}

describe("PostgreSQL Google channel OWNER activation", { skip: databaseUrl === undefined }, () => {
  it("reports readiness, applies once, replays exactly, and records no sync or receipt fact", async () => {
    const value = await fixture();
    try {
      const repository = new GoogleChannelActivationRepository(value.pool);
      assert.deepEqual(await repository.get(owner, "listing-a", occurrenceId), {
        listingId: "listing-a", occurrenceId, state: "READY",
        expectedMappingVersion: 1, expectedBindingVersion: 1, expectedDesiredVersion: 7,
      });
      for (const actor of [
        { ...owner, calendarRoleCeiling: "VIEWER" as const },
        { providerId: "provider-a", nihoUserId: "cohost-a", calendarRoleCeiling: "EDITOR" as const },
        { providerId: "provider-a", nihoUserId: "owner-a", calendarScope: "OPERATOR" as const },
        { providerId: "provider-a", nihoUserId: "owner-b", calendarRoleCeiling: "OWNER" as const },
      ]) await assert.rejects(() => repository.activate(actor, input()), StoreAccessDeniedError);
      assert.equal((await value.pool.query("SELECT count(*)::int AS count FROM google_channel_activation_commands")).rows[0].count, 0);

      const [first, replayed] = await Promise.all([repository.activate(owner, input()), repository.activate(owner, input())]);
      assert.equal(first.state, "APPLIED");
      assert.equal(replayed.state, "APPLIED");
      assert.equal((await repository.activate(owner, input())).state, "APPLIED");
      await assert.rejects(() => repository.activate(owner, { ...input(), expectedDesiredVersion: 8 }), StoreConflictError);
      await value.pool.query("UPDATE provider_google_connections SET granted_scopes=ARRAY['https://www.googleapis.com/auth/calendar.app.created'] WHERE provider_id='provider-a'");
      await assert.rejects(() => repository.activate(owner, input()), StoreConflictError);
      await value.pool.query("UPDATE provider_google_connections SET granted_scopes=$1 WHERE provider_id='provider-a'", [[...scopes]]);
      assert.deepEqual((await value.pool.query(
        "SELECT active,binding_version,initialize_missing_open_anchor FROM google_channel_output_bindings WHERE listing_id='listing-a'",
      )).rows[0], { active: true, binding_version: "2", initialize_missing_open_anchor: true });
      assert.equal((await value.pool.query("SELECT count(*)::int AS count FROM google_channel_activation_commands")).rows[0].count, 1);
      assert.equal((await value.pool.query("SELECT count(*)::int AS count FROM google_channel_deliveries")).rows[0].count, 0);
      assert.equal((await value.pool.query("SELECT count(*)::int AS count FROM channel_job_results")).rows[0].count, 0);
      assert.equal((await repository.get(owner, "listing-a", occurrenceId)).state, "ACTIVE");
      assert.equal((await new GoogleChannelSetupRepository(value.pool).get(owner, "listing-a"))?.state, "UNCERTAIN");
    } finally { await cleanup(value); }
  });

  it("invalidates stale authority before mutating the binding", async (context) => {
    const cases: readonly [string, string][] = [
      ["mapping", "UPDATE channel_listings SET mapping_version=2 WHERE id='listing-a'"],
      ["desired", "UPDATE channel_desired_states SET desired_version=8 WHERE listing_id='listing-a'"],
      ["binding", "UPDATE google_channel_output_bindings SET binding_version=2 WHERE listing_id='listing-a'"],
      ["account", "UPDATE channel_external_accounts SET active=false WHERE id='account-a'"],
      ["scopes", "UPDATE provider_google_connections SET granted_scopes=ARRAY['https://www.googleapis.com/auth/calendar.app.created'] WHERE provider_id='provider-a'"],
      ["generation", "UPDATE provider_google_connections SET connection_generation=connection_generation+1 WHERE provider_id='provider-a'"],
      ["canonical", "UPDATE schedule_rules SET local_start_time='11:00' WHERE id='rule-a'"],
      ["inventory", `INSERT INTO schedule_occurrence_sales_states (provider_id,rule_id,occurrence_id,desired_state) VALUES ('provider-a','rule-a','${occurrenceId}','CLOSED')`],
      ["anchor unresolved", "UPDATE google_channel_anchor_journals SET phase='UNCERTAIN',reason='WRITE_UNCERTAIN' WHERE listing_id='listing-a'"],
      ["cross-provider input", "INSERT INTO provider_google_calendars (provider_id,opaque_calendar_id) VALUES ('provider-b','output-a')"],
      ["active account lease", `
        INSERT INTO channel_workers (id,display_name,credential_digest,credential_expires_at)
          VALUES ('worker-a','Synthetic','${"d".repeat(64)}','2099-02-01T00:00:00Z');
        INSERT INTO channel_jobs
          (id,provider_id,account_id,listing_id,occurrence_id,action,account_version,desired_version,mapping_version,
           target_site,target_external_account_id,target_external_product_id,target_external_option_id,target_time_zone,
           target_adapter,target_adapter_version,target_connection_mode,source_start_at,source_end_at,status,priority,
           leased_worker_id,lease_digest,lease_epoch,lease_assignment_version,lease_started_at,lease_expires_at,job_deadline_at)
        VALUES ('${command(800)}','provider-a','account-a','listing-a','${occurrenceId}','SET_OPEN',1,7,1,
          'Airbnb','12345','67890','','Asia/Tokyo','airbnb-google-busy','1','GOOGLE',
          '2099-01-01T01:00:00Z','2099-01-01T02:00:00Z','LEASED',50,'worker-a','${"e".repeat(64)}',1,1,
          clock_timestamp(),'2099-01-01T00:00:00Z','2099-01-01T00:00:00Z')`],
      ["unresolved delivery", `
        INSERT INTO channel_workers (id,display_name,credential_digest,credential_expires_at)
          VALUES ('worker-a','Synthetic','${"d".repeat(64)}','2099-02-01T00:00:00Z');
        INSERT INTO channel_jobs
          (id,provider_id,account_id,listing_id,occurrence_id,action,account_version,desired_version,mapping_version,
           target_site,target_external_account_id,target_external_product_id,target_external_option_id,target_time_zone,
           target_adapter,target_adapter_version,target_connection_mode,source_start_at,source_end_at,status,priority)
        VALUES ('${command(801)}','provider-a','account-a','listing-a','${occurrenceId}','SET_OPEN',1,7,1,
          'Airbnb','12345','67890','','Asia/Tokyo','airbnb-google-busy','1','GOOGLE',
          '2099-01-01T01:00:00Z','2099-01-01T02:00:00Z','QUEUED',50);
        INSERT INTO google_channel_deliveries
          (id,intent_fingerprint,job_id,provider_id,account_id,listing_id,occurrence_id,action,desired_state,
           desired_version,mapping_version,source_start_at,source_end_at,worker_id,lease_epoch,assignment_version,
           account_version,binding_version,connection_generation,binding_calendar_digest,granted_scopes_digest,
           operation_nonce,operation_kind,operation_job_id,operation_worker_id,operation_lease_epoch,
           operation_assignment_version,phase)
        SELECT '${command(802)}','${"f".repeat(64)}','${command(801)}','provider-a','account-a','listing-a',
          '${occurrenceId}','SET_OPEN','OPEN',7,1,'2099-01-01T01:00:00Z','2099-01-01T02:00:00Z',
          'worker-a',1,1,1,b.binding_version,b.connection_generation,'${hash("output-a")}','${scopeDigest}',
          '${command(803)}','DISPATCH','${command(801)}','worker-a',1,1,'DISPATCHING'
          FROM google_channel_output_bindings b WHERE b.provider_id='provider-a' AND b.listing_id='listing-a'`],
    ];
    for (const [name, mutation] of cases) await context.test(name, async () => {
      const value = await fixture();
      try {
        await value.pool.query(mutation);
        await assert.rejects(() => new GoogleChannelActivationRepository(value.pool).activate(owner, input()), StoreConflictError);
        assert.deepEqual((await value.pool.query(
          "SELECT active,binding_version,initialize_missing_open_anchor FROM google_channel_output_bindings WHERE listing_id='listing-a'",
        )).rows[0], { active: false, binding_version: name === "binding" ? "2" : "1", initialize_missing_open_anchor: false });
        assert.equal((await value.pool.query("SELECT count(*)::int AS count FROM google_channel_activation_commands")).rows[0].count, 0);
      } finally { await cleanup(value); }
    });
  });

  it("keeps connection status independent of the initial slot after activation", async () => {
    const value = await fixture();
    try {
      const repository = new GoogleChannelActivationRepository(value.pool);
      await repository.activate(owner, input());
      await value.pool.query("UPDATE channel_desired_states SET desired_state='CLOSED',desired_version=8 WHERE listing_id='listing-a'");
      assert.equal((await repository.get(owner, "listing-a", occurrenceId)).state, "ACTIVE");

      await value.pool.query("UPDATE schedule_rules SET ends_on='2099-01-02' WHERE id='rule-a'");
      await value.pool.query(`INSERT INTO channel_desired_states
        (listing_id,provider_id,occurrence_id,desired_state,reason,desired_version,mapping_version,source_start_at,source_end_at)
        VALUES ('listing-a','provider-a','rule-a@2099-01-02','OPEN','SYNTHETIC',9,1,'2099-01-02T01:00:00Z','2099-01-02T02:00:00Z')`);
      const next = await repository.get(owner, "listing-a", "rule-a@2099-01-02");
      assert.equal(next.state, "ACTIVE");
      assert.equal(next.expectedDesiredVersion, 9);
      await value.pool.query("UPDATE channel_external_accounts SET quarantined_at=clock_timestamp(),quarantine_reason='MANUAL_HANDLING' WHERE id='account-a'");
      assert.equal((await repository.get(owner, "listing-a", occurrenceId)).state, "NEEDS_REVIEW");
      assert.equal((await value.pool.query("SELECT count(*)::int AS count FROM channel_job_results")).rows[0].count, 0);
    } finally { await cleanup(value); }
  });
});
