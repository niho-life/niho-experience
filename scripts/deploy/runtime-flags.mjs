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
const CHANNEL_CAPABILITY = "(observe|readReservations|close|open|create)";
const ADMIN_EMAIL = "[a-z0-9._%+-]{1,64}@niho\\.life";
const CHANNEL_ADAPTER = `[A-Za-z0-9._-]+/[A-Za-z0-9._-]+@[0-9]+=${CHANNEL_CAPABILITY}(\\+${CHANNEL_CAPABILITY})*`;

/** Plain settings' shapes: what resolve-config accepts, narrowed to what --set-env-vars carries (never a comma). */
export const SHAPES = Object.freeze({
  consentVersion: { pattern: /^[A-Za-z0-9._:+-]{1,100}$/, words: "letters, digits and ._:+- (1-100)" },
  sellerReference: { pattern: /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/, words: "a seller reference (1-256 characters)" },
  sellerName: { pattern: /^(?=.*\S)[^,\p{Cc}]{1,300}$/u, words: "a seller name without commas or control characters (1-300 characters)" },
  stripeAccount: { pattern: /^acct_[A-Za-z0-9]{8,}$/, words: "a Stripe account ID" },
  bucketName: { pattern: /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/, words: "a 3-63 character lower-case GCS bucket name" },
  mailbox: { pattern: new RegExp(`^(${ADDRESS}|[^<>",\\u0000-\\u001F\\u007F\\s][^<>",\\u0000-\\u001F\\u007F]{0,99} <${ADDRESS}>)$`), words: "an address, or Name <address> without commas or quotes" },
  httpsUrl: { pattern: new RegExp(`^${HTTPS_URL}$`), words: "an https URL with a lower-case host, no query or comma" },
  httpsOrigin: { pattern: /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+$/, words: "an exact https origin without path, credentials or query" },
  cloudRunServiceUrl: { pattern: /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.run\.app$/, words: "a Cloud Run service URL ending in .run.app" },
  // Semicolons preserve the two callers as one gcloud value; the runtime accepts the same closed list.
  serviceAccountList: { pattern: new RegExp(`^${SERVICE_ACCOUNT}(;${SERVICE_ACCOUNT})*$`), words: "service account emails separated by semicolons, without spaces" },
  serviceAccountEmail: { pattern: new RegExp(`^${SERVICE_ACCOUNT}$`), words: "a single service account email" },
  // The Admin allowlist (ADR 0003): the runtime compares them in lower case and refuses any other domain.
  adminAllowedEmails: { pattern: new RegExp(`^${ADMIN_EMAIL}(;${ADMIN_EMAIL})*$`), words: "@niho.life addresses separated by semicolons, without spaces" },
  // 運営の CLI (#576): the Google OAuth client IDs whose ID tokens /admin/api accepts (gcloud's own client for `gcloud auth print-identity-token`).
  googleClientIdList: { pattern: /^[0-9A-Za-z-]{6,80}\.apps\.googleusercontent\.com(;[0-9A-Za-z-]{6,80}\.apps\.googleusercontent\.com)*$/, words: "Google OAuth client IDs (…apps.googleusercontent.com) separated by semicolons, without spaces" },
  vapidPublicKey: { pattern: /^B[A-Za-z0-9_-]{86}$/, words: "an uncompressed P-256 public key in base64url" },
  vapidSubject: { pattern: new RegExp(`^(mailto:${ADDRESS}|${HTTPS_URL})$`), words: "mailto: an address, or an https URL" },
  // The OTA adapters' short form (apps/web/src/lib/experience/channel-adapters.ts): only its shape; the runtime refuses
  // a key listed twice or a capability repeated.
  channelAdapters: {
    pattern: new RegExp(`^${CHANNEL_ADAPTER}(;${CHANNEL_ADAPTER})*$`),
    words: "site/adapter@version=capability(+capability) entries joined by semicolons, capabilities from observe, readReservations, close, open and create, without commas or spaces",
  },
});

