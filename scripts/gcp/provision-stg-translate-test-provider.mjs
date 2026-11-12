#!/usr/bin/env node
// Creates one private Experience stg provider and its Host Account OWNER for translation acceptance.
// Run only beneath niho-app scripts/dev/niho-db.sh stg --via-bastion; writes only to experience_stg
// through the NOLOGIN migration role. The generated provider ID is also the isolated NIHO translation budget scope.
// No NIHO user, seller profile, product, fee, listing, booking or payment is created; no email is sent.
//
//   STG_TRANSLATE_TEST_OWNER_EMAIL=... \
//     <niho-app>/scripts/dev/niho-db.sh stg --via-bastion -- \
//     node scripts/gcp/provision-stg-translate-test-provider.mjs --dry-run
//
//   STG_TRANSLATE_TEST_OWNER_EMAIL=... CONFIRM_STG_TRANSLATE_TEST_PROVIDER=niho-app-stg \
//     <niho-app>/scripts/dev/niho-db.sh stg --via-bastion -- \
//     node scripts/gcp/provision-stg-translate-test-provider.mjs --apply [--show-provider-id]
//
// Output never includes the email, Host Account ID, connection URL, SQL rows or credentials.
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { grantProviderOwnerIn, normalizeHostEmail } from "../../packages/experience-store/src/host-accounts.ts";

const { Client } = pg;
const STG_PROJECT = "niho-app-stg";
const STG_ADMIN_DATABASE = "niho";
const STG_ADMIN_USER = "niho";
const EXPERIENCE_DATABASE = "experience_stg";
const EXPERIENCE_MIGRATOR = "experience_stg_migrator";
const FIXTURE_PROVIDER_PREFIX = "stg-translate-test-";
const REQUIRED_TABLES = [
  "public.experience_providers",
  "public.provider_memberships",
  "public.experience_products",
  "public.experience_host_seller_profiles",
  "public.provider_sale_settings",
  "public.provider_payout_account_consents",
  "public.host_accounts",
];

class SafeFailure extends Error {}
let currentStep = "startup";

function assert(condition, message) {
  if (!condition) throw new SafeFailure(message);
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === "--help") return { help: true };
  const modes = argv.filter((arg) => arg === "--dry-run" || arg === "--apply");
  const unknown = argv.filter((arg) => !["--dry-run", "--apply", "--show-provider-id"].includes(arg));
  assert(modes.length === 1 && unknown.length === 0, "Choose exactly one mode: --dry-run or --apply");
  assert(argv.filter((arg) => arg === "--show-provider-id").length <= 1, "--show-provider-id may appear once");
  const apply = modes[0] === "--apply";
  assert(apply || !argv.includes("--show-provider-id"), "--show-provider-id is only available with --apply");
  return { apply, showProviderId: argv.includes("--show-provider-id") };
}

function printUsage() {
  console.log([
    "Usage:",
    "  STG_TRANSLATE_TEST_OWNER_EMAIL=<owner-email> node scripts/gcp/provision-stg-translate-test-provider.mjs --dry-run",
    "  STG_TRANSLATE_TEST_OWNER_EMAIL=<owner-email> CONFIRM_STG_TRANSLATE_TEST_PROVIDER=niho-app-stg node scripts/gcp/provision-stg-translate-test-provider.mjs --apply [--show-provider-id]",
    "Run only beneath niho-app/scripts/dev/niho-db.sh stg --via-bastion.",
  ].join("\n"));
}

function validateExecutionEnvironment(appUrl, apply) {
  assert(process.env.NIHO_DB_ENV === "stg", "NIHO_DB_ENV must be stg; use niho-db.sh stg --via-bastion");
  if (apply) {
    assert(process.env.CONFIRM_STG_TRANSLATE_TEST_PROVIDER === STG_PROJECT,
      "CONFIRM_STG_TRANSLATE_TEST_PROVIDER=niho-app-stg is required for --apply");
  }
  assert(appUrl.protocol === "postgresql:" || appUrl.protocol === "postgres:", "PostgreSQL URL required");
  assert(appUrl.hostname === "127.0.0.1" && appUrl.port, "IAP bastion localhost tunnel required");
  assert(appUrl.pathname === "/" + STG_ADMIN_DATABASE && decodeURIComponent(appUrl.username) === STG_ADMIN_USER,
    "NIHO staging administrator connection required");
  assert(appUrl.password, "NIHO staging administrator password is missing");
}

