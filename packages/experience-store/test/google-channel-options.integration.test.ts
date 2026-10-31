import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { GoogleChannelOptionsRepository } from "../src/google-channel-options.ts";
import { StoreAccessDeniedError, StoreValidationError } from "../src/errors.ts";
import type { HostActor } from "../src/types.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const occurrenceId = "rule-a@2099-01-01";
const setupCommandId = "00000000-0000-4000-8000-000000000317";
const anchorCommandId = "00000000-0000-4000-8000-000000000318";
const owner: HostActor = { providerId: "provider-a", nihoUserId: "owner-a", calendarRoleCeiling: "OWNER" };

async function fixture() {
  const { Pool } = await import("pg");
  const schema = `google_options_${randomUUID().replaceAll("-", "")}`;
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
    VALUES ('account-a','provider-a','Airbnb','12345','合成アカウント',2,true,'2099-02-01T00:00:00Z')`);
  await pool.query(`INSERT INTO channel_listings
    (id,provider_id,account_id,product_id,external_product_id,external_option_id,adapter,adapter_version,connection_mode,active)
    VALUES ('listing-a','provider-a','account-a','tea','67890','','airbnb-google-busy','1','GOOGLE',true),
           ('listing-inactive','provider-a','account-a','tea','67891','','airbnb-google-busy','1','GOOGLE',false)`);
  await pool.query(`INSERT INTO channel_desired_states
    (listing_id,provider_id,occurrence_id,desired_state,reason,desired_version,mapping_version,source_start_at,source_end_at)
    VALUES ('listing-a','provider-a',$1,'OPEN','SYNTHETIC',7,1,'2099-01-01T01:00:00Z','2099-01-01T02:00:00Z')`, [occurrenceId]);
  await pool.query(`INSERT INTO provider_google_connections
    (provider_id,connected_by_niho_user_id,encrypted_refresh_token,granted_scopes,busy_calendar_id,booking_calendar_id)
    VALUES ('provider-a','owner-a',$1,ARRAY[]::text[],'busy-a','booking-a')`, ["ciphertext".padEnd(48, "x")]);
  const generation = (await pool.query("SELECT connection_generation FROM provider_google_connections WHERE provider_id='provider-a'")).rows[0].connection_generation;
  await pool.query(`INSERT INTO google_channel_setup_journals
    (provider_id,command_id,listing_id,account_id,request_fingerprint,created_by_niho_user_id,operation_nonce,
     expected_mapping_version,account_version,connection_generation,granted_scopes_digest,calendar_summary,phase)
    VALUES ('provider-a',$1::uuid,'listing-a','account-a',$2,'owner-a',$3::uuid,1,1,$4,$5,'NIHO Airbnb | Synthetic','PREPARING')`,
  [setupCommandId, "a".repeat(64), randomUUID(), generation, "b".repeat(64)]);
  await pool.query(`INSERT INTO google_channel_anchor_journals
    (provider_id,command_id,account_id,listing_id,occurrence_id,actor_niho_user_id,request_fingerprint,
     operation,operation_nonce,account_version,mapping_version,binding_version,connection_generation,
     binding_calendar_digest,granted_scopes_digest,desired_state,desired_version,source_start_at,source_end_at,phase)
    VALUES ('provider-a',$1::uuid,'account-a','listing-a',$2,'owner-a',$3,'INITIALIZE',$4::uuid,1,1,1,$5,
      $6,$7,'OPEN',7,'2099-01-01T01:00:00Z','2099-01-01T02:00:00Z','PREPARING')`,
  [anchorCommandId, occurrenceId, "c".repeat(64), randomUUID(), generation, "d".repeat(64), "e".repeat(64)]);
  return { pool, schema };
}

async function cleanup(value: Awaited<ReturnType<typeof fixture>>) {
  await value.pool.query(`DROP SCHEMA IF EXISTS "${value.schema}" CASCADE`).catch(() => undefined);
  await value.pool.end();
}

describe("PostgreSQL Google channel OWNER options", { skip: databaseUrl === undefined }, () => {
  it("selects only canonical eligible candidates and preserves same-actor original command versions", async () => {
    const value = await fixture();
    try {
      const repository = new GoogleChannelOptionsRepository(value.pool);
      const selected = await repository.get(owner, "tea", occurrenceId);
      assert.deepEqual(selected, { connected: true, candidates: [{
        listingId: "listing-a", accountDisplayName: "合成アカウント", mappingVersion: 1,
        localDate: "2099-01-01", sourceStartAtUtc: "2099-01-01T01:00:00.000Z",
        sourceEndAtUtc: "2099-01-01T02:00:00.000Z", desiredVersion: 7,
        pendingSetup: { commandId: setupCommandId, expectedMappingVersion: 1 },
        pendingAnchor: { commandId: anchorCommandId, expectedMappingVersion: 1, expectedDesiredVersion: 7 },
      }] });
      assert.equal(JSON.stringify(selected).includes("67890"), false);

      await value.pool.query("DELETE FROM channel_desired_states WHERE listing_id='listing-a'");
      const withoutDesired = await repository.get(owner, "tea", occurrenceId);
      assert.equal(withoutDesired.candidates[0]?.desiredVersion, undefined);
      await value.pool.query("DELETE FROM provider_google_connections WHERE provider_id='provider-a'");
      assert.equal((await repository.get(owner, "tea", occurrenceId)).connected, false);
      await value.pool.query(`INSERT INTO provider_google_connections
        (provider_id,connected_by_niho_user_id,encrypted_refresh_token,granted_scopes,busy_calendar_id,booking_calendar_id)
        VALUES ('provider-a','owner-b',$1,ARRAY[]::text[],'busy-b','booking-b')`, ["ciphertext".padEnd(48, "y")]);
      await assert.rejects(() => repository.get(owner, "tea", occurrenceId), StoreAccessDeniedError);
    } finally { await cleanup(value); }
  });

  it("rejects operator, cohost, provider/product, and occurrence mismatches without writing", async () => {
    const value = await fixture();
    try {
      const repository = new GoogleChannelOptionsRepository(value.pool);
      await assert.rejects(() => repository.get({ ...owner, calendarScope: "OPERATOR" }, "tea", occurrenceId), StoreAccessDeniedError);
      await assert.rejects(() => repository.get({ providerId: "provider-a", nihoUserId: "cohost-a", calendarRoleCeiling: "EDITOR" }, "tea", occurrenceId), StoreAccessDeniedError);
      await assert.rejects(() => repository.get({ ...owner, providerId: "provider-b" }, "tea", occurrenceId), StoreAccessDeniedError);
      await assert.rejects(() => repository.get(owner, "missing", occurrenceId), StoreValidationError);
      await assert.rejects(() => repository.get(owner, "tea", "rule-a@2099-01-02"), StoreValidationError);
      assert.equal((await value.pool.query("SELECT count(*)::int AS count FROM google_channel_setup_journals")).rows[0].count, 1);
      assert.equal((await value.pool.query("SELECT count(*)::int AS count FROM google_channel_anchor_journals")).rows[0].count, 1);
    } finally { await cleanup(value); }
  });
});
