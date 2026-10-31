#!/usr/bin/env node
// The feature flags the staging and production deploy workflows may put on a Cloud Run revision (#84), in one table
// for both. Each flag is a GitHub variable `<PREFIX>_<variable>`: STG_ in the `host-staging` environment, PROD_ in the
// repository. Unset or false keeps the flag off: none of its env, settings or Secret references are on the revision.
// true turns it on once everything it needs is set and well formed, and every flag it depends on is on too (the rules
// of apps/web/src/lib/resolve-config.ts, so a revision never fails at start-up or opens half a feature). Otherwise
// this prints every problem by variable name (never a value) and exits 1, before anything is deployed.
//
// The workflows run it after checkout and before any cloud credential exists, and only pass on the strings it writes
// to $GITHUB_OUTPUT: `env` and `secrets` for --set-env-vars / --set-secrets, `expected_env`, `expected_secrets` and
// `names` (every name the table can set) for checking the revision afterwards, and `summary`.
//
// To add a flag: one entry in FLAGS and a row in docs/production-deploy.md「機能のフラグ」. The workflows need no
// change. apps/web/src/lib/deploy-runtime-flags.test.ts checks each entry against resolve-config.ts.
//
//   DEPLOY_VARS='${{ toJSON(vars) }}' node scripts/deploy/runtime-flags.mjs --target stg|prod --host-console true|false --site-url https://…

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const TARGETS = Object.freeze({
  stg: { prefix: "STG", project: "niho-app-stg" },
  prod: { prefix: "PROD", project: "niho-app-prd" },
});

/** What a flag may need besides other flags: the host console, and the experience DB (both workflows wire them together). */
export const CAPABILITIES = Object.freeze(["HOST_CONSOLE", "DATABASE"]);

const ADDRESS = "[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+";
const HTTPS_URL = "https://[a-z0-9-]+(\\.[a-z0-9-]+)+(/[A-Za-z0-9._~%/-]*)?";

/** Plain settings' shapes: what resolve-config accepts, narrowed to what --set-env-vars carries (never a comma). */
export const SHAPES = Object.freeze({
  consentVersion: { pattern: /^[A-Za-z0-9._:+-]{1,100}$/, words: "letters, digits and ._:+- (1-100)" },
  mailbox: { pattern: new RegExp(`^(${ADDRESS}|[^<>",\\u0000-\\u001F\\u007F\\s][^<>",\\u0000-\\u001F\\u007F]{0,99} <${ADDRESS}>)$`), words: "an address, or Name <address> without commas or quotes" },
  httpsUrl: { pattern: new RegExp(`^${HTTPS_URL}$`), words: "an https URL with a lower-case host, no query or comma" },
  vapidPublicKey: { pattern: /^B[A-Za-z0-9_-]{86}$/, words: "an uncompressed P-256 public key in base64url" },
  vapidSubject: { pattern: new RegExp(`^(mailto:${ADDRESS}|${HTTPS_URL})$`), words: "mailto: an address, or an https URL" },
});

const serviceAccount = (name) => ({ project }) => `${name}@${project}.iam.gserviceaccount.com`;
const siteUrl = ({ siteUrl: url }) => url;

/**
 * The table. `env`: the Cloud Run variable set to "true". `variable`: the GitHub variable after the prefix.
 * `defaults`: on when its variable is unset (only staging's PWA, which it always had). `needs`: CAPABILITIES or other
 * flags' `env`, "A|B" for either. `secrets`: Secret Manager references (`name:version`), with staging's fixed Secret
 * name. `settings`: plain values with their shape. `fixed`: values the workflow derives (job audiences and callers).
 */
