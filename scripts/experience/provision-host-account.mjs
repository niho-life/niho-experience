#!/usr/bin/env node
// Registers an Experience host account (ADR 0003, docs/host-accounts.md) by email and makes it the first OWNER of a
// provider. The host then signs in to /host with an emailed link (EXPERIENCE_HOST_ACCOUNTS_ENABLED). With `seller`, the
// same run first registers the provider's seller for host accounts (slice 3): the provider when it is missing, its names
// and its existing Stripe connected account, verified with Stripe, with no NIHO ID. Without `seller` the provider must
// exist and nothing but the account and its OWNER membership is written. It never changes an existing membership or
// seller profile, writes no fee setting, creates no product and records no payout consent (the OWNER does, in /host).
//
// A provider whose seller is mapped to NIHO (the NIHO login era) moves onto host accounts with
// `"seller": { "convertFromNiho": true, "stripeConnectAccountRef": "acct_..." }`: the same account and names, a new `sel_`
// seller reference, the provider's drafts following it, and the address's host account made its OWNER, all in one
// transaction (SiteSaleRegistration.convertNihoSellerToHostAccounts): when the OWNER cannot be granted, or a listing stands
// on a version published under the NIHO seller, nothing moves. The account must be the one already registered; it is not
// checked with Stripe here (it does not change, and every publication checks it), so no Stripe key is needed for this.
//
//   node scripts/experience/provision-host-account.mjs [plan|register|invite] <input.json> [--yes]
//
// Signing in is with the host's NIHO account (Epic #591): a registered host account is invited to bind it. `invite` (input
// `{ "email": "..." }`, an account that is already registered) and `register` with `"invite": true` create a one-time
// invitation; the mail job emails the link to the registered address (the link is never printed: no one here holds it). It
// works for 7 days, once, in the first browser that opens it; the host signs in at NIHO and the NIHO account that comes back
// is bound to this host account (the same `hst_`, so nothing it owns changes). Inviting again replaces an open invitation.
// This is also how an existing OWNER (registered for the emailed link) and a COHOST move to NIHO sign-in.
//
// input.json (kept outside git; see host-account.example.json):
//   { "email": "...", "providerId": "...",
//     "seller": { "providerDisplayName": "...", "sellerDisplayName": "...", "stripeConnectAccountRef": "acct_..." } }
//
// Environment (never printed):
//   EXPERIENCE_DATABASE_URL                 Experience DB (the migration identity when `seller` is given: the runtime
//                                           role cannot write seller profiles, by design)
//   EXPERIENCE_DATABASE_ROLE                optional role to act as (SET ROLE)
//   EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY   register with `seller`: verifies the connected account with Stripe
//
// Prints IDs (the host account ID, the provider ID, the account's last 4 characters) and outcome kinds only: never the
// address, a name or connection details.
import { readFile } from "node:fs/promises";
import pg from "pg";
import { retrieveConnectedAccount } from "@niho-experience/experience-payments";
import { HostAccounts, HostInvitations, normalizeHostEmail, StoreError } from "@niho-experience/experience-store";
import { SiteSaleRegistration } from "@niho-experience/experience-store/site-sale-registration";

const EXIT = { ok: 0, failed: 1, unexpected: 2 };
const USAGE = "Usage: node scripts/experience/provision-host-account.mjs [plan|register|invite] <input.json> [--yes]";
const ROLE = /^[a-z_][a-z0-9_]{0,62}$/;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const CONNECT_ACCOUNT_ID = /^acct_[A-Za-z0-9]{8,250}$/;
const CONTROL = /[\u0000-\u001F\u007F]/;
const SELLER_FIELDS = ["providerDisplayName", "sellerDisplayName", "stripeConnectAccountRef"];
const CONVERT_FIELDS = ["convertFromNiho", "stripeConnectAccountRef"];
const out = (line) => console.log(line);
const masked = (value) => `…${value.slice(-4)}`;

function refuse(problems) {
  for (const problem of problems) console.error(`Invalid: ${problem}`);
  return EXIT.failed;
}

function parseArguments(argv) {
  const yes = argv.includes("--yes");
  const rest = argv.filter((value) => value !== "--yes");
  if (rest.some((value) => value.startsWith("-"))) return { problems: ["unknown option (only --yes is accepted)"] };
  const [first, second, ...extra] = rest;
  const named = first === "register" || first === "plan" || first === "invite";
  const command = named ? first : "plan";
  const inputPath = named ? second : first;
  const leftover = named ? extra : [second, ...extra].filter((value) => value !== undefined);
  if (!inputPath) return { problems: ["the input file path is missing"] };
  if (leftover.length > 0) return { problems: ["unknown command or extra arguments"] };
  if (yes && command !== "register" && command !== "invite") return { problems: ["--yes is only for register and invite"] };
  return { command, inputPath, yes };
}

