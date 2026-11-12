import { parseChannelAdapters } from "./experience/channel-adapters";

type Env = Record<string, string | undefined>;

/**
 * Development-only key for the host console cookies in mock mode. Never accepted
 * in http mode: deployments pass HOST_SESSION_SECRET from Secret Manager.
 */
export const DEV_ONLY_HOST_SESSION_SECRET = "dev-only/niho-experience/host-session/not-a-secret-never-deploy";

/**
 * Mock previews only (#177 P2): a browser needs an application server key to subscribe, and the mock
 * never sends, so the private half was discarded when this was generated. Never accepted in http mode.
 */
export const DEV_ONLY_HOST_PUSH_VAPID_PUBLIC_KEY = "BJWY_HMlymTEFRF78WYjPHnZOQxGNtNWqszkz8y3srKGLBuKF8KQhyce8tx2APhY6Ps4WT1EPAQIGyydJ7L0O8M";
/** base64url without padding: an uncompressed P-256 point (65 octets) and its 32-octet private scalar. */
const VAPID_PUBLIC_KEY = /^B[A-Za-z0-9_-]{86}$/;
const VAPID_PRIVATE_KEY = /^[A-Za-z0-9_-]{43}$/;

/** A Google service account that calls an internal route with its ID token. */
const SERVICE_ACCOUNT_EMAIL = /^[a-z0-9][a-z0-9-]*@[a-z0-9][a-z0-9-]*\.iam\.gserviceaccount\.com$/;

const MIN_HOST_SESSION_SECRET_LENGTH = 32;
const MIN_ADMIN_SESSION_SECRET_LENGTH = 32;