export const FLAGS = Object.freeze([
  {
    env: "EXPERIENCE_GUEST_BOOKING_ENABLED",
    variable: "GUEST_BOOKING_ENABLED",
    // Booking needs its confirmation email and booking page (the mail job), not only what resolve-config checks.
    needs: ["HOST_CONSOLE", "DATABASE", "EXPERIENCE_GUEST_MAIL_ENABLED"],
    secrets: [
      { env: "EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY", variable: "STRIPE_PLATFORM_SECRET_KEY_REF", stg: "STRIPE_CONNECT_PLATFORM_SECRET_KEY" },
      { env: "EXPERIENCE_STRIPE_WEBHOOK_SECRET", variable: "STRIPE_WEBHOOK_SECRET_REF", stg: "experience-stg-stripe-webhook-secret" },
    ],
    settings: [
      { env: "EXPERIENCE_BOOKING_CONSENT_VERSION", variable: "BOOKING_CONSENT_VERSION", shape: "consentVersion" },
      { env: "EXPERIENCE_PRIVACY_POLICY_URL", variable: "PRIVACY_POLICY_URL", shape: "httpsUrl", optional: true },
    ],
  },
  {
    env: "EXPERIENCE_GUEST_MAIL_ENABLED",
    variable: "GUEST_MAIL_ENABLED",
    needs: ["DATABASE"],
    secrets: [
      { env: "EXPERIENCE_SMTP_HOST", variable: "SMTP_HOST_REF", stg: "RECEIPT_DELIVERY_SMTP_HOST" },
      { env: "EXPERIENCE_SMTP_PORT", variable: "SMTP_PORT_REF", stg: "RECEIPT_DELIVERY_SMTP_PORT" },
      { env: "EXPERIENCE_SMTP_USER", variable: "SMTP_USER_REF", stg: "RECEIPT_DELIVERY_SMTP_USER" },
      { env: "EXPERIENCE_SMTP_PASSWORD", variable: "SMTP_PASSWORD_REF", stg: "RECEIPT_DELIVERY_SMTP_PASSWORD" },
    ],
    settings: [
      { env: "EXPERIENCE_MAIL_FROM", variable: "MAIL_FROM", shape: "mailbox" },
      { env: "EXPERIENCE_MAIL_REPLY_TO", variable: "MAIL_REPLY_TO", shape: "mailbox" },
    ],
    fixed: { EXPERIENCE_JOBS_AUDIENCE: siteUrl, EXPERIENCE_JOBS_SERVICE_ACCOUNT_EMAIL: serviceAccount("experience-jobs") },
  },
  { env: "EXPERIENCE_GUEST_QUESTIONS_ENABLED", variable: "GUEST_QUESTIONS_ENABLED", needs: ["HOST_CONSOLE", "DATABASE"] },
  {
    env: "EXPERIENCE_TRANSLATION_ENABLED",
    variable: "TRANSLATION_ENABLED",
    // It translates the questions and messages the mail job or メッセージ handle; alone it does nothing.
    needs: ["EXPERIENCE_GUEST_MAIL_ENABLED|EXPERIENCE_GUEST_QUESTIONS_ENABLED"],
    secrets: [{ env: "EXPERIENCE_ANTHROPIC_API_KEY", variable: "ANTHROPIC_API_KEY_REF", stg: "NIHO_TRANSLATE_ANTHROPIC_API_KEY" }],
  },
  { env: "EXPERIENCE_GUEST_REVIEWS_ENABLED", variable: "GUEST_REVIEWS_ENABLED", needs: ["DATABASE"] },
  { env: "EXPERIENCE_HOST_ATTENDANCE_ENABLED", variable: "HOST_ATTENDANCE_ENABLED", needs: ["EXPERIENCE_GUEST_BOOKING_ENABLED"] },
  { env: "HOST_SALES_LEDGER_ENABLED", variable: "HOST_SALES_LEDGER_ENABLED", needs: ["HOST_CONSOLE", "DATABASE"] },
  {
    env: "HOST_SALES_PAYOUTS_ENABLED",
    variable: "HOST_SALES_PAYOUTS_ENABLED",
    needs: ["HOST_SALES_LEDGER_ENABLED"],
    secrets: [{ env: "EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY", variable: "STRIPE_PLATFORM_SECRET_KEY_REF", stg: "STRIPE_CONNECT_PLATFORM_SECRET_KEY" }],
  },
  { env: "HOST_NOTIFICATION_SETTINGS_ENABLED", variable: "HOST_NOTIFICATION_SETTINGS_ENABLED", needs: ["HOST_CONSOLE", "DATABASE"] },
  { env: "HOST_PWA_ENABLED", variable: "HOST_PWA_ENABLED", defaults: { stg: true }, needs: ["HOST_CONSOLE"] },
  {
    env: "HOST_PUSH_ENABLED",
    variable: "HOST_PUSH_ENABLED",
    needs: ["HOST_PWA_ENABLED", "DATABASE"],
    secrets: [{ env: "HOST_PUSH_VAPID_PRIVATE_KEY", variable: "HOST_PUSH_VAPID_PRIVATE_KEY_REF", stg: "experience-stg-host-push-vapid-private-key" }],
    settings: [
      { env: "HOST_PUSH_VAPID_PUBLIC_KEY", variable: "HOST_PUSH_VAPID_PUBLIC_KEY", shape: "vapidPublicKey" },
      { env: "HOST_PUSH_VAPID_SUBJECT", variable: "HOST_PUSH_VAPID_SUBJECT", shape: "vapidSubject" },
    ],
    fixed: { HOST_PUSH_JOB_AUDIENCE: siteUrl, HOST_PUSH_JOB_SERVICE_ACCOUNT_EMAIL: serviceAccount("experience-host-push") },
  },
  {
    env: "EXPERIENCE_GOOGLE_BUSY_SYNC_ENABLED",
    variable: "GOOGLE_BUSY_SYNC_ENABLED",
    needs: ["HOST_CONSOLE", "DATABASE"],
    fixed: { EXPERIENCE_GOOGLE_JOBS_AUDIENCE: siteUrl, EXPERIENCE_GOOGLE_JOBS_SERVICE_ACCOUNT_EMAIL: serviceAccount("experience-google-jobs") },
  },
  {
    env: "EXPERIENCE_GOOGLE_BOOKING_EVENTS_ENABLED",
    variable: "GOOGLE_BOOKING_EVENTS_ENABLED",
    needs: ["HOST_CONSOLE", "DATABASE"],
    fixed: { EXPERIENCE_GOOGLE_JOBS_AUDIENCE: siteUrl, EXPERIENCE_GOOGLE_JOBS_SERVICE_ACCOUNT_EMAIL: serviceAccount("experience-google-jobs") },
  },
]);

