#!/usr/bin/env node
// One-time bootstrap for the empty Experience database in niho-app-stg.
// Run only through the NIHO staging IAP bastion; no credential is written to disk.
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import pg from "pg";

const { Client } = pg;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const project = "niho-app-stg";
const instance = `${project}:asia-northeast1:niho-app-db-stg`;
const database = "experience_stg";
const runtimeRole = "experience_stg_runtime";
const migrationRole = "experience_stg_migrator";
const secret = "experience-stg-database-url";
const migrations = [
  "0001_experience_store.sql",
  "0002_google_oauth.sql",
  "0003_google_busy_coverage.sql",
];
const writeTables = [
  "experience_products", "schedule_rules", "schedule_occurrence_overrides",
  "schedule_occurrences", "provider_google_calendars", "google_busy_intervals",
  "bookings", "stripe_webhook_events", "payment_ledger_entries",
  "outbox_messages", "provider_google_connections",
];
const updateTables = [
  "experience_products", "schedule_rules", "schedule_occurrence_overrides",
  "schedule_occurrences", "provider_google_calendars", "bookings",
  "outbox_messages", "provider_google_connections",
];
const deleteTables = ["google_busy_intervals", "provider_google_connections"];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runGcloudWithStdin(value) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn("gcloud", [
      "secrets", "versions", "add", secret,
      "--project", project, "--data-file=-", "--format=value(name)", "--quiet",
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

const localUrl = new URL(process.env.DATABASE_URL || "postgresql://invalid/");
assert(process.env.NIHO_DB_ENV === "stg", "NIHO_DB_ENV=stg is required");
assert(process.env.CONFIRM_EXPERIENCE_STG_DB_BOOTSTRAP === project,
  `CONFIRM_EXPERIENCE_STG_DB_BOOTSTRAP=${project} is required`);
assert(localUrl.protocol === "postgresql:" || localUrl.protocol === "postgres:", "PostgreSQL URL required");
assert(localUrl.hostname === "127.0.0.1" && localUrl.port,
  "IAP bastion localhost tunnel required");
assert(localUrl.pathname === "/niho" && decodeURIComponent(localUrl.username) === "niho",
  "NIHO staging administrator connection required");
assert(localUrl.password, "Administrator password is missing");

const targetUrl = new URL(localUrl);
targetUrl.pathname = `/${database}`;
const admin = new Client({ connectionString: localUrl.toString() });
const target = new Client({ connectionString: targetUrl.toString() });
let step = "preflight";
try {
  await admin.connect();
  await target.connect();
  const adminCheck = await admin.query(`
    SELECT current_database() AS db, current_user AS username,
           (SELECT rolcreaterole FROM pg_roles WHERE rolname=current_user) AS can_create_role,
           pg_has_role(current_user, 'cloudsqlsuperuser', 'MEMBER') AS cloudsql_member`);
  assert(adminCheck.rows[0].db === "niho" && adminCheck.rows[0].username === "niho" &&
    adminCheck.rows[0].can_create_role && adminCheck.rows[0].cloudsql_member,
  "Administrator identity check failed");
  const targetCheck = await target.query(`
    SELECT current_database() AS db,
           (SELECT count(*)::int FROM pg_tables WHERE schemaname='public') AS table_count,
           (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public' AND p.proname IN ('protect_booking_snapshots','reject_ledger_mutation')) AS function_count`);
  assert(targetCheck.rows[0].db === database && targetCheck.rows[0].table_count === 0 &&
    targetCheck.rows[0].function_count === 0, "Experience database is not empty");
  const existing = await admin.query(
    "SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])", [[runtimeRole, migrationRole]]);
  assert(existing.rowCount === 0, "Experience DB roles already exist; inspect before retrying");

  const password = randomBytes(48).toString("base64url");
  step = "create dedicated roles";
  await admin.query("BEGIN");
  try {
    await admin.query(`CREATE ROLE ${migrationRole} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
    await admin.query(`CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
    await admin.query(`GRANT ${migrationRole} TO niho`);
    await admin.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${database} TO niho, ${migrationRole}, ${runtimeRole}`);
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }

  step = "apply Experience migrations";
  await target.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${migrationRole}`);
  await target.query(`SET ROLE ${migrationRole}`);
  for (const name of migrations) {
    const sql = await readFile(resolve(root, "packages/experience-store/migrations", name), "utf8");
    await target.query(sql);
  }
  await target.query("RESET ROLE");

  step = "grant runtime DML";
  await target.query(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}`);
  await target.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${runtimeRole}`);
  await target.query(`GRANT INSERT ON ${writeTables.join(", ")} TO ${runtimeRole}`);
  await target.query(`GRANT UPDATE ON ${updateTables.join(", ")} TO ${runtimeRole}`);
  await target.query(`GRANT DELETE ON ${deleteTables.join(", ")} TO ${runtimeRole}`);
  await target.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${runtimeRole}`);

  step = "verify runtime permissions";
  const runtimeLocalUrl = new URL(targetUrl);
  runtimeLocalUrl.username = runtimeRole;
  runtimeLocalUrl.password = password;
  const runtime = new Client({ connectionString: runtimeLocalUrl.toString() });
  try {
    await runtime.connect();
    const result = await runtime.query(`
      SELECT current_user AS username, current_database() AS db,
             has_schema_privilege(current_user, 'public', 'CREATE') AS can_ddl,
             (SELECT rolcreaterole FROM pg_roles WHERE rolname=current_user) AS can_create_role,
             (SELECT count(*)::int FROM pg_tables WHERE schemaname='public') AS table_count`);
    assert(result.rows[0].username === runtimeRole && result.rows[0].db === database &&
      !result.rows[0].can_ddl && !result.rows[0].can_create_role && result.rows[0].table_count === 13,
    "Runtime connection or privilege check failed");
  } finally {
    await runtime.end();
  }

  // The shared NIHO database may still allow PUBLIC CONNECT. Confirm that it
  // exposes no application tables to the new runtime login before saving its URL.
  const otherDbUrl = new URL(localUrl);
  otherDbUrl.username = runtimeRole;
  otherDbUrl.password = password;
  const otherDb = new Client({ connectionString: otherDbUrl.toString() });
  try {
    await otherDb.connect();
    const grants = await otherDb.query(`
      SELECT count(*)::int AS readable_tables
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE c.relkind IN ('r','p','v','m')
         AND n.nspname NOT IN ('pg_catalog','information_schema')
         AND has_table_privilege(current_user, c.oid, 'SELECT')`);
    assert(grants.rows[0].readable_tables === 0, "Runtime can read NIHO application tables");
  } catch (error) {
    if (error?.code !== "42501") throw error; // CONNECT denied is the stronger outcome.
  } finally {
    await otherDb.end().catch(() => {});
  }

  const cloudUrl = new URL(`postgresql://${runtimeRole}@localhost/${database}`);
  cloudUrl.password = password;
  cloudUrl.searchParams.set("host", `/cloudsql/${instance}`);
  step = "register runtime database URL";
  const versionName = await runGcloudWithStdin(cloudUrl.toString());
  const match = versionName.match(/(?:^|\/versions\/)(\d+)$/);
  assert(match, "Secret version could not be read back");
  console.log(`Experience DB bootstrap complete: ${migrations.length} migrations, 13 tables, restricted runtime role.`);
  console.log(`STG_HOST_DATABASE_URL_REF=${secret}:${match[1]}`);
} catch (error) {
  console.error(`Experience DB bootstrap stopped during ${step}: ${error?.code || "check failed"}`);
  process.exitCode = 1;
} finally {
  await target.end().catch(() => {});
  await admin.end().catch(() => {});
}