async function verifyConnection(client) {
  const identity = await client.query(
    "SELECT current_database() AS db, current_user AS username, " +
    "(SELECT rolcreaterole FROM pg_roles WHERE rolname=current_user) AS can_create_role, " +
    "pg_has_role(current_user, 'cloudsqlsuperuser', 'MEMBER') AS cloudsql_member");
  const row = identity.rows[0];
  assert(row && row.db === EXPERIENCE_DATABASE && row.username === STG_ADMIN_USER
    && row.can_create_role === true && row.cloudsql_member === true,
  "Staging Experience administrator identity check failed");
  const migrator = await client.query("SELECT pg_has_role(current_user, $1, 'MEMBER') AS member", [EXPERIENCE_MIGRATOR]);
  assert(migrator.rows[0] && migrator.rows[0].member === true,
    "Staging administrator cannot switch to the Experience migration role");
  const tables = await client.query(
    "SELECT to_regclass(table_name) IS NOT NULL AS present FROM unnest($1::text[]) AS tables(table_name)",
    [REQUIRED_TABLES]);
  assert(tables.rowCount === REQUIRED_TABLES.length && tables.rows.every((result) => result.present === true),
    "Experience staging schema is not ready");
}

async function withMigrator(client, work) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL ROLE " + EXPERIENCE_MIGRATOR);
    const role = await client.query("SELECT current_user AS username");
    assert(role.rows[0] && role.rows[0].username === EXPERIENCE_MIGRATOR,
      "Experience migration role did not apply");
    const result = await work();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function assertNoCommercialData(client, providerId) {
  const result = await client.query(
    "SELECT (SELECT count(*)::int FROM experience_products WHERE provider_id=$1) AS products, " +
    "(SELECT count(*)::int FROM provider_sale_settings WHERE provider_id=$1) AS fees, " +
    "(SELECT count(*)::int FROM experience_host_seller_profiles WHERE provider_id=$1) AS sellers, " +
    "(SELECT count(*)::int FROM provider_payout_account_consents WHERE provider_id=$1) AS payout_consents", [providerId]);
  assert(result.rows[0] && result.rows[0].products === 0 && result.rows[0].fees === 0
    && result.rows[0].sellers === 0 && result.rows[0].payout_consents === 0,
  "Translation fixture unexpectedly has seller, product, sale-fee or payout-consent rows; refusing to continue");
}

async function verifyExistingFixture(client, providerId, hostAccountId) {
  assert(providerId.startsWith(FIXTURE_PROVIDER_PREFIX),
    "Owner already has an unrelated provider; refusing to reuse it");
  const provider = await client.query("SELECT id FROM experience_providers WHERE id=$1", [providerId]);
  assert(provider.rowCount === 1, "Translation fixture provider mapping is missing");
  const memberships = await client.query(
    "SELECT provider_id, niho_user_id, role, active FROM provider_memberships WHERE provider_id=$1", [providerId]);
  assert(memberships.rowCount === 1 && memberships.rows[0].niho_user_id === hostAccountId
    && memberships.rows[0].role === "OWNER" && memberships.rows[0].active === true,
  "Translation fixture membership changed; refusing to repair it automatically");
  await assertNoCommercialData(client, providerId);
}

async function inspectOwner(client, emailKey) {
  const account = await client.query("SELECT id, status FROM host_accounts WHERE email_key=$1", [emailKey]);
  if (account.rowCount === 0) return { accountExists: false, providerId: null };
  assert(account.rows[0].status === "ACTIVE",
    "The matching Host Account is not active; refusing to reactivate it");
  const ownerMemberships = await client.query(
    "SELECT provider_id FROM provider_memberships WHERE niho_user_id=$1 AND active=true AND role='OWNER'",
    [account.rows[0].id]);
  assert(ownerMemberships.rowCount <= 1, "Host Account already owns multiple providers; inspect stg before proceeding");
  if (ownerMemberships.rowCount === 0) {
    return { accountExists: true, hostAccountId: account.rows[0].id, providerId: null };
  }
  const providerId = ownerMemberships.rows[0].provider_id;
  await verifyExistingFixture(client, providerId, account.rows[0].id);
  return { accountExists: true, hostAccountId: account.rows[0].id, providerId };
}