const PROD_SECRET_REF = /^[A-Za-z0-9_-]+:[1-9][0-9]*$/;
const SITE_URL = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every Cloud Run name the table can set: what the revision must carry exactly as expected, and nothing else of. */
export function tableNames() {
  const names = new Set();
  for (const flag of FLAGS) {
    names.add(flag.env);
    for (const item of [...(flag.secrets ?? []), ...(flag.settings ?? [])]) names.add(item.env);
    for (const name of Object.keys(flag.fixed ?? {})) names.add(name);
  }
  return [...names].sort();
}

/**
 * Resolves the flags for one deployment. `vars` is the workflow's `vars` context; `hostConsole` whether the revision
 * has the host console and the experience DB. Returns what to deploy, or the problems (by name, never a value).
 */
export function resolveDeployFlags({ target, vars, hostConsole, siteUrl: url }) {
  const settings = TARGETS[target];
  if (!settings) return { problems: [`unknown target ${String(target)}`], on: [], env: {}, secrets: {}, names: tableNames() };
  const problems = [];
  if (!SITE_URL.test(url ?? "")) problems.push("the site URL must be an https origin");
  const name = (variable) => `${settings.prefix}_${variable}`;
  const value = (variable) => {
    const raw = vars?.[name(variable)];
    return typeof raw === "string" ? raw : "";
  };
  const on = new Set();
  for (const flag of FLAGS) {
    const raw = value(flag.variable);
    if (raw === "") {
      if (flag.defaults?.[target]) on.add(flag.env);
    } else if (raw === "true") on.add(flag.env);
    else if (raw !== "false") problems.push(`${name(flag.variable)} must be true, false or unset`);
  }
  const has = (need) => need.split("|").some((one) => (CAPABILITIES.includes(one) ? hostConsole === true : on.has(one)));
  const env = {};
  const secrets = {};
  const context = { project: settings.project, siteUrl: url };
  for (const flag of FLAGS) {
    if (!on.has(flag.env)) continue;
    const by = `${flag.env} (${name(flag.variable)})`;
    for (const need of flag.needs ?? []) {
      if (!has(need)) {
        const words = need.split("|").map((one) => (one === "HOST_CONSOLE" || one === "DATABASE" ? (target === "prod" ? "enable_host_calendar=true" : "the host console") : one)).join(" or ");
        problems.push(`${by} needs ${words}`);
      }
    }
    env[flag.env] = "true";
    for (const secret of flag.secrets ?? []) {
      const ref = value(secret.variable);
      const pattern = target === "stg" ? new RegExp(`^${escape(secret.stg)}:[1-9][0-9]*$`) : PROD_SECRET_REF;
      if (!pattern.test(ref)) problems.push(`${by} needs ${name(secret.variable)} as ${target === "stg" ? `${secret.stg}:VERSION` : "secret-name:VERSION"} (a numeric version)`);
      else secrets[secret.env] = ref;
    }
    for (const setting of flag.settings ?? []) {
      const text = value(setting.variable);
      if (text === "" && setting.optional) continue;
      if (!SHAPES[setting.shape].pattern.test(text)) problems.push(`${by} needs ${name(setting.variable)}: ${SHAPES[setting.shape].words}`);
      else env[setting.env] = text;
    }
    for (const [key, derive] of Object.entries(flag.fixed ?? {})) env[key] = derive(context);
  }
  return { problems: [...new Set(problems)], on: FLAGS.map((flag) => flag.env).filter((flag) => on.has(flag)), env, secrets, names: tableNames() };
}