const serviceAccount = (name) => ({ project }) => `${name}@${project}.iam.gserviceaccount.com`;
const siteUrl = ({ siteUrl: url }) => url;

/**
 * The table. `id` identifies a flag when multiple mutually-exclusive choices write the same runtime env; otherwise
 * `env` is also the id. `env`: the Cloud Run variable set to "true". `variable`: the GitHub variable after the prefix.
 * `defaults`: on when its variable is unset (only staging's PWA, which it always had). `needs`: CAPABILITIES or other
 * flags' `env`, "A|B" for either. `conflicts`: flags that may not be on at the same time. `secrets`: Secret Manager
 * references (`name:version`), with staging's fixed Secret name. `optional` permits an unset reference.
 * `settings`: plain values with their shape. `fixed`: values the workflow derives (job audiences and callers).
 */
export const FLAGS = Object.freeze([
  {
    env: "ADMIN_SUPPORT_CONSOLE_ENABLED",
    variable: "ADMIN_SUPPORT_CONSOLE_ENABLED",
    // The workflows attach the native support DB with the host console capability.
    needs: ["HOST_CONSOLE", "DATABASE"],
    secrets: [{ env: "ADMIN_SESSION_SECRET", variable: "ADMIN_SESSION_SECRET_REF", stg: "experience-stg-admin-session-secret" }],
    fixed: { NIHO_EXPERIENCE_ADMIN_ORIGIN: siteUrl },
  },
  {
    env: "EXPERIENCE_ARTICLE_AUTHORITY_API_ENABLED",
    variable: "ARTICLE_AUTHORITY_API_ENABLED",
    needs: ["DATABASE"],
    settings: [
      { env: "EXPERIENCE_ARTICLE_AUTHORITY_SERVICE_ACCOUNT_EMAILS", variable: "ARTICLE_AUTHORITY_SERVICE_ACCOUNT_EMAILS", shape: "serviceAccountList" },
      { env: "NIHO_ARTICLE_AUTHORITY_ORIGIN", variable: "NIHO_ARTICLE_AUTHORITY_ORIGIN", shape: "httpsOrigin" },
      { env: "NIHO_ARTICLE_AUTHORITY_AUDIENCE", variable: "NIHO_ARTICLE_AUTHORITY_AUDIENCE", shape: "httpsUrl" },
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
    ],
  },
  {
    id: "DATABASE_GUIDE_PUBLICATIONS",
    env: "EXPERIENCE_GUIDE_PUBLIC_SOURCE",
    variable: "DATABASE_GUIDE_PUBLICATIONS_ENABLED",
    value: "database",
    needs: ["DATABASE"],
    settings: [{ env: "GUIDE_MEDIA_BUCKET", variable: "GUIDE_MEDIA_BUCKET", shape: "bucketName" }],
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
    env: "EXPERIENCE_MANAGED_SALES_WEBHOOKS_ENABLED",
    variable: "MANAGED_SALES_WEBHOOKS_ENABLED",
    needs: ["EXPERIENCE_GUEST_BOOKING_ENABLED"],
    secrets: [{
      env: "EXPERIENCE_STRIPE_PLATFORM_WEBHOOK_SECRET", variable: "STRIPE_PLATFORM_WEBHOOK_SECRET_REF",
      stg: "experience-stg-stripe-platform-webhook-secret",
    }],
    settings: [{ env: "EXPERIENCE_MANAGED_PLATFORM_ACCOUNT_ID", variable: "MANAGED_PLATFORM_ACCOUNT_ID", shape: "stripeAccount" }],
  },
  {
    env: "EXPERIENCE_MANAGED_SALES_ENABLED",
    variable: "MANAGED_SALES_ENABLED",
    needs: ["EXPERIENCE_MANAGED_SALES_WEBHOOKS_ENABLED", "EXPERIENCE_HOST_PUBLICATION_API_ENABLED", "ADMIN_SUPPORT_CONSOLE_ENABLED", "EXPERIENCE_GUEST_MAIL_ENABLED"],
    settings: [
      { env: "EXPERIENCE_MANAGED_LEGAL_SELLER_NAME", variable: "MANAGED_LEGAL_SELLER_NAME", shape: "sellerName" },
      { env: "EXPERIENCE_MANAGED_COMMERCIAL_TRANSACTIONS_URL", variable: "MANAGED_COMMERCIAL_TRANSACTIONS_URL", shape: "httpsUrl" },
      { env: "EXPERIENCE_MANAGED_SELLER_NIHO_ACCOUNT_REF", variable: "MANAGED_SELLER_NIHO_ACCOUNT_REF", shape: "sellerReference" },
      { env: "EXPERIENCE_MANAGED_AGREEMENT_VERSION", variable: "MANAGED_AGREEMENT_VERSION", shape: "consentVersion" },
      { env: "EXPERIENCE_OWNER_SALES_PLAN_AGREEMENT_VERSION", variable: "OWNER_SALES_PLAN_AGREEMENT_VERSION", shape: "consentVersion", optional: true },
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
      { env: "EXPERIENCE_MANAGED_PROVIDER_MAIL_RECIPIENTS", variable: "MANAGED_PROVIDER_MAIL_RECIPIENTS_REF", stg: "experience-stg-managed-provider-mail-recipients", optional: true },
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
    env: "EXPERIENCE_TRANSLATE_STANDALONE_API_ENABLED",
    variable: "TRANSLATE_STANDALONE_API_ENABLED",
    // Reservation-free Host Account rooms use the server-to-server OIDC route, not a NIHO host bearer.
    needs: ["HOST_CONSOLE", "DATABASE", "EXPERIENCE_HOST_ACCOUNTS_ENABLED"],
  },
  {
    env: "EXPERIENCE_GUEST_QUESTIONS_ENABLED",
    variable: "GUEST_QUESTIONS_ENABLED",
    needs: ["HOST_CONSOLE", "DATABASE"],
  },
  {
    env: "EXPERIENCE_PERSON_MESSAGES_ENABLED",
    variable: "PERSON_MESSAGES_ENABLED",
    // 街の人 (Japanese site) → a message to the person, kept like a question and answered by the OWNER in メッセージ; the
    // answer is an email (guest mail). Like the questions, the OWNER must be able to read it in the Experience's own メッセージ.
    needs: ["HOST_CONSOLE", "DATABASE", "EXPERIENCE_GUEST_MAIL_ENABLED", "EXPERIENCE_JAPANESE_SITE_ENABLED"],
    conflicts: ["EXPERIENCE_PROVIDER_OPERATIONS_API_ENABLED"],
  },
  {
    env: "EXPERIENCE_GROUP_INQUIRY_ENABLED",
    variable: "GROUP_INQUIRY_ENABLED",
    // The two emails of an inquiry go with the mail job (guest mail); the Admin inbox needs the Admin sign-in as ever.
    needs: ["DATABASE", "EXPERIENCE_GUEST_MAIL_ENABLED"],
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
  // ホストのアカウント (ADR 0003, docs/host-accounts.md): /host signs in with Experience's own accounts and an emailed link
  // (sent by the mail job) instead of NIHO. No flag whose code sends a NIHO host access token may be on with it
  // (resolve-config.ts NIHO_HOST_TOKEN_FLAGS; the others of that list are not in this table). In this mode 受取口座 is
  // read from Stripe with the platform key and the OWNER consents to it at a version (slice 3): resolve-config needs both
  // once the host publication API is on too; the table asks for them with the flag, so turning that API on later never
  // finds them missing.
  {
    env: "EXPERIENCE_HOST_ACCOUNTS_ENABLED",
    variable: "HOST_ACCOUNTS_ENABLED",
    needs: ["HOST_CONSOLE", "DATABASE", "EXPERIENCE_GUEST_MAIL_ENABLED"],
    conflicts: ["EXPERIENCE_PROVIDER_OPERATIONS_API_ENABLED", "EXPERIENCE_PROVIDER_PAGES_API_ENABLED", "EXPERIENCE_TRANSLATE_API_ENABLED", "EXPERIENCE_HOST_ARTICLE_LINKS_ENABLED"],
    secrets: [{ env: "EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY", variable: "STRIPE_PLATFORM_SECRET_KEY_REF", stg: "STRIPE_CONNECT_PLATFORM_SECRET_KEY" }],
    settings: [{ env: "EXPERIENCE_PAYOUT_ACCOUNT_CONSENT_VERSION", variable: "PAYOUT_ACCOUNT_CONSENT_VERSION", shape: "consentVersion" }],
  },
  // ホストの NIHO アカウントでのログイン (Epic #591, #594): 「NIHO アカウントでログイン」 1 ボタン。NIHO は本人確認だけ（接続はすぐ解除し、
  // NIHO のトークンは持たない）、セッションと結び付け（0083）は Experience の DB。メールのリンクは画面から外れ、route は残る。
  // NIHO 側（niho-coliving/niho-app#20305・#20306）の本番配備と stg の受入が済むまで ON にしない。
  {
    env: "EXPERIENCE_HOST_NIHO_LOGIN_ENABLED",
    variable: "HOST_NIHO_LOGIN_ENABLED",
    needs: ["HOST_CONSOLE", "DATABASE", "EXPERIENCE_HOST_ACCOUNTS_ENABLED"],
  },
  // 旅行者のアカウント (Epic #591, #597, ADR 0004 §8): Google / Apple / LINE のボタンから、NIHO の名前を出さずにアカウントを作る。
  // アカウントとセッション（migration 0085）は Experience の DB で、ホストアカウントとは別の表と cookie。NIHO の戻りは同じ callback なので
  // ホストのアカウント（HOST_ACCOUNTS_ENABLED。旧 NIHO トークン方式の callback に旅行者を入れないため）が前提。
  // NIHO 側（niho-coliving/niho-app#20330・#20332）が stg に入り、stg の受入が済むまで ON にしない。
  {
    env: "EXPERIENCE_TRAVELER_ACCOUNTS_ENABLED",
    variable: "TRAVELER_ACCOUNTS_ENABLED",
    needs: ["HOST_CONSOLE", "DATABASE", "EXPERIENCE_HOST_ACCOUNTS_ENABLED"],
    // The terms of service a traveler agrees to by logging in: linked beside the privacy notice while set.
    settings: [{ env: "EXPERIENCE_TERMS_URL", variable: "TERMS_URL", shape: "httpsUrl", optional: true }],
  },
  // Experience-native COHOST teams. This is independent from (and does not open) the legacy provider-operations consumer.
  {
    env: "EXPERIENCE_HOST_TEAM_ENABLED",
    variable: "HOST_TEAM_ENABLED",
    needs: ["HOST_CONSOLE", "DATABASE", "EXPERIENCE_HOST_ACCOUNTS_ENABLED"],
    // The dependency opens the native account mode, so the team switch has the same incompatible legacy consumers.
    conflicts: ["EXPERIENCE_PROVIDER_OPERATIONS_API_ENABLED", "EXPERIENCE_PROVIDER_PAGES_API_ENABLED", "EXPERIENCE_TRANSLATE_API_ENABLED", "EXPERIENCE_HOST_ARTICLE_LINKS_ENABLED"],
  },
  // 開催回の担当 (#535 v0, docs/occurrence-assignments.md): 承認後決済の開催回に1人の内部担当。報酬の計算・送金はしない。
  {
    env: "EXPERIENCE_OCCURRENCE_ASSIGNMENT_ENABLED",
    variable: "OCCURRENCE_ASSIGNMENT_ENABLED",
    needs: ["HOST_CONSOLE", "DATABASE", "EXPERIENCE_MANAGED_SALES_ENABLED"],
  },
  // 日本語サイト (#59): /ja の detail・sitemap・hreflang。公開サイト側の機能だが、flag は host console を配線する経路の
  // revision にだけ渡るので HOST_CONSOLE を要する。NIHO の日本語 release の実配備と実機確認が済むまで ON にしない
  // （docs/localization-consumer.md「有効化の前に確かめること」）。
  { env: "EXPERIENCE_JAPANESE_SITE_ENABLED", variable: "JAPANESE_SITE_ENABLED", needs: ["HOST_CONSOLE"] },
  // OTA の枠管理 (#194, docs/ota-runtime.md): the start-up gates of resolve-config.ts, all off by default. The watchdog is
  // called by Cloud Scheduler with its own service account; the runtime (worker API) needs the manager that configures
  // listings, the watchdog that recovers stuck jobs and holds new OPENs, and an allowlist of adapters. The Google OAuth
  // client the resource and Airbnb flags need is the host console's.
  {
    env: "EXPERIENCE_CHANNEL_WATCHDOG_ENABLED",
    variable: "CHANNEL_WATCHDOG_ENABLED",
    needs: ["HOST_CONSOLE", "DATABASE"],
    fixed: { EXPERIENCE_CHANNEL_WATCHDOG_AUDIENCE: siteUrl, EXPERIENCE_CHANNEL_WATCHDOG_SERVICE_ACCOUNT_EMAIL: serviceAccount("experience-ota-watchdog") },
  },
  { env: "EXPERIENCE_CHANNEL_MANAGER_ENABLED", variable: "CHANNEL_MANAGER_ENABLED", needs: ["ADMIN_SUPPORT_CONSOLE_ENABLED", "DATABASE"] },
  // Admin のログイン (ADR 0003 decision 4, docs/admin-auth.md): /admin signs in with a niho.life Google account on this
  // allowlist, with sessions in the experience DB, instead of NIHO's Admin session. It uses the host console's Google
  // OAuth client (the operator adds the redirect URI to it first). No flag whose code sends a NIHO admin token may be on
  // with it (resolve-config.ts NIHO_ADMIN_TOKEN_FLAGS; none of them is in this table).
  {
    env: "EXPERIENCE_ADMIN_GOOGLE_LOGIN_ENABLED",
    variable: "ADMIN_GOOGLE_LOGIN_ENABLED",
    needs: ["ADMIN_SUPPORT_CONSOLE_ENABLED", "HOST_CONSOLE", "DATABASE"],
    settings: [{ env: "EXPERIENCE_ADMIN_ALLOWED_EMAILS", variable: "ADMIN_ALLOWED_EMAILS", shape: "adminAllowedEmails" }],
  },
  // 運営の CLI (#576, docs/operator-cli.md): the same /admin APIs from a command line, with the signed-in admin's own Google
  // ID token (a niho.life account on the Admin allowlist). Only with the Google admin login; writes are recorded in
  // operator_cli_requests (migration 0078).
  {
    env: "EXPERIENCE_OPERATOR_CLI_ENABLED",
    variable: "OPERATOR_CLI_ENABLED",
    needs: ["EXPERIENCE_ADMIN_GOOGLE_LOGIN_ENABLED"],
    settings: [{ env: "EXPERIENCE_OPERATOR_CLI_AUDIENCES", variable: "OPERATOR_CLI_AUDIENCES", shape: "googleClientIdList" }],
  },
  {
    env: "EXPERIENCE_CHANNEL_RUNTIME_ENABLED",
    variable: "CHANNEL_RUNTIME_ENABLED",
    needs: ["EXPERIENCE_CHANNEL_MANAGER_ENABLED", "EXPERIENCE_CHANNEL_WATCHDOG_ENABLED", "DATABASE"],
    settings: [{ env: "EXPERIENCE_CHANNEL_SUPPORTED_ADAPTERS", variable: "CHANNEL_SUPPORTED_ADAPTERS", shape: "channelAdapters" }],
  },
  { env: "EXPERIENCE_RESOURCE_GOOGLE_ENABLED", variable: "RESOURCE_GOOGLE_ENABLED", needs: ["HOST_CONSOLE", "DATABASE"] },
  {
    env: "EXPERIENCE_RESOURCE_GOOGLE_WATCH_ENABLED",
    variable: "RESOURCE_GOOGLE_WATCH_ENABLED",
    needs: ["EXPERIENCE_RESOURCE_GOOGLE_ENABLED"],
    fixed: { EXPERIENCE_RESOURCE_GOOGLE_WEBHOOK_URL: ({ siteUrl: url }) => `${url}/api/google/calendar/watch` },
  },
  { env: "EXPERIENCE_AIRBNB_GOOGLE_SETUP_ENABLED", variable: "AIRBNB_GOOGLE_SETUP_ENABLED", needs: ["HOST_CONSOLE", "DATABASE"] },
  { env: "EXPERIENCE_AIRBNB_GOOGLE_ACTIVATION_ENABLED", variable: "AIRBNB_GOOGLE_ACTIVATION_ENABLED", needs: ["EXPERIENCE_AIRBNB_GOOGLE_SETUP_ENABLED"] },
  { env: "EXPERIENCE_AIRBNB_GOOGLE_DELIVERY_ENABLED", variable: "AIRBNB_GOOGLE_DELIVERY_ENABLED", needs: ["EXPERIENCE_CHANNEL_RUNTIME_ENABLED"] },
  { env: "EXPERIENCE_AIRBNB_GOOGLE_OBSERVATION_ENABLED", variable: "AIRBNB_GOOGLE_OBSERVATION_ENABLED", needs: ["EXPERIENCE_AIRBNB_GOOGLE_DELIVERY_ENABLED"] },
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
  const flagId = (flag) => flag.id ?? flag.env;
  const on = new Set();
  for (const flag of FLAGS) {
    const raw = value(flag.variable);
    if (raw === "") {
      if (flag.defaults?.[target]) on.add(flagId(flag));
    } else if (raw === "true") on.add(flagId(flag));
    else if (raw !== "false") problems.push(`${name(flag.variable)} must be true, false or unset`);
  }
  const has = (need) => need.split("|").some((one) => (CAPABILITIES.includes(one) ? hostConsole === true : on.has(one)));
  for (const flag of FLAGS) {
    if (!on.has(flagId(flag))) continue;
    for (const conflict of flag.conflicts ?? []) {
      if (!on.has(conflict)) continue;
      const other = FLAGS.find((candidate) => flagId(candidate) === conflict);
      problems.push(`${flagId(flag)} (${name(flag.variable)}) conflicts with ${other ? flagId(other) : conflict}${other ? ` (${name(other.variable)})` : ""}`);
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
    if (!on.has(flagId(flag))) continue;
    const by = `${flagId(flag)} (${name(flag.variable)})`;
    for (const need of flag.needs ?? []) {
      if (!has(need)) {
        const words = need.split("|").map((one) => (one === "HOST_CONSOLE" || one === "DATABASE" ? (target === "prod" ? "enable_host_calendar=true" : "the host console") : one)).join(" or ");
        problems.push(`${by} needs ${words}`);
      }
    }
    env[flag.env] = flag.value ?? "true";
    for (const secret of flag.secrets ?? []) {
      const ref = value(secret.variable);
      if (ref === "" && secret.optional) continue;
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
  if (secrets.EXPERIENCE_STRIPE_PLATFORM_WEBHOOK_SECRET
    && secrets.EXPERIENCE_STRIPE_PLATFORM_WEBHOOK_SECRET === secrets.EXPERIENCE_STRIPE_WEBHOOK_SECRET) {
    problems.push(`${name("STRIPE_PLATFORM_WEBHOOK_SECRET_REF")} must differ from ${name("STRIPE_WEBHOOK_SECRET_REF")}`);
  }
  return { problems: [...new Set(problems)], on: FLAGS.map(flagId).filter((id) => on.has(id)), env, secrets, names: tableNames() };
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