function oneLine(value, path, problems) {
  if (typeof value !== "string" || value.trim() !== value || value.length < 1 || value.length > 300 || CONTROL.test(value)) {
    problems.push(`${path} must be one line of 1-300 characters without surrounding spaces`);
  }
}

/** The seller for host accounts: exactly the provider's name, the legal seller name and the existing Stripe account. */
function parseSeller(raw, problems) {
  if (raw === undefined) return null;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    problems.push("input.seller must be an object");
    return null;
  }
  if (raw.convertFromNiho !== undefined) {
    // Moving a seller mapped to NIHO: only the account it already uses, to make sure it is the one meant.
    for (const key of Object.keys(raw)) if (!CONVERT_FIELDS.includes(key)) problems.push(`input.seller.${key} is not taken when moving a seller from NIHO (its names stay)`);
    if (raw.convertFromNiho !== true) problems.push("input.seller.convertFromNiho must be true");
    if (typeof raw.stripeConnectAccountRef !== "string" || !CONNECT_ACCOUNT_ID.test(raw.stripeConnectAccountRef)) {
      problems.push("input.seller.stripeConnectAccountRef must be a Stripe connected account ID (acct_…)");
    }
    return { convertFromNiho: true, stripeConnectAccountRef: raw.stripeConnectAccountRef };
  }
  for (const key of Object.keys(raw)) if (!SELLER_FIELDS.includes(key)) problems.push(`input.seller.${key} is not a known field (no NIHO ID is taken)`);
  oneLine(raw.providerDisplayName, "input.seller.providerDisplayName", problems);
  oneLine(raw.sellerDisplayName, "input.seller.sellerDisplayName", problems);
  if (typeof raw.stripeConnectAccountRef !== "string" || !CONNECT_ACCOUNT_ID.test(raw.stripeConnectAccountRef)) {
    problems.push("input.seller.stripeConnectAccountRef must be a Stripe connected account ID (acct_…)");
  }
  return { providerDisplayName: raw.providerDisplayName, sellerDisplayName: raw.sellerDisplayName, stripeConnectAccountRef: raw.stripeConnectAccountRef };
}

/** The invite command's input: the registered host account's address, nothing else. Checked by the store's rule, never echoed. */
function parseInviteInput(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { problems: ["input must be an object"] };
  const problems = Object.keys(raw).filter((key) => key !== "email").map((key) => `input.${key} is not a known field`);
  let emailKey = "";
  try { emailKey = normalizeHostEmail(raw.email); }
  catch { problems.push("input.email must be one email address of 3-254 characters"); }
  return problems.length > 0 ? { problems } : { email: raw.email, emailKey };
}

/** `email`, `providerId` and optionally `seller` and `invite`. The address is checked by the store's rule and never echoed. */
function parseInput(raw) {
  const problems = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { problems: ["input must be an object"] };
  for (const key of Object.keys(raw)) if (key !== "email" && key !== "providerId" && key !== "seller" && key !== "invite") problems.push(`input.${key} is not a known field`);
  if (raw.invite !== undefined && typeof raw.invite !== "boolean") problems.push("input.invite must be true or false");
  let emailKey = "";
  try { emailKey = normalizeHostEmail(raw.email); }
  catch { problems.push("input.email must be one email address of 3-254 characters"); }
  if (typeof raw.providerId !== "string" || !PROVIDER_ID.test(raw.providerId)) problems.push("input.providerId must be an Experience provider ID");
  const seller = parseSeller(raw.seller, problems);
  return problems.length > 0 ? { problems } : { email: raw.email, emailKey, providerId: raw.providerId, seller, invite: raw.invite === true };
}

