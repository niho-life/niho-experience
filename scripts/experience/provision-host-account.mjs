#!/usr/bin/env node
// Registers an Experience host account (ADR 0003, docs/host-accounts.md) by email and makes it the first OWNER of an
// existing provider. The host then signs in to /host with an emailed link (EXPERIENCE_HOST_ACCOUNTS_ENABLED). It does
// not create a provider, a seller profile, a product or a payout account, and it never changes an existing membership.
//
//   node scripts/experience/provision-host-account.mjs [plan|register] <input.json> [--yes]
//
// input.json (kept outside git; see host-account.example.json): { "email": "...", "providerId": "..." }
//
// Environment (never printed):
//   EXPERIENCE_DATABASE_URL    Experience DB
//   EXPERIENCE_DATABASE_ROLE   optional role to act as (SET ROLE)
//
// Prints IDs (the host account ID, the provider ID) and outcome kinds only: never the address or connection details.
import { readFile } from "node:fs/promises";
import pg from "pg";
import { HostAccounts, normalizeHostEmail, StoreError } from "@niho-experience/experience-store";

const EXIT = { ok: 0, failed: 1, unexpected: 2 };
const USAGE = "Usage: node scripts/experience/provision-host-account.mjs [plan|register] <input.json> [--yes]";
const ROLE = /^[a-z_][a-z0-9_]{0,62}$/;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const out = (line) => console.log(line);

function refuse(problems) {
  for (const problem of problems) console.error(`Invalid: ${problem}`);
  return EXIT.failed;
}

function parseArguments(argv) {
  const yes = argv.includes("--yes");
  const rest = argv.filter((value) => value !== "--yes");
  if (rest.some((value) => value.startsWith("-"))) return { problems: ["unknown option (only --yes is accepted)"] };
  const [first, second, ...extra] = rest;
  const command = first === "register" || first === "plan" ? first : "plan";
  const inputPath = first === "register" || first === "plan" ? second : first;
  const leftover = first === "register" || first === "plan" ? extra : [second, ...extra].filter((value) => value !== undefined);
  if (!inputPath) return { problems: ["the input file path is missing"] };
  if (leftover.length > 0) return { problems: ["unknown command or extra arguments"] };
  if (yes && command !== "register") return { problems: ["--yes is only for register"] };
  return { command, inputPath, yes };
}

/** Exactly `email` and `providerId`. The address is checked by the store's rule and never echoed. */
function parseInput(raw) {
  const problems = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { problems: ["input must be an object"] };
  for (const key of Object.keys(raw)) if (key !== "email" && key !== "providerId") problems.push(`input.${key} is not a known field`);
  let emailKey = "";
  try { emailKey = normalizeHostEmail(raw.email); }
  catch { problems.push("input.email must be one email address of 3-254 characters"); }
  if (typeof raw.providerId !== "string" || !PROVIDER_ID.test(raw.providerId)) problems.push("input.providerId must be an Experience provider ID");
  return problems.length > 0 ? { problems } : { email: raw.email, emailKey, providerId: raw.providerId };
}

/** What register would do, from reads only. */
async function currentState(pool, input) {
  const provider = await pool.query("SELECT 1 FROM experience_providers WHERE id = $1", [input.providerId]);
  const account = await pool.query("SELECT id, status FROM host_accounts WHERE email_key = $1", [input.emailKey]);
  const row = account.rows[0];
  const membership = row
    ? (await pool.query("SELECT role, active FROM provider_memberships WHERE provider_id = $1 AND niho_user_id = $2", [input.providerId, row.id])).rows[0]
    : undefined;
  return {
    providerExists: (provider.rowCount ?? 0) > 0,
    account: row ? { id: String(row.id), status: String(row.status) } : null,
    membership: membership ? { role: String(membership.role), active: membership.active === true } : null,
  };
}

function membershipOutcome(state) {
  if (!state.membership) return "grant OWNER";
  return state.membership.role === "OWNER" && state.membership.active ? "already OWNER" : "conflict: an existing membership is changed by hand only";
}

async function run(command, input, yes, pool) {
  const accounts = new HostAccounts(pool);
  try {
    const state = await currentState(pool, input);
    out(`Experience provider ${input.providerId}: ${state.providerExists ? "registered" : "not found"}`);
    out(`Host account: ${state.account ? `${state.account.id} (${state.account.status})` : "create (ACTIVE)"}`);
    out(`OWNER membership: ${membershipOutcome(state)}`);
    out("Provider, seller profile, product and payout account: not created by this operation");
    if (command === "plan") return EXIT.ok;
    if (!yes) {
      out("Nothing was written. Run register again with --yes to write.");
      return EXIT.failed;
    }
    if (!state.providerExists) {
      out("Refused: the provider does not exist. Nothing was written.");
      return EXIT.failed;
    }
    const nowUtc = new Date().toISOString();
    const provisioned = await accounts.provisionHostAccount({ email: input.email, nowUtc });
    const granted = await accounts.grantProviderOwner({ providerId: input.providerId, hostAccountId: provisioned.hostAccountId, nowUtc });
    out(`Registered: host account=${provisioned.hostAccountId} (${provisioned.created ? "created" : "existing"}), OWNER=${granted.kind}.`);
    if (granted.kind !== "granted" && granted.kind !== "already-owner") return EXIT.failed;
    out("The host signs in at /host with a link sent to the address (EXPERIENCE_HOST_ACCOUNTS_ENABLED=true).");
    return EXIT.ok;
  } catch (error) {
    if (error instanceof StoreError) {
      out(`Refused: ${error.name}: ${error.message}`);
      return EXIT.failed;
    }
    out("Unexpected failure. No credentials, addresses, or driver details were printed.");
    return EXIT.unexpected;
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.problems) {
    console.error(USAGE);
    return refuse(args.problems);
  }

  let input;
  try {
    input = parseInput(JSON.parse(await readFile(args.inputPath, "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) return refuse(["the input file is not JSON"]);
    return refuse(["the input file cannot be read"]);
  }
  if (input.problems) return refuse(input.problems);

  const databaseUrl = process.env.EXPERIENCE_DATABASE_URL;
  if (!databaseUrl) return refuse(["EXPERIENCE_DATABASE_URL is not set"]);
  const role = process.env.EXPERIENCE_DATABASE_ROLE;
  if (role !== undefined && role !== "" && !ROLE.test(role)) return refuse(["EXPERIENCE_DATABASE_ROLE is not a role name"]);

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2, ...(role ? { options: `-c role=${role}` } : {}) });
  pool.on("error", () => {});
  try {
    if (role) {
      const current = await pool.query("SELECT current_user AS name");
      if (current.rows[0]?.name !== role) return refuse(["EXPERIENCE_DATABASE_ROLE did not apply (remove `options` from EXPERIENCE_DATABASE_URL)"]);
    }
    return await run(args.command, input, args.yes, pool);
  } finally {
    await pool.end().catch(() => {});
  }
}

try { process.exitCode = await main(); }
catch { console.error("Unexpected failure. Credentials, addresses, and driver details were not printed."); process.exitCode = EXIT.unexpected; }
