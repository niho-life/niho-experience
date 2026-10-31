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
const MIN_EDITOR_SESSION_SECRET_LENGTH = 32;

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

type GuideEditorSettings = Readonly<{ apiBaseUrl: string; handle: string; token: string; assetOrigins: readonly string[] }>;

const NO_GUIDE_EDITOR: GuideEditorSettings = { apiBaseUrl: "", handle: "", token: "", assetOrigins: [] };
const GUIDE_EDITOR_HANDLE = /^[A-Za-z0-9_-]{1,128}$/;

const isLoopbackHost = (hostname: string) => hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

/** The editor's public API base (with its version path, still provisional): https, or loopback http for a local fixture server. */
function guideEditorBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("GUIDE_EDITOR_API_BASE_URL must be an absolute URL");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("GUIDE_EDITOR_API_BASE_URL must not contain credentials, a query or a fragment");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new Error("GUIDE_EDITOR_API_BASE_URL must use HTTPS, except loopback HTTP in development");
  }
  return url;
}

/** Comma-separated https origins that may serve editor photos; the API's own origin when unset. */
function guideEditorAssetOrigins(value: string | undefined, apiOrigin: string): string[] {
  const entries = (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (!entries.length) return [apiOrigin];
  return [...new Set(entries.map((entry) => {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error("GUIDE_EDITOR_ASSET_ORIGINS must list absolute https origins");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("GUIDE_EDITOR_ASSET_ORIGINS must list https origins only");
    }
    return url.origin;
  }))];
}

/**
 * editor.niho.life's public API as the guide source (#252, provisional contract: lib/editor-publication/contract.ts).
 * Every setting is required; a missing one stops the server instead of falling back to static guides.
 */
function guideEditorSettings(env: Env): GuideEditorSettings {
  const base = env.GUIDE_EDITOR_API_BASE_URL?.trim() ?? "";
  const handle = env.GUIDE_EDITOR_API_HANDLE?.trim() ?? "";
  const token = env.GUIDE_EDITOR_API_TOKEN?.trim() ?? "";
  if (!base) throw new Error("EXPERIENCE_GUIDE_PUBLIC_SOURCE=editor needs GUIDE_EDITOR_API_BASE_URL in http mode");
  if (!handle) throw new Error("EXPERIENCE_GUIDE_PUBLIC_SOURCE=editor needs GUIDE_EDITOR_API_HANDLE in http mode");
  if (!token) throw new Error("EXPERIENCE_GUIDE_PUBLIC_SOURCE=editor needs GUIDE_EDITOR_API_TOKEN in http mode");
  if (!GUIDE_EDITOR_HANDLE.test(handle)) throw new Error("GUIDE_EDITOR_API_HANDLE must be letters, digits, - or _");
  const url = guideEditorBaseUrl(base);
  return {
    apiBaseUrl: url.href.replace(/\/+$/, ""),
    handle,
    token,
    assetOrigins: guideEditorAssetOrigins(env.GUIDE_EDITOR_ASSET_ORIGINS, url.origin),
  };
}

/**
 * Where writers go to write (editor.niho.life, #254): the footer's "For writers" and the host console's 記事を書く.
 * Unset keeps both links hidden, so neither points at an editor that is not serving yet.
 */
function guideEditorSiteOrigin(value: string | undefined): string {
  const origin = value?.trim() ?? "";
  return origin ? deploymentOrigin(origin, "GUIDE_EDITOR_SITE_ORIGIN") : "";
}