function sellerOutcome(state, seller) {
  if (seller.convertFromNiho) {
    if (state.sellerProfile === null) return "conflict: the provider has no seller to move from NIHO";
    if (state.sellerProfile.stripeConnectAccountRef !== seller.stripeConnectAccountRef) return "conflict: the provider's seller uses another Stripe account";
    return state.sellerProfile.kind === "niho" ? "move from NIHO (same Stripe account and names)" : "unchanged";
  }
  if (state.sellerProfile === null) return state.accountUsedElsewhere ? "conflict: another seller uses this Stripe account" : "register (no NIHO ID)";
  if (state.sellerProfile.kind === "niho") return "conflict: the provider has a seller mapped to NIHO";
  const same = state.sellerProfile.providerDisplayName === seller.providerDisplayName
    && state.sellerProfile.sellerDisplayName === seller.sellerDisplayName
    && state.sellerProfile.stripeConnectAccountRef === seller.stripeConnectAccountRef;
  return same ? "unchanged" : "conflict: the registered seller differs";
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

/** Creates the invitation of a host account; the mail job sends the link. Prints no token (nobody here holds it). */
async function invite(pool, hostAccountId) {
  const result = await new HostInvitations(pool).createInvitation({ hostAccountId, nowUtc: new Date().toISOString() });
  if (result.kind === "created") {
    out(`Invitation created for ${hostAccountId}${result.superseded ? " (it replaced an open one, whose link no longer works)" : ""}: the mail job emails the link to the registered address within a minute. It works until ${result.expiresAtUtc}, once, in the first browser that opens it.`);
    return EXIT.ok;
  }
  out(result.kind === "already-linked"
    ? `Refused: ${hostAccountId} already has a NIHO account bound (unbind it first to bind another). Nothing was written.`
    : `Refused: ${hostAccountId} is not an ACTIVE host account. Nothing was written.`);
  return EXIT.failed;
}

/** The invite command: for a host account that is already registered. `plan` reads only. */
async function runInvite(command, input, yes, pool) {
  try {
    const account = (await pool.query("SELECT id, status FROM host_accounts WHERE email_key = $1", [input.emailKey])).rows[0];
    if (!account) {
      out("Host account: not registered (register it first). Nothing was written.");
      return EXIT.failed;
    }
    const bound = (await pool.query("SELECT 1 FROM host_account_identities WHERE host_account_id = $1 AND provider = 'NIHO' AND unlinked_at IS NULL", [account.id])).rowCount > 0;
    const open = (await pool.query("SELECT 1 FROM host_account_invitations WHERE host_account_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now()", [account.id])).rowCount > 0;
    out(`Host account: ${account.id} (${account.status})`);
    out(`NIHO account: ${bound ? "bound (no invitation needed; unbind it first to bind another)" : "not bound"}`);
    out(`Open invitation: ${open ? "yes (a new one replaces it)" : "none"}`);
    if (command === "plan") return EXIT.ok;
    if (!yes) {
      out("Nothing was written. Run invite again with --yes to write.");
      return EXIT.failed;
    }
    return await invite(pool, String(account.id));
  } catch (error) {
    if (error instanceof StoreError) {
      out(`Refused: ${error.name}: ${error.message}`);
      return EXIT.failed;
    }
    out("Unexpected failure. No credentials, addresses, or driver details were printed.");
    return EXIT.unexpected;
  }
}

async function run(command, input, yes, pool, stripeKey) {
  const accounts = new HostAccounts(pool);
  const registration = new SiteSaleRegistration(pool);
  try {
    const state = await currentState(pool, input);
    const sellerState = input.seller
      ? await registration.currentHostAccountSellerState({ providerId: input.providerId, stripeConnectAccountRef: input.seller.stripeConnectAccountRef })
      : null;
    const sellerPlan = input.seller ? sellerOutcome(sellerState, input.seller) : null;
    out(`Experience provider ${input.providerId}: ${state.providerExists ? "registered" : input.seller ? "create" : "not found"}`);
    if (input.seller) {
      out(`Seller for host accounts: ${sellerPlan}`);
      out(`Stripe connected account ${masked(input.seller.stripeConnectAccountRef)}: ${sellerPlan === "unchanged" || input.seller.convertFromNiho ? "registered" : "verify with Stripe and register"}`);
    }
    out(`Host account: ${state.account ? `${state.account.id} (${state.account.status})` : "create (ACTIVE)"}`);
    out(`OWNER membership: ${membershipOutcome(state)}`);
    out(input.seller
      ? "Fee setting, product and payout consent: not created by this operation (the OWNER consents in /host)"
      : "Provider, seller profile, product and payout account: not created by this operation");
    if (command === "plan") return EXIT.ok;
    if (!yes) {
      out("Nothing was written. Run register again with --yes to write.");
      return EXIT.failed;
    }
    if (!input.seller && !state.providerExists) {
      out("Refused: the provider does not exist. Nothing was written.");
      return EXIT.failed;
    }
    if (input.seller) {
      if (sellerPlan.startsWith("conflict:")) {
        out(`Refused: ${sellerPlan.slice("conflict: ".length)}. Nothing was written.`);
        return EXIT.failed;
      }
      if (!await registration.canProvisionHostAccountSeller()) {
        out("This database connection cannot write seller profiles (the runtime role cannot, by design). Use the migration identity. Nothing was written.");
        return EXIT.failed;
      }
      if (input.seller.convertFromNiho) {
        // The account first (harmless alone), then the move and its OWNER in one transaction: a refused OWNER moves nothing.
        const nowUtc = new Date().toISOString();
        const provisioned = await accounts.provisionHostAccount({ email: input.email, nowUtc });
        const moved = await registration.convertNihoSellerToHostAccounts({
          providerId: input.providerId, stripeConnectAccountRef: input.seller.stripeConnectAccountRef, ownerHostAccountId: provisioned.hostAccountId, nowUtc,
        });
        out(`Registered: host account=${provisioned.hostAccountId} (${provisioned.created ? "created" : "existing"}), seller moved from NIHO=${moved.outcome}, products following the new seller reference=${moved.productsUpdated}, OWNER=${moved.owner}.`);
        out("Next: the OWNER signs in at /host, consents to the payout account in 設定 › 受取口座, then publishes.");
        return input.invite ? await invite(pool, provisioned.hostAccountId) : EXIT.ok;
      } else if (sellerPlan !== "unchanged") {
        if (!stripeKey) {
          out("Refused: EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY is not set (the Stripe account is verified first). Nothing was written.");
          return EXIT.failed;
        }
        const stripe = await retrieveConnectedAccount({ accountId: input.seller.stripeConnectAccountRef, platformStripeKey: stripeKey });
        if (stripe.kind !== "ready") {
          out(stripe.kind === "unreachable"
            ? `Refused: Stripe does not show account ${masked(input.seller.stripeConnectAccountRef)} to this platform key. Nothing was written.`
            : `Refused: Stripe account ${masked(input.seller.stripeConnectAccountRef)} is not ready (${stripe.problems.join(", ")}). Nothing was written.`);
          return EXIT.failed;
        }
      }
      const seller = await registration.provisionHostAccountSeller({ providerId: input.providerId, ...input.seller });
      out(`Registered: provider=${seller.provider}, seller for host accounts=${seller.sellerProfile}.`);
    }
    const nowUtc = new Date().toISOString();
    const provisioned = await accounts.provisionHostAccount({ email: input.email, nowUtc });
    const granted = await accounts.grantProviderOwner({ providerId: input.providerId, hostAccountId: provisioned.hostAccountId, nowUtc });
    out(`Registered: host account=${provisioned.hostAccountId} (${provisioned.created ? "created" : "existing"}), OWNER=${granted.kind}.`);
    if (granted.kind !== "granted" && granted.kind !== "already-owner") return EXIT.failed;
    if (input.seller) out("Next: the OWNER signs in, consents to the payout account in 設定 › 受取口座, then publishes.");
    if (input.invite) return await invite(pool, provisioned.hostAccountId);
    out("The host signs in at /host with their NIHO account once it is bound (add \"invite\": true, or run invite, to send the invitation); an emailed link is the fallback (EXPERIENCE_HOST_ACCOUNTS_ENABLED=true).");
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
    const raw = JSON.parse(await readFile(args.inputPath, "utf8"));
    input = args.command === "invite" ? parseInviteInput(raw) : parseInput(raw);
  } catch (error) {
    if (error instanceof SyntaxError) return refuse(["the input file is not JSON"]);
    return refuse(["the input file cannot be read"]);
  }
  if (input.problems) return refuse(input.problems);

  const databaseUrl = process.env.EXPERIENCE_DATABASE_URL;
  if (!databaseUrl) return refuse(["EXPERIENCE_DATABASE_URL is not set"]);
  const role = process.env.EXPERIENCE_DATABASE_ROLE;
  if (role !== undefined && role !== "" && !ROLE.test(role)) return refuse(["EXPERIENCE_DATABASE_ROLE is not a role name"]);
  const stripeKey = process.env.EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY?.trim() || undefined;

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2, ...(role ? { options: `-c role=${role}` } : {}) });
  pool.on("error", () => {});
  try {
    if (role) {
      const current = await pool.query("SELECT current_user AS name");
      if (current.rows[0]?.name !== role) return refuse(["EXPERIENCE_DATABASE_ROLE did not apply (remove `options` from EXPERIENCE_DATABASE_URL)"]);
    }
    return args.command === "invite" ? await runInvite(args.command, input, args.yes, pool) : await run(args.command, input, args.yes, pool, stripeKey);
  } finally {
    await pool.end().catch(() => {});
  }
}

try { process.exitCode = await main(); }
catch { console.error("Unexpected failure. Credentials, addresses, and driver details were not printed."); process.exitCode = EXIT.unexpected; }