/** `NAME=value,…` in the table's order of names (stable for review). */
const joined = (pairs) => Object.keys(pairs).sort().map((key) => `${key}=${pairs[key]}`).join(",");

export function outputsOf(resolved) {
  return {
    env: joined(resolved.env),
    secrets: joined(resolved.secrets),
    expected_env: JSON.stringify(resolved.env),
    expected_secrets: JSON.stringify(resolved.secrets),
    names: JSON.stringify(resolved.names),
    summary: resolved.on.length ? resolved.on.join(" ") : "none",
  };
}

function argument(args, flag) {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
}

function main(args) {
  let vars = {};
  try {
    vars = JSON.parse(process.env.DEPLOY_VARS || "{}");
  } catch {
    console.log("::error title=Deploy flags::DEPLOY_VARS is not the workflow's vars as JSON");
    return 1;
  }
  const hostConsole = argument(args, "--host-console");
  const resolved = resolveDeployFlags({ target: argument(args, "--target"), vars, hostConsole: hostConsole === "true", siteUrl: argument(args, "--site-url") });
  if (hostConsole !== "true" && hostConsole !== "false") resolved.problems.push("--host-console must be true or false");
  if (resolved.problems.length) {
    for (const problem of resolved.problems) console.log(`::error title=Deploy flags::${problem}`);
    return 1;
  }
  const outputs = outputsOf(resolved);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, text]) => `${key}=${text}\n`).join(""));
  console.log(`Feature flags on: ${outputs.summary}`);
  console.log(`Secret references: ${Object.keys(resolved.secrets).sort().join(" ") || "none"}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