function guidePublicSourceSetting(apiMode: "mock" | "http", env: Env): "static" | "database" | "editor" {
  if (apiMode === "http" && env.EXPERIENCE_GUIDE_PUBLIC_SOURCE === "editor") return "editor";
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

/** The terms version a traveler agrees to (consent.agreedVersion, 1-100 characters): printable ASCII without spaces. */
const BOOKING_CONSENT_VERSION = /^[\x21-\x7E]{1,100}$/;

/**
 * 旅行者の予約 on this site (#285, docs/guest-booking.md): availability and checkout from the experience DB with
 * Stripe Checkout on the provider's account. HTTP only. Turned on without everything a sale needs, the server
 * stops at start-up instead of taking bookings it cannot charge or confirm. Error messages never echo values.
 */
function guestBookingSettings(apiMode: "mock" | "http", env: Env): { enabled: boolean; consentVersion: string } {
  if (apiMode !== "http" || env.EXPERIENCE_GUEST_BOOKING_ENABLED !== "true") return { enabled: false, consentVersion: "" };
  for (const name of ["EXPERIENCE_DATABASE_URL", "EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY", "EXPERIENCE_STRIPE_WEBHOOK_SECRET"]) {
    if (!env[name]?.trim()) throw new Error(`EXPERIENCE_GUEST_BOOKING_ENABLED=true needs ${name} in http mode`);
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
}>;

const NO_GUEST_MAIL: GuestMailSettings = { enabled: false, smtpHost: "", smtpPort: 0, from: null, replyTo: null, jobAudience: "", jobServiceAccountEmail: "" };

/**
 * 予約者へのメール (#285 slice 5, docs/guest-booking.md): the job behind POST /internal/experience-jobs/v1/drain
 * sends host replies and booking confirmations over SMTP (the provider NIHO uses, with experience's own
 * credentials) and erases guest data after a year. HTTP only. Turned on without everything it needs, the
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
  // Links in the emails are absolute: https (loopback http in development).
  let siteOrigin: string;
  try {
    siteOrigin = new URL(env.SITE_URL ?? "http://localhost:3000").origin;
  } catch {
    throw new Error("SITE_URL must be an absolute URL");
  }
  deploymentOrigin(siteOrigin, "SITE_URL (for EXPERIENCE_GUEST_MAIL_ENABLED)");
  return { enabled: true, smtpHost, smtpPort, from, replyTo, jobAudience, jobServiceAccountEmail };
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
  // Current provider membership and booking operations are independent from Admin and assisted launch.
  // The real transport opens only after the selected v1 API is deployed and accepted.
  const experienceProviderOperationsApiEnabled = apiMode === "http" && hostConsoleEnabled && env.EXPERIENCE_PROVIDER_OPERATIONS_API_ENABLED === "true";
  const experienceProviderOperationsPreviewEnabled = apiMode === "mock" && hostConsoleEnabled && env.EXPERIENCE_PROVIDER_OPERATIONS_PREVIEW_ENABLED === "true";
  // 対面通訳 (#181): the translate-rooms BFF under /host/api/translate. The mock always serves synthetic rooms;
  // http opens only after niho-app N1b (#19447) is deployed and accepted, per environment.
  const experienceTranslateApiEnabled = apiMode === "http" && hostConsoleEnabled && env.EXPERIENCE_TRANSLATE_API_ENABLED === "true";
  // 設定 › 通知 (#109) kept in the experience DB. The mock keeps the switches on screen; http opens per
  // environment after migration 0020 and the provider's experience OWNER membership are accepted.
  const hostNotificationSettingsEnabled = apiMode === "http" && hostConsoleEnabled && env.HOST_NOTIFICATION_SETTINGS_ENABLED === "true";
  // 予約前の質問 (#105/#106) kept in the experience DB (docs/guest-questions.md): the traveler's "Ask the host", the
  // reply page and the OWNER's メッセージ. The mock keeps its own synthetic questions; http opens per environment
  // after migration 0022 is applied and accepted. A question is taken only where the OWNER can read it: the host
  // console is on and メッセージ is not showing NIHO's booking messages instead.
  const guestQuestionsEnabled = apiMode === "http" && hostConsoleEnabled && !experienceProviderOperationsApiEnabled && env.EXPERIENCE_GUEST_QUESTIONS_ENABLED === "true";
  // 予約者のレビュー (#104/#108) kept in the experience DB: for now only the public read of published reviews, so it
  // does not need the host console. The mock keeps its own synthetic reviews; http opens per environment after
  // migration 0027 is applied and accepted.
  const guestReviewsEnabled = apiMode === "http" && env.EXPERIENCE_GUEST_REVIEWS_ENABLED === "true";
  // 旅行者の予約 (#285) on this site instead of NIHO: availability and checkout from the experience DB. The mock keeps
  // NIHO's contract served by the api-client mock; http opens per environment after migrations 0023/0024 are accepted.
  const guestBooking = guestBookingSettings(apiMode, env);
  // 予約者へのメール (#285 slice 5): host replies, booking confirmations and the one-year erasure, run by Cloud
  // Scheduler through its own service account. Independent of the two flags above: a payment confirmed after
  // guest booking is turned off still gets its email.
  const guestMail = guestMailSettings(apiMode, env);
  const hostSessionSecret = env.HOST_SESSION_SECRET?.trim() || (apiMode === "mock" ? DEV_ONLY_HOST_SESSION_SECRET : "");
  const nihoFirebaseWebApiKey = env.NIHO_FIREBASE_WEB_API_KEY?.trim() ?? "";
  const adminSessionSecret = env.ADMIN_SESSION_SECRET?.trim() || (apiMode === "mock" ? DEV_ONLY_HOST_SESSION_SECRET : "");
  const adminOriginSetting = env.NIHO_EXPERIENCE_ADMIN_ORIGIN?.trim() ?? "";
  const editorSettings = resolveEditorConsoleSettings(apiMode, env);
  const guideDraftsDir = guideDraftsSetting(apiMode, env.GUIDE_DRAFTS_DIR);
  const guidePublicSource = guidePublicSourceSetting(apiMode, env);
  const guideEditor = guidePublicSource === "editor" ? guideEditorSettings(env) : NO_GUIDE_EDITOR;
  const guideEditorSite = guideEditorSiteOrigin(env.GUIDE_EDITOR_SITE_ORIGIN);
  const guideAdmin = guideAdminSettings(apiMode, env);
  if (apiMode === "http" && hostConsoleEnabled) assertHostConsoleSecrets(hostSessionSecret, nihoFirebaseWebApiKey);
  const adminOrigin = apiMode === "http" && adminSupportConsoleEnabled
    ? assertAdminConsoleSettings(
      adminSessionSecret,
      nihoFirebaseWebApiKey,
      env.SITE_URL ?? "http://localhost:3000",
      adminOriginSetting,
      env.NEXT_PUBLIC_NIHO_WEB_ORIGIN ?? "https://niho.life",
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
    // Public CMS reads are opt-in and HTTP-only. Database and editor modes never fall back to code-backed guides.
    guidePublicSource,
    // editor.niho.life's public API (editor mode only; empty otherwise). The token is a server-only secret.
    guideEditorApiBaseUrl: guideEditor.apiBaseUrl,
    guideEditorApiHandle: guideEditor.handle,
    guideEditorApiToken: guideEditor.token,
    guideEditorAssetOrigins: guideEditor.assetOrigins,
    // The editor's own site, linked from the footer and /host; empty hides the links.
    guideEditorSiteOrigin: guideEditorSite,
    // NIHO platform ADMIN server -> Experience guide administration. This is a
    // service-to-service surface and never reuses /admin, /editor, or /host sessions.
    guideAdminApiEnabled: guideAdmin.enabled,
    guideAdminAudience: guideAdmin.audience,
    guideAdminServiceAccountEmail: guideAdmin.serviceAccountEmail,
    siteUrl: (env.SITE_URL ?? "http://localhost:3000").replace(/\/$/, ""),
    // Synthetic data must never be indexed, even if SITE_INDEXING is set by mistake.
    indexingAllowed: env.SITE_INDEXING === "allow" && apiMode === "http",
    // Incident switch (#15): "false" stops new bookings on the site. NIHO's API remains the authority.
    bookingsEnabled: env.BOOKINGS_ENABLED !== "false",
    hostSignupMode: env.HOST_SIGNUP_MODE === "open" ? "open" : "pilot",
    nihoHostStartUrl: env.NIHO_HOST_START_URL ?? "",
    hostPilotContactUrl: env.HOST_PILOT_CONTACT_URL ?? "",
    nihoBookingHelpUrl: env.NIHO_BOOKING_HELP_URL ?? "",
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
    adminSupportReadApiEnabled,
    adminSupportReadPreviewEnabled,
    adminSupportCaseApiEnabled,
    adminSupportCasePreviewEnabled,
    adminOperationsApiEnabled,
    adminOperationsPreviewEnabled,
    hostSupportHistoryApiEnabled,
    hostSupportSettingsApiEnabled,
    hostSupportSettingsPreviewEnabled,
    experienceFeeSummaryApiEnabled,
    experienceFeeSummaryPreviewEnabled,
    experienceAssistedLaunchApiEnabled,
    experienceAssistedLaunchPreviewEnabled,
    experienceProviderOperationsApiEnabled,
    experienceProviderOperationsPreviewEnabled,
    experienceTranslateApiEnabled,
    hostNotificationSettingsEnabled,
    guestQuestionsEnabled,
    guestReviewsEnabled,
    guestBookingEnabled: guestBooking.enabled,
    // The terms version travelers agree to at checkout (consent.agreedVersion); empty while guest booking is off.
    guestBookingConsentVersion: guestBooking.consentVersion,
    // The mail job (empty while off). SMTP credentials are not here: they are read where they are used.
    guestMailEnabled: guestMail.enabled,
    guestMailSmtpHost: guestMail.smtpHost,
    guestMailSmtpPort: guestMail.smtpPort,
    guestMailFrom: guestMail.from,
    guestMailReplyTo: guestMail.replyTo,
    experienceJobsAudience: guestMail.jobAudience,
    experienceJobsServiceAccountEmail: guestMail.jobServiceAccountEmail,
    // Comma-separated keys: the first seals new cookies, the rest still open old ones while keys rotate.
    hostSessionSecret,
    adminSessionSecret,
    adminOrigin,
    editorConsoleEnabled: editorSettings.enabled,
    editorSessionSecret: editorSettings.sessionSecret,
    editorOrigin: editorSettings.origin,
    nihoFirebaseWebApiKey,
  } as const;
}

/**
 * The editor client does not exist on NIHO yet (#19459). Missing rollout
 * settings therefore close the surface with 404 instead of enabling a mock or
 * partially configured authentication path.
 */
function resolveEditorConsoleSettings(apiMode: "mock" | "http", env: Env): { enabled: boolean; sessionSecret: string; origin: string } {
  if (apiMode !== "http" || env.EDITOR_CONSOLE_ENABLED !== "true") return { enabled: false, sessionSecret: "", origin: "" };
  const sessionSecret = env.EDITOR_SESSION_SECRET?.trim() ?? "";
  const firebaseWebApiKey = env.NIHO_FIREBASE_WEB_API_KEY?.trim() ?? "";
  const configuredOrigin = env.NIHO_EXPERIENCE_EDITOR_ORIGIN?.trim() ?? "";
  const keys = sessionSecret.split(",").map((key) => key.trim()).filter(Boolean);
  const otherCookieKeys = [env.HOST_SESSION_SECRET, env.ADMIN_SESSION_SECRET]
    .flatMap((value) => (value ?? "").split(",").map((key) => key.trim()).filter(Boolean));
  if (
    keys.length === 0
    || keys.some((key) => key.length < MIN_EDITOR_SESSION_SECRET_LENGTH || key === DEV_ONLY_HOST_SESSION_SECRET || otherCookieKeys.includes(key))
    || !firebaseWebApiKey
    || !configuredOrigin
  ) return { enabled: false, sessionSecret: "", origin: "" };

  const origin = deploymentOrigin(configuredOrigin, "NIHO_EXPERIENCE_EDITOR_ORIGIN");
  deploymentOrigin(env.NEXT_PUBLIC_NIHO_WEB_ORIGIN ?? "https://niho.life", "NEXT_PUBLIC_NIHO_WEB_ORIGIN");
  let siteOrigin: string;
  try {
    siteOrigin = new URL(env.SITE_URL ?? "http://localhost:3000").origin;
  } catch {
    throw new Error("SITE_URL must be an absolute URL");
  }
  if (origin !== siteOrigin) throw new Error("NIHO_EXPERIENCE_EDITOR_ORIGIN must exactly match the SITE_URL origin");
  return { enabled: true, sessionSecret, origin };
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
function assertHostConsoleSecrets(secret: string, firebaseWebApiKey: string) {
  const keys = secret.split(",").map((key) => key.trim()).filter(Boolean);
  if (keys.length === 0 || keys.some((key) => key.length < MIN_HOST_SESSION_SECRET_LENGTH || key === DEV_ONLY_HOST_SESSION_SECRET)) {
    throw new Error(`HOST_CONSOLE_ENABLED=true needs HOST_SESSION_SECRET (each key at least ${MIN_HOST_SESSION_SECRET_LENGTH} characters) in http mode`);
  }
  if (!firebaseWebApiKey) throw new Error("HOST_CONSOLE_ENABLED=true needs NIHO_FIREBASE_WEB_API_KEY in http mode");
}

/** Real Admin auth is closed unless its independent cookie key and exact callback origin are configured. */
function assertAdminConsoleSettings(secret: string, firebaseWebApiKey: string, siteUrl: string, configuredOrigin: string, nihoWebOrigin: string): string {
  const keys = secret.split(",").map((key) => key.trim()).filter(Boolean);
  if (keys.length === 0 || keys.some((key) => key.length < MIN_ADMIN_SESSION_SECRET_LENGTH || key === DEV_ONLY_HOST_SESSION_SECRET)) {
    throw new Error(`ADMIN_SUPPORT_CONSOLE_ENABLED=true needs ADMIN_SESSION_SECRET (each key at least ${MIN_ADMIN_SESSION_SECRET_LENGTH} characters) in http mode`);
  }
  if (!firebaseWebApiKey) throw new Error("ADMIN_SUPPORT_CONSOLE_ENABLED=true needs NIHO_FIREBASE_WEB_API_KEY in http mode");
  if (!configuredOrigin) throw new Error("ADMIN_SUPPORT_CONSOLE_ENABLED=true needs NIHO_EXPERIENCE_ADMIN_ORIGIN in http mode");
  const adminOrigin = deploymentOrigin(configuredOrigin, "NIHO_EXPERIENCE_ADMIN_ORIGIN");
  deploymentOrigin(nihoWebOrigin, "NEXT_PUBLIC_NIHO_WEB_ORIGIN");
  let siteOrigin: string;
  try {
    siteOrigin = new URL(siteUrl).origin;
  } catch {
    throw new Error("SITE_URL must be an absolute URL");
  }
  if (adminOrigin !== siteOrigin) throw new Error("NIHO_EXPERIENCE_ADMIN_ORIGIN must exactly match the SITE_URL origin");
  return adminOrigin;
}
