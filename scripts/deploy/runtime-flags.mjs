#!/usr/bin/env node
// The feature flags the staging and production deploy workflows may put on a Cloud Run revision (#84), in one table
// for both. Each flag is a GitHub variable `<PREFIX>_<variable>`: STG_ in the `host-staging` environment, PROD_ in the
// repository. Unset or false keeps the flag off: none of its env, settings or Secret references are on the revision.
// The host identity audience is a base host-console setting, not a feature flag: /host always uses it to mint the
// NIHO API ID token, even while every optional host API remains closed.
// true turns it on once everything it needs is set and well formed, and every flag it depends on is on too (the rules
// of apps/web/src/lib/resolve-config.ts, so a revision never fails at start-up or opens half a feature). Otherwise
// this prints every problem by variable name (never a value) and exits 1, before anything is deployed.
//
// The workflows run it after checkout and before any cloud credential exists, and only pass on the strings it writes
// to $GITHUB_OUTPUT: `env` and `secrets` for --set-env-vars / --set-secrets, `expected_env`, `expected_secrets` and
// `names` (every name the table can set) for checking the revision afterwards, and `summary`.
//
// To add a flag: one entry in FLAGS and rows in docs/production-deploy.md「機能のフラグ」 and the staging guide. The
// workflows need no change. apps/web/src/lib/deploy-runtime-flags.test.ts checks each entry against resolve-config.ts.
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

const HOST_CONSOLE_SETTINGS = Object.freeze([
  { env: "NIHO_EXPERIENCE_HOST_COMMON_CONTRACT_AUDIENCE", variable: "NIHO_EXPERIENCE_HOST_COMMON_CONTRACT_AUDIENCE", shape: "httpsOrigin" },
]);

const ADDRESS = "[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+";
const HTTPS_URL = "https://[a-z0-9-]+(\\.[a-z0-9-]+)+(/[A-Za-z0-9._~%/-]*)?";
const SERVICE_ACCOUNT = "[a-z0-9][a-z0-9-]*@[a-z0-9][a-z0-9-]*\\.iam\\.gserviceaccount\\.com";

/** Plain settings' shapes: what resolve-config accepts, narrowed to what --set-env-vars carries (never a comma). */
export const SHAPES = Object.freeze({
  consentVersion: { pattern: /^[A-Za-z0-9._:+-]{1,100}$/, words: "letters, digits and ._:+- (1-100)" },
  bucketName: { pattern: /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/, words: "a 3-63 character lower-case GCS bucket name" },
  mailbox: { pattern: new RegExp(`^(${ADDRESS}|[^<>",\\u0000-\\u001F\\u007F\\s][^<>",\\u0000-\\u001F\\u007F]{0,99} <${ADDRESS}>)$`), words: "an address, or Name <address> without commas or quotes" },
  httpsUrl: { pattern: new RegExp(`^${HTTPS_URL}$`), words: "an https URL with a lower-case host, no query or comma" },
  httpsOrigin: { pattern: /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+$/, words: "an exact https origin without path, credentials or query" },
  cloudRunServiceUrl: { pattern: /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.run\.app$/, words: "a Cloud Run service URL ending in .run.app" },
  // Semicolons preserve the two callers as one gcloud value; the runtime accepts the same closed list.
  serviceAccountList: { pattern: new RegExp(`^${SERVICE_ACCOUNT}(;${SERVICE_ACCOUNT})*$`), words: "service account emails separated by semicolons, without spaces" },
  serviceAccountEmail: { pattern: new RegExp(`^${SERVICE_ACCOUNT}$`), words: "a single service account email" },
  vapidPublicKey: { pattern: /^B[A-Za-z0-9_-]{86}$/, words: "an uncompressed P-256 public key in base64url" },
  vapidSubject: { pattern: new RegExp(`^(mailto:${ADDRESS}|${HTTPS_URL})$`), words: "mailto: an address, or an https URL" },
});

const serviceAccount = (name) => ({ project }) => `${name}@${project}.iam.gserviceaccount.com`;
const siteUrl = ({ siteUrl: url }) => url;

/**
 * The table. `env`: the Cloud Run variable set to "true". `variable`: the GitHub variable after the prefix.
 * `defaults`: on when its variable is unset (only staging's PWA, which it always had). `needs`: CAPABILITIES or other
 * flags' `env`, "A|B" for either. `conflicts`: flags that may not be on at the same time. `secrets`: Secret Manager
 * references (`name:version`), with staging's fixed Secret
 * name. `settings`: plain values with their shape. `fixed`: values the workflow derives (job audiences and callers).
 */