function deploymentOrigin(value: string, setting: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${setting} must be an absolute origin`);
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error(`${setting} must contain only an origin`);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error(`${setting} must use HTTPS, except loopback HTTP in development`);
  return url.origin;
}

/** POSIX (`/srv/…`) or Windows (`C:\…`) absolute path. node:path is not imported: this module stays runtime-neutral. */
const isAbsolutePath = (value: string) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);

/**
 * The guide drafts folder (docs/content/guides.md): mock previews only, so http deployments never read it. A relative
 * path would depend on the server's working directory, so it stops the server at start-up like other invalid settings.
 */
function guideDraftsSetting(apiMode: "mock" | "http", value: string | undefined): string | null {
  const dir = value?.trim() ?? "";
  if (apiMode !== "mock" || !dir) return null;
  if (!isAbsolutePath(dir)) throw new Error("GUIDE_DRAFTS_DIR must be an absolute path");
  return dir;
}

const isLoopbackHost = (hostname: string) => hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

function guidePublicSourceSetting(apiMode: "mock" | "http", env: Env): "static" | "database" {
  if (apiMode !== "http" || env.EXPERIENCE_GUIDE_PUBLIC_SOURCE !== "database") return "static";
  if (!env.EXPERIENCE_DATABASE_URL?.trim()) {
    throw new Error("EXPERIENCE_GUIDE_PUBLIC_SOURCE=database needs EXPERIENCE_DATABASE_URL in http mode");
  }
  if (!env.GUIDE_MEDIA_BUCKET?.trim()) {
    throw new Error("EXPERIENCE_GUIDE_PUBLIC_SOURCE=database needs GUIDE_MEDIA_BUCKET in http mode");
  }
  return "database";
}

function guideAdminSettings(apiMode: "mock" | "http", env: Env): {
  enabled: boolean;
  audience: string;
  serviceAccountEmail: string;
} {
  if (apiMode !== "http" || env.GUIDE_ADMIN_API_ENABLED !== "true") {
    return { enabled: false, audience: "", serviceAccountEmail: "" };
  }
  const audience = env.GUIDE_ADMIN_AUDIENCE?.trim() ?? "";
  const serviceAccountEmail = env.GUIDE_ADMIN_SERVICE_ACCOUNT_EMAIL?.trim() ?? "";
  if (!audience) throw new Error("GUIDE_ADMIN_API_ENABLED=true needs GUIDE_ADMIN_AUDIENCE in http mode");
  if (!SERVICE_ACCOUNT_EMAIL.test(serviceAccountEmail)) {
    throw new Error("GUIDE_ADMIN_API_ENABLED=true needs GUIDE_ADMIN_SERVICE_ACCOUNT_EMAIL in http mode");
  }
  if (!env.EXPERIENCE_DATABASE_URL?.trim()) {
    throw new Error("GUIDE_ADMIN_API_ENABLED=true needs EXPERIENCE_DATABASE_URL in http mode");
  }
  return { enabled: true, audience, serviceAccountEmail };
}

function serviceAccountAllowlist(value: string | undefined, setting: string): readonly string[] {
  const entries = [...new Set((value ?? "").split(/[,;]/).map((item) => item.trim()).filter(Boolean))];
  if (!entries.length || entries.some((entry) => !SERVICE_ACCOUNT_EMAIL.test(entry))) {
    throw new Error(`${setting} must list service account emails`);
  }
  return entries;
}

function articleAuthoritySettings(apiMode: "mock" | "http", env: Env) {
  const enabled = apiMode === "http" && env.EXPERIENCE_ARTICLE_AUTHORITY_API_ENABLED === "true";
  const hostLinksEnabled = apiMode === "http" && env.EXPERIENCE_HOST_ARTICLE_LINKS_ENABLED === "true";
  if (!enabled && !hostLinksEnabled) {
    return { enabled: false, audience: "", serviceAccountEmails: [] as readonly string[], nihoOrigin: "", nihoAudience: "", nihoLinksAudience: "", hostLinksEnabled: false };
  }
  const nihoOrigin = deploymentOrigin(env.NIHO_ARTICLE_AUTHORITY_ORIGIN?.trim() ?? "", "NIHO_ARTICLE_AUTHORITY_ORIGIN");
  const nihoAudience = enabled ? env.NIHO_ARTICLE_AUTHORITY_AUDIENCE?.trim() ?? "" : "";
  const nihoLinksAudience = hostLinksEnabled ? env.NIHO_ARTICLE_LINKS_AUDIENCE?.trim() ?? "" : "";
  if (enabled && !nihoAudience) throw new Error("article authority needs NIHO_ARTICLE_AUTHORITY_AUDIENCE in http mode");
  if (hostLinksEnabled && !nihoLinksAudience) throw new Error("host article links need NIHO_ARTICLE_LINKS_AUDIENCE in http mode");
  if (hostLinksEnabled && env.HOST_CONSOLE_ENABLED !== "true") {
    throw new Error("EXPERIENCE_HOST_ARTICLE_LINKS_ENABLED=true needs HOST_CONSOLE_ENABLED=true in http mode");
  }
  if (!enabled) {
    return { enabled: false, audience: "", serviceAccountEmails: [] as readonly string[], nihoOrigin, nihoAudience, nihoLinksAudience, hostLinksEnabled };
  }
  if (!env.EXPERIENCE_DATABASE_URL?.trim()) throw new Error("EXPERIENCE_ARTICLE_AUTHORITY_API_ENABLED=true needs EXPERIENCE_DATABASE_URL");
  const audience = env.EXPERIENCE_ARTICLE_AUTHORITY_AUDIENCE?.trim() ?? "";
  if (!audience) throw new Error("EXPERIENCE_ARTICLE_AUTHORITY_API_ENABLED=true needs EXPERIENCE_ARTICLE_AUTHORITY_AUDIENCE");
  return {
    enabled,
    audience,
    serviceAccountEmails: serviceAccountAllowlist(env.EXPERIENCE_ARTICLE_AUTHORITY_SERVICE_ACCOUNT_EMAILS, "EXPERIENCE_ARTICLE_AUTHORITY_SERVICE_ACCOUNT_EMAILS"),
    nihoOrigin,
    nihoAudience,
    nihoLinksAudience,
    hostLinksEnabled,
  };
}

/**
 * The host push job's trigger (#177 P2, POST /internal/host-push/v1/drain): Cloud Scheduler calls it
 * with a Google ID token of its own service account. On only in http mode with push on and both set;
 * half a setting, a malformed account or no experience DB stops the start-up.
 */
function hostPushJobSettings(apiMode: "mock" | "http", hostPushEnabled: boolean, env: Env): {
  enabled: boolean;
  audience: string;
  serviceAccountEmail: string;
} {
  const audience = env.HOST_PUSH_JOB_AUDIENCE?.trim() ?? "";
  const serviceAccountEmail = env.HOST_PUSH_JOB_SERVICE_ACCOUNT_EMAIL?.trim() ?? "";
  if (apiMode !== "http" || !hostPushEnabled || (!audience && !serviceAccountEmail)) {
    return { enabled: false, audience: "", serviceAccountEmail: "" };
  }
  if (!audience) throw new Error("HOST_PUSH_JOB_SERVICE_ACCOUNT_EMAIL needs HOST_PUSH_JOB_AUDIENCE in http mode");
  if (!SERVICE_ACCOUNT_EMAIL.test(serviceAccountEmail)) {
    throw new Error("HOST_PUSH_JOB_AUDIENCE needs HOST_PUSH_JOB_SERVICE_ACCOUNT_EMAIL (a service account) in http mode");
  }
  if (!env.EXPERIENCE_DATABASE_URL?.trim()) {
    throw new Error("HOST_PUSH_JOB_AUDIENCE needs EXPERIENCE_DATABASE_URL in http mode");
  }
  return { enabled: true, audience, serviceAccountEmail };
}

/**
 * The Google calendar jobs (#238): Cloud Scheduler re-checks the providers' and resources' busy calendars
 * (POST /internal/google-calendar/v1/busy-sync) and writes confirmed bookings to each provider's booking calendar
 * (POST /internal/google-calendar/v1/booking-events) with a Google ID token of its own service account. Each job is
 * on only in http mode with its flag; either needs both identity settings, the experience DB and the Google OAuth
 * client and token key, or the start-up stops.
 */
function googleCalendarJobSettings(apiMode: "mock" | "http", env: Env): {
  busySyncEnabled: boolean;
  bookingEventsEnabled: boolean;
  audience: string;
  serviceAccountEmail: string;
} {
  const busySyncEnabled = apiMode === "http" && env.EXPERIENCE_GOOGLE_BUSY_SYNC_ENABLED === "true";
  const bookingEventsEnabled = apiMode === "http" && env.EXPERIENCE_GOOGLE_BOOKING_EVENTS_ENABLED === "true";
  if (!busySyncEnabled && !bookingEventsEnabled) return { busySyncEnabled, bookingEventsEnabled, audience: "", serviceAccountEmail: "" };
  const name = busySyncEnabled ? "EXPERIENCE_GOOGLE_BUSY_SYNC_ENABLED" : "EXPERIENCE_GOOGLE_BOOKING_EVENTS_ENABLED";
  const audience = env.EXPERIENCE_GOOGLE_JOBS_AUDIENCE?.trim() ?? "";
  const serviceAccountEmail = env.EXPERIENCE_GOOGLE_JOBS_SERVICE_ACCOUNT_EMAIL?.trim() ?? "";
  if (!audience) throw new Error(`${name} needs EXPERIENCE_GOOGLE_JOBS_AUDIENCE in http mode`);
  if (!SERVICE_ACCOUNT_EMAIL.test(serviceAccountEmail)) {
    throw new Error(`${name} needs EXPERIENCE_GOOGLE_JOBS_SERVICE_ACCOUNT_EMAIL (a service account) in http mode`);
  }
  for (const required of ["EXPERIENCE_DATABASE_URL", "EXPERIENCE_GOOGLE_CLIENT_ID", "EXPERIENCE_GOOGLE_CLIENT_SECRET", "EXPERIENCE_GOOGLE_TOKEN_KEY"]) {
    if (!env[required]?.trim()) throw new Error(`${name} needs ${required} in http mode`);
  }
  return { busySyncEnabled, bookingEventsEnabled, audience, serviceAccountEmail };
}

/**
 * この口座への入金 on 売上 (#91): the balance and payouts of the Stripe accounts the OWNER's sales here go to, read from
 * Stripe with the platform key (GETs only). HTTP only, and only under this site's ledger. Turned on without the ledger
 * or the key, the server stops at start-up (the message names the setting, never its value). The key is a secret read
 * where it is used, so it is not kept here.
 */
function hostSalesPayoutsSetting(apiMode: "mock" | "http", env: Env, hostSalesLedgerEnabled: boolean): boolean {
  if (apiMode !== "http" || env.HOST_SALES_PAYOUTS_ENABLED !== "true") return false;
  if (!hostSalesLedgerEnabled) throw new Error("HOST_SALES_PAYOUTS_ENABLED=true needs HOST_SALES_LEDGER_ENABLED=true (and HOST_CONSOLE_ENABLED=true) in http mode");
  if (!env.EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY?.trim()) throw new Error("HOST_SALES_PAYOUTS_ENABLED=true needs EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY in http mode");
  return true;
}

/**
 * 予約者の情報つきの OTA の予約 (#194, owner decision 2026-11-01): keep the guest details an OTA reader sends with a
 * reservation, and tell the product's OWNER and operators of new, cancelled and moved ones by push. HTTP only, both off
 * by default. The details are kept only where the mail job erases them after a year (EXPERIENCE_GUEST_MAIL_ENABLED);
 * the pushes only where the push job sends them and removes the guest's name (HOST_PUSH_ENABLED). Turned on without
 * those, the server stops at start-up. Neither opens an OTA read: that stays with the channel runtime's own gates.
 */
function otaBookingSettings(apiMode: "mock" | "http", env: Env, guestMailEnabled: boolean, hostPushEnabled: boolean): { guestDetails: boolean; notifications: boolean } {
  const guestDetails = apiMode === "http" && env.EXPERIENCE_OTA_GUEST_DETAILS_ENABLED === "true";
  const notifications = apiMode === "http" && env.EXPERIENCE_OTA_BOOKING_NOTIFICATIONS_ENABLED === "true";
  if (guestDetails && !guestMailEnabled) throw new Error("EXPERIENCE_OTA_GUEST_DETAILS_ENABLED=true needs EXPERIENCE_GUEST_MAIL_ENABLED=true (the job that erases them) in http mode");
  if (notifications && !hostPushEnabled) throw new Error("EXPERIENCE_OTA_BOOKING_NOTIFICATIONS_ENABLED=true needs HOST_PUSH_ENABLED=true in http mode");
  return { guestDetails, notifications };
}

/**
 * ホストへのメール (#194, owner decision 2026-11-01): copy the NIHO account's verified address when a host signs in to /host,
 * let the host choose another one in 設定 › 通知 (it takes effect once the emailed link is opened), and email new, cancelled
 * and moved bookings (this site's and OTA ones) to the people the push goes to. HTTP only, off by default. The emails go out
 * through the mail job (EXPERIENCE_GUEST_MAIL_ENABLED), and the people sign in through the host console: turned on without
 * them, the server stops at start-up.
 */
function hostMailSetting(apiMode: "mock" | "http", env: Env, hostConsoleEnabled: boolean, guestMailEnabled: boolean): boolean {
  if (apiMode !== "http" || env.EXPERIENCE_HOST_MAIL_ENABLED !== "true") return false;
  if (!hostConsoleEnabled) throw new Error("EXPERIENCE_HOST_MAIL_ENABLED=true needs HOST_CONSOLE_ENABLED=true in http mode");
  if (!guestMailEnabled) throw new Error("EXPERIENCE_HOST_MAIL_ENABLED=true needs EXPERIENCE_GUEST_MAIL_ENABLED=true (the mail job) in http mode");
  return true;
}

/**
 * The flags whose code sends the signed-in host's NIHO access token to NIHO. With Experience host accounts there is no
 * such token (ADR 0003), so none of them may be on at the same time. The host publication API is not here: for an
 * Experience session it reads Stripe and the experience DB instead of NIHO (publication-host-boundary.ts, slice 3).
 */
export const NIHO_HOST_TOKEN_FLAGS = Object.freeze([
  "EXPERIENCE_PROVIDER_OPERATIONS_API_ENABLED",
  "EXPERIENCE_PROVIDER_PAGES_API_ENABLED",
  "EXPERIENCE_TRANSLATE_API_ENABLED",
  "HOST_SUPPORT_SETTINGS_API_ENABLED",
  "HOST_SUPPORT_HISTORY_API_ENABLED",
  "EXPERIENCE_FEE_SUMMARY_API_ENABLED",
  "EXPERIENCE_HOST_ARTICLE_LINKS_ENABLED",
] as const);

/**
 * ホストのアカウント (ADR 0003 slice 2, docs/host-accounts.md): /host signs hosts in with Experience's own accounts (a
 * single-use link emailed to them) and reads their providers from the experience DB, with no call to NIHO for identity.
 * HTTP only, off by default (the NIHO login is unchanged while off). The links go out through the mail job
 * (EXPERIENCE_GUEST_MAIL_ENABLED) and the accounts live in the experience DB: turned on without them, or together with a
 * flag that sends a NIHO host access token (NIHO_HOST_TOKEN_FLAGS), the server stops at start-up.
 */
function hostAccountsSetting(apiMode: "mock" | "http", env: Env, hostConsoleEnabled: boolean, guestMailEnabled: boolean): boolean {
  if (apiMode !== "http" || env.EXPERIENCE_HOST_ACCOUNTS_ENABLED !== "true") return false;
  if (!hostConsoleEnabled) throw new Error("EXPERIENCE_HOST_ACCOUNTS_ENABLED=true needs HOST_CONSOLE_ENABLED=true in http mode");
  if (!env.EXPERIENCE_DATABASE_URL?.trim()) throw new Error("EXPERIENCE_HOST_ACCOUNTS_ENABLED=true needs EXPERIENCE_DATABASE_URL in http mode");
  if (!guestMailEnabled) throw new Error("EXPERIENCE_HOST_ACCOUNTS_ENABLED=true needs EXPERIENCE_GUEST_MAIL_ENABLED=true (the mail job sends the sign-in links) in http mode");
  for (const name of NIHO_HOST_TOKEN_FLAGS) {
    if (env[name] === "true") throw new Error(`EXPERIENCE_HOST_ACCOUNTS_ENABLED=true cannot be on with ${name}=true (it sends a NIHO host access token to NIHO)`);
  }
  return true;
}

/** Native Experience teams require every native identity boundary; the legacy provider-operations flag is unrelated. */
function hostTeamSetting(apiMode: "mock" | "http", env: Env, hostConsoleEnabled: boolean, hostAccountsEnabled: boolean): boolean {
  const name = "EXPERIENCE_HOST_TEAM_ENABLED";
  if (apiMode !== "http" || env[name] !== "true") return false;
  if (!hostConsoleEnabled) throw new Error(`${name}=true needs HOST_CONSOLE_ENABLED=true in http mode`);
  if (!hostAccountsEnabled) throw new Error(`${name}=true needs EXPERIENCE_HOST_ACCOUNTS_ENABLED=true in http mode`);
  if (!env.EXPERIENCE_DATABASE_URL?.trim()) throw new Error(`${name}=true needs EXPERIENCE_DATABASE_URL in http mode`);
  return true;
}

/**
 * The flags whose code sends the signed-in admin's NIHO admin token (NIHO's Admin session) to NIHO. With the Google
 * login (ADR 0003 decision 4) there is no such token, so none of them may be on at the same time. The fee summary is
 * here for its Admin side (it is one gate for Admin and /host).
 */
export const NIHO_ADMIN_TOKEN_FLAGS = Object.freeze([
  "ADMIN_SUPPORT_READ_API_ENABLED",
  "ADMIN_SUPPORT_CASE_API_ENABLED",
  "ADMIN_OPERATIONS_API_ENABLED",
  "EXPERIENCE_ASSISTED_LAUNCH_API_ENABLED",
  "EXPERIENCE_FEE_SUMMARY_API_ENABLED",
] as const);

/** The Google Workspace domain whose accounts may sign in to /admin (the `hd` claim and every allowlisted address). */
export const ADMIN_GOOGLE_HOSTED_DOMAIN = "niho.life";

const ADMIN_ALLOWED_EMAIL = /^[a-z0-9._%+-]{1,64}@niho\.life$/;

/**
 * EXPERIENCE_ADMIN_ALLOWED_EMAILS: one or more addresses separated by semicolons, each in @niho.life (trimmed, compared
 * in lower case). null for an empty list, an empty entry or any other address. Its values are never logged.
 */
export function parseAdminAllowedEmails(value: string | undefined): readonly string[] | null {
  const entries = (value ?? "").split(";").map((entry) => entry.trim().toLowerCase());
  if (entries.some((entry) => !ADMIN_ALLOWED_EMAIL.test(entry))) return null;
  return Object.freeze([...new Set(entries)]);
}

/**
 * Admin のログイン (ADR 0003 decision 4, docs/admin-auth.md): /admin signs staff in with Google (a niho.life Workspace
 * account) and authorizes them from EXPERIENCE_ADMIN_ALLOWED_EMAILS, with server-side sessions in the experience DB and
 * no call to NIHO. HTTP only, off by default (the NIHO admin login is unchanged while off). It uses the Google OAuth
 * client the host console already has. Turned on without the Admin console, the experience DB, that client or a valid
 * allowlist, or together with a flag that sends a NIHO admin token (NIHO_ADMIN_TOKEN_FLAGS), the server stops at start-up.
 */
function adminGoogleLoginSettings(apiMode: "mock" | "http", env: Env, adminSupportConsoleEnabled: boolean): { enabled: boolean; allowedEmails: readonly string[] } {
  const name = "EXPERIENCE_ADMIN_GOOGLE_LOGIN_ENABLED";
  if (apiMode !== "http" || env[name] !== "true") return { enabled: false, allowedEmails: Object.freeze([]) };
  if (!adminSupportConsoleEnabled) throw new Error(`${name}=true needs ADMIN_SUPPORT_CONSOLE_ENABLED=true in http mode`);
  requireSettings(name, env, ["EXPERIENCE_DATABASE_URL", "EXPERIENCE_GOOGLE_CLIENT_ID", "EXPERIENCE_GOOGLE_CLIENT_SECRET"]);
  const allowedEmails = parseAdminAllowedEmails(env.EXPERIENCE_ADMIN_ALLOWED_EMAILS);
  if (!allowedEmails) {
    throw new Error(`${name}=true needs EXPERIENCE_ADMIN_ALLOWED_EMAILS (one or more @${ADMIN_GOOGLE_HOSTED_DOMAIN} addresses separated by semicolons) in http mode`);
  }
  for (const flag of NIHO_ADMIN_TOKEN_FLAGS) {
    if (env[flag] === "true") throw new Error(`${name}=true cannot be on with ${flag}=true (it sends a NIHO admin token to NIHO)`);
  }
  return { enabled: true, allowedEmails };
}

/*
 * OTA の枠管理 (docs/ota-runtime.md, docs/ota-google-channel-flow.md). These settings are the start-up gate and the deploy
 * table's counterpart (scripts/deploy/runtime-flags.mjs): a flag turned on without what it needs stops the server, naming
 * the setting, never its value. The routes and jobs still read process.env where they are used (channel-runtime.ts,
 * resource-google.ts, google-channel-*.ts), so these do not change what is served. HTTP only, all off by default.
 */

const GOOGLE_OAUTH_SETTINGS = ["EXPERIENCE_GOOGLE_CLIENT_ID", "EXPERIENCE_GOOGLE_CLIENT_SECRET", "EXPERIENCE_GOOGLE_TOKEN_KEY"] as const;

function requireSettings(name: string, env: Env, required: readonly string[]): void {
  for (const setting of required) {
    if (!env[setting]?.trim()) throw new Error(`${name}=true needs ${setting} in http mode`);
  }
}

function isHttpsOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
}

/** The public endpoint Google calls for watched calendars: https, not loopback, at /api/google/calendar/watch. */
function isGoogleWatchWebhookUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && !isLoopbackHost(url.hostname) && !url.username && !url.password && !url.search && !url.hash
    && url.pathname === "/api/google/calendar/watch";
}

/**
 * The OTA runtime watchdog (POST /internal/ota/v1/watchdog): Cloud Scheduler calls it with a Google ID token of its own
 * service account, so both identity settings are required; it reads the experience DB under the host console's deploy.
 */
function channelWatchdogSetting(apiMode: "mock" | "http", env: Env, hostConsoleEnabled: boolean): boolean {
  const name = "EXPERIENCE_CHANNEL_WATCHDOG_ENABLED";
  if (apiMode !== "http" || env[name] !== "true") return false;
  if (!hostConsoleEnabled) throw new Error(`${name}=true needs HOST_CONSOLE_ENABLED=true in http mode`);
  requireSettings(name, env, ["EXPERIENCE_DATABASE_URL"]);
  if (!isHttpsOrigin(env.EXPERIENCE_CHANNEL_WATCHDOG_AUDIENCE?.trim() ?? "")) {
    throw new Error(`${name}=true needs EXPERIENCE_CHANNEL_WATCHDOG_AUDIENCE (an https origin) in http mode`);
  }
  if (!SERVICE_ACCOUNT_EMAIL.test(env.EXPERIENCE_CHANNEL_WATCHDOG_SERVICE_ACCOUNT_EMAIL?.trim() ?? "")) {
    throw new Error(`${name}=true needs EXPERIENCE_CHANNEL_WATCHDOG_SERVICE_ACCOUNT_EMAIL (a service account) in http mode`);
  }
  return true;
}

/** The Admin channel manager API (掲載先の設定): behind a fresh Admin session, on the experience DB. */
function channelManagerSetting(apiMode: "mock" | "http", env: Env, adminSupportConsoleEnabled: boolean): boolean {
  const name = "EXPERIENCE_CHANNEL_MANAGER_ENABLED";
  if (apiMode !== "http" || env[name] !== "true") return false;
  if (!adminSupportConsoleEnabled) throw new Error(`${name}=true needs ADMIN_SUPPORT_CONSOLE_ENABLED=true in http mode`);
  requireSettings(name, env, ["EXPERIENCE_DATABASE_URL"]);
  return true;
}

/**
 * The worker API (claim, preflight, result): only with the manager that configures listings, the watchdog that recovers
 * stuck jobs, and a valid allowlist of at least one adapter (an empty or malformed one would claim nothing).
 */
function channelRuntimeSetting(apiMode: "mock" | "http", env: Env, channelManagerEnabled: boolean, channelWatchdogEnabled: boolean): boolean {
  const name = "EXPERIENCE_CHANNEL_RUNTIME_ENABLED";
  if (apiMode !== "http" || env[name] !== "true") return false;
  if (!channelManagerEnabled) throw new Error(`${name}=true needs EXPERIENCE_CHANNEL_MANAGER_ENABLED=true in http mode`);
  if (!channelWatchdogEnabled) throw new Error(`${name}=true needs EXPERIENCE_CHANNEL_WATCHDOG_ENABLED=true in http mode`);
  requireSettings(name, env, ["EXPERIENCE_DATABASE_URL"]);
  const adapters = parseChannelAdapters(env.EXPERIENCE_CHANNEL_SUPPORTED_ADAPTERS);
  if (!adapters || Object.keys(adapters).length === 0) {
    throw new Error(`${name}=true needs EXPERIENCE_CHANNEL_SUPPORTED_ADAPTERS (a valid allowlist of at least one adapter) in http mode`);
  }
  return true;
}

/** Per-resource Google busy input (#238), and its push notifications from Google to the public webhook. */
function resourceGoogleSettings(apiMode: "mock" | "http", env: Env, hostConsoleEnabled: boolean): { enabled: boolean; watchEnabled: boolean } {
  const name = "EXPERIENCE_RESOURCE_GOOGLE_ENABLED";
  const watchName = "EXPERIENCE_RESOURCE_GOOGLE_WATCH_ENABLED";
  const enabled = apiMode === "http" && env[name] === "true";
  const watchEnabled = apiMode === "http" && env[watchName] === "true";
  if (enabled) {
    if (!hostConsoleEnabled) throw new Error(`${name}=true needs HOST_CONSOLE_ENABLED=true in http mode`);
    requireSettings(name, env, ["EXPERIENCE_DATABASE_URL", ...GOOGLE_OAUTH_SETTINGS]);
  }
  if (watchEnabled) {
    if (!enabled) throw new Error(`${watchName}=true needs ${name}=true in http mode`);
    if (!isGoogleWatchWebhookUrl(env.EXPERIENCE_RESOURCE_GOOGLE_WEBHOOK_URL?.trim() ?? "")) {
      throw new Error(`${watchName}=true needs EXPERIENCE_RESOURCE_GOOGLE_WEBHOOK_URL (the public https /api/google/calendar/watch) in http mode`);
    }
  }
  return { enabled, watchEnabled };
}

/**
 * Airbnb availability through an app-created Google output calendar (#270): the OWNER's setup and activation of a binding,
 * and the channel runtime's delivery to it and the observation paired with that delivery.
 */
function airbnbGoogleSettings(apiMode: "mock" | "http", env: Env, hostConsoleEnabled: boolean, channelRuntimeEnabled: boolean): {
  setupEnabled: boolean;
  activationEnabled: boolean;
  deliveryEnabled: boolean;
  observationEnabled: boolean;
} {
  const on = (name: string) => apiMode === "http" && env[name] === "true";
  const setupEnabled = on("EXPERIENCE_AIRBNB_GOOGLE_SETUP_ENABLED");
  const activationEnabled = on("EXPERIENCE_AIRBNB_GOOGLE_ACTIVATION_ENABLED");
  const deliveryEnabled = on("EXPERIENCE_AIRBNB_GOOGLE_DELIVERY_ENABLED");
  const observationEnabled = on("EXPERIENCE_AIRBNB_GOOGLE_OBSERVATION_ENABLED");
  if (setupEnabled) {
    if (!hostConsoleEnabled) throw new Error("EXPERIENCE_AIRBNB_GOOGLE_SETUP_ENABLED=true needs HOST_CONSOLE_ENABLED=true in http mode");
    requireSettings("EXPERIENCE_AIRBNB_GOOGLE_SETUP_ENABLED", env, ["EXPERIENCE_DATABASE_URL", ...GOOGLE_OAUTH_SETTINGS]);
  }
  if (activationEnabled && !setupEnabled) {
    throw new Error("EXPERIENCE_AIRBNB_GOOGLE_ACTIVATION_ENABLED=true needs EXPERIENCE_AIRBNB_GOOGLE_SETUP_ENABLED=true in http mode");
  }
  if (deliveryEnabled && !channelRuntimeEnabled) {
    throw new Error("EXPERIENCE_AIRBNB_GOOGLE_DELIVERY_ENABLED=true needs EXPERIENCE_CHANNEL_RUNTIME_ENABLED=true in http mode");
  }
  if (observationEnabled && !deliveryEnabled) {
    throw new Error("EXPERIENCE_AIRBNB_GOOGLE_OBSERVATION_ENABLED=true needs EXPERIENCE_AIRBNB_GOOGLE_DELIVERY_ENABLED=true in http mode");
  }
  return { setupEnabled, activationEnabled, deliveryEnabled, observationEnabled };
}

/** The terms version a traveler agrees to (consent.agreedVersion, 1-100 characters): printable ASCII without spaces. */
const BOOKING_CONSENT_VERSION = /^[\x21-\x7E]{1,100}$/;

/**
 * 旅行者の予約 on this site (#285, docs/guest-booking.md): availability and checkout from the experience DB with
 * Stripe Checkout on the provider's account. HTTP only. Turned on without everything a sale needs, the server
 * stops at start-up instead of taking bookings it cannot charge or confirm. That includes the host console:
 * the host sees these bookings only in its 予約 (#285 slice 8), and a sale the host cannot see is not taken.
 * Error messages never echo values.
 */
function guestBookingSettings(apiMode: "mock" | "http", env: Env, hostConsoleEnabled: boolean): { enabled: boolean; consentVersion: string } {
  if (apiMode !== "http" || env.EXPERIENCE_GUEST_BOOKING_ENABLED !== "true") return { enabled: false, consentVersion: "" };
  if (!hostConsoleEnabled) throw new Error("EXPERIENCE_GUEST_BOOKING_ENABLED=true needs HOST_CONSOLE_ENABLED=true in http mode");
  for (const name of ["EXPERIENCE_DATABASE_URL", "EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY", "EXPERIENCE_STRIPE_WEBHOOK_SECRET", "EXPERIENCE_CHECKOUT_IP_HMAC_KEY"]) {
    if (!env[name]?.trim()) throw new Error(`EXPERIENCE_GUEST_BOOKING_ENABLED=true needs ${name} in http mode`);
  }
  if (Buffer.byteLength(env.EXPERIENCE_CHECKOUT_IP_HMAC_KEY!.trim(), "utf8") < 32) {
    throw new Error("EXPERIENCE_CHECKOUT_IP_HMAC_KEY must be at least 32 bytes in http mode");
  }
  const consentVersion = env.EXPERIENCE_BOOKING_CONSENT_VERSION?.trim() ?? "";
  if (!BOOKING_CONSENT_VERSION.test(consentVersion)) {
    throw new Error("EXPERIENCE_GUEST_BOOKING_ENABLED=true needs EXPERIENCE_BOOKING_CONSENT_VERSION (1-100 printable characters, no spaces) in http mode");
  }
  // Stripe returns the guest to this origin, which must be https (loopback http in development).
  let siteOrigin: string;
  try {
    siteOrigin = new URL(env.SITE_URL ?? "http://localhost:3000").origin;
  } catch {
    throw new Error("SITE_URL must be an absolute URL");
  }
  deploymentOrigin(siteOrigin, "SITE_URL (for EXPERIENCE_GUEST_BOOKING_ENABLED)");
  return { enabled: true, consentVersion };
}

/**
 * 受取口座の利用同意 (ADR 0003 slice 3, docs/host-accounts.md): with Experience host accounts the host publication API
 * reads the payout account from Stripe and the OWNER's consent from the experience DB instead of NIHO, so it needs the
 * consent version the OWNER agrees to (the same shape as the publication consent version) and the Stripe platform key.
 * The NIHO audience is not needed then: no NIHO call is made for the publication API.
 */
function payoutAccountConsentSetting(env: Env, hostAccountsEnabled: boolean, hostApiEnabled: boolean): string {
  const version = env.EXPERIENCE_PAYOUT_ACCOUNT_CONSENT_VERSION?.trim() ?? "";
  if (version.length > 160) throw new Error("EXPERIENCE_PAYOUT_ACCOUNT_CONSENT_VERSION must be at most 160 characters");
  if (!hostAccountsEnabled || !hostApiEnabled) return version;
  if (!version) throw new Error("EXPERIENCE_HOST_ACCOUNTS_ENABLED=true with EXPERIENCE_HOST_PUBLICATION_API_ENABLED=true needs EXPERIENCE_PAYOUT_ACCOUNT_CONSENT_VERSION in http mode");
  if (!env.EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY?.trim()) {
    throw new Error("EXPERIENCE_HOST_ACCOUNTS_ENABLED=true with EXPERIENCE_HOST_PUBLICATION_API_ENABLED=true needs EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY in http mode (payout readiness is read from Stripe)");
  }
  return version;
}

function experiencePublicationSettings(apiMode: "mock" | "http", env: Env, hostConsoleEnabled: boolean, hostAccountsEnabled: boolean) {
  const requested = env.EXPERIENCE_PUBLICATIONS_ENABLED === "true";
  const hostApiRequested = env.EXPERIENCE_HOST_PUBLICATION_API_ENABLED === "true";
  const nihoAudience = env.NIHO_EXPERIENCE_HOST_COMMON_CONTRACT_AUDIENCE?.trim() ?? "";
  const consentVersion = env.EXPERIENCE_PUBLICATION_CONSENT_VERSION?.trim() ?? "";
  const databaseConfigured = Boolean(env.EXPERIENCE_DATABASE_URL?.trim());
  if (requested && apiMode === "http" && !hostConsoleEnabled) {
    throw new Error("EXPERIENCE_PUBLICATIONS_ENABLED=true needs HOST_CONSOLE_ENABLED=true");
  }
  if (requested && apiMode === "http" && !databaseConfigured) {
    throw new Error("EXPERIENCE_PUBLICATIONS_ENABLED=true needs EXPERIENCE_DATABASE_URL");
  }
  if (requested && apiMode === "http" && !consentVersion) {
    throw new Error("EXPERIENCE_PUBLICATIONS_ENABLED=true needs EXPERIENCE_PUBLICATION_CONSENT_VERSION");
  }
  if (requested && apiMode === "http" && !env.EXPERIENCE_PUBLIC_MEDIA_BUCKET?.trim()) {
    throw new Error("EXPERIENCE_PUBLICATIONS_ENABLED=true needs EXPERIENCE_PUBLIC_MEDIA_BUCKET");
  }
  // With Experience host accounts the API reads Stripe and the experience DB, never NIHO (ADR 0003).
  if (requested && hostApiRequested && apiMode === "http" && !nihoAudience && !hostAccountsEnabled) {
    throw new Error("EXPERIENCE_HOST_PUBLICATION_API_ENABLED=true needs NIHO_EXPERIENCE_HOST_COMMON_CONTRACT_AUDIENCE");
  }
  if (nihoAudience) {
    let audienceUrl: URL;
    try { audienceUrl = new URL(nihoAudience); }
    catch { throw new Error("NIHO_EXPERIENCE_HOST_COMMON_CONTRACT_AUDIENCE must be an absolute HTTPS URL"); }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(audienceUrl.hostname);
    if (audienceUrl.username || audienceUrl.password || audienceUrl.search || audienceUrl.hash
      || (audienceUrl.protocol !== "https:" && !(audienceUrl.protocol === "http:" && loopback))) {
      throw new Error("NIHO_EXPERIENCE_HOST_COMMON_CONTRACT_AUDIENCE must be an HTTPS URL without credentials, query or fragment");
    }
  }
  if (consentVersion.length > 160) throw new Error("EXPERIENCE_PUBLICATION_CONSENT_VERSION must be at most 160 characters");
  const hostApiEnabled = apiMode === "http" && hostConsoleEnabled && requested && hostApiRequested && (Boolean(nihoAudience) || hostAccountsEnabled);
  return {
    enabled: apiMode === "http" && hostConsoleEnabled && requested && databaseConfigured && consentVersion.length > 0,
    hostApiEnabled,
    nihoAudience,
    consentVersion,
    payoutAccountConsentVersion: payoutAccountConsentSetting(env, hostAccountsEnabled, hostApiEnabled),
  };
}

/** An email address: one line, no display name. */
const MAIL_ADDRESS = /^[^\s<>@",;]+@[^\s<>@",;]+\.[^\s<>@",;]+$/;
/** An SMTP host name or IPv4 address. */
const SMTP_HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

export interface Mailbox {
  readonly name: string;
  readonly address: string;
}

/** `Display Name <address>` or a bare address, printable and on one line; null for anything else. */
function mailbox(value: string): Mailbox | null {
  if (!value || /[\u0000-\u001F\u007F]/.test(value)) return null;
  const named = /^([^<>"]{1,100}?)\s*<([^<>]+)>$/.exec(value);
  const name = named ? named[1]!.trim() : "";
  const address = named ? named[2]!.trim() : value;
  return MAIL_ADDRESS.test(address) && address.length <= 254 ? { name, address } : null;
}

type GuestMailSettings = Readonly<{
  enabled: boolean;
  smtpHost: string;
  smtpPort: number;
  from: Mailbox | null;
  replyTo: Mailbox | null;
  jobAudience: string;
  jobServiceAccountEmail: string;
  feedbackEnabled: boolean;
  feedbackAudience: string;
  feedbackServiceAccountEmail: string;
}>;

const NO_GUEST_MAIL: GuestMailSettings = { enabled: false, smtpHost: "", smtpPort: 0, from: null, replyTo: null, jobAudience: "", jobServiceAccountEmail: "", feedbackEnabled: false, feedbackAudience: "", feedbackServiceAccountEmail: "" };

/**
 * 予約者へのメール (#285 slice 5, docs/guest-booking.md): the job behind POST /internal/experience-jobs/v1/drain
 * sends host replies and booking confirmations over the shared SMTP credentials NIHO already uses
 * and erases guest data after a year. HTTP only. Turned on without everything it needs, the
 * server stops at start-up; messages name the setting, never its value. The SMTP user and password are
 * secrets read where they are used (lib/mail/transport.ts), like the Stripe keys, so they are not kept here.
 */
function guestMailSettings(apiMode: "mock" | "http", env: Env): GuestMailSettings {
  if (apiMode !== "http" || env.EXPERIENCE_GUEST_MAIL_ENABLED !== "true") return NO_GUEST_MAIL;
  for (const name of ["EXPERIENCE_DATABASE_URL", "EXPERIENCE_SMTP_USER", "EXPERIENCE_SMTP_PASSWORD"]) {
    if (!env[name]?.trim()) throw new Error(`EXPERIENCE_GUEST_MAIL_ENABLED=true needs ${name} in http mode`);
  }
  const smtpHost = env.EXPERIENCE_SMTP_HOST?.trim() ?? "";
  if (!SMTP_HOST.test(smtpHost)) throw new Error("EXPERIENCE_GUEST_MAIL_ENABLED=true needs EXPERIENCE_SMTP_HOST (a host name) in http mode");
  const portText = env.EXPERIENCE_SMTP_PORT?.trim() ?? "";
  const smtpPort = /^[0-9]{1,5}$/.test(portText) ? Number(portText) : 0;
  if (smtpPort < 1 || smtpPort > 65_535) throw new Error("EXPERIENCE_GUEST_MAIL_ENABLED=true needs EXPERIENCE_SMTP_PORT (1-65535) in http mode");
  const from = mailbox(env.EXPERIENCE_MAIL_FROM?.trim() ?? "");
  if (!from) throw new Error("EXPERIENCE_GUEST_MAIL_ENABLED=true needs EXPERIENCE_MAIL_FROM (Name <address> or an address) in http mode");
  const replyTo = mailbox(env.EXPERIENCE_MAIL_REPLY_TO?.trim() ?? "");
  if (!replyTo) throw new Error("EXPERIENCE_GUEST_MAIL_ENABLED=true needs EXPERIENCE_MAIL_REPLY_TO (Name <address> or an address) in http mode");
  const jobAudience = env.EXPERIENCE_JOBS_AUDIENCE?.trim() ?? "";
  const jobServiceAccountEmail = env.EXPERIENCE_JOBS_SERVICE_ACCOUNT_EMAIL?.trim() ?? "";
  if (!jobAudience) throw new Error("EXPERIENCE_GUEST_MAIL_ENABLED=true needs EXPERIENCE_JOBS_AUDIENCE in http mode");
  if (!SERVICE_ACCOUNT_EMAIL.test(jobServiceAccountEmail)) {
    throw new Error("EXPERIENCE_GUEST_MAIL_ENABLED=true needs EXPERIENCE_JOBS_SERVICE_ACCOUNT_EMAIL (a service account) in http mode");
  }
  const feedbackAudience = env.EXPERIENCE_MAIL_FEEDBACK_AUDIENCE?.trim() ?? "";
  const feedbackServiceAccountEmail = env.EXPERIENCE_MAIL_FEEDBACK_SERVICE_ACCOUNT_EMAIL?.trim() ?? "";
  if (Boolean(feedbackAudience) !== Boolean(feedbackServiceAccountEmail)) {
    throw new Error("EXPERIENCE_MAIL_FEEDBACK_AUDIENCE and EXPERIENCE_MAIL_FEEDBACK_SERVICE_ACCOUNT_EMAIL must be set together");
  }
  if (feedbackAudience) {
    let audienceUrl: URL;
    try { audienceUrl = new URL(feedbackAudience); } catch { throw new Error("EXPERIENCE_MAIL_FEEDBACK_AUDIENCE must be an absolute URL"); }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(audienceUrl.hostname);
    if (audienceUrl.username || audienceUrl.password || audienceUrl.hash || (audienceUrl.protocol !== "https:" && !(audienceUrl.protocol === "http:" && loopback))) {
      throw new Error("EXPERIENCE_MAIL_FEEDBACK_AUDIENCE must use HTTPS without credentials or a fragment, except loopback HTTP");
    }
    if (!SERVICE_ACCOUNT_EMAIL.test(feedbackServiceAccountEmail)) {
      throw new Error("EXPERIENCE_MAIL_FEEDBACK_SERVICE_ACCOUNT_EMAIL must be a service account");
    }
  }
  // Links in the emails are absolute: https (loopback http in development).
  let siteOrigin: string;
  try {
    siteOrigin = new URL(env.SITE_URL ?? "http://localhost:3000").origin;
  } catch {
    throw new Error("SITE_URL must be an absolute URL");
  }
  deploymentOrigin(siteOrigin, "SITE_URL (for EXPERIENCE_GUEST_MAIL_ENABLED)");
  return {
    enabled: true, smtpHost, smtpPort, from, replyTo, jobAudience, jobServiceAccountEmail,
    feedbackEnabled: Boolean(feedbackAudience), feedbackAudience, feedbackServiceAccountEmail,
  };
}

/** The octets a padded standard base64 string decodes to; null when it is not one. Without Buffer: this module stays runtime-neutral. */
function base64Octets(value: string): number | null {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  return (value.length / 4) * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
}

/**
 * 設定 › カレンダー's bookings feed (#109): a secret address per provider that Apple, Outlook and the like read this
 * site's confirmed bookings from (/host/calendar/feed/…/bookings.ics). HTTP only, with the host console that issues
 * it. Turned on without the experience DB or the key its addresses are derived from (base64, at least 32 octets),
 * the server stops at start-up; the messages name the settings, never their values. The key is read where it is used
 * (host/calendar-server.ts), so it is not kept here.
 */
function hostCalendarFeedSetting(apiMode: "mock" | "http", env: Env, hostConsoleEnabled: boolean): boolean {
  if (apiMode !== "http" || !hostConsoleEnabled || env.EXPERIENCE_HOST_CALENDAR_FEED_ENABLED !== "true") return false;
  if (!env.EXPERIENCE_DATABASE_URL?.trim()) throw new Error("EXPERIENCE_HOST_CALENDAR_FEED_ENABLED=true needs EXPERIENCE_DATABASE_URL in http mode");
  if ((base64Octets(env.EXPERIENCE_CALENDAR_FEED_KEY?.trim() ?? "") ?? 0) < 32) {
    throw new Error("EXPERIENCE_HOST_CALENDAR_FEED_ENABLED=true needs EXPERIENCE_CALENDAR_FEED_KEY (base64 of at least 32 random bytes) in http mode");
  }
  return true;
}

/**
 * 予約前の質問's translations with the Claude API (#285 slice 5, owner decision 2026-10-31): the mail job
 * translates guests' English for the host, and メッセージ's 英語にする drafts the host's English. HTTP only;
 * turned on without its key, the server stops at start-up (the message names the setting, never its value).
 * The key is a secret read where it is used (lib/translation/anthropic.ts), so it is not kept here.
 */
function translationEnabledSetting(apiMode: "mock" | "http", env: Env): boolean {
  if (apiMode !== "http" || env.EXPERIENCE_TRANSLATION_ENABLED !== "true") return false;
  if (!env.EXPERIENCE_ANTHROPIC_API_KEY?.trim()) throw new Error("EXPERIENCE_TRANSLATION_ENABLED=true needs EXPERIENCE_ANTHROPIC_API_KEY in http mode");
  return true;
}

/**
 * NIHO's privacy policy, linked from the traveler privacy notice at /privacy. Optional: unset (or blank) leaves the link
 * out. A plain https URL only (no credentials), so a typo stops the server at start-up instead of printing a broken link.
 */
function privacyPolicyUrlSetting(value: string | undefined): string {
  const raw = value?.trim() ?? "";
  if (!raw) return "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("EXPERIENCE_PRIVACY_POLICY_URL must be an absolute https URL");
  }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("EXPERIENCE_PRIVACY_POLICY_URL must be an https URL without credentials");
  return url.href;
}

/** Pure so it can be unit-tested; see config.ts for the server instance. */
export function resolveConfig(env: Env) {
  const apiMode = env.EXPERIENCE_API_MODE === "http" ? "http" : "mock";
  // The host console (/host/home and below, #86) stays off unless explicitly enabled.
  const hostConsoleEnabled = env.HOST_CONSOLE_ENABLED === "true";
  // The console as an installable app (#177): manifest, service worker and 設定's この端末. Off by default;
  // turning it off serves a service worker that removes itself.
  const hostPwaEnabled = hostConsoleEnabled && env.HOST_PWA_ENABLED === "true";
  // Web Push to the app (#177 P2), next to email. Its VAPID private key is server-only, like the session key.
  const hostPushEnabled = hostPwaEnabled && env.HOST_PUSH_ENABLED === "true";
  const hostPush = hostPushSettings(apiMode, hostPushEnabled, env);
  const hostPushJob = hostPushJobSettings(apiMode, hostPushEnabled, env);
  // The support console has no NIHO admin contract yet. Its explicit gate is useful only for
  // the synthetic preview; http mode renders a preparation boundary and never accepts a mock role.
  const adminSupportConsoleEnabled = env.ADMIN_SUPPORT_CONSOLE_ENABLED === "true";
  // The selected booking/notification contract is agreed but not deployed. Keep its
  // transport behind a second switch so enabling Admin auth alone still reads no data.
  const adminSupportReadApiEnabled = env.ADMIN_SUPPORT_READ_API_ENABLED === "true";
  // Synthetic UI-only preview. Its BFF remains closed in mock mode; Playwright stubs
  // the browser requests with contract-shaped fixtures. Never accepted in HTTP mode.
  const adminSupportReadPreviewEnabled = apiMode === "mock" && env.ADMIN_SUPPORT_READ_PREVIEW_ENABLED === "true";
  // The assignee/internal-memo API is a separate agreed-not-deployed contract. A real
  // connection requires the read transport as well as this narrower write-capable gate.
  const adminSupportCaseApiEnabled = apiMode === "http" && env.ADMIN_SUPPORT_CASE_API_ENABLED === "true";
  // Synthetic case UI acceptance stays on its own fourth Playwright server. It never
  // opens a mock BFF and is ignored by HTTP deployments.
  const adminSupportCasePreviewEnabled = apiMode === "mock" && env.ADMIN_SUPPORT_CASE_PREVIEW_ENABLED === "true";
  // Immutable Admin commands are independent from case writes and stay closed until the
  // selected operations API is deployed and accepted.
  const adminOperationsApiEnabled = apiMode === "http" && env.ADMIN_OPERATIONS_API_ENABLED === "true";
  const adminOperationsPreviewEnabled = apiMode === "mock" && env.ADMIN_OPERATIONS_PREVIEW_ENABLED === "true";
  // サイト予約 (#121/#128): synthetic /admin/site-bookings for Playwright only. Mock mode only, so an HTTP deployment
  // ignores it; the page renders fixtures and the browser's API calls are stubbed (its BFF stays closed in mock mode).
  const adminSiteBookingsPreviewEnabled = apiMode === "mock" && env.ADMIN_SITE_BOOKINGS_PREVIEW_ENABLED === "true";
  // Host history is read-only, but its selected endpoint is also agreed-not-deployed.
  const hostSupportHistoryApiEnabled = apiMode === "http" && env.HOST_SUPPORT_HISTORY_API_ENABLED === "true";
  // Host本人の支援設定は独立契約。配備・受入まではHTTP BFFを閉じる。
  const hostSupportSettingsApiEnabled = apiMode === "http" && env.HOST_SUPPORT_SETTINGS_API_ENABLED === "true";
  // UI検証専用。mockのBFFや保存は開かず、Playwrightがcontract-shaped responseをstubする。
  const hostSupportSettingsPreviewEnabled = apiMode === "mock" && env.HOST_SUPPORT_SETTINGS_PREVIEW_ENABLED === "true";
  // Booking fee/accounting reads share one rollout gate for Admin and Host. Each BFF
  // still requires its own console and server-side session; preview only opens browser UI.
  const experienceFeeSummaryApiEnabled = apiMode === "http" && env.EXPERIENCE_FEE_SUMMARY_API_ENABLED === "true";
  const experienceFeeSummaryPreviewEnabled = apiMode === "mock" && env.EXPERIENCE_FEE_SUMMARY_PREVIEW_ENABLED === "true";
  // Assisted launch is an independent, agreed-not-deployed API. Preview only exposes
  // the UI for browser-stubbed acceptance; its BFF remains closed in mock mode.
  const experienceAssistedLaunchApiEnabled = apiMode === "http" && env.EXPERIENCE_ASSISTED_LAUNCH_API_ENABLED === "true";
  const experienceAssistedLaunchPreviewEnabled = apiMode === "mock" && env.EXPERIENCE_ASSISTED_LAUNCH_PREVIEW_ENABLED === "true";
  // Provider page authoring has its own rollout so the page editor can be accepted without opening booking operations.
  const experienceProviderPagesApiEnabled = apiMode === "http" && hostConsoleEnabled && env.EXPERIENCE_PROVIDER_PAGES_API_ENABLED === "true";
  // Current provider membership and booking operations are independent from Admin and assisted launch.
  // The real transport opens only after the selected v1 API is deployed and accepted.
  const experienceProviderOperationsApiEnabled = apiMode === "http" && hostConsoleEnabled && env.EXPERIENCE_PROVIDER_OPERATIONS_API_ENABLED === "true";
  const experienceProviderOperationsPreviewEnabled = apiMode === "mock" && hostConsoleEnabled && env.EXPERIENCE_PROVIDER_OPERATIONS_PREVIEW_ENABLED === "true";
  // 設定 › 通知 (#109) kept in the experience DB. The mock keeps the switches on screen; http opens per
  // environment after migration 0020 and the provider's experience OWNER membership are accepted.
  const hostNotificationSettingsEnabled = apiMode === "http" && hostConsoleEnabled && env.HOST_NOTIFICATION_SETTINGS_ENABLED === "true";
  // 売上 (#91) from the experience DB's payment ledger: the OWNER's sales of bookings made on this site. The mock keeps
  // its synthetic ledger; http opens per environment once the ledger's reads are accepted against real bookings.
  const hostSalesLedgerEnabled = apiMode === "http" && hostConsoleEnabled && env.HOST_SALES_LEDGER_ENABLED === "true";
  // この口座への入金 (#91) under that ledger: Stripe's payouts to the OWNER's accounts, which take NIHO's sales too. The
  // mock shows a synthetic one with its synthetic ledger; http opens per environment once read against Stripe's test mode.
  const hostSalesPayoutsEnabled = hostSalesPayoutsSetting(apiMode, env, hostSalesLedgerEnabled);
  // 予約前の質問 (#105/#106) kept in the experience DB (docs/guest-questions.md): the traveler's "Ask the host", the
  // reply page and the OWNER's メッセージ. The mock keeps its own synthetic questions; http opens per environment
  // after migration 0022 is applied and accepted. A question is taken only where the OWNER can read it: the host
  // console is on. Provider membership operations are independent of Experience reservations and questions.
  const guestQuestionsEnabled = apiMode === "http" && hostConsoleEnabled && env.EXPERIENCE_GUEST_QUESTIONS_ENABLED === "true";
  // 予約者のレビュー (#104/#108) and attendance-gated invitations live in the experience DB. Public reads and
  // writes use this flag; invitations also require guest booking, attendance and mail to be enabled. The mock keeps
  // its own synthetic reviews; http opens per environment after migrations 0027 and 0033 are accepted.
  const guestReviewsEnabled = apiMode === "http" && env.EXPERIENCE_GUEST_REVIEWS_ENABLED === "true";
  // 旅行者の予約 (#285) on this site instead of NIHO: availability and checkout from the experience DB. The mock keeps
  // NIHO's contract served by the api-client mock; http opens per environment after migrations 0023/0024 are accepted,
  // and only with the host console that shows the OWNER these bookings.
  const guestBooking = guestBookingSettings(apiMode, env, hostConsoleEnabled);
  // 対面通訳 (#181): Experience予約はExperience DBで所属・状態を検証する。旧NIHO予約経路は使わない。
  // site bookingは別のguest-booking flagが無いと画面・BFFとも閉じたまま。通訳自体は販売flagに依存しない。
  // http opens only after the selected NIHO API is deployed and accepted, per environment.
  const experienceTranslateApiEnabled = apiMode === "http" && hostConsoleEnabled && Boolean(env.EXPERIENCE_DATABASE_URL?.trim()) && env.EXPERIENCE_TRANSLATE_API_ENABLED === "true";
  // 出欠 (#107) of the bookings made on this site, kept in the experience DB (migration 0033), with the capacity of
  // their session on この回. Only where those bookings are (the flag above); the mock records attendance on screen
  // only. http opens per environment after 0033 is applied and accepted.
  const hostAttendanceEnabled = guestBooking.enabled && env.EXPERIENCE_HOST_ATTENDANCE_ENABLED === "true";
  // 予約者へのメール (#285 slice 5): host replies, booking confirmations and the one-year erasure, run by Cloud
  // Scheduler through its own service account. Independent of the two flags above: a payment confirmed after
  // guest booking is turned off still gets its email.
  const guestMail = guestMailSettings(apiMode, env);
  // OTA の予約 (#194): the guest details an OTA reader sends, and the pushes about them; see otaBookingSettings.
  const otaBooking = otaBookingSettings(apiMode, env, guestMail.enabled, hostPushEnabled);
  // ホストへのメール (#194): the sign-in's verified address, the host's own choice and the booking emails; see hostMailSetting.
  const hostMailEnabled = hostMailSetting(apiMode, env, hostConsoleEnabled, guestMail.enabled);
  // ホストのアカウント (ADR 0003): /host signs in with Experience's own accounts instead of NIHO; see hostAccountsSetting.
  const hostAccountsEnabled = hostAccountsSetting(apiMode, env, hostConsoleEnabled, guestMail.enabled);
  const experienceTranslateStandaloneRequested = env.EXPERIENCE_TRANSLATE_STANDALONE_API_ENABLED === "true";
  if (experienceTranslateStandaloneRequested && apiMode === "http" && !hostAccountsEnabled) {
    throw new Error("EXPERIENCE_TRANSLATE_STANDALONE_API_ENABLED=true needs EXPERIENCE_HOST_ACCOUNTS_ENABLED=true");
  }
  if (experienceTranslateStandaloneRequested && apiMode === "http" && !env.NIHO_EXPERIENCE_HOST_COMMON_CONTRACT_AUDIENCE?.trim()) {
    throw new Error("EXPERIENCE_TRANSLATE_STANDALONE_API_ENABLED=true needs NIHO_EXPERIENCE_HOST_COMMON_CONTRACT_AUDIENCE");
  }
  const experienceTranslateStandaloneApiEnabled = apiMode === "http"
    && hostConsoleEnabled
    && Boolean(env.EXPERIENCE_DATABASE_URL?.trim())
    && hostAccountsEnabled
    && experienceTranslateStandaloneRequested;
  const hostTeamEnabled = hostTeamSetting(apiMode, env, hostConsoleEnabled, hostAccountsEnabled);
  // After host accounts: with them, the host publication API reads Stripe and the experience DB instead of NIHO.
  const experiencePublication = experiencePublicationSettings(apiMode, env, hostConsoleEnabled, hostAccountsEnabled);
  // The Google calendar jobs (#238): busy re-checks and the booking calendar, each behind its own flag.
  const googleCalendarJobs = googleCalendarJobSettings(apiMode, env);
  // OTA の枠管理: start-up gates only; the routes still read their flags from process.env (see channelWatchdogSetting).
  const channelWatchdogEnabled = channelWatchdogSetting(apiMode, env, hostConsoleEnabled);
  const channelManagerEnabled = channelManagerSetting(apiMode, env, adminSupportConsoleEnabled);
  // Admin のログイン (ADR 0003): /admin signs in with Google and Experience's allowlist instead of NIHO; see adminGoogleLoginSettings.
  const adminGoogleLogin = adminGoogleLoginSettings(apiMode, env, adminSupportConsoleEnabled);
  const channelRuntimeEnabled = channelRuntimeSetting(apiMode, env, channelManagerEnabled, channelWatchdogEnabled);
  const resourceGoogle = resourceGoogleSettings(apiMode, env, hostConsoleEnabled);
  const airbnbGoogle = airbnbGoogleSettings(apiMode, env, hostConsoleEnabled, channelRuntimeEnabled);
  // 設定 › カレンダー's bookings feed (#109) for other calendars. The mock keeps its synthetic address on screen; http
  // opens per environment after migration 0035 is applied and accepted.
  const hostCalendarFeedEnabled = hostCalendarFeedSetting(apiMode, env, hostConsoleEnabled);
  // Translations (#285 slice 5): the guest's Japanese runs in the mail job above; the host's English draft in
  // メッセージ for questions kept here. Off, the host reads the guest's English and writes the English reply.
  const translationEnabled = translationEnabledSetting(apiMode, env);
  const hostSessionSecret = env.HOST_SESSION_SECRET?.trim() || (apiMode === "mock" ? DEV_ONLY_HOST_SESSION_SECRET : "");
  const nihoFirebaseWebApiKey = env.NIHO_FIREBASE_WEB_API_KEY?.trim() ?? "";
  const adminSessionSecret = env.ADMIN_SESSION_SECRET?.trim() || (apiMode === "mock" ? DEV_ONLY_HOST_SESSION_SECRET : "");
  const adminOriginSetting = env.NIHO_EXPERIENCE_ADMIN_ORIGIN?.trim() ?? "";
  const guideDraftsDir = guideDraftsSetting(apiMode, env.GUIDE_DRAFTS_DIR);
  const guidePublicSource = guidePublicSourceSetting(apiMode, env);
  const guideAdmin = guideAdminSettings(apiMode, env);
  const articleAuthority = articleAuthoritySettings(apiMode, env);
  if (apiMode === "http" && hostConsoleEnabled) assertHostConsoleSecrets(hostSessionSecret);
  const adminOrigin = apiMode === "http" && adminSupportConsoleEnabled
    ? assertAdminConsoleSettings(
      adminSessionSecret,
      nihoFirebaseWebApiKey,
      env.SITE_URL ?? "http://localhost:3000",
      adminOriginSetting,
      env.NEXT_PUBLIC_NIHO_WEB_ORIGIN ?? "https://niho.life",
      adminGoogleLogin.enabled,
    )
    : "";

  return {
    apiMode,
    // v1.2 is opt-in after NIHO deploys the approved catalog and checkout contract.
    publicApiVersion: env.EXPERIENCE_PUBLIC_API_VERSION === "1.2" ? "1.2" : env.EXPERIENCE_PUBLIC_API_VERSION === "1.1" ? "1.1" : "1.0",
    // The guest-journey additions (participation conditions, questions to the host, a mobile number: Epic #103) have no NIHO
    // contract yet. Only the mock serves them (packages/api-client/src/journey.ts); a real deployment shows none of it.
    journeyApi: apiMode === "mock" ? "mock" : "off",
    // Japanese routes remain an explicit deployment gate. Visual presentation
    // source-display is intentionally not configurable: public layout is code-owned.
    presentationSourceDisplayEnabled: false,
    japaneseSiteEnabled: apiMode === "http" && env.EXPERIENCE_JAPANESE_SITE_ENABLED === "true",
    nihoWebOrigin: env.NEXT_PUBLIC_NIHO_WEB_ORIGIN ?? "https://niho.life",
    mockLatencyMs: Number(env.MOCK_LATENCY_MS ?? 0) || 0,
    // "pilot" shows the permitted first experiences with provisional details (docs/content/README.md).
    mockCatalog: env.MOCK_CATALOG === "pilot" ? "pilot" : "synthetic",
    // Unpublished guide drafts shown in the mock preview only (absolute path, outside git); null otherwise.
    guideDraftsDir,
    // Public CMS reads are opt-in and HTTP-only. Database mode never falls back to code-backed guides.
    guidePublicSource,
    // NIHO platform ADMIN server -> Experience guide administration. This is a
    // service-to-service surface and never reuses /admin, /editor, or /host sessions.
    guideAdminApiEnabled: guideAdmin.enabled,
    guideAdminAudience: guideAdmin.audience,
    guideAdminServiceAccountEmail: guideAdmin.serviceAccountEmail,
    articleAuthorityApiEnabled: articleAuthority.enabled,
    articleAuthorityAudience: articleAuthority.audience,
    articleAuthorityServiceAccountEmails: articleAuthority.serviceAccountEmails,
    nihoArticleAuthorityOrigin: articleAuthority.nihoOrigin,
    nihoArticleAuthorityAudience: articleAuthority.nihoAudience,
    nihoArticleLinksAudience: articleAuthority.nihoLinksAudience,
    hostArticleLinksEnabled: articleAuthority.hostLinksEnabled,
    siteUrl: (env.SITE_URL ?? "http://localhost:3000").replace(/\/$/, ""),
    // Synthetic data must never be indexed, even if SITE_INDEXING is set by mistake.
    indexingAllowed: env.SITE_INDEXING === "allow" && apiMode === "http",
    // Incident switch (#15): "false" stops new bookings on the site. NIHO's API remains the authority.
    bookingsEnabled: env.BOOKINGS_ENABLED !== "false",
    hostSignupMode: env.HOST_SIGNUP_MODE === "open" ? "open" : "pilot",
    nihoHostStartUrl: env.NIHO_HOST_START_URL ?? "",
    hostPilotContactUrl: env.HOST_PILOT_CONTACT_URL ?? "",
    nihoBookingHelpUrl: env.NIHO_BOOKING_HELP_URL ?? "",
    // NIHO's privacy policy, linked from /privacy (empty hides the link).
    privacyPolicyUrl: privacyPolicyUrlSetting(env.EXPERIENCE_PRIVACY_POLICY_URL),
    // Only the production runtime receives this public Umami website ID.
    umamiWebsiteId: env.UMAMI_WEBSITE_ID?.trim() ?? "",
    hostConsoleEnabled,
    hostPwaEnabled,
    hostPushEnabled,
    // The browser's applicationServerKey (public). Empty while push is off.
    hostPushVapidPublicKey: hostPush.publicKey,
    // Server only: signs VAPID tokens. Empty in mock mode, which never sends.
    hostPushVapidPrivateKey: hostPush.privateKey,
    hostPushVapidSubject: hostPush.subject,
    // The notification job that sends what `outbox_messages` holds; a service-to-service surface like guide admin.
    hostPushJobEnabled: hostPushJob.enabled,
    hostPushJobAudience: hostPushJob.audience,
    hostPushJobServiceAccountEmail: hostPushJob.serviceAccountEmail,
    adminSupportConsoleEnabled,
    // Admin のログイン (ADR 0003): Google and Experience's own sessions instead of NIHO's Admin session (docs/admin-auth.md).
    adminGoogleLoginEnabled: adminGoogleLogin.enabled,
    // The lower-case @niho.life addresses that may sign in to /admin (empty while off). Never logged.
    adminAllowedEmails: adminGoogleLogin.allowedEmails,
    adminSupportReadApiEnabled,
    adminSupportReadPreviewEnabled,
    adminSupportCaseApiEnabled,
    adminSupportCasePreviewEnabled,
    adminOperationsApiEnabled,
    adminOperationsPreviewEnabled,
    adminSiteBookingsPreviewEnabled,
    hostSupportHistoryApiEnabled,
    hostSupportSettingsApiEnabled,
    hostSupportSettingsPreviewEnabled,
    experienceFeeSummaryApiEnabled,
    experienceFeeSummaryPreviewEnabled,
    experienceAssistedLaunchApiEnabled,
    experienceAssistedLaunchPreviewEnabled,
    experienceProviderPagesApiEnabled,
    experienceProviderOperationsApiEnabled,
    experienceProviderOperationsPreviewEnabled,
    experienceTranslateApiEnabled,
    experienceTranslateStandaloneApiEnabled,
    hostNotificationSettingsEnabled,
    hostSalesLedgerEnabled,
    hostSalesPayoutsEnabled,
    guestQuestionsEnabled,
    guestReviewsEnabled,
    guestBookingEnabled: guestBooking.enabled,
    managedSalesEnabled: apiMode === "http" && env.EXPERIENCE_MANAGED_SALES_ENABLED === "true",
    managedSalesWebhooksEnabled: apiMode === "http" && env.EXPERIENCE_MANAGED_SALES_WEBHOOKS_ENABLED === "true",
    // The terms version travelers agree to at checkout (consent.agreedVersion); empty while guest booking is off.
    guestBookingConsentVersion: guestBooking.consentVersion,
    experiencePublicationsEnabled: experiencePublication.enabled,
    experiencePublicationConsentVersion: experiencePublication.consentVersion,
    experienceHostPublicationApiEnabled: experiencePublication.hostApiEnabled,
    nihoExperienceHostCommonContractAudience: experiencePublication.nihoAudience,
    // 受取口座の利用同意 (ADR 0003): the version the OWNER agrees to with host accounts; may be empty otherwise.
    experiencePayoutAccountConsentVersion: experiencePublication.payoutAccountConsentVersion,
    hostAttendanceEnabled,
    // The mail job (empty while off). SMTP credentials are not here: they are read where they are used.
    guestMailEnabled: guestMail.enabled,
    guestMailSmtpHost: guestMail.smtpHost,
    guestMailSmtpPort: guestMail.smtpPort,
    guestMailFrom: guestMail.from,
    guestMailReplyTo: guestMail.replyTo,
    experienceJobsAudience: guestMail.jobAudience,
    experienceJobsServiceAccountEmail: guestMail.jobServiceAccountEmail,
    guestMailFeedbackEnabled: guestMail.feedbackEnabled,
    guestMailFeedbackAudience: guestMail.feedbackAudience,
    guestMailFeedbackServiceAccountEmail: guestMail.feedbackServiceAccountEmail,
    otaGuestDetailsEnabled: otaBooking.guestDetails,
    otaBookingNotificationsEnabled: otaBooking.notifications,
    hostMailEnabled,
    // Experience host accounts (ADR 0003): the emailed sign-in link and server-side sessions replace the NIHO login.
    hostAccountsEnabled,
    // Experience-native COHOST membership, independent from the legacy provider-operations consumer.
    hostTeamEnabled,
    googleBusySyncEnabled: googleCalendarJobs.busySyncEnabled,
    googleBookingEventsEnabled: googleCalendarJobs.bookingEventsEnabled,
    googleJobsAudience: googleCalendarJobs.audience,
    googleJobsServiceAccountEmail: googleCalendarJobs.serviceAccountEmail,
    // OTA の枠管理: for the start-up gate and the deploy table; the routes read process.env, not these.
    channelWatchdogEnabled,
    channelManagerEnabled,
    channelRuntimeEnabled,
    resourceGoogleEnabled: resourceGoogle.enabled,
    resourceGoogleWatchEnabled: resourceGoogle.watchEnabled,
    airbnbGoogleSetupEnabled: airbnbGoogle.setupEnabled,
    airbnbGoogleActivationEnabled: airbnbGoogle.activationEnabled,
    airbnbGoogleDeliveryEnabled: airbnbGoogle.deliveryEnabled,
    airbnbGoogleObservationEnabled: airbnbGoogle.observationEnabled,
    // The feed's key is not here: it is read where it is used.
    hostCalendarFeedEnabled,
    // The Claude API key is not here: it is read where it is used.
    translationEnabled,
    // Comma-separated keys: the first seals new cookies, the rest still open old ones while keys rotate.
    hostSessionSecret,
    adminSessionSecret,
    adminOrigin,
    nihoFirebaseWebApiKey,
  } as const;
}

/** Push settings; http mode refuses to start without a usable key pair shape and a subject (the pair itself: startup-check.ts). */
function hostPushSettings(apiMode: "mock" | "http", enabled: boolean, env: Env): { publicKey: string; privateKey: string; subject: string } {
  if (!enabled) return { publicKey: "", privateKey: "", subject: "" };
  if (apiMode === "mock") return { publicKey: DEV_ONLY_HOST_PUSH_VAPID_PUBLIC_KEY, privateKey: "", subject: "" };
  const publicKey = env.HOST_PUSH_VAPID_PUBLIC_KEY?.trim() ?? "";
  const privateKey = env.HOST_PUSH_VAPID_PRIVATE_KEY?.trim() ?? "";
  const subject = env.HOST_PUSH_VAPID_SUBJECT?.trim() ?? "";
  if (!VAPID_PUBLIC_KEY.test(publicKey) || publicKey === DEV_ONLY_HOST_PUSH_VAPID_PUBLIC_KEY) {
    throw new Error("HOST_PUSH_ENABLED=true needs HOST_PUSH_VAPID_PUBLIC_KEY (an uncompressed P-256 public key, base64url) in http mode");
  }
  if (!VAPID_PRIVATE_KEY.test(privateKey)) throw new Error("HOST_PUSH_ENABLED=true needs HOST_PUSH_VAPID_PRIVATE_KEY (a P-256 private key, base64url) in http mode");
  if (!/^(mailto:[^\s@/]+@[^\s@/]+|https:\/\/[^\s/]+(\/\S*)?)$/.test(subject)) throw new Error("HOST_PUSH_ENABLED=true needs HOST_PUSH_VAPID_SUBJECT (mailto: or https:) in http mode");
  return { publicKey, privateKey, subject };
}

/** Refuses to start a real host console with a missing or guessable cookie key. */
function assertHostConsoleSecrets(secret: string) {
  const keys = secret.split(",").map((key) => key.trim()).filter(Boolean);
  if (keys.length === 0 || keys.some((key) => key.length < MIN_HOST_SESSION_SECRET_LENGTH || key === DEV_ONLY_HOST_SESSION_SECRET)) {
    throw new Error(`HOST_CONSOLE_ENABLED=true needs HOST_SESSION_SECRET (each key at least ${MIN_HOST_SESSION_SECRET_LENGTH} characters) in http mode`);
  }
}

/**
 * Real Admin auth is closed unless its independent cookie key and exact callback origin are configured. With the Google
 * login (ADR 0003) NIHO is not called: the Firebase key and NIHO's admin origin are not needed, and the origin is
 * SITE_URL's (NIHO_EXPERIENCE_ADMIN_ORIGIN, when set, must still match it). The key seals the sign-in's state.
 */
function assertAdminConsoleSettings(secret: string, firebaseWebApiKey: string, siteUrl: string, configuredOrigin: string, nihoWebOrigin: string, googleLogin: boolean): string {
  const keys = secret.split(",").map((key) => key.trim()).filter(Boolean);
  if (keys.length === 0 || keys.some((key) => key.length < MIN_ADMIN_SESSION_SECRET_LENGTH || key === DEV_ONLY_HOST_SESSION_SECRET)) {
    throw new Error(`ADMIN_SUPPORT_CONSOLE_ENABLED=true needs ADMIN_SESSION_SECRET (each key at least ${MIN_ADMIN_SESSION_SECRET_LENGTH} characters) in http mode`);
  }
  let siteOrigin: string;
  try {
    siteOrigin = new URL(siteUrl).origin;
  } catch {
    throw new Error("SITE_URL must be an absolute URL");
  }
  if (googleLogin && !configuredOrigin) return deploymentOrigin(siteOrigin, "SITE_URL");
  if (!googleLogin && !firebaseWebApiKey) throw new Error("ADMIN_SUPPORT_CONSOLE_ENABLED=true needs NIHO_FIREBASE_WEB_API_KEY in http mode");
  if (!configuredOrigin) throw new Error("ADMIN_SUPPORT_CONSOLE_ENABLED=true needs NIHO_EXPERIENCE_ADMIN_ORIGIN in http mode");
  const adminOrigin = deploymentOrigin(configuredOrigin, "NIHO_EXPERIENCE_ADMIN_ORIGIN");
  if (!googleLogin) deploymentOrigin(nihoWebOrigin, "NEXT_PUBLIC_NIHO_WEB_ORIGIN");
  if (adminOrigin !== siteOrigin) throw new Error("NIHO_EXPERIENCE_ADMIN_ORIGIN must exactly match the SITE_URL origin");
  return adminOrigin;
}
