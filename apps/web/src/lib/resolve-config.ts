type Env = Record<string, string | undefined>;

/**
 * Development-only key for the host console cookies in mock mode. Never accepted
 * in http mode: deployments pass HOST_SESSION_SECRET from Secret Manager.
 */
export const DEV_ONLY_HOST_SESSION_SECRET = "dev-only/niho-experience/host-session/not-a-secret-never-deploy";

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

/** Pure so it can be unit-tested; see config.ts for the server instance. */
export function resolveConfig(env: Env) {
  const apiMode = env.EXPERIENCE_API_MODE === "http" ? "http" : "mock";
  // The host console (/host/home and below, #86) stays off unless explicitly enabled.
  const hostConsoleEnabled = env.HOST_CONSOLE_ENABLED === "true";
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
  const hostSessionSecret = env.HOST_SESSION_SECRET?.trim() || (apiMode === "mock" ? DEV_ONLY_HOST_SESSION_SECRET : "");
  const nihoFirebaseWebApiKey = env.NIHO_FIREBASE_WEB_API_KEY?.trim() ?? "";
  const adminSessionSecret = env.ADMIN_SESSION_SECRET?.trim() || (apiMode === "mock" ? DEV_ONLY_HOST_SESSION_SECRET : "");
  const adminOriginSetting = env.NIHO_EXPERIENCE_ADMIN_ORIGIN?.trim() ?? "";
  const guideDraftsDir = guideDraftsSetting(apiMode, env.GUIDE_DRAFTS_DIR);
  if (apiMode === "http" && hostConsoleEnabled) assertHostConsoleSecrets(hostSessionSecret);
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
    // Comma-separated keys: the first seals new cookies, the rest still open old ones while keys rotate.
    hostSessionSecret,
    adminSessionSecret,
    adminOrigin,
    nihoFirebaseWebApiKey,
  } as const;
}

/** Refuses to start a real host console with a missing or guessable cookie key. */
function assertHostConsoleSecrets(secret: string) {
  const keys = secret.split(",").map((key) => key.trim()).filter(Boolean);
  if (keys.length === 0 || keys.some((key) => key.length < MIN_HOST_SESSION_SECRET_LENGTH || key === DEV_ONLY_HOST_SESSION_SECRET)) {
    throw new Error(`HOST_CONSOLE_ENABLED=true needs HOST_SESSION_SECRET (each key at least ${MIN_HOST_SESSION_SECRET_LENGTH} characters) in http mode`);
  }
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