export const FLAGS = Object.freeze([
  {
    env: "EXPERIENCE_ARTICLE_AUTHORITY_API_ENABLED",
    variable: "ARTICLE_AUTHORITY_API_ENABLED",
    needs: ["DATABASE"],
    settings: [
      { env: "EXPERIENCE_ARTICLE_AUTHORITY_SERVICE_ACCOUNT_EMAILS", variable: "ARTICLE_AUTHORITY_SERVICE_ACCOUNT_EMAILS", shape: "serviceAccountList" },
      { env: "NIHO_ARTICLE_AUTHORITY_ORIGIN", variable: "NIHO_ARTICLE_AUTHORITY_ORIGIN", shape: "httpsOrigin" },
      { env: "NIHO_ARTICLE_AUTHORITY_AUDIENCE", variable: "NIHO_ARTICLE_AUTHORITY_AUDIENCE", shape: "httpsUrl" },
      { env: "EDITOR_ARTICLE_AUTHORITY_ORIGIN", variable: "EDITOR_ARTICLE_AUTHORITY_ORIGIN", shape: "httpsOrigin" },
      { env: "EDITOR_ARTICLE_AUTHORITY_AUDIENCE", variable: "EDITOR_ARTICLE_AUTHORITY_AUDIENCE", shape: "httpsUrl" },
    ],
    fixed: { EXPERIENCE_ARTICLE_AUTHORITY_AUDIENCE: siteUrl },
  },
  {
    env: "GUIDE_ADMIN_API_ENABLED",
    variable: "GUIDE_ADMIN_API_ENABLED",
    needs: ["DATABASE"],
    settings: [
      { env: "GUIDE_ADMIN_AUDIENCE", variable: "GUIDE_ADMIN_AUDIENCE", shape: "cloudRunServiceUrl" },
      { env: "GUIDE_ADMIN_SERVICE_ACCOUNT_EMAIL", variable: "GUIDE_ADMIN_SERVICE_ACCOUNT_EMAIL", shape: "serviceAccountEmail" },
    ],
  },
  {
    env: "EXPERIENCE_HOST_ARTICLE_LINKS_ENABLED",
    variable: "HOST_ARTICLE_LINKS_ENABLED",
    needs: ["HOST_CONSOLE"],
    settings: [
      { env: "NIHO_ARTICLE_AUTHORITY_ORIGIN", variable: "NIHO_ARTICLE_AUTHORITY_ORIGIN", shape: "httpsOrigin" },
      { env: "NIHO_ARTICLE_LINKS_AUDIENCE", variable: "NIHO_ARTICLE_LINKS_AUDIENCE", shape: "httpsUrl" },
      { env: "GUIDE_EDITOR_SITE_ORIGIN", variable: "GUIDE_EDITOR_SITE_ORIGIN", shape: "httpsOrigin" },
    ],
  },
  {
    env: "EXPERIENCE_GUIDE_PUBLIC_SOURCE",
    variable: "EDITOR_PUBLICATIONS_ENABLED",
    value: "editor",
    needs: ["DATABASE", "EXPERIENCE_ARTICLE_AUTHORITY_API_ENABLED"],
    settings: [
      { env: "GUIDE_EDITOR_API_BASE_URL", variable: "GUIDE_EDITOR_API_BASE_URL", shape: "httpsUrl" },
      { env: "GUIDE_EDITOR_ASSET_ORIGINS", variable: "GUIDE_EDITOR_ASSET_ORIGIN", shape: "httpsOrigin" },
      { env: "GUIDE_EDITOR_SITE_ORIGIN", variable: "GUIDE_EDITOR_SITE_ORIGIN", shape: "httpsOrigin" },
    ],
    secrets: [{ env: "GUIDE_EDITOR_API_TOKEN", variable: "GUIDE_EDITOR_API_TOKEN_REF", stg: "experience-stg-editor-api-token" }],
    fixed: { GUIDE_EDITOR_API_HANDLE: () => "exp" },
  },
  {
    env: "EXPERIENCE_GUIDE_APP_CARDS_ENABLED",
    variable: "GUIDE_APP_CARDS_ENABLED",
    needs: ["EXPERIENCE_GUIDE_PUBLIC_SOURCE"],
  },
  {
    env: "EXPERIENCE_GUEST_BOOKING_ENABLED",
    variable: "GUEST_BOOKING_ENABLED",
    // Booking needs its confirmation email and booking page (the mail job), not only what resolve-config checks.
    needs: ["HOST_CONSOLE", "DATABASE", "EXPERIENCE_GUEST_MAIL_ENABLED"],
    secrets: [
      { env: "EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY", variable: "STRIPE_PLATFORM_SECRET_KEY_REF", stg: "STRIPE_CONNECT_PLATFORM_SECRET_KEY" },
      { env: "EXPERIENCE_STRIPE_WEBHOOK_SECRET", variable: "STRIPE_WEBHOOK_SECRET_REF", stg: "experience-stg-stripe-webhook-secret" },
      { env: "EXPERIENCE_CHECKOUT_IP_HMAC_KEY", variable: "CHECKOUT_IP_HMAC_KEY_REF", stg: "experience-stg-checkout-ip-hmac-key" },
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
  {
    env: "EXPERIENCE_PUBLICATIONS_ENABLED",
    variable: "PUBLICATIONS_ENABLED",
    needs: ["HOST_CONSOLE", "DATABASE"],
    settings: [
      { env: "EXPERIENCE_PUBLICATION_CONSENT_VERSION", variable: "PUBLICATION_CONSENT_VERSION", shape: "consentVersion" },
      { env: "EXPERIENCE_PUBLIC_MEDIA_BUCKET", variable: "PUBLIC_MEDIA_BUCKET", shape: "bucketName" },
    ],
  },
  {
    env: "EXPERIENCE_HOST_PUBLICATION_API_ENABLED",
    variable: "HOST_PUBLICATION_API_ENABLED",
    needs: ["EXPERIENCE_PUBLICATIONS_ENABLED"],
  },
  {
    env: "EXPERIENCE_PROVIDER_PAGES_API_ENABLED",
    variable: "PROVIDER_PAGES_API_ENABLED",
    needs: ["HOST_CONSOLE", "DATABASE"],
  },
  {
    env: "EXPERIENCE_PROVIDER_OPERATIONS_API_ENABLED",
    variable: "PROVIDER_OPERATIONS_API_ENABLED",
    needs: ["HOST_CONSOLE", "DATABASE"],
  },
  {
    env: "EXPERIENCE_TRANSLATE_API_ENABLED",
    variable: "TRANSLATE_API_ENABLED",
    // NIHO予約はNIHO APIで検証する。site予約は販売ONなら通常表示し、販売OFFでも通訳flagでread-only表示する。
    needs: ["HOST_CONSOLE", "DATABASE"],
  },
  {
    env: "EXPERIENCE_GUEST_QUESTIONS_ENABLED",
    variable: "GUEST_QUESTIONS_ENABLED",
    needs: ["HOST_CONSOLE", "DATABASE"],
    conflicts: ["EXPERIENCE_PROVIDER_OPERATIONS_API_ENABLED"],
  },
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
  {
    env: "EXPERIENCE_HOST_CALENDAR_FEED_ENABLED",
    variable: "HOST_CALENDAR_FEED_ENABLED",
    needs: ["HOST_CONSOLE", "DATABASE"],
    secrets: [{ env: "EXPERIENCE_CALENDAR_FEED_KEY", variable: "CALENDAR_FEED_KEY_REF", stg: "experience-stg-calendar-feed-key" }],
  },
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
  // OTA の予約 (#194): the guest details OTA readers send (erased by the mail job) and the pushes about OTA bookings.
  // Neither opens an OTA read; the channel runtime keeps its own gates.
  { env: "EXPERIENCE_OTA_GUEST_DETAILS_ENABLED", variable: "OTA_GUEST_DETAILS_ENABLED", needs: ["DATABASE", "EXPERIENCE_GUEST_MAIL_ENABLED"] },
  { env: "EXPERIENCE_OTA_BOOKING_NOTIFICATIONS_ENABLED", variable: "OTA_BOOKING_NOTIFICATIONS_ENABLED", needs: ["HOST_PUSH_ENABLED", "DATABASE"] },
  // ホストへのメール (#194): the sign-in's verified address, the host's choice in 設定 › 通知, and booking emails to hosts,
  // all sent by the mail job.
  { env: "EXPERIENCE_HOST_MAIL_ENABLED", variable: "HOST_MAIL_ENABLED", needs: ["HOST_CONSOLE", "DATABASE", "EXPERIENCE_GUEST_MAIL_ENABLED"] },
]);

const PROD_SECRET_REF = /^[A-Za-z0-9_-]+:[1-9][0-9]*$/;
const SITE_URL = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every Cloud Run name the table can set: what the revision must carry exactly as expected, and nothing else of. */
export function tableNames() {
  const names = new Set(HOST_CONSOLE_SETTINGS.map((setting) => setting.env));
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
  for (const flag of FLAGS) {
    if (!on.has(flag.env)) continue;
    for (const conflict of flag.conflicts ?? []) {
      if (!on.has(conflict)) continue;
      const other = FLAGS.find((candidate) => candidate.env === conflict);
      problems.push(`${flag.env} (${name(flag.variable)}) conflicts with ${other?.env ?? conflict}${other ? ` (${name(other.variable)})` : ""}`);
    }
  }
  const env = {};
  const secrets = {};
  const context = { project: settings.project, siteUrl: url };
  if (hostConsole) {
    for (const setting of HOST_CONSOLE_SETTINGS) {
      const text = value(setting.variable);
      if (!SHAPES[setting.shape].pattern.test(text)) {
        problems.push(`host console needs ${name(setting.variable)}: ${SHAPES[setting.shape].words}`);
      } else {
        env[setting.env] = text;
      }
    }
  }
  for (const flag of FLAGS) {
    if (!on.has(flag.env)) continue;
    const by = `${flag.env} (${name(flag.variable)})`;
    for (const need of flag.needs ?? []) {
      if (!has(need)) {
        const words = need.split("|").map((one) => (one === "HOST_CONSOLE" || one === "DATABASE" ? (target === "prod" ? "enable_host_calendar=true" : "the host console") : one)).join(" or ");
        problems.push(`${by} needs ${words}`);
      }
    }
    env[flag.env] = flag.value ?? "true";
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
