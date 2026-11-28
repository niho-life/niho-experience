import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { HostAccounts } from "../src/host-accounts.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";

/*
 * #732 (migration 0100): the trigger functions of 0092 to 0097 pin search_path = pg_catalog, public, pg_temp, so a temporary
 * table of a session's own cannot stand in for a table a function reads. Real schema, synthetic data.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const skip = databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false;
const PINNED = "search_path=pg_catalog, public, pg_temp";

async function withDb(run: (pool: Pool) => Promise<void>): Promise<void> {
  const db = await createIsolatedDatabase(databaseUrl, "trigger_search_path", { max: 4 });
  try { await run(db.pool); } finally { await db.dispose(); }
}

async function hostOwning(pool: Pool, providerId: string, email: string): Promise<string> {
  await pool.query("INSERT INTO experience_providers (id) VALUES ($1) ON CONFLICT DO NOTHING", [providerId]);
  const accounts = new HostAccounts(pool);
  const { hostAccountId } = await accounts.provisionHostAccount({ email, nowUtc: new Date().toISOString() });
  assert.equal((await accounts.grantProviderOwner({ providerId, hostAccountId, nowUtc: new Date().toISOString() })).kind, "granted");
  return hostAccountId;
}

describe("trigger functions pin their search_path (0100)", { skip }, () => {
  it("every trigger function of 0092 to 0097 carries the setting", async () => {
    await withDb(async (pool) => {
      // The list is read from the migration files, so a function a later edit adds there is checked too.
      const files = ["0092_experience_booking_publication", "0093_host_self_registration", "0094_booking_changes", "0094_host_operations_tools",
        "0095_host_connect_accounts", "0096_agent_sales", "0097_agent_payouts"];
      const names = new Set<string>();
      for (const file of files) {
        const sql = await readFile(new URL(`../migrations/${file}.sql`, import.meta.url), "utf8");
        for (const match of sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION\s+([a-z_0-9]+)\(/g)) names.add(match[1]!);
      }
      assert.ok(names.size >= 14, `found ${names.size} functions`);
      const rows = (await pool.query(
        `SELECT p.proname, p.proconfig FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])`, [[...names]])).rows;
      assert.deepEqual(rows.map((row) => row.proname).sort(), [...names].sort());
      for (const row of rows) assert.deepEqual(row.proconfig, [PINNED], row.proname);
    });
  });

  it("the owner limit counts the real table, not a temporary one of the same name (0093)", async () => {
    await withDb(async (pool) => {
      const hostAccountId = await hostOwning(pool, "provider-limit-1", "limit-owner@example.test");
      for (const n of [2, 3]) {
        await pool.query("INSERT INTO experience_providers (id) VALUES ($1)", [`provider-limit-${n}`]);
        await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES ($1,$2,'OWNER',true)", [`provider-limit-${n}`, hostAccountId]);
      }
      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-limit-4')");
      const client = await pool.connect();
      try {
        await client.query("CREATE TEMP TABLE provider_memberships (niho_user_id text, role text, active boolean, provider_id text)");
        await assert.rejects(
          () => client.query("INSERT INTO public.provider_memberships (provider_id,niho_user_id,role,active) VALUES ('provider-limit-4',$1,'OWNER',true)", [hostAccountId]),
          /at most 3 providers/);
      } finally {
        await client.query("DROP TABLE IF EXISTS pg_temp.provider_memberships").catch(() => undefined);
        client.release();
      }
    });
  });

  it("the agent seller reference check reads the real consents, not a temporary table (0096)", async () => {
    await withDb(async (pool) => {
      const hostAccountId = await hostOwning(pool, "provider-consent", "consent-owner@example.test");
      const insert = (client: Pick<Pool, "query">, ref: string) => client.query(
        `INSERT INTO public.provider_agent_sales_consents (id,provider_id,seller_ref,consent_version,consented_by_host_account_id,consented_at)
         VALUES ($1,'provider-consent',$2,'v1',$3,clock_timestamp())`, [randomUUID(), ref, hostAccountId]);
      await insert(pool, `agt_${"a".repeat(32)}`);
      await pool.query("UPDATE public.provider_agent_sales_consents SET revoked_at=clock_timestamp(),revoked_by_host_account_id=$1", [hostAccountId]);
      const client = await pool.connect();
      try {
        // An empty table of the same name would hide the first reference from an unpinned lookup.
        await client.query("CREATE TEMP TABLE provider_agent_sales_consents (provider_id text, seller_ref text)");
        await assert.rejects(() => insert(client, `agt_${"b".repeat(32)}`), /never changes/);
      } finally {
        await client.query("DROP TABLE IF EXISTS pg_temp.provider_agent_sales_consents").catch(() => undefined);
        client.release();
      }
    });
  });
});