async function provision(client, email, emailKey) {
  return withMigrator(client, async () => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 19797))",
      ["stg-translate-fixture:" + emailKey]);
    const current = await inspectOwner(client, emailKey);
    if (current.providerId) return { created: false, providerId: current.providerId };

    const now = new Date().toISOString();
    const candidateHostAccountId = "hst_" + randomBytes(16).toString("hex");
    const insertedAccount = await client.query(
      "INSERT INTO host_accounts (id, email, email_key, created_at, updated_at) " +
      "VALUES ($1, $2, $3, $4, $4) ON CONFLICT (email_key) DO NOTHING RETURNING id, status",
      [candidateHostAccountId, email, emailKey, now]);
    let account = insertedAccount.rows[0];
    if (!account) {
      const existing = await client.query(
        "SELECT id, status FROM host_accounts WHERE email_key=$1 FOR UPDATE", [emailKey]);
      account = existing.rows[0];
    }
    assert(account && account.status === "ACTIVE",
      "The matching Host Account is not active; refusing to reactivate it");
    const providerId = FIXTURE_PROVIDER_PREFIX + randomUUID();
    await client.query("INSERT INTO experience_providers (id) VALUES ($1)", [providerId]);
    const grant = await grantProviderOwnerIn(client, {
      providerId,
      hostAccountId: account.id,
      nowUtc: now,
    });
    assert(grant.kind === "granted",
      "Host Account cannot be safely assigned as this fixture's first OWNER");
    await verifyExistingFixture(client, providerId, account.id);
    return { created: true, providerId };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  const suppliedEmail = (process.env.STG_TRANSLATE_TEST_OWNER_EMAIL ?? "").normalize("NFKC").trim();
  const emailKey = normalizeHostEmail(suppliedEmail);
  assert(suppliedEmail.length <= 254, "STG_TRANSLATE_TEST_OWNER_EMAIL must be a valid host email address");
  const appUrl = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/");
  validateExecutionEnvironment(appUrl, args.apply);

  const experienceUrl = new URL(appUrl);
  experienceUrl.pathname = "/" + EXPERIENCE_DATABASE;
  const client = new Client({ connectionString: experienceUrl.toString() });
  try {
    await client.connect();
    currentStep = "verify staging connection and schema";
    await verifyConnection(client);
    currentStep = "inspect existing translation fixture";
    const current = await inspectOwner(client, emailKey);
    if (!args.apply) {
      console.log("stg preflight passed; Host Account=" + (current.accountExists ? "present" : "would-create")
        + "; provider=" + (current.providerId ? "present" : "would-create")
        + "; active OWNER=" + (current.providerId ? "1" : "would-create")
        + "; products=0; sale-fee rows=0");
      return;
    }
    currentStep = "create or reuse isolated Host Account provider";
    const result = await provision(client, suppliedEmail, emailKey);
    console.log("stg translation fixture " + (result.created ? "created" : "reused")
      + "; Host Account OWNER=1; products=0; sale-fee rows=0; seller profile=none");
    if (args.showProviderId) console.log("provider_id=" + result.providerId);
    else console.log("provider_id=hidden (use --show-provider-id only for a private stg allowlist update)");
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((error) => {
  const message = error instanceof SafeFailure ? error.message : "database operation failed; driver details suppressed";
  console.error("stg translation fixture failed during " + currentStep + ": " + message);
  if (!(error instanceof SafeFailure) && /^[0-9A-Z]{5}$/.test(String(error?.code ?? ""))) {
    console.error("postgres_code=" + error.code);
  }
  process.exitCode = 1;
});
