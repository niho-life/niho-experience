#!/usr/bin/env node
// Registers an experience sold on this site in the experience DB and opens or stops its sale (#285 slice 9).
// Runbook: docs/guest-booking.md 「体験の登録と切替（第9段）」. The flow and the validation live in
// packages/experience-store/src/site-sale-script.ts (tested there); this file only wires the environment.
//
//   node scripts/experience/register-site-sale.mjs [plan|register|open-sale|stop-sale|status] <input.json> [--yes]
//
// Environment (never printed):
//   EXPERIENCE_DATABASE_URL                the experience DB, connected as the migration identity for writes
//   EXPERIENCE_DATABASE_ROLE               optional: the role to act as on that connection (SET ROLE at startup)
//   EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY  register and open-sale: reads the seller's connected account
// Exit codes: 0 done, 1 refused (input, readiness, Stripe account, missing --yes, conflict), 2 unexpected.
// It never writes NIHO and never prints a key, a connection URL or a driver message.
import { readFile } from "node:fs/promises";
import pg from "pg";
import { retrieveConnectedAccount } from "@niho-experience/experience-payments";
import { SiteSaleRegistration } from "@niho-experience/experience-store/site-sale-registration";
import {
  SITE_SALE_EXIT,
  SITE_SALE_USAGE,
  SiteSaleInputError,
  parseSiteSaleArguments,
  parseSiteSaleInput,
  runSiteSale,
  safeErrorLabel,
  stripeKeyMode,
} from "@niho-experience/experience-store/site-sale-script";

const ROLE = /^[a-z_][a-z0-9_]{0,62}$/;
const out = (line) => console.log(line);

function refuse(problems) {
  for (const problem of problems) console.error(`Invalid: ${problem}`);
  return SITE_SALE_EXIT.failed;
}

async function main() {
  let args;
  let input;
  try {
    args = parseSiteSaleArguments(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof SiteSaleInputError)) throw error;
    console.error(SITE_SALE_USAGE);
    return refuse(error.problems);
  }
  let text;
  try {
    text = await readFile(args.inputPath, "utf8");
  } catch {
    return refuse(["the input file cannot be read"]);
  }
  try {
    input = parseSiteSaleInput(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) return refuse(["the input file is not JSON"]);
    if (error instanceof SiteSaleInputError) return refuse(error.problems);
    throw error;
  }

  const databaseUrl = process.env.EXPERIENCE_DATABASE_URL;
  if (!databaseUrl) return refuse(["EXPERIENCE_DATABASE_URL is not set"]);
  const role = process.env.EXPERIENCE_DATABASE_ROLE;
  if (role !== undefined && role !== "" && !ROLE.test(role)) return refuse(["EXPERIENCE_DATABASE_ROLE is not a role name"]);
  const stripeKey = process.env.EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY;
  const needsStripe = args.yes && (args.command === "register" || args.command === "open-sale");
  if (needsStripe && !stripeKey) return refuse(["EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY is not set (register and open-sale check the Stripe account)"]);

  // The role is a startup parameter, so every connection of the pool acts as it (an unknown role fails to connect).
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2, ...(role ? { options: `-c role=${role}` } : {}) });
  pool.on("error", () => {}); // An idle client's failure surfaces on the next query; never print the driver's message.
  try {
    if (role) {
      // pg lets the URL's own parameters win over `options`: make sure the role really applies.
      const current = await pool.query("SELECT current_user AS name");
      if (current.rows[0]?.name !== role) return refuse(["EXPERIENCE_DATABASE_ROLE did not apply (remove `options` from EXPERIENCE_DATABASE_URL)"]);
    }
    return await runSiteSale(args.command, input, { yes: args.yes }, {
      store: new SiteSaleRegistration(pool),
      checkStripeAccount: (accountId) => retrieveConnectedAccount({ accountId, platformStripeKey: stripeKey }),
      stripeKeyMode: stripeKeyMode(stripeKey),
      out,
    });
  } finally {
    await pool.end().catch(() => {});
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`Unexpected failure: ${safeErrorLabel(error)}`);
  process.exitCode = SITE_SALE_EXIT.unexpected;
}
