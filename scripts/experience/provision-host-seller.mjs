#!/usr/bin/env node
// Provisions the explicit Experience seller → NIHO legacy Connect mapping and NIHO-approved fee settings.
// It does not create a product, grant an OWNER role, or publish. OWNER is bound later from NIHO v1's
// authenticated current identity when it exactly matches seller.nihoAccountRef.
//
//   node scripts/experience/provision-host-seller.mjs [plan|register] <input.json> [--yes]
//
// Environment (never printed):
//   EXPERIENCE_DATABASE_URL                 Experience DB, migration identity for writes
//   EXPERIENCE_DATABASE_ROLE               optional role to act as (SET ROLE)
//   EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY   register: verifies the exact connected account
import { readFile } from "node:fs/promises";
import pg from "pg";
import { retrieveConnectedAccount } from "@niho-experience/experience-payments";
import { SiteSaleRegistration } from "@niho-experience/experience-store/site-sale-registration";
import {
  HOST_SELLER_PROVISIONING_EXIT,
  HOST_SELLER_PROVISIONING_USAGE,
  HostSellerProvisioningInputError,
  parseHostSellerProvisioningArguments,
  parseHostSellerProvisioningFile,
  runHostSellerProvisioning,
} from "@niho-experience/experience-store/host-seller-provisioning";

const ROLE = /^[a-z_][a-z0-9_]{0,62}$/;
const out = (line) => console.log(line);

function refuse(problems) {
  for (const problem of problems) console.error(`Invalid: ${problem}`);
  return HOST_SELLER_PROVISIONING_EXIT.failed;
}

async function main() {
  let args;
  try { args = parseHostSellerProvisioningArguments(process.argv.slice(2)); }
  catch (error) {
    if (!(error instanceof HostSellerProvisioningInputError)) throw error;
    console.error(HOST_SELLER_PROVISIONING_USAGE);
    return refuse(error.problems);
  }

  let input;
  try {
    input = parseHostSellerProvisioningFile(JSON.parse(await readFile(args.inputPath, "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) return refuse(["the input file is not JSON"]);
    if (error instanceof HostSellerProvisioningInputError) return refuse(error.problems);
    return refuse(["the input file cannot be read"]);
  }

  const databaseUrl = process.env.EXPERIENCE_DATABASE_URL;
  if (!databaseUrl) return refuse(["EXPERIENCE_DATABASE_URL is not set"]);
  const role = process.env.EXPERIENCE_DATABASE_ROLE;
  if (role !== undefined && role !== "" && !ROLE.test(role)) return refuse(["EXPERIENCE_DATABASE_ROLE is not a role name"]);
  const stripeKey = process.env.EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY;
  if (args.command === "register" && args.yes && !stripeKey) {
    return refuse(["EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY is not set (register verifies the Stripe account)"]);
  }

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2, ...(role ? { options: `-c role=${role}` } : {}) });
  pool.on("error", () => {});
  try {
    if (role) {
      const current = await pool.query("SELECT current_user AS name");
      if (current.rows[0]?.name !== role) return refuse(["EXPERIENCE_DATABASE_ROLE did not apply (remove `options` from EXPERIENCE_DATABASE_URL)"]);
    }
    return await runHostSellerProvisioning(args.command, input, args.yes, {
      store: new SiteSaleRegistration(pool),
      checkStripeAccount: (accountId) => retrieveConnectedAccount({ accountId, platformStripeKey: stripeKey }),
      out,
    });
  } finally {
    await pool.end().catch(() => {});
  }
}

try { process.exitCode = await main(); }
catch { console.error("Unexpected failure. Credentials, identifiers, and driver details were not printed."); process.exitCode = HOST_SELLER_PROVISIONING_EXIT.unexpected; }
