#!/usr/bin/env node
// Retires a provider's payout account row (#710, docs/host-operations.md): the provider's next OWNER can then register a new one.
// It does not touch the Stripe account (close or keep it in Stripe yourself) and never deletes the row.
//
//   node scripts/experience/retire-connect-account.mjs <providerId> --by <who> --yes
//
// Environment (never printed): EXPERIENCE_DATABASE_URL (the migration identity), EXPERIENCE_DATABASE_ROLE (optional, SET ROLE).
import pg from "pg";
import { retireConnectAccount } from "@niho-experience/experience-store/connect-account-retirement";

const ROLE = /^[a-z_][a-z0-9_]{0,62}$/;
const USAGE = "Usage: node scripts/experience/retire-connect-account.mjs <providerId> --by <who> --yes";

async function main() {
  const [providerId, ...rest] = process.argv.slice(2);
  const by = rest[0] === "--by" ? rest[1] : undefined;
  if (!providerId || !by || !rest.includes("--yes")) { console.error(USAGE); return 1; }
  const databaseUrl = process.env.EXPERIENCE_DATABASE_URL;
  if (!databaseUrl) { console.error("EXPERIENCE_DATABASE_URL is not set"); return 1; }
  const role = process.env.EXPERIENCE_DATABASE_ROLE;
  if (role !== undefined && role !== "" && !ROLE.test(role)) { console.error("EXPERIENCE_DATABASE_ROLE is not a role name"); return 1; }
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, ...(role ? { options: `-c role=${role}` } : {}) });
  pool.on("error", () => {});
  try {
    const retired = await retireConnectAccount(pool, { providerId, retiredBy: by });
    console.log(retired ? `Retired the payout account row ${retired.id}.` : "The provider has no valid payout account row.");
    return retired ? 0 : 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

try { process.exitCode = await main(); }
catch { console.error("Unexpected failure. Credentials, identifiers, and driver details were not printed."); process.exitCode = 2; }
