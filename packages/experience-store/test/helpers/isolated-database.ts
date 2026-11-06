import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { Pool } from "pg";

/**
 * A database of its own for one DB integration test case, holding every migration, synthetic data only (#431).
 *
 * Applying all migrations into a fresh schema per case took about a second on the CI image (and `DROP SCHEMA ... CASCADE`
 * another 0.4 s), which was the largest share of the store's test time. Here the migrations run once into a template
 * database; each case copies it (`CREATE DATABASE ... TEMPLATE`, about 50 ms) and drops the copy (about 15 ms).
 *
 * - The template is named after a hash of the migration files, so a changed migration builds a new one and never reuses
 *   a stale one. It is built under an advisory lock, so test processes started in parallel build it once, and under
 *   another name that is renamed only when complete, so an interrupted build leaves nothing a later run would trust.
 * - Old templates and the `exptest_` copies of a crashed run stay in the test database until you drop them
 *   (docs/development.md). CI uses a throwaway PostgreSQL, so nothing accumulates there.
 * - Where the role may not create databases, a case falls back to the former schema with every migration, so a local
 *   TEST_DATABASE_URL with fewer privileges still works.
 */
export interface IsolatedDatabase {
  readonly pool: Pool;
  /** Another pool on the same isolated database (a different role through `options`, say); it is closed by `dispose`. */
  extraPool(settings?: { readonly max?: number; readonly options?: string }): Pool;
  /** Close the pools and drop the database. Safe to call after a failure; never throws. */
  dispose(): Promise<void>;
}

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const PERMISSION_DENIED = "42501";

interface Migration { readonly name: string; readonly sql: string }

let migrationsRead: Promise<readonly Migration[]> | undefined;
function readMigrations(): Promise<readonly Migration[]> {
  migrationsRead ??= (async () => {
    const names = (await readdir(MIGRATIONS)).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort();
    return Promise.all(names.map(async (name) => ({ name, sql: await readFile(new URL(name, MIGRATIONS), "utf8") })));
  })();
  return migrationsRead;
}

function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A pool of a test database must not turn the server ending one of its sessions into an unhandled error. `pool.end()`
 * returns once its clients are asked to close, not once the server has dropped them, so the `DROP DATABASE ... WITH
 * (FORCE)` that follows can still end a session the pool is closing (57P01, "terminating connection due to
 * administrator command"). node-postgres then emits `error` on the pool, and a pool without a listener throws it: the
 * test run fails with every test green. A query on a broken client reports its own error, so nothing is hidden.
 */
function quiet<T extends Pool>(pool: T): T {
  pool.on("error", () => undefined);
  return pool;
}

/** A database cannot be renamed or copied while a session of the build is still shutting down on the server. */
async function retryWhileInUse<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await run(); } catch (error) {
      // 55006: object_in_use
      if ((error as { code?: string }).code !== "55006" || attempt >= 40) throw error;
      await sleep(50);
    }
  }
}

async function buildTemplate(databaseUrl: string): Promise<string | null> {
  const { Client, Pool: PgPool } = await import("pg");
  const migrations = await readMigrations();
  const hash = createHash("sha256");
  for (const migration of migrations) hash.update(migration.name).update("\0").update(migration.sql).update("\0");
  const template = `exptmpl_${hash.digest("hex").slice(0, 24)}`;
  const building = `${template}_build`;
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  try {
    await admin.query("SELECT pg_advisory_lock(hashtextextended('experience-store-test-template', 0))");
    if ((await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [template])).rowCount) return template;
    await admin.query(`DROP DATABASE IF EXISTS "${building}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${building}"`);
    const pool = new PgPool({ connectionString: withDatabase(databaseUrl, building), max: 1 });
    try {
      for (const migration of migrations) await pool.query(migration.sql);
    } finally {
      await pool.end();
    }
    await retryWhileInUse(() => admin.query(`ALTER DATABASE "${building}" RENAME TO "${template}"`));
    await admin.query(`ALTER DATABASE "${template}" WITH ALLOW_CONNECTIONS false`);
    return template;
  } catch (error) {
    if ((error as { code?: string }).code === PERMISSION_DENIED) return null;
    throw error;
  } finally {
    await admin.end();
  }
}

/** One template per test process and database server; null where the role cannot create databases. */
const templates = new Map<string, Promise<string | null>>();
function templateFor(databaseUrl: string): Promise<string | null> {
  let template = templates.get(databaseUrl);
  if (!template) {
    template = buildTemplate(databaseUrl);
    templates.set(databaseUrl, template);
  }
  return template;
}

async function inSchema(databaseUrl: string, prefix: string, max: number): Promise<IsolatedDatabase> {
  const { Pool: PgPool } = await import("pg");
  const schema = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  const pool = new PgPool({ connectionString: databaseUrl, max, options: `-c search_path=${schema}` });
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    for (const migration of await readMigrations()) await pool.query(migration.sql);
  } catch (error) {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw error;
  }
  const extras: Pool[] = [];
  return {
    pool,
    extraPool(settings = {}) {
      const extra = new PgPool({ connectionString: databaseUrl, max: settings.max ?? 2, options: `-c search_path=${schema}${settings.options ? ` ${settings.options}` : ""}` });
      extras.push(extra);
      return extra;
    },
    async dispose() {
      await Promise.all(extras.map((extra) => extra.end().catch(() => undefined)));
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await pool.end().catch(() => undefined);
    },
  };
}

/** `prefix` only labels the database for whoever lists them; uniqueness comes from a random id. */
export async function createIsolatedDatabase(databaseUrl: string | undefined, prefix: string, options: { readonly max?: number } = {}): Promise<IsolatedDatabase> {
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for a DB integration test.");
  const max = options.max ?? 4;
  const template = await templateFor(databaseUrl);
  if (!template) return inSchema(databaseUrl, prefix, max);
  const { Client, Pool: PgPool } = await import("pg");
  const database = `exptest_${randomUUID().replaceAll("-", "")}_${prefix.replace(/[^a-z0-9_]/gi, "_")}`.slice(0, 63);
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE "${template}"`);
  } catch (error) {
    await admin.end();
    if ((error as { code?: string }).code === PERMISSION_DENIED) return inSchema(databaseUrl, prefix, max);
    throw error;
  }
  await admin.end();
  const connectionString = withDatabase(databaseUrl, database);
  const pool = quiet(new PgPool({ connectionString, max }));
  const extras: Pool[] = [];
  let disposed = false;
  return {
    pool,
    extraPool(settings = {}) {
      const extra = quiet(new PgPool({ connectionString, max: settings.max ?? 2, ...(settings.options ? { options: settings.options } : {}) }));
      extras.push(extra);
      return extra;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await Promise.all(extras.map((extra) => extra.end().catch(() => undefined)));
      await pool.end().catch(() => undefined);
      const cleaner = new Client({ connectionString: databaseUrl });
      try {
        await cleaner.connect();
        await cleaner.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      } catch {
        // Best effort: a copy left behind is harmless and listed by its exptest_ prefix.
      } finally {
        await cleaner.end().catch(() => undefined);
      }
    },
  };
}
