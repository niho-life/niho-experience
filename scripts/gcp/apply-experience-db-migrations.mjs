#!/usr/bin/env node
// Applies pending Experience migrations as the NOLOGIN migration role and reconciles
// the runtime role to `experience-db-grants.mjs`. On an empty database without roles
// it first creates both roles and stores the runtime URL in Secret Manager.
// Run only as a child of niho-app `niho-db.sh <stg|prd> --via-bastion`.
// No credential, connection URL, or SQL response value is printed or written to disk.
import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import pg from "pg";
import { MIGRATION_LEDGER_TABLE, RUNTIME_TABLE_GRANTS } from "./experience-db-grants.mjs";
import { atomicMigrationSql, pendingMigrations } from "./migration-sql.mjs";

const { Client } = pg;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsDir = resolve(root, "packages/experience-store/migrations");

const ENVIRONMENTS = {
  stg: {
    project: "niho-app-stg", instance: "niho-app-stg:asia-northeast1:niho-app-db-stg", adminDatabase: "niho", adminUser: "niho",
    database: "experience_stg", runtimeRole: "experience_stg_runtime", migrationRole: "experience_stg_migrator", secret: "experience-stg-database-url",
  },
  prd: {
    project: "niho-app-prd", instance: "niho-app-prd:asia-northeast1:niho-app-db", adminDatabase: "niho_app", adminUser: "niho_app",
    database: "experience_prd", runtimeRole: "experience_prd_runtime", migrationRole: "experience_prd_migrator", secret: "experience-prd-database-url",
  },
};
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function ident(name) {
  assert(/^[a-z_][a-z0-9_]*$/.test(name), "Unexpected identifier");
  return name;
}

function addSecretVersion(env, value) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn("gcloud", [
      "secrets", "versions", "add", env.secret, "--project", env.project, "--data-file=-", "--format=value(name)", "--quiet",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.resume(); // gcloud diagnostics must not leak a credential into logs.
    child.on("error", rejectCommand);
    child.on("close", (code) => code === 0
      ? resolveCommand(output.trim())
      : rejectCommand(new Error(`Secret Manager registration failed (exit ${code})`)));
    child.stdin.end(value);
  });
}

/** Tables a set of migration files creates, by name. */
function createdTables(sources) {
  const tables = new Set();
  for (const sql of sources) for (const match of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/g)) tables.add(match[1]);
  return tables;
}

const envName = process.env.NIHO_DB_ENV;
const env = ENVIRONMENTS[envName];
assert(env, "NIHO_DB_ENV must be stg or prd (run through niho-db.sh)");
assert(process.env.CONFIRM_EXPERIENCE_DB_MIGRATE === env.project, `CONFIRM_EXPERIENCE_DB_MIGRATE=${env.project} is required`);
const localUrl = new URL(process.env.DATABASE_URL || "postgresql://invalid/");
assert(localUrl.protocol === "postgresql:" || localUrl.protocol === "postgres:", "PostgreSQL URL required");
assert(localUrl.hostname === "127.0.0.1" && localUrl.port, "IAP bastion localhost tunnel required");
assert(localUrl.pathname === `/${env.adminDatabase}` && decodeURIComponent(localUrl.username) === env.adminUser,
  "NIHO administrator connection required");
assert(localUrl.password, "Administrator password is missing");

