import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import pg from "pg";

/*
 * #705: upgrading a database that already holds pre-0092 data. Migrations up to 0091 are applied to a fresh database,
 * realistic rows are inserted with the pre-0092 columns only, then 0092 is applied and its backfill and constraints checked.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const skip = databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false;
const MIGRATIONS = new URL("../migrations/", import.meta.url);

function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

describe("migration 0092 on a database with pre-0092 data (#705)", { skip }, () => {
  it("backfills only products that are PUBLISHED, keeps them sellable, and enforces the new constraints", async () => {
    const names = (await readdir(MIGRATIONS)).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort();
    const target = "0092_experience_booking_publication.sql";
    assert.ok(names.includes(target));
    const database = `exptest_${randomUUID().replaceAll("-", "")}_upgrade_0092`.slice(0, 63);
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    const pool = new pg.Pool({ connectionString: withDatabase(databaseUrl!, database), max: 2 });
    pool.on("error", () => undefined);
    try {
      for (const name of names.filter((item) => item < target)) await pool.query(await readFile(new URL(name, MIGRATIONS), "utf8"));
      assert.equal((await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name='experience_product_publication_states' AND column_name='booking_publication_id'")).rowCount, 0);

      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-up')");
      await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES ('provider-up','owner-up','OWNER',true)");
      const product = (id: string, status: string) => pool.query(
        `INSERT INTO experience_products
           (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
         VALUES ('provider-up',$1,$1,$2,'Synthetic','{}','JPY',1000,'terms','seller-up','acct_Up','Up Seller')`, [id, status]);
      // A publication exactly as before 0092: the seller group, the consent and (for the oldest) the pre-0043 sentinel terms.
      const publish = async (id: string, termsVersion: number, snapshot: string, state: string) => {
        const publication = await pool.query<{ id: string }>(
          `INSERT INTO experience_product_publications
             (provider_id,product_id,draft_version,sale_terms_version,slug,public_title,content,currency,unit_amount,cancellation_terms_ref,
              seller_niho_account_ref,stripe_connect_account_ref,seller_display_name,consent_version,published_by_niho_user_id,sale_terms_snapshot)
           VALUES ('provider-up',$1,1,$2,$1,'Synthetic','{}','JPY',1000,'terms','seller-up','acct_Up','Up Seller','consent-v1','owner-up',$3::jsonb)
           RETURNING id::text`, [id, termsVersion, snapshot]);
        await pool.query(
          `INSERT INTO experience_product_publication_states (provider_id,product_id,current_publication_id,first_published_at ${state ? "," + state.split("=")[0] : ""})
           SELECT 'provider-up',$1,$2::bigint,published_at ${state ? ", " + state.split("=")[1] : ""} FROM experience_product_publications WHERE id=$2::bigint`,
          [id, publication.rows[0]!.id]);
      };
      await product("a-oldest", "PUBLISHED"); await publish("a-oldest", 0, "{}", "");
      await product("b-published", "PUBLISHED"); await publish("b-published", 3, '{"minimumParticipants":1}', "");
      await product("c-stopped", "PUBLISHED"); await publish("c-stopped", 3, '{"minimumParticipants":1}', "self_stopped_at=clock_timestamp()");
      await product("d-draft-with-state", "DRAFT"); await publish("d-draft-with-state", 3, '{"minimumParticipants":1}', "");
      await product("e-draft", "DRAFT");
      await product("f-legacy", "PUBLISHED");
      const statuses = async () => Object.fromEntries((await pool.query("SELECT id,status FROM experience_products ORDER BY id")).rows.map((row) => [row.id, row.status]));
      const before = await statuses();

      await pool.query(await readFile(new URL(target, MIGRATIONS), "utf8"));

      assert.deepEqual(await statuses(), before, "no status changes: every published product is still sellable");
      const states = (await pool.query("SELECT product_id,(booking_publication_id=current_publication_id) AS same,booking_publication_id IS NULL AS none FROM experience_product_publication_states ORDER BY product_id")).rows;
      assert.deepEqual(states.map((row) => [row.product_id, row.none ? "none" : row.same ? "booking=page" : "other"]), [
        ["a-oldest", "booking=page"], ["b-published", "booking=page"], ["c-stopped", "booking=page"], ["d-draft-with-state", "none"],
      ]);
      const events = (await pool.query("SELECT product_id,kind,reason FROM experience_product_booking_events ORDER BY product_id")).rows;
      assert.deepEqual(events.map((row) => `${row.product_id}:${row.kind}:${row.reason}`), [
        "a-oldest:OPENED:BACKFILL", "b-published:OPENED:BACKFILL", "c-stopped:OPENED:BACKFILL",
      ]);

      // The constraints are live: the status/booking trigger, the append-only log, the page-version shape.
      await assert.rejects(pool.query("UPDATE experience_products SET status='PUBLISHED' WHERE id='d-draft-with-state'"), { code: "23514" });
      await assert.rejects(pool.query("UPDATE experience_products SET status='DRAFT' WHERE id='b-published'"), { code: "23514" });
      await assert.rejects(pool.query("DELETE FROM experience_product_booking_events"), { code: "23514" });
      await assert.rejects(pool.query(
        `INSERT INTO experience_product_publications (provider_id,product_id,draft_version,slug,public_title,content,currency,unit_amount,cancellation_terms_ref,published_by_niho_user_id,sale_terms_version)
         VALUES ('provider-up','e-draft',1,'e','e','{}','JPY',1000,'t','owner-up',2)`), { code: "23514" });
      await pool.query(
        `INSERT INTO experience_product_publications (provider_id,product_id,draft_version,slug,public_title,content,currency,unit_amount,cancellation_terms_ref,published_by_niho_user_id)
         VALUES ('provider-up','e-draft',1,'e','e','{}','JPY',1000,'t','owner-up')`);
      // The pre-0043 sentinel row stays valid and untouched (the sale-terms CHECK is NOT VALID for old rows).
      assert.equal((await pool.query("SELECT sale_terms_version::int AS v FROM experience_product_publications WHERE product_id='a-oldest'")).rows[0]?.v, 0);
    } finally {
      await pool.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });
});
