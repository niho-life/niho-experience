import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const repo = new URL("../../../", import.meta.url);
const { atomicMigrationSql, migrationBody } = await import(new URL("scripts/gcp/migration-sql.mjs", repo).href) as {
  atomicMigrationSql(input: { name: string; source: string; ledger: string; sha256: string; escapeLiteral(value: string): string }): string;
  migrationBody(name: string, source: string): string;
};
const databaseUrl = process.env.TEST_DATABASE_URL;
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const HASH = "a".repeat(64);

describe("atomic migration SQL", () => {
  it("replaces the file's own BEGIN/COMMIT with one transaction that also records the ledger row", () => {
    const sql = atomicMigrationSql({ name: "0001_x.sql", source: "-- note\nBEGIN;\nCREATE TABLE t (id int);\nCOMMIT;\n", ledger: "ledger", sha256: HASH, escapeLiteral: quote });
    assert.equal(sql, `BEGIN;\nCREATE TABLE t (id int);\nINSERT INTO ledger (name,sha256) VALUES ('0001_x.sql','${HASH}');\nCOMMIT;`);
    // A file that never opened a transaction is wrapped as it is.
    assert.equal(migrationBody("0003_x.sql", "ALTER TABLE t ADD COLUMN c int;\n"), "ALTER TABLE t ADD COLUMN c int;\n");
  });

  it("refuses a file whose transaction control it cannot place", () => {
    for (const source of [
      "BEGIN;\nCREATE TABLE t (id int);\n",
      "CREATE TABLE t (id int);\nCOMMIT;\n",
      "BEGIN;\nCREATE TABLE a (id int);\nCOMMIT;\nBEGIN;\nCREATE TABLE b (id int);\nCOMMIT;\n",
      "BEGIN;\nCREATE TABLE a (id int);\nROLLBACK;\nCOMMIT;\n",
      "CREATE TABLE a (id int);\nBEGIN;\n",
    ]) assert.throws(() => migrationBody("0001_x.sql", source), /transaction|BEGIN/, source);
  });

  it("accepts every migration file in the repository, and plpgsql END; is not transaction control", async () => {
    const dir = new URL("packages/experience-store/migrations/", repo);
    const names = (await readdir(dir)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name));
    assert.ok(names.length > 20);
    for (const name of names) {
      const body = migrationBody(name, await readFile(new URL(name, dir), "utf8"));
      assert.doesNotMatch(body, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;\s*$/im, name);
    }
  });
});

describe("PostgreSQL atomic migration apply", { skip: databaseUrl === undefined }, () => {
  it("leaves neither the schema change nor the ledger row when the run fails, and both when it succeeds", async () => {
    const { Client } = await import("pg");
    const schema = `migration_sql_${Date.now()}`;
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path=${schema}`);
      await client.query("CREATE TABLE ledger (name text PRIMARY KEY, sha256 text NOT NULL)");
      const exists = async () => (await client.query("SELECT to_regclass('t') IS NOT NULL AS present")).rows[0].present as boolean;
      const rows = async () => Number((await client.query("SELECT count(*)::int AS n FROM ledger")).rows[0].n);
      const run = (name: string, source: string) => atomicMigrationSql({ name, source, ledger: "ledger", sha256: HASH, escapeLiteral: (value) => client.escapeLiteral(value) });

      // The migration's last statement fails: its earlier statements and the ledger row are rolled back together.
      await assert.rejects(() => client.query(run("0001_a.sql", "BEGIN;\nCREATE TABLE t (id int);\nINSERT INTO nowhere VALUES (1);\nCOMMIT;\n")));
      await client.query("ROLLBACK");
      assert.equal(await exists(), false);
      assert.equal(await rows(), 0);

      // The ledger row cannot be written (name already recorded): the schema change is rolled back with it.
      await client.query(`INSERT INTO ledger VALUES ('0002_b.sql','${HASH}')`);
      await assert.rejects(() => client.query(run("0002_b.sql", "BEGIN;\nCREATE TABLE t (id int);\nCOMMIT;\n")));
      await client.query("ROLLBACK");
      assert.equal(await exists(), false);
      assert.equal(await rows(), 1);

      await client.query(run("0003_c.sql", "BEGIN;\nCREATE TABLE t (id int);\nCOMMIT;\n"));
      assert.equal(await exists(), true);
      assert.equal(await rows(), 2);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
      await client.end();
    }
  });
});