const files = (await readdir(migrationsDir)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
const sources = new Map();
for (const name of files) sources.set(name, await readFile(resolve(migrationsDir, name), "utf8"));
const baselineThrough = process.env.EXPERIENCE_DB_BASELINE_THROUGH;
assert(baselineThrough === undefined || files.includes(baselineThrough), "EXPERIENCE_DB_BASELINE_THROUGH must name a migration file");

const targetUrl = new URL(localUrl);
targetUrl.pathname = `/${env.database}`;
const admin = new Client({ connectionString: localUrl.toString() });
const target = new Client({ connectionString: targetUrl.toString() });
const runtime = ident(env.runtimeRole);
const migrator = ident(env.migrationRole);
const ledger = ident(MIGRATION_LEDGER_TABLE);
let step = "preflight";
let createdSecretRef;
const applied = [];
try {
  await admin.connect();
  await target.connect();
  const adminCheck = await admin.query(`
    SELECT current_database() AS db, current_user AS username,
           (SELECT rolcreaterole FROM pg_roles WHERE rolname=current_user) AS can_create_role,
           pg_has_role(current_user, 'cloudsqlsuperuser', 'MEMBER') AS cloudsql_member`);
  assert(adminCheck.rows[0].db === env.adminDatabase && adminCheck.rows[0].username === env.adminUser
    && adminCheck.rows[0].can_create_role && adminCheck.rows[0].cloudsql_member, "Administrator identity check failed");
  const targetCheck = await target.query("SELECT current_database() AS db");
  assert(targetCheck.rows[0].db === env.database, "Experience database check failed");
  // Migrations may need old revisions drained (for example 0006). Nothing may be connected as the runtime.
  const live = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename=$1", [runtime]);
  assert(live.rows[0].count === 0, "The runtime role has open sessions; drain them before migrating");

  const roles = await admin.query("SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])", [[runtime, migrator]]);
  const publicTables = async () => (await target.query(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map((row) => row.tablename);
  if (roles.rowCount === 0) {
    step = "bootstrap roles";
    assert((await publicTables()).length === 0, "Roles are missing but the Experience database is not empty");
    const password = randomBytes(48).toString("base64url");
    const cloudUrl = new URL(`postgresql://${runtime}@localhost/${env.database}`);
    cloudUrl.password = password;
    cloudUrl.searchParams.set("host", `/cloudsql/${env.instance}`);
    // Store the recoverable credential before the role exists, as the staging bootstrap did.
    const versionName = await addSecretVersion(env, cloudUrl.toString());
    const match = versionName.match(/(?:^|\/versions\/)(\d+)$/);
    assert(match, "Secret version could not be read back");
    createdSecretRef = `${env.secret}:${match[1]}`;
    await admin.query("BEGIN");
    try {
      await admin.query(`CREATE ROLE ${migrator} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
      await admin.query(`CREATE ROLE ${runtime} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
      await admin.query(`GRANT ${migrator} TO ${ident(env.adminUser)}`);
      await admin.query(`REVOKE ALL ON DATABASE ${ident(env.database)} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${ident(env.database)} TO ${ident(env.adminUser)}, ${migrator}, ${runtime}`);
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
    // Prove the new login once, without printing it.
    const runtimeUrl = new URL(targetUrl);
    runtimeUrl.username = runtime;
    runtimeUrl.password = password;
    const login = new Client({ connectionString: runtimeUrl.toString() });
    try {
      await login.connect();
      assert((await login.query("SELECT current_user AS u")).rows[0].u === runtime, "Runtime login check failed");
    } finally {
      await login.end().catch(() => {});
    }
  } else {
    assert(roles.rowCount === 2, "Only one Experience DB role exists; inspect before retrying");
    const member = await admin.query("SELECT pg_has_role(current_user, $1, 'MEMBER') AS member", [migrator]);
    assert(member.rows[0].member, "Administrator cannot switch to the migration role");
  }

  step = "read migration ledger";
  await target.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${migrator}`);
  const hasLedger = (await target.query("SELECT to_regclass($1) IS NOT NULL AS present", [`public.${ledger}`])).rows[0].present;
  if (!hasLedger) {
    const existing = await publicTables();
    if (existing.length > 0) {
      // A database bootstrapped before this ledger: the operator names the last applied file and
      // the table set must match exactly what the files up to it create.
      assert(baselineThrough, "Existing tables without a migration ledger; set EXPERIENCE_DB_BASELINE_THROUGH");
      const expected = createdTables(files.filter((name) => name <= baselineThrough).map((name) => sources.get(name)));
      assert(existing.length === expected.size && existing.every((name) => expected.has(name)),
        "Existing tables do not match the baseline migrations");
    } else {
      assert(!baselineThrough, "EXPERIENCE_DB_BASELINE_THROUGH is only for an existing schema");
    }
    await target.query(`SET ROLE ${migrator}`);
    await target.query(`CREATE TABLE ${ledger} (
      name text PRIMARY KEY CHECK (name ~ '^[0-9]{4}_[a-z0-9_]+[.]sql$'),
      sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      baseline boolean NOT NULL DEFAULT false,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
    await target.query(`REVOKE ALL ON ${ledger} FROM PUBLIC`);
    if (existing.length > 0) {
      for (const name of files.filter((file) => file <= baselineThrough)) {
        await target.query(`INSERT INTO ${ledger} (name,sha256,baseline) VALUES ($1,$2,true)`, [name, sha256(sources.get(name))]);
      }
    }
    await target.query("RESET ROLE");
  } else {
    assert(!baselineThrough, "The migration ledger already exists; do not pass a baseline");
  }
  const recorded = new Map((await target.query(`SELECT name,sha256 FROM ${ledger} ORDER BY name`)).rows.map((row) => [row.name, row.sha256]));
  for (const [name, digest] of recorded) {
    assert(sources.has(name), `Applied migration ${name} is missing from this checkout`);
    assert(sources.get(name) && sha256(sources.get(name)) === digest, `Applied migration ${name} was edited after it was applied`);
  }
  // EXPERIENCE_DB_ALLOW_OUT_OF_ORDER: comma-separated file names the operator checked (docs/host-calendar-staging.md).
  const allowOutOfOrder = (process.env.EXPERIENCE_DB_ALLOW_OUT_OF_ORDER ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  const { pending, outOfOrder } = pendingMigrations({ files, applied: [...recorded.keys()], allowOutOfOrder });
  if (outOfOrder.length > 0) console.log(`Applying out of order, as the operator named: ${outOfOrder.join(", ")}`);

  for (const name of pending) {
    step = `apply ${name}`;
    await target.query(`SET ROLE ${migrator}`);
    // The file and its ledger row commit together: a dropped connection leaves both or neither.
    const sql = atomicMigrationSql({ name, source: sources.get(name), ledger, sha256: sha256(sources.get(name)), escapeLiteral: (value) => target.escapeLiteral(value) });
    try {
      await target.query(sql);
    } catch (error) {
      await target.query("ROLLBACK").catch(() => {});
      throw error;
    }
    await target.query("RESET ROLE");
    applied.push(name);
  }

  step = "reconcile runtime grants";
  const tables = await publicTables();
  const declared = Object.keys(RUNTIME_TABLE_GRANTS);
  const undeclared = tables.filter((name) => name !== ledger && !(name in RUNTIME_TABLE_GRANTS));
  const missing = declared.filter((name) => !tables.includes(name));
  assert(undeclared.length === 0, `Tables without a runtime grant entry: ${undeclared.join(",")}`);
  assert(missing.length === 0, `Grant entries without a table: ${missing.join(",")}`);
  await target.query("BEGIN");
  try {
    await target.query(`GRANT USAGE ON SCHEMA public TO ${runtime}`);
    await target.query(`REVOKE ALL ON ${ledger} FROM ${runtime}`);
    for (const name of declared) {
      const grant = RUNTIME_TABLE_GRANTS[name];
      const table = ident(name);
      // Table-level REVOKE also removes column privileges, so each run starts clean.
      await target.query(`REVOKE ALL ON ${table} FROM ${runtime}`);
      await target.query(`GRANT ${["SELECT", ...grant.write].join(", ")} ON ${table} TO ${runtime}`);
      if (grant.updateColumns?.length) await target.query(`GRANT UPDATE (${grant.updateColumns.map(ident).join(", ")}) ON ${table} TO ${runtime}`);
    }
    await target.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${runtime}`);
    await target.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${runtime}`);
    await target.query("COMMIT");
  } catch (error) {
    await target.query("ROLLBACK");
    throw error;
  }

  step = "verify runtime grants";
  const roleCheck = await admin.query(
    "SELECT rolsuper,rolcreaterole,rolcreatedb,rolcanlogin FROM pg_roles WHERE rolname=$1", [runtime]);
  assert(roleCheck.rows[0] && !roleCheck.rows[0].rolsuper && !roleCheck.rows[0].rolcreaterole && !roleCheck.rows[0].rolcreatedb
    && roleCheck.rows[0].rolcanlogin, "Runtime role attributes are wider than expected");
  const schema = await target.query("SELECT has_schema_privilege($1,'public','CREATE') AS can_ddl", [runtime]);
  assert(!schema.rows[0].can_ddl, "Runtime can create objects in public");
  for (const name of [...declared, ledger]) {
    const grant = name === ledger ? { write: [], select: false } : RUNTIME_TABLE_GRANTS[name];
    const expected = new Set(name === ledger ? [] : ["SELECT", ...grant.write]);
    for (const privilege of PRIVILEGES) {
      const actual = (await target.query("SELECT has_table_privilege($1,$2,$3) AS ok", [runtime, `public.${name}`, privilege])).rows[0].ok;
      assert(actual === expected.has(privilege), `Runtime ${privilege} on ${name} does not match the declaration`);
    }
    if (grant.updateColumns?.length) {
      const columns = (await target.query(
        `SELECT attname, has_column_privilege($1, attrelid, attname, 'UPDATE') AS ok FROM pg_attribute
          WHERE attrelid=$2::regclass AND attnum>0 AND NOT attisdropped`, [runtime, `public.${name}`])).rows;
      for (const column of columns) {
        assert(column.ok === grant.updateColumns.includes(column.attname), `Runtime UPDATE on ${name}.${column.attname} does not match the declaration`);
      }
    }
  }
  // The administrator database must expose nothing to the runtime login.
  const other = await admin.query(`
    SELECT count(*)::int AS readable FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE c.relkind IN ('r','p','v','m') AND n.nspname NOT IN ('pg_catalog','information_schema')
       AND has_table_privilege($1, c.oid, 'SELECT')`, [runtime]);
  assert(other.rows[0].readable === 0, "Runtime can read NIHO application tables");

  console.log(`Experience DB ${envName}: applied ${applied.length} migration(s)${applied.length ? ` (${applied[0]} .. ${applied.at(-1)})` : ""}; `
    + `${declared.length} tables reconciled to the declared runtime grants.`);
  if (createdSecretRef) console.log(`RUNTIME_DATABASE_URL_REF=${createdSecretRef}`);
} catch (error) {
  // Messages above are fixed strings and object names; never print driver errors, which may echo SQL values.
  console.error(`Experience DB ${envName ?? "?"} migration stopped during ${step}: ${error?.code || error?.message || "check failed"}`);
  if (applied.length) console.error(`Applied before stopping: ${applied.join(", ")}`);
  if (createdSecretRef) console.error(`A runtime credential version was stored first: ${createdSecretRef}`);
  process.exitCode = 1;
} finally {
  await target.end().catch(() => {});
  await admin.end().catch(() => {});
}
