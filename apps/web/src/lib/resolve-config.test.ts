import { describe, expect, it } from "vitest";
import { DEV_ONLY_HOST_PUSH_VAPID_PUBLIC_KEY, DEV_ONLY_HOST_SESSION_SECRET, resolveConfig } from "./resolve-config";

describe("public API version rollout gate", () => {
  it("keeps v1.0 when the runtime flag is absent", () => {
    expect(resolveConfig({}).publicApiVersion).toBe("1.0");
  });

  it("opts into v1.1 only when explicitly configured", () => {
    expect(resolveConfig({ EXPERIENCE_PUBLIC_API_VERSION: "1.1" }).publicApiVersion).toBe("1.1");
  });

  it("opts into v1.2 filters only when explicitly configured", () => {
    expect(resolveConfig({ EXPERIENCE_PUBLIC_API_VERSION: "1.2" }).publicApiVersion).toBe("1.2");
  });
});

describe("Experience owner publication settings", () => {
  const http = {
    EXPERIENCE_API_MODE: "http",
    HOST_CONSOLE_ENABLED: "true",
    HOST_SESSION_SECRET: "s".repeat(32),
    EXPERIENCE_DATABASE_URL: "postgresql://synthetic.invalid/experience",
    EXPERIENCE_PUBLIC_MEDIA_BUCKET: "experience-public-media-test",
    EXPERIENCE_PUBLICATIONS_ENABLED: "true",
    EXPERIENCE_HOST_PUBLICATION_API_ENABLED: "true",
    EXPERIENCE_PUBLICATION_CONSENT_VERSION: "owner-publish-v1",
  };

  it("requires the NIHO common-contract audience before opening owner routes", () => {
    expect(() => resolveConfig(http)).toThrow(/NIHO_EXPERIENCE_HOST_COMMON_CONTRACT_AUDIENCE/);
    expect(() => resolveConfig({ ...http, NIHO_EXPERIENCE_HOST_COMMON_CONTRACT_AUDIENCE: "http://public.example" }))
      .toThrow(/NIHO_EXPERIENCE_HOST_COMMON_CONTRACT_AUDIENCE/);
    expect(resolveConfig({ ...http, NIHO_EXPERIENCE_HOST_COMMON_CONTRACT_AUDIENCE: "https://niho-api.example.test" }))
      .toMatchObject({ experiencePublicationsEnabled: true, experienceHostPublicationApiEnabled: true });
  });

  it("keeps the host surface closed when either publication flag is off", () => {
    expect(resolveConfig({ ...http, EXPERIENCE_HOST_PUBLICATION_API_ENABLED: "false" }))
      .toMatchObject({ experiencePublicationsEnabled: true, experienceHostPublicationApiEnabled: false });
    expect(resolveConfig({ ...http, EXPERIENCE_PUBLICATIONS_ENABLED: "false" }))
      .toMatchObject({ experiencePublicationsEnabled: false, experienceHostPublicationApiEnabled: false });
  });
});

describe("guide admin service settings", () => {
  const complete = {
    EXPERIENCE_API_MODE: "http",
    GUIDE_ADMIN_API_ENABLED: "true",
    GUIDE_ADMIN_AUDIENCE: "https://experience.example/internal/guide-admin",
    GUIDE_ADMIN_SERVICE_ACCOUNT_EMAIL: "guide-admin@example.iam.gserviceaccount.com",
    EXPERIENCE_DATABASE_URL: "postgresql://synthetic.invalid/experience",
  };

  it("is default-off and cannot be opened in mock mode", () => {
    expect(resolveConfig({})).toMatchObject({
      guideAdminApiEnabled: false,
      guideAdminAudience: "",
      guideAdminServiceAccountEmail: "",
    });
    expect(resolveConfig({ ...complete, EXPERIENCE_API_MODE: "mock" }).guideAdminApiEnabled).toBe(false);
    expect(resolveConfig({ ...complete, GUIDE_ADMIN_API_ENABLED: "1" }).guideAdminApiEnabled).toBe(false);
  });

  it("requires the audience, exact service identity, and database when enabled", () => {
    expect(() => resolveConfig({ ...complete, GUIDE_ADMIN_AUDIENCE: "" })).toThrow(/GUIDE_ADMIN_AUDIENCE/);
    expect(() => resolveConfig({ ...complete, GUIDE_ADMIN_SERVICE_ACCOUNT_EMAIL: "" })).toThrow(/GUIDE_ADMIN_SERVICE_ACCOUNT_EMAIL/);
    expect(() => resolveConfig({ ...complete, GUIDE_ADMIN_SERVICE_ACCOUNT_EMAIL: "admin@example.com" })).toThrow(/GUIDE_ADMIN_SERVICE_ACCOUNT_EMAIL/);
    expect(() => resolveConfig({ ...complete, EXPERIENCE_DATABASE_URL: "" })).toThrow(/EXPERIENCE_DATABASE_URL/);
    expect(resolveConfig(complete)).toMatchObject({
      guideAdminApiEnabled: true,
      guideAdminAudience: complete.GUIDE_ADMIN_AUDIENCE,
      guideAdminServiceAccountEmail: complete.GUIDE_ADMIN_SERVICE_ACCOUNT_EMAIL,
    });
  });
});

describe("article authority settings", () => {
  const authority = {
    EXPERIENCE_API_MODE: "http",
    EXPERIENCE_ARTICLE_AUTHORITY_API_ENABLED: "true",
    EXPERIENCE_DATABASE_URL: "postgresql://synthetic.invalid/experience",
    EXPERIENCE_ARTICLE_AUTHORITY_AUDIENCE: "https://experience.example.invalid/internal/article-authority",
    EXPERIENCE_ARTICLE_AUTHORITY_SERVICE_ACCOUNT_EMAILS: "editor@example-project.iam.gserviceaccount.com",
    NIHO_ARTICLE_AUTHORITY_ORIGIN: "https://niho.example.invalid",
    NIHO_ARTICLE_AUTHORITY_AUDIENCE: "https://niho.example.invalid/internal/editor-authority",
    EDITOR_ARTICLE_AUTHORITY_ORIGIN: "https://editor.example.invalid",
    EDITOR_ARTICLE_AUTHORITY_AUDIENCE: "https://editor.example.invalid/internal/publication-authority",
  };

  it("is HTTP-only, exact-flag default OFF, and exposes no partial runtime", () => {
    expect(resolveConfig({})).toMatchObject({ articleAuthorityApiEnabled: false, hostArticleLinksEnabled: false });
    expect(resolveConfig({ ...authority, EXPERIENCE_API_MODE: "mock" }).articleAuthorityApiEnabled).toBe(false);
    expect(resolveConfig({ ...authority, EXPERIENCE_ARTICLE_AUTHORITY_API_ENABLED: "1" }).articleAuthorityApiEnabled).toBe(false);
    expect(resolveConfig(authority)).toMatchObject({
      articleAuthorityApiEnabled: true,
      articleAuthorityAudience: authority.EXPERIENCE_ARTICLE_AUTHORITY_AUDIENCE,
      articleAuthorityServiceAccountEmails: [authority.EXPERIENCE_ARTICLE_AUTHORITY_SERVICE_ACCOUNT_EMAILS],
    });
  });

  it("fails startup when an enabled authority lacks DB, origin, audience, or a valid allowlist", () => {
    for (const key of ["EXPERIENCE_DATABASE_URL", "EXPERIENCE_ARTICLE_AUTHORITY_AUDIENCE", "NIHO_ARTICLE_AUTHORITY_ORIGIN", "NIHO_ARTICLE_AUTHORITY_AUDIENCE", "EDITOR_ARTICLE_AUTHORITY_ORIGIN", "EDITOR_ARTICLE_AUTHORITY_AUDIENCE", "EXPERIENCE_ARTICLE_AUTHORITY_SERVICE_ACCOUNT_EMAILS"] as const) {
      expect(() => resolveConfig({ ...authority, [key]: "" }), key).toThrow();
    }
    expect(() => resolveConfig({ ...authority, EXPERIENCE_ARTICLE_AUTHORITY_SERVICE_ACCOUNT_EMAILS: "person@example.com" })).toThrow(/SERVICE_ACCOUNT_EMAILS/);
  });

  it("keeps host links independent from the retired editor console and requires only the live host boundary plus NIHO service identity", () => {
    const host = {
      EXPERIENCE_API_MODE: "http",
      HOST_CONSOLE_ENABLED: "true",
      HOST_SESSION_SECRET: "s".repeat(32),
      EXPERIENCE_HOST_ARTICLE_LINKS_ENABLED: "true",
      NIHO_ARTICLE_AUTHORITY_ORIGIN: authority.NIHO_ARTICLE_AUTHORITY_ORIGIN,
      NIHO_ARTICLE_LINKS_AUDIENCE: "https://niho.example.invalid/experience-guide-links",
    };
    expect(resolveConfig(host)).toMatchObject({ hostArticleLinksEnabled: true, articleAuthorityApiEnabled: false, nihoArticleAuthorityAudience: "", nihoArticleLinksAudience: host.NIHO_ARTICLE_LINKS_AUDIENCE });
    expect(() => resolveConfig({ ...host, HOST_CONSOLE_ENABLED: "false" })).toThrow(/HOST_CONSOLE_ENABLED/);
    expect(() => resolveConfig({ ...host, NIHO_ARTICLE_LINKS_AUDIENCE: "" })).toThrow(/NIHO_ARTICLE_LINKS_AUDIENCE/);
  });
});

describe("code-owned presentation and Japanese release gate", () => {
  it("ignores the retired visual source flag and gates only the approved Japanese release", () => {
    expect(resolveConfig({})).toMatchObject({ japaneseSiteEnabled: false });
    expect(resolveConfig({ EXPERIENCE_PRESENTATION_SOURCE_DISPLAY_ENABLED: "true", EXPERIENCE_JAPANESE_SITE_ENABLED: "true" })).toMatchObject({ japaneseSiteEnabled: false });
    const config = resolveConfig({ EXPERIENCE_API_MODE: "http", EXPERIENCE_PRESENTATION_SOURCE_DISPLAY_ENABLED: "true", EXPERIENCE_JAPANESE_SITE_ENABLED: "true" });
    expect(config).toMatchObject({ japaneseSiteEnabled: true });
    expect(config.presentationSourceDisplayEnabled).toBe(false);
  });
});

describe("host console settings", () => {
  const http = { EXPERIENCE_API_MODE: "http", HOST_CONSOLE_ENABLED: "true" };
  const secret = "s".repeat(32);

  it("stays off unless HOST_CONSOLE_ENABLED is exactly true", () => {
    expect(resolveConfig({}).hostConsoleEnabled).toBe(false);
    expect(resolveConfig({ HOST_CONSOLE_ENABLED: "1" }).hostConsoleEnabled).toBe(false);
    expect(resolveConfig({ HOST_CONSOLE_ENABLED: "true" }).hostConsoleEnabled).toBe(true);
  });

  it("offers the console as an app only when the console is on and HOST_PWA_ENABLED is exactly true", () => {
    expect(resolveConfig({ HOST_CONSOLE_ENABLED: "true" }).hostPwaEnabled).toBe(false);
    expect(resolveConfig({ HOST_CONSOLE_ENABLED: "true", HOST_PWA_ENABLED: "1" }).hostPwaEnabled).toBe(false);
    expect(resolveConfig({ HOST_PWA_ENABLED: "true" }).hostPwaEnabled).toBe(false);
    expect(resolveConfig({ HOST_CONSOLE_ENABLED: "true", HOST_PWA_ENABLED: "true" }).hostPwaEnabled).toBe(true);
  });

  it("sends push to the app only on top of the app, and keeps the private key out of mock mode (#177 P2)", () => {
    const app = { HOST_CONSOLE_ENABLED: "true", HOST_PWA_ENABLED: "true" };
    expect(resolveConfig({ ...app, HOST_PUSH_ENABLED: "1" }).hostPushEnabled).toBe(false);
    expect(resolveConfig({ HOST_CONSOLE_ENABLED: "true", HOST_PUSH_ENABLED: "true" }).hostPushEnabled).toBe(false);
    expect(resolveConfig(app)).toMatchObject({ hostPushEnabled: false, hostPushVapidPublicKey: "", hostPushVapidPrivateKey: "" });
    const mock = resolveConfig({ ...app, HOST_PUSH_ENABLED: "true", HOST_PUSH_VAPID_PRIVATE_KEY: "p".repeat(43), HOST_PUSH_VAPID_PUBLIC_KEY: `B${"x".repeat(86)}` });
    expect(mock).toMatchObject({ hostPushEnabled: true, hostPushVapidPublicKey: DEV_ONLY_HOST_PUSH_VAPID_PUBLIC_KEY, hostPushVapidPrivateKey: "", hostPushVapidSubject: "" });
  });

  it("fails at start-up when http push lacks its VAPID keys or subject", () => {
    const push = { ...http, HOST_SESSION_SECRET: secret, NIHO_FIREBASE_WEB_API_KEY: "key", HOST_PWA_ENABLED: "true", HOST_PUSH_ENABLED: "true" };
    const keys = { HOST_PUSH_VAPID_PUBLIC_KEY: `B${"x".repeat(86)}`, HOST_PUSH_VAPID_PRIVATE_KEY: "p".repeat(43), HOST_PUSH_VAPID_SUBJECT: "mailto:host-push@example.test" };
    expect(() => resolveConfig({ ...push, ...keys, HOST_PUSH_VAPID_PUBLIC_KEY: "" })).toThrow(/HOST_PUSH_VAPID_PUBLIC_KEY/);
    expect(() => resolveConfig({ ...push, ...keys, HOST_PUSH_VAPID_PUBLIC_KEY: DEV_ONLY_HOST_PUSH_VAPID_PUBLIC_KEY })).toThrow(/HOST_PUSH_VAPID_PUBLIC_KEY/);
    expect(() => resolveConfig({ ...push, ...keys, HOST_PUSH_VAPID_PRIVATE_KEY: "short" })).toThrow(/HOST_PUSH_VAPID_PRIVATE_KEY/);
    expect(() => resolveConfig({ ...push, ...keys, HOST_PUSH_VAPID_SUBJECT: "http://example.test" })).toThrow(/HOST_PUSH_VAPID_SUBJECT/);
    expect(() => resolveConfig({ ...push, ...keys, HOST_PUSH_VAPID_SUBJECT: "" })).toThrow(/HOST_PUSH_VAPID_SUBJECT/);
    expect(resolveConfig({ ...push, ...keys })).toMatchObject({ hostPushEnabled: true, hostPushVapidPrivateKey: "p".repeat(43), hostPushVapidSubject: "mailto:host-push@example.test" });
    // Off, nothing is required.
    expect(() => resolveConfig({ ...push, HOST_PUSH_ENABLED: "false" })).not.toThrow();
  });

  it("opens the push job's trigger only with http push, both job settings and the experience DB", () => {
    const push = {
      ...http, HOST_SESSION_SECRET: secret, NIHO_FIREBASE_WEB_API_KEY: "key", HOST_PWA_ENABLED: "true", HOST_PUSH_ENABLED: "true",
      HOST_PUSH_VAPID_PUBLIC_KEY: `B${"x".repeat(86)}`, HOST_PUSH_VAPID_PRIVATE_KEY: "p".repeat(43), HOST_PUSH_VAPID_SUBJECT: "mailto:host-push@example.test",
    };
    const job = {
      HOST_PUSH_JOB_AUDIENCE: "https://experience.example/internal/host-push",
      HOST_PUSH_JOB_SERVICE_ACCOUNT_EMAIL: "host-push-job@example.iam.gserviceaccount.com",
      EXPERIENCE_DATABASE_URL: "postgresql://synthetic.invalid/experience",
    };
    const off = { hostPushJobEnabled: false, hostPushJobAudience: "", hostPushJobServiceAccountEmail: "" };
    expect(resolveConfig({})).toMatchObject(off);
    expect(resolveConfig({ ...push, ...job })).toMatchObject({
      hostPushJobEnabled: true,
      hostPushJobAudience: job.HOST_PUSH_JOB_AUDIENCE,
      hostPushJobServiceAccountEmail: job.HOST_PUSH_JOB_SERVICE_ACCOUNT_EMAIL,
    });
    // Push on without the job: test notifications only.
    expect(resolveConfig(push)).toMatchObject({ hostPushEnabled: true, ...off });
    // Push off, or mock mode: the job stays closed whatever is set.
    expect(resolveConfig({ ...push, ...job, HOST_PUSH_ENABLED: "false" })).toMatchObject(off);
    expect(resolveConfig({ ...push, ...job, EXPERIENCE_API_MODE: "mock" })).toMatchObject(off);
    // Half a setting, a malformed account or no database stops the start-up.
    expect(() => resolveConfig({ ...push, ...job, HOST_PUSH_JOB_AUDIENCE: "" })).toThrow(/HOST_PUSH_JOB_AUDIENCE/);
    expect(() => resolveConfig({ ...push, ...job, HOST_PUSH_JOB_SERVICE_ACCOUNT_EMAIL: "" })).toThrow(/HOST_PUSH_JOB_SERVICE_ACCOUNT_EMAIL/);
    expect(() => resolveConfig({ ...push, ...job, HOST_PUSH_JOB_SERVICE_ACCOUNT_EMAIL: "job@example.com" })).toThrow(/HOST_PUSH_JOB_SERVICE_ACCOUNT_EMAIL/);
    expect(() => resolveConfig({ ...push, ...job, EXPERIENCE_DATABASE_URL: "" })).toThrow(/EXPERIENCE_DATABASE_URL/);
  });

  it("opens each Google calendar job only in http mode with its flag, the job identity, the DB and the Google client", () => {
    const google = {
      EXPERIENCE_API_MODE: "http",
      EXPERIENCE_GOOGLE_JOBS_AUDIENCE: "https://experience.example/internal/google-calendar",
      EXPERIENCE_GOOGLE_JOBS_SERVICE_ACCOUNT_EMAIL: "google-calendar-job@example.iam.gserviceaccount.com",
      EXPERIENCE_DATABASE_URL: "postgresql://synthetic.invalid/experience",
      EXPERIENCE_GOOGLE_CLIENT_ID: "synthetic-client", EXPERIENCE_GOOGLE_CLIENT_SECRET: "synthetic-secret", EXPERIENCE_GOOGLE_TOKEN_KEY: "k".repeat(44),
    };
    const off = { googleBusySyncEnabled: false, googleBookingEventsEnabled: false, googleJobsAudience: "", googleJobsServiceAccountEmail: "" };
    expect(resolveConfig({})).toMatchObject(off);
    expect(resolveConfig(google)).toMatchObject(off);
    expect(resolveConfig({ ...google, EXPERIENCE_API_MODE: "mock", EXPERIENCE_GOOGLE_BUSY_SYNC_ENABLED: "true" })).toMatchObject(off);
    expect(resolveConfig({ ...google, EXPERIENCE_GOOGLE_BUSY_SYNC_ENABLED: "true" })).toMatchObject({
      ...off, googleBusySyncEnabled: true,
      googleJobsAudience: google.EXPERIENCE_GOOGLE_JOBS_AUDIENCE, googleJobsServiceAccountEmail: google.EXPERIENCE_GOOGLE_JOBS_SERVICE_ACCOUNT_EMAIL,
    });
    expect(resolveConfig({ ...google, EXPERIENCE_GOOGLE_BOOKING_EVENTS_ENABLED: "true" })).toMatchObject({ googleBusySyncEnabled: false, googleBookingEventsEnabled: true });
    for (const missing of ["EXPERIENCE_GOOGLE_JOBS_AUDIENCE", "EXPERIENCE_GOOGLE_JOBS_SERVICE_ACCOUNT_EMAIL", "EXPERIENCE_DATABASE_URL", "EXPERIENCE_GOOGLE_CLIENT_ID", "EXPERIENCE_GOOGLE_TOKEN_KEY"]) {
      expect(() => resolveConfig({ ...google, EXPERIENCE_GOOGLE_BUSY_SYNC_ENABLED: "true", [missing]: "" })).toThrow(new RegExp(missing));
    }
    expect(() => resolveConfig({ ...google, EXPERIENCE_GOOGLE_BOOKING_EVENTS_ENABLED: "true", EXPERIENCE_GOOGLE_JOBS_SERVICE_ACCOUNT_EMAIL: "job@example.com" })).toThrow(/SERVICE_ACCOUNT_EMAIL/);
  });

  it("allows the labelled development key in mock mode only", () => {
    expect(resolveConfig({ HOST_CONSOLE_ENABLED: "true" }).hostSessionSecret).toBe(DEV_ONLY_HOST_SESSION_SECRET);
    expect(resolveConfig({ EXPERIENCE_API_MODE: "http" }).hostSessionSecret).toBe("");
  });

  it("does not need secrets while the console is off in http mode", () => {
    expect(() => resolveConfig({ EXPERIENCE_API_MODE: "http" })).not.toThrow();
  });

  it("fails at start-up when an enabled http console lacks its cookie secret", () => {
    expect(() => resolveConfig({ ...http, NIHO_FIREBASE_WEB_API_KEY: "key" })).toThrow(/HOST_SESSION_SECRET/);
    expect(() => resolveConfig({ ...http, HOST_SESSION_SECRET: "short", NIHO_FIREBASE_WEB_API_KEY: "key" })).toThrow(/HOST_SESSION_SECRET/);
    expect(() => resolveConfig({ ...http, HOST_SESSION_SECRET: DEV_ONLY_HOST_SESSION_SECRET, NIHO_FIREBASE_WEB_API_KEY: "key" })).toThrow(/HOST_SESSION_SECRET/);
    expect(() => resolveConfig({ ...http, HOST_SESSION_SECRET: `${secret},short`, NIHO_FIREBASE_WEB_API_KEY: "key" })).toThrow(/HOST_SESSION_SECRET/);
    const ok = resolveConfig({ ...http, HOST_SESSION_SECRET: ` ${secret} ` });
    expect(ok).toMatchObject({ hostConsoleEnabled: true, hostSessionSecret: secret, nihoFirebaseWebApiKey: "" });
  });
});

describe("admin support console settings", () => {
  it("stays off unless its dedicated flag is exactly true", () => {
    expect(resolveConfig({}).adminSupportConsoleEnabled).toBe(false);
    expect(resolveConfig({ ADMIN_SUPPORT_CONSOLE_ENABLED: "1" }).adminSupportConsoleEnabled).toBe(false);
    expect(resolveConfig({ ADMIN_SUPPORT_CONSOLE_ENABLED: "true" }).adminSupportConsoleEnabled).toBe(true);
  });

  it("keeps the independent Admin read API rollout flag off by default", () => {
    expect(resolveConfig({}).adminSupportReadApiEnabled).toBe(false);
    expect(resolveConfig({ ADMIN_SUPPORT_READ_API_ENABLED: "1" }).adminSupportReadApiEnabled).toBe(false);
    expect(resolveConfig({ ADMIN_SUPPORT_READ_API_ENABLED: "true" }).adminSupportReadApiEnabled).toBe(true);
  });

  it("allows the synthetic read UI preview only in mock mode", () => {
    expect(resolveConfig({ ADMIN_SUPPORT_READ_PREVIEW_ENABLED: "true" }).adminSupportReadPreviewEnabled).toBe(true);
    expect(resolveConfig({ EXPERIENCE_API_MODE: "http", ADMIN_SUPPORT_READ_PREVIEW_ENABLED: "true" }).adminSupportReadPreviewEnabled).toBe(false);
  });

  it("keeps the case API and its synthetic preview behind separate exact flags", () => {
    expect(resolveConfig({ ADMIN_SUPPORT_CASE_API_ENABLED: "true" }).adminSupportCaseApiEnabled).toBe(false);
    expect(resolveConfig({ EXPERIENCE_API_MODE: "http", ADMIN_SUPPORT_CASE_API_ENABLED: "1" }).adminSupportCaseApiEnabled).toBe(false);
    expect(resolveConfig({ EXPERIENCE_API_MODE: "http", ADMIN_SUPPORT_CASE_API_ENABLED: "true" }).adminSupportCaseApiEnabled).toBe(true);
    expect(resolveConfig({ ADMIN_SUPPORT_CASE_PREVIEW_ENABLED: "true" }).adminSupportCasePreviewEnabled).toBe(true);
    expect(resolveConfig({ EXPERIENCE_API_MODE: "http", ADMIN_SUPPORT_CASE_PREVIEW_ENABLED: "true" }).adminSupportCasePreviewEnabled).toBe(false);
  });

  it("keeps operations and host history independently OFF and HTTP-only", () => {
    expect(resolveConfig({}).adminOperationsApiEnabled).toBe(false);
    expect(resolveConfig({ ADMIN_OPERATIONS_API_ENABLED: "true" }).adminOperationsApiEnabled).toBe(false);
    expect(resolveConfig({ EXPERIENCE_API_MODE: "http", ADMIN_OPERATIONS_API_ENABLED: "true" }).adminOperationsApiEnabled).toBe(true);
    expect(resolveConfig({ ADMIN_OPERATIONS_PREVIEW_ENABLED: "true" }).adminOperationsPreviewEnabled).toBe(true);
    expect(resolveConfig({ EXPERIENCE_API_MODE: "http", ADMIN_OPERATIONS_PREVIEW_ENABLED: "true" }).adminOperationsPreviewEnabled).toBe(false);
    expect(resolveConfig({}).adminSiteBookingsPreviewEnabled).toBe(false);
    expect(resolveConfig({ ADMIN_SITE_BOOKINGS_PREVIEW_ENABLED: "1" }).adminSiteBookingsPreviewEnabled).toBe(false);
    expect(resolveConfig({ ADMIN_SITE_BOOKINGS_PREVIEW_ENABLED: "true" }).adminSiteBookingsPreviewEnabled).toBe(true);
    expect(resolveConfig({ EXPERIENCE_API_MODE: "http", ADMIN_SITE_BOOKINGS_PREVIEW_ENABLED: "true" }).adminSiteBookingsPreviewEnabled).toBe(false);
    expect(resolveConfig({ HOST_SUPPORT_HISTORY_API_ENABLED: "true" }).hostSupportHistoryApiEnabled).toBe(false);
    expect(resolveConfig({ EXPERIENCE_API_MODE: "http", HOST_SUPPORT_HISTORY_API_ENABLED: "true" }).hostSupportHistoryApiEnabled).toBe(true);
    expect(resolveConfig({ HOST_SUPPORT_SETTINGS_API_ENABLED: "true" }).hostSupportSettingsApiEnabled).toBe(false);
    expect(resolveConfig({ EXPERIENCE_API_MODE: "http", HOST_SUPPORT_SETTINGS_API_ENABLED: "true" }).hostSupportSettingsApiEnabled).toBe(true);
    expect(resolveConfig({ HOST_SUPPORT_SETTINGS_PREVIEW_ENABLED: "true" }).hostSupportSettingsPreviewEnabled).toBe(true);
    expect(resolveConfig({ EXPERIENCE_API_MODE: "http", HOST_SUPPORT_SETTINGS_PREVIEW_ENABLED: "true" }).hostSupportSettingsPreviewEnabled).toBe(false);
  });

  it("keeps the shared fee summary API and UI preview behind separate exact mode gates", () => {
    expect(resolveConfig({})).toMatchObject({ experienceFeeSummaryApiEnabled: false, experienceFeeSummaryPreviewEnabled: false });
    expect(resolveConfig({ EXPERIENCE_FEE_SUMMARY_API_ENABLED: "true" }).experienceFeeSummaryApiEnabled).toBe(false);
    expect(resolveConfig({ EXPERIENCE_API_MODE: "http", EXPERIENCE_FEE_SUMMARY_API_ENABLED: "1" }).experienceFeeSummaryApiEnabled).toBe(false);
    expect(resolveConfig({ EXPERIENCE_API_MODE: "http", EXPERIENCE_FEE_SUMMARY_API_ENABLED: "true" }).experienceFeeSummaryApiEnabled).toBe(true);
    expect(resolveConfig({ EXPERIENCE_FEE_SUMMARY_PREVIEW_ENABLED: "true" }).experienceFeeSummaryPreviewEnabled).toBe(true);
    expect(resolveConfig({ EXPERIENCE_API_MODE: "http", EXPERIENCE_FEE_SUMMARY_PREVIEW_ENABLED: "true" }).experienceFeeSummaryPreviewEnabled).toBe(false);
  });

  it("separates assisted-launch HTTP and synthetic UI preview gates", () => {
    expect(resolveConfig({})).toMatchObject({ experienceAssistedLaunchApiEnabled: false, experienceAssistedLaunchPreviewEnabled: false });
    expect(resolveConfig({ EXPERIENCE_ASSISTED_LAUNCH_API_ENABLED: "true" }).experienceAssistedLaunchApiEnabled).toBe(false);
    expect(resolveConfig({ EXPERIENCE_API_MODE: "http", EXPERIENCE_ASSISTED_LAUNCH_API_ENABLED: "1" }).experienceAssistedLaunchApiEnabled).toBe(false);
    expect(resolveConfig({ EXPERIENCE_API_MODE: "http", EXPERIENCE_ASSISTED_LAUNCH_API_ENABLED: "true" }).experienceAssistedLaunchApiEnabled).toBe(true);
    expect(resolveConfig({ EXPERIENCE_ASSISTED_LAUNCH_PREVIEW_ENABLED: "true" }).experienceAssistedLaunchPreviewEnabled).toBe(true);
    expect(resolveConfig({ EXPERIENCE_API_MODE: "http", EXPERIENCE_ASSISTED_LAUNCH_PREVIEW_ENABLED: "true" }).experienceAssistedLaunchPreviewEnabled).toBe(false);
  });

  it("opens the translate rooms BFF in http mode only with its own flag, host console, and database", () => {
    expect(resolveConfig({}).experienceTranslateApiEnabled).toBe(false);
    expect(resolveConfig({ EXPERIENCE_TRANSLATE_API_ENABLED: "true", HOST_CONSOLE_ENABLED: "true" }).experienceTranslateApiEnabled).toBe(false);
    expect(resolveConfig({ EXPERIENCE_API_MODE: "http", EXPERIENCE_TRANSLATE_API_ENABLED: "true" }).experienceTranslateApiEnabled).toBe(false);
    const host = { EXPERIENCE_API_MODE: "http", HOST_CONSOLE_ENABLED: "true", HOST_SESSION_SECRET: "s".repeat(32), NIHO_FIREBASE_WEB_API_KEY: "key", EXPERIENCE_TRANSLATE_API_ENABLED: "true" };
    expect(resolveConfig(host).experienceTranslateApiEnabled).toBe(false);
    const withDatabase = { ...host, EXPERIENCE_DATABASE_URL: "postgresql://synthetic@127.0.0.1/unused" };
    expect(resolveConfig(withDatabase)).toMatchObject({ guestBookingEnabled: false, experienceTranslateApiEnabled: true });
    expect(resolveConfig({ ...withDatabase, EXPERIENCE_GUEST_BOOKING_ENABLED: "false" }).experienceTranslateApiEnabled).toBe(true);
    expect(() => resolveConfig({ ...withDatabase, EXPERIENCE_GUEST_BOOKING_ENABLED: "true" })).toThrow("EXPERIENCE_GUEST_BOOKING_ENABLED=true needs EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY");
    expect(resolveConfig({ ...host, SITE_URL: "https://experience.example", EXPERIENCE_GUEST_BOOKING_ENABLED: "true", EXPERIENCE_DATABASE_URL: "postgresql://synthetic@127.0.0.1/unused", EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY: "sk_test_sample", EXPERIENCE_STRIPE_WEBHOOK_SECRET: "whsec_sample", EXPERIENCE_CHECKOUT_IP_HMAC_KEY: "h".repeat(32), EXPERIENCE_BOOKING_CONSENT_VERSION: "sample-terms-2026-10" }).experienceTranslateApiEnabled).toBe(true);
  });

  it("keeps 設定 › 通知 in the experience DB only in http mode with its own flag and the host console (#109)", () => {
    expect(resolveConfig({}).hostNotificationSettingsEnabled).toBe(false);
    expect(resolveConfig({ HOST_NOTIFICATION_SETTINGS_ENABLED: "true", HOST_CONSOLE_ENABLED: "true" }).hostNotificationSettingsEnabled).toBe(false);
    expect(resolveConfig({ EXPERIENCE_API_MODE: "http", HOST_NOTIFICATION_SETTINGS_ENABLED: "true" }).hostNotificationSettingsEnabled).toBe(false);
    expect(resolveConfig({ EXPERIENCE_API_MODE: "http", HOST_CONSOLE_ENABLED: "true", HOST_SESSION_SECRET: "s".repeat(32), NIHO_FIREBASE_WEB_API_KEY: "key", HOST_NOTIFICATION_SETTINGS_ENABLED: "true" }).hostNotificationSettingsEnabled).toBe(true);
    expect(resolveConfig({}).hostSalesLedgerEnabled).toBe(false);
    expect(resolveConfig({ HOST_SALES_LEDGER_ENABLED: "true", HOST_CONSOLE_ENABLED: "true" }).hostSalesLedgerEnabled).toBe(false);
    expect(resolveConfig({ EXPERIENCE_API_MODE: "http", HOST_SALES_LEDGER_ENABLED: "true" }).hostSalesLedgerEnabled).toBe(false);
    expect(resolveConfig({ EXPERIENCE_API_MODE: "http", HOST_CONSOLE_ENABLED: "true", HOST_SESSION_SECRET: "s".repeat(32), NIHO_FIREBASE_WEB_API_KEY: "key", HOST_SALES_LEDGER_ENABLED: "true" }).hostSalesLedgerEnabled).toBe(true);
  });

  it("opens 設定 › カレンダー's bookings feed only in http mode with the host console, the DB and its key (#109)", () => {
    const host = { EXPERIENCE_API_MODE: "http", HOST_CONSOLE_ENABLED: "true", HOST_SESSION_SECRET: "s".repeat(32), NIHO_FIREBASE_WEB_API_KEY: "key" };
    // base64 of 32 synthetic bytes.
    const feed = { ...host, EXPERIENCE_HOST_CALENDAR_FEED_ENABLED: "true", EXPERIENCE_DATABASE_URL: "postgresql://synthetic.invalid/experience", EXPERIENCE_CALENDAR_FEED_KEY: `${"A".repeat(43)}=` };
    expect(resolveConfig({}).hostCalendarFeedEnabled).toBe(false);
    expect(resolveConfig({ ...feed, EXPERIENCE_API_MODE: "mock" }).hostCalendarFeedEnabled).toBe(false);
    expect(resolveConfig({ ...feed, HOST_CONSOLE_ENABLED: "false" }).hostCalendarFeedEnabled).toBe(false);
    expect(resolveConfig({ ...feed, EXPERIENCE_HOST_CALENDAR_FEED_ENABLED: "1" }).hostCalendarFeedEnabled).toBe(false);
    expect(resolveConfig(feed).hostCalendarFeedEnabled).toBe(true);
    expect(resolveConfig({ ...feed, EXPERIENCE_CALENDAR_FEED_KEY: "B".repeat(64) }).hostCalendarFeedEnabled).toBe(true);
    expect(() => resolveConfig({ ...feed, EXPERIENCE_DATABASE_URL: "" })).toThrow(/EXPERIENCE_DATABASE_URL/);
    for (const key of ["", "A".repeat(40), `${"A".repeat(42)}==`, "not base64 at all!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"]) {
      expect(() => resolveConfig({ ...feed, EXPERIENCE_CALENDAR_FEED_KEY: key })).toThrow(/EXPERIENCE_CALENDAR_FEED_KEY/);
    }
    // The message names the setting, never its value.
    let message = "";
    try {
      resolveConfig({ ...feed, EXPERIENCE_CALENDAR_FEED_KEY: "c2VjcmV0" });
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toMatch(/EXPERIENCE_CALENDAR_FEED_KEY/);
    expect(message).not.toContain("c2VjcmV0");
  });

  it("reads この口座への入金 from Stripe only in http mode under this site's ledger, with the platform key (#91)", () => {
    const ledger = { EXPERIENCE_API_MODE: "http", HOST_CONSOLE_ENABLED: "true", HOST_SESSION_SECRET: "s".repeat(32), NIHO_FIREBASE_WEB_API_KEY: "key", HOST_SALES_LEDGER_ENABLED: "true" };
    const key = { EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY: "sk_test_synthetic" };
    expect(resolveConfig({}).hostSalesPayoutsEnabled).toBe(false);
    expect(resolveConfig({ HOST_SALES_PAYOUTS_ENABLED: "true", ...key }).hostSalesPayoutsEnabled).toBe(false);
    expect(resolveConfig({ ...ledger, ...key }).hostSalesPayoutsEnabled).toBe(false);
    expect(resolveConfig({ ...ledger, ...key, HOST_SALES_PAYOUTS_ENABLED: "true" }).hostSalesPayoutsEnabled).toBe(true);
    expect(() => resolveConfig({ ...ledger, HOST_SALES_LEDGER_ENABLED: "false", ...key, HOST_SALES_PAYOUTS_ENABLED: "true" })).toThrow("HOST_SALES_PAYOUTS_ENABLED=true needs HOST_SALES_LEDGER_ENABLED=true");
    expect(() => resolveConfig({ ...ledger, HOST_SALES_PAYOUTS_ENABLED: "true" })).toThrow("HOST_SALES_PAYOUTS_ENABLED=true needs EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY in http mode");
    try {
      resolveConfig({ ...ledger, EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY: " ", HOST_SALES_PAYOUTS_ENABLED: "true" });
    } catch (error) {
      expect(String(error)).not.toContain("sk_");
    }
  });

  it("keeps questions to the host in the experience DB only in http mode with their own flag (#105 #106)", () => {
    expect(resolveConfig({}).guestQuestionsEnabled).toBe(false);
    expect(resolveConfig({ EXPERIENCE_GUEST_QUESTIONS_ENABLED: "true" }).guestQuestionsEnabled).toBe(false);
    const host = { EXPERIENCE_API_MODE: "http", HOST_CONSOLE_ENABLED: "true", HOST_SESSION_SECRET: "s".repeat(32), NIHO_FIREBASE_WEB_API_KEY: "key" };
    expect(resolveConfig({ ...host, EXPERIENCE_GUEST_QUESTIONS_ENABLED: "1" }).guestQuestionsEnabled).toBe(false);
    expect(resolveConfig({ ...host, EXPERIENCE_GUEST_QUESTIONS_ENABLED: "true" }).guestQuestionsEnabled).toBe(true);
  });

  it("reads published reviews from the experience DB only in http mode with their own flag (#104)", () => {
    expect(resolveConfig({}).guestReviewsEnabled).toBe(false);
    // The mock keeps its synthetic reviews, whatever is set; "1" is not "true".
    expect(resolveConfig({ EXPERIENCE_GUEST_REVIEWS_ENABLED: "true" }).guestReviewsEnabled).toBe(false);
    expect(resolveConfig({ EXPERIENCE_API_MODE: "mock", EXPERIENCE_GUEST_REVIEWS_ENABLED: "true" }).guestReviewsEnabled).toBe(false);
    expect(resolveConfig({ EXPERIENCE_API_MODE: "http", EXPERIENCE_GUEST_REVIEWS_ENABLED: "1" }).guestReviewsEnabled).toBe(false);
    // The public read does not wait for the host console.
    expect(resolveConfig({ EXPERIENCE_API_MODE: "http", EXPERIENCE_GUEST_REVIEWS_ENABLED: "true" }).guestReviewsEnabled).toBe(true);
  });

  it("opens Experience guest questions for the OWNER when the host console is available (#106)", () => {
    // No host console: nobody would see the question.
    expect(resolveConfig({ EXPERIENCE_API_MODE: "http", EXPERIENCE_GUEST_QUESTIONS_ENABLED: "true" }).guestQuestionsEnabled).toBe(false);
    const host = { EXPERIENCE_API_MODE: "http", HOST_CONSOLE_ENABLED: "true", HOST_SESSION_SECRET: "s".repeat(32), NIHO_FIREBASE_WEB_API_KEY: "key" };
    expect(resolveConfig({ ...host, EXPERIENCE_PROVIDER_OPERATIONS_API_ENABLED: "true", EXPERIENCE_GUEST_QUESTIONS_ENABLED: "true" }).guestQuestionsEnabled).toBe(true);
  });

  it("opens NIHO provider page authoring independently from bookings and team operations", () => {
    expect(resolveConfig({}).experienceProviderPagesApiEnabled).toBe(false);
    const host = { EXPERIENCE_API_MODE: "http", HOST_CONSOLE_ENABLED: "true", HOST_SESSION_SECRET: "s".repeat(32), NIHO_FIREBASE_WEB_API_KEY: "key" };
    expect(resolveConfig({ ...host, EXPERIENCE_PROVIDER_PAGES_API_ENABLED: "1" }).experienceProviderPagesApiEnabled).toBe(false);
    expect(resolveConfig({ ...host, EXPERIENCE_PROVIDER_PAGES_API_ENABLED: "true" }).experienceProviderPagesApiEnabled).toBe(true);
    expect(resolveConfig({ ...host, HOST_CONSOLE_ENABLED: "false", EXPERIENCE_PROVIDER_PAGES_API_ENABLED: "true" }).experienceProviderPagesApiEnabled).toBe(false);
    expect(resolveConfig({ ...host, EXPERIENCE_PROVIDER_PAGES_API_ENABLED: "true" })).toMatchObject({
      experienceProviderOperationsApiEnabled: false,
      experienceProviderPagesApiEnabled: true,
    });
  });

  it("sells on this site only in http mode with its own flag, and refuses to start without what a sale needs (#285)", () => {
    const sale = {
      EXPERIENCE_API_MODE: "http",
      SITE_URL: "https://experience.example",
      HOST_CONSOLE_ENABLED: "true",
      HOST_SESSION_SECRET: "s".repeat(32),
      NIHO_FIREBASE_WEB_API_KEY: "key",
      EXPERIENCE_GUEST_BOOKING_ENABLED: "true",
      EXPERIENCE_DATABASE_URL: "postgresql://synthetic@127.0.0.1/unused",
      EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY: "sk_test_sample",
      EXPERIENCE_STRIPE_WEBHOOK_SECRET: "whsec_sample",
      EXPERIENCE_CHECKOUT_IP_HMAC_KEY: "sample-checkout-ip-hmac-key".padEnd(32, "x"),
      EXPERIENCE_BOOKING_CONSENT_VERSION: "sample-terms-2026-10",
    };
    expect(resolveConfig({})).toMatchObject({ guestBookingEnabled: false, guestBookingConsentVersion: "" });
    // The mock keeps NIHO's contract on the api-client mock, whatever is set; "1" is not "true".
    expect(resolveConfig({ ...sale, EXPERIENCE_API_MODE: "mock" }).guestBookingEnabled).toBe(false);
    expect(resolveConfig({ ...sale, EXPERIENCE_GUEST_BOOKING_ENABLED: "1" }).guestBookingEnabled).toBe(false);
    expect(resolveConfig(sale)).toMatchObject({ guestBookingEnabled: true, guestBookingConsentVersion: "sample-terms-2026-10" });
    expect(resolveConfig({ ...sale, EXPERIENCE_BOOKING_CONSENT_VERSION: "  sample-terms-2026-10 " }).guestBookingConsentVersion).toBe("sample-terms-2026-10");
    expect(resolveConfig({ ...sale, SITE_URL: "http://localhost:3000" }).guestBookingEnabled).toBe(true);

    for (const name of ["EXPERIENCE_DATABASE_URL", "EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY", "EXPERIENCE_STRIPE_WEBHOOK_SECRET", "EXPERIENCE_CHECKOUT_IP_HMAC_KEY", "EXPERIENCE_BOOKING_CONSENT_VERSION"]) {
      expect(() => resolveConfig({ ...sale, [name]: undefined })).toThrow(name);
      expect(() => resolveConfig({ ...sale, [name]: " " })).toThrow(name);
    }
    expect(() => resolveConfig({ ...sale, EXPERIENCE_CHECKOUT_IP_HMAC_KEY: "short" })).toThrow(/EXPERIENCE_CHECKOUT_IP_HMAC_KEY/);
    for (const version of ["two words", "x".repeat(101), "terms\u0000"]) {
      expect(() => resolveConfig({ ...sale, EXPERIENCE_BOOKING_CONSENT_VERSION: version })).toThrow(/EXPERIENCE_BOOKING_CONSENT_VERSION/);
    }
    expect(() => resolveConfig({ ...sale, SITE_URL: "http://experience.example" })).toThrow(/HTTPS/);
    // 出欠 (#107): its own flag, and only where the bookings made here are.
    expect(resolveConfig(sale).hostAttendanceEnabled).toBe(false);
    expect(resolveConfig({ ...sale, EXPERIENCE_HOST_ATTENDANCE_ENABLED: "1" }).hostAttendanceEnabled).toBe(false);
    expect(resolveConfig({ ...sale, EXPERIENCE_HOST_ATTENDANCE_ENABLED: "true" }).hostAttendanceEnabled).toBe(true);
    expect(resolveConfig({ ...sale, EXPERIENCE_GUEST_BOOKING_ENABLED: "false", EXPERIENCE_HOST_ATTENDANCE_ENABLED: "true" }).hostAttendanceEnabled).toBe(false);
    expect(resolveConfig({ ...sale, EXPERIENCE_API_MODE: "mock", EXPERIENCE_HOST_ATTENDANCE_ENABLED: "true" }).hostAttendanceEnabled).toBe(false);
    // The host sees these bookings only in the console's 予約 (#285 slice 8): no sale without it.
    for (const hostConsole of [undefined, "false", "1"]) {
      expect(() => resolveConfig({ ...sale, HOST_CONSOLE_ENABLED: hostConsole })).toThrow("EXPERIENCE_GUEST_BOOKING_ENABLED=true needs HOST_CONSOLE_ENABLED=true");
    }
    expect(resolveConfig({ ...sale, HOST_CONSOLE_ENABLED: undefined, EXPERIENCE_GUEST_BOOKING_ENABLED: "false" }).guestBookingEnabled).toBe(false);
    // A refused setting is named, never repeated.
    try {
      resolveConfig({ ...sale, EXPERIENCE_DATABASE_URL: undefined });
    } catch (error) {
      expect(String(error)).not.toMatch(/sk_test_sample|whsec_sample/);
    }
  });

  it("keeps OTA guest details only where the mail job erases them, and pushes OTA bookings only with push (#194)", () => {
    const http = { EXPERIENCE_API_MODE: "http", HOST_CONSOLE_ENABLED: "true" };
    const secret = "s".repeat(32);
    const mail = {
      EXPERIENCE_API_MODE: "http", SITE_URL: "https://experience.example", EXPERIENCE_GUEST_MAIL_ENABLED: "true",
      EXPERIENCE_DATABASE_URL: "postgresql://synthetic@127.0.0.1/unused", EXPERIENCE_SMTP_HOST: "smtp.example.com", EXPERIENCE_SMTP_PORT: "587",
      EXPERIENCE_SMTP_USER: "sample-smtp-user", EXPERIENCE_SMTP_PASSWORD: "sample-smtp-password",
      EXPERIENCE_MAIL_FROM: "NIHO Experiences <experiences@example.com>", EXPERIENCE_MAIL_REPLY_TO: "support@example.com",
      EXPERIENCE_JOBS_AUDIENCE: "https://experience.example/internal/experience-jobs",
      EXPERIENCE_JOBS_SERVICE_ACCOUNT_EMAIL: "experience-jobs@example.iam.gserviceaccount.com",
    };
    const push = {
      ...http, HOST_SESSION_SECRET: secret, NIHO_FIREBASE_WEB_API_KEY: "key", HOST_PWA_ENABLED: "true", HOST_PUSH_ENABLED: "true",
      HOST_PUSH_VAPID_PUBLIC_KEY: `B${"x".repeat(86)}`, HOST_PUSH_VAPID_PRIVATE_KEY: "p".repeat(43), HOST_PUSH_VAPID_SUBJECT: "mailto:host-push@example.test",
    };
    expect(resolveConfig({})).toMatchObject({ otaGuestDetailsEnabled: false, otaBookingNotificationsEnabled: false });
    // The mock never keeps or sends them; "1" is not "true".
    expect(resolveConfig({ EXPERIENCE_OTA_GUEST_DETAILS_ENABLED: "true", EXPERIENCE_OTA_BOOKING_NOTIFICATIONS_ENABLED: "true" }))
      .toMatchObject({ otaGuestDetailsEnabled: false, otaBookingNotificationsEnabled: false });
    expect(resolveConfig({ ...mail, EXPERIENCE_OTA_GUEST_DETAILS_ENABLED: "1" }).otaGuestDetailsEnabled).toBe(false);
    expect(resolveConfig({ ...mail, EXPERIENCE_OTA_GUEST_DETAILS_ENABLED: "true" }).otaGuestDetailsEnabled).toBe(true);
    expect(() => resolveConfig({ ...http, EXPERIENCE_OTA_GUEST_DETAILS_ENABLED: "true" })).toThrow("EXPERIENCE_OTA_GUEST_DETAILS_ENABLED=true needs EXPERIENCE_GUEST_MAIL_ENABLED=true");
    expect(resolveConfig({ ...push, EXPERIENCE_OTA_BOOKING_NOTIFICATIONS_ENABLED: "true" }).otaBookingNotificationsEnabled).toBe(true);
    expect(() => resolveConfig({ ...push, HOST_PUSH_ENABLED: "false", EXPERIENCE_OTA_BOOKING_NOTIFICATIONS_ENABLED: "true" }))
      .toThrow("EXPERIENCE_OTA_BOOKING_NOTIFICATIONS_ENABLED=true needs HOST_PUSH_ENABLED=true");
  });

  it("emails hosts only in http mode with its own flag, and only with the host console and the mail job (#194)", () => {
    const mail = {
      EXPERIENCE_API_MODE: "http", SITE_URL: "https://experience.example", EXPERIENCE_GUEST_MAIL_ENABLED: "true",
      EXPERIENCE_DATABASE_URL: "postgresql://synthetic@127.0.0.1/unused", EXPERIENCE_SMTP_HOST: "smtp.example.com", EXPERIENCE_SMTP_PORT: "587",
      EXPERIENCE_SMTP_USER: "sample-smtp-user", EXPERIENCE_SMTP_PASSWORD: "sample-smtp-password",
      EXPERIENCE_MAIL_FROM: "NIHO Experiences <experiences@example.com>", EXPERIENCE_MAIL_REPLY_TO: "support@example.com",
      EXPERIENCE_JOBS_AUDIENCE: "https://experience.example/internal/experience-jobs",
      EXPERIENCE_JOBS_SERVICE_ACCOUNT_EMAIL: "experience-jobs@example.iam.gserviceaccount.com",
    };
    const host = { HOST_CONSOLE_ENABLED: "true", HOST_SESSION_SECRET: "s".repeat(32), NIHO_FIREBASE_WEB_API_KEY: "key" };
    expect(resolveConfig({}).hostMailEnabled).toBe(false);
    // The mock never copies or sends; "1" is not "true".
    expect(resolveConfig({ EXPERIENCE_HOST_MAIL_ENABLED: "true" }).hostMailEnabled).toBe(false);
    expect(resolveConfig({ ...mail, ...host, EXPERIENCE_HOST_MAIL_ENABLED: "1" }).hostMailEnabled).toBe(false);
    expect(resolveConfig({ ...mail, ...host, EXPERIENCE_HOST_MAIL_ENABLED: "true" }).hostMailEnabled).toBe(true);
    expect(() => resolveConfig({ ...mail, EXPERIENCE_HOST_MAIL_ENABLED: "true" })).toThrow("EXPERIENCE_HOST_MAIL_ENABLED=true needs HOST_CONSOLE_ENABLED=true");
    expect(() => resolveConfig({ EXPERIENCE_API_MODE: "http", ...host, EXPERIENCE_HOST_MAIL_ENABLED: "true" }))
      .toThrow("EXPERIENCE_HOST_MAIL_ENABLED=true needs EXPERIENCE_GUEST_MAIL_ENABLED=true");
  });

  it("sends guest mail only in http mode with its own flag, and refuses to start without SMTP, the senders and the job identity (#285)", () => {
    const mail = {
      EXPERIENCE_API_MODE: "http",
      SITE_URL: "https://experience.example",
      EXPERIENCE_GUEST_MAIL_ENABLED: "true",
      EXPERIENCE_DATABASE_URL: "postgresql://synthetic@127.0.0.1/unused",
      EXPERIENCE_SMTP_HOST: "smtp.example.com",
      EXPERIENCE_SMTP_PORT: "587",
      EXPERIENCE_SMTP_USER: "sample-smtp-user",
      EXPERIENCE_SMTP_PASSWORD: "sample-smtp-password",
      EXPERIENCE_MAIL_FROM: "NIHO Experiences <experiences@example.com>",
      EXPERIENCE_MAIL_REPLY_TO: "support@example.com",
      EXPERIENCE_JOBS_AUDIENCE: "https://experience.example/internal/experience-jobs",
      EXPERIENCE_JOBS_SERVICE_ACCOUNT_EMAIL: "experience-jobs@example.iam.gserviceaccount.com",
    };
    const off = {
      guestMailEnabled: false, guestMailSmtpHost: "", guestMailSmtpPort: 0, guestMailFrom: null, guestMailReplyTo: null,
      experienceJobsAudience: "", experienceJobsServiceAccountEmail: "",
      guestMailFeedbackEnabled: false, guestMailFeedbackAudience: "", guestMailFeedbackServiceAccountEmail: "",
    };
    expect(resolveConfig({})).toMatchObject(off);
    // The mock never sends; "1" is not "true".
    expect(resolveConfig({ ...mail, EXPERIENCE_API_MODE: "mock" })).toMatchObject(off);
    expect(resolveConfig({ ...mail, EXPERIENCE_GUEST_MAIL_ENABLED: "1" })).toMatchObject(off);
    const on = resolveConfig(mail);
    expect(on).toMatchObject({
      guestMailEnabled: true,
      guestMailSmtpHost: "smtp.example.com",
      guestMailSmtpPort: 587,
      guestMailFrom: { name: "NIHO Experiences", address: "experiences@example.com" },
      guestMailReplyTo: { name: "", address: "support@example.com" },
      experienceJobsAudience: mail.EXPERIENCE_JOBS_AUDIENCE,
      experienceJobsServiceAccountEmail: mail.EXPERIENCE_JOBS_SERVICE_ACCOUNT_EMAIL,
      guestMailFeedbackEnabled: false,
    });
    // The SMTP credentials are read where they are used, never kept in config.
    expect(JSON.stringify(on)).not.toMatch(/sample-smtp-user|sample-smtp-password/);
    expect(resolveConfig({ ...mail, SITE_URL: "http://localhost:3000" }).guestMailEnabled).toBe(true);

    const feedback = {
      ...mail,
      EXPERIENCE_MAIL_FEEDBACK_AUDIENCE: "https://experience.example/internal/experience-mail-feedback/v1/events",
      EXPERIENCE_MAIL_FEEDBACK_SERVICE_ACCOUNT_EMAIL: "niho-api@example.iam.gserviceaccount.com",
    };
    expect(resolveConfig(feedback)).toMatchObject({
      guestMailFeedbackEnabled: true,
      guestMailFeedbackAudience: feedback.EXPERIENCE_MAIL_FEEDBACK_AUDIENCE,
      guestMailFeedbackServiceAccountEmail: feedback.EXPERIENCE_MAIL_FEEDBACK_SERVICE_ACCOUNT_EMAIL,
    });
    expect(() => resolveConfig({ ...mail, EXPERIENCE_MAIL_FEEDBACK_AUDIENCE: feedback.EXPERIENCE_MAIL_FEEDBACK_AUDIENCE }))
      .toThrow("EXPERIENCE_MAIL_FEEDBACK_AUDIENCE and EXPERIENCE_MAIL_FEEDBACK_SERVICE_ACCOUNT_EMAIL must be set together");

    for (const name of [
      "EXPERIENCE_DATABASE_URL", "EXPERIENCE_SMTP_HOST", "EXPERIENCE_SMTP_PORT", "EXPERIENCE_SMTP_USER", "EXPERIENCE_SMTP_PASSWORD",
      "EXPERIENCE_MAIL_FROM", "EXPERIENCE_MAIL_REPLY_TO", "EXPERIENCE_JOBS_AUDIENCE", "EXPERIENCE_JOBS_SERVICE_ACCOUNT_EMAIL",
    ]) {
      expect(() => resolveConfig({ ...mail, [name]: undefined })).toThrow(name);
      expect(() => resolveConfig({ ...mail, [name]: " " })).toThrow(name);
    }
    for (const [name, value] of [
      ["EXPERIENCE_SMTP_HOST", "smtp://smtp.example.com"],
      ["EXPERIENCE_SMTP_HOST", "smtp.example.com:587"],
      ["EXPERIENCE_SMTP_PORT", "0"],
      ["EXPERIENCE_SMTP_PORT", "65536"],
      ["EXPERIENCE_SMTP_PORT", "587a"],
      ["EXPERIENCE_MAIL_FROM", "NIHO Experiences"],
      ["EXPERIENCE_MAIL_FROM", "NIHO <experiences@example.com>\r\nBcc: other@example.com"],
      ["EXPERIENCE_MAIL_REPLY_TO", "support@example.com, other@example.com"],
      ["EXPERIENCE_JOBS_SERVICE_ACCOUNT_EMAIL", "experience-jobs@example.com"],
    ] as const) {
      expect(() => resolveConfig({ ...mail, [name]: value })).toThrow(name);
    }
    expect(() => resolveConfig({ ...mail, SITE_URL: "http://experience.example" })).toThrow(/HTTPS/);
    // A refused setting is named, never repeated.
    for (const name of ["EXPERIENCE_SMTP_HOST", "EXPERIENCE_SMTP_PORT", "EXPERIENCE_MAIL_FROM"]) {
      try {
        resolveConfig({ ...mail, [name]: "bad value <sample-smtp-password>" });
      } catch (error) {
        expect(String(error)).not.toMatch(/sample-smtp|bad value/);
      }
    }
  });

  it("translates with the Claude API only in http mode with its own flag, and refuses to start without its key (#285)", () => {
    const translation = { EXPERIENCE_API_MODE: "http", EXPERIENCE_TRANSLATION_ENABLED: "true", EXPERIENCE_ANTHROPIC_API_KEY: "sample-anthropic-key" };
    expect(resolveConfig({}).translationEnabled).toBe(false);
    // The mock never calls the API; "1" is not "true".
    expect(resolveConfig({ ...translation, EXPERIENCE_API_MODE: "mock" }).translationEnabled).toBe(false);
    expect(resolveConfig({ ...translation, EXPERIENCE_TRANSLATION_ENABLED: "1" }).translationEnabled).toBe(false);
    const on = resolveConfig(translation);
    expect(on.translationEnabled).toBe(true);
    // The key is read where it is used, never kept in config.
    expect(JSON.stringify(on)).not.toMatch(/sample-anthropic-key/);
    for (const value of [undefined, " "]) {
      expect(() => resolveConfig({ ...translation, EXPERIENCE_ANTHROPIC_API_KEY: value })).toThrow("EXPERIENCE_ANTHROPIC_API_KEY");
    }
  });

  it("links NIHO's privacy policy from /privacy only when it is a plain https URL, and leaves the link out when unset", () => {
    expect(resolveConfig({}).privacyPolicyUrl).toBe("");
    expect(resolveConfig({ EXPERIENCE_PRIVACY_POLICY_URL: " " }).privacyPolicyUrl).toBe("");
    expect(resolveConfig({ EXPERIENCE_PRIVACY_POLICY_URL: " https://policy.example/legal/privacy " }).privacyPolicyUrl).toBe("https://policy.example/legal/privacy");
    // Both modes read it: the preview shows the same notice.
    expect(resolveConfig({ EXPERIENCE_API_MODE: "http", EXPERIENCE_PRIVACY_POLICY_URL: "https://policy.example/privacy" }).privacyPolicyUrl).toBe("https://policy.example/privacy");
    for (const value of ["http://policy.example/privacy", "https://user:secret@policy.example/privacy", "javascript:alert(1)", "/legal/privacy", "policy.example/privacy", "not a url"]) {
      expect(() => resolveConfig({ EXPERIENCE_PRIVACY_POLICY_URL: value }), value).toThrow("EXPERIENCE_PRIVACY_POLICY_URL");
    }
    // The message names the setting, never its value.
    expect(() => resolveConfig({ EXPERIENCE_PRIVACY_POLICY_URL: "https://user:secret@policy.example/privacy" })).not.toThrow(/secret/);
  });

  it("closes real Admin auth unless its dedicated secret, Firebase key and exact origin are explicit", () => {
    const http = { EXPERIENCE_API_MODE: "http", ADMIN_SUPPORT_CONSOLE_ENABLED: "true", SITE_URL: "https://experience.example" };
    const configured = {
      ...http,
      ADMIN_SESSION_SECRET: "a".repeat(32),
      NIHO_FIREBASE_WEB_API_KEY: "firebase-key",
      NIHO_EXPERIENCE_ADMIN_ORIGIN: "https://experience.example",
    };
    expect(() => resolveConfig(http)).toThrow(/ADMIN_SESSION_SECRET/);
    expect(() => resolveConfig({ ...http, ADMIN_SESSION_SECRET: "a".repeat(32) })).toThrow(/NIHO_FIREBASE_WEB_API_KEY/);
    expect(() => resolveConfig({ ...http, ADMIN_SESSION_SECRET: "a".repeat(32), NIHO_FIREBASE_WEB_API_KEY: "key" })).toThrow(/NIHO_EXPERIENCE_ADMIN_ORIGIN/);
    expect(() => resolveConfig({ ...configured, NIHO_EXPERIENCE_ADMIN_ORIGIN: "https://other.example" })).toThrow(/exactly match/);
    expect(() => resolveConfig({ ...configured, SITE_URL: "http://experience.example", NIHO_EXPERIENCE_ADMIN_ORIGIN: "http://experience.example" })).toThrow(/HTTPS/);
    expect(() => resolveConfig({ ...configured, NEXT_PUBLIC_NIHO_WEB_ORIGIN: "http://niho.example" })).toThrow(/NEXT_PUBLIC_NIHO_WEB_ORIGIN.*HTTPS/);
    expect(resolveConfig(configured)).toMatchObject({ adminSessionSecret: "a".repeat(32), adminOrigin: "https://experience.example" });
    expect(resolveConfig({ ...configured, SITE_URL: "http://localhost:3000", NIHO_EXPERIENCE_ADMIN_ORIGIN: "http://localhost:3000" }).adminOrigin).toBe("http://localhost:3000");
  });
});

describe("guide drafts folder", () => {
  it("is read only in mock mode, as a trimmed absolute path, and is null otherwise", () => {
    expect(resolveConfig({}).guideDraftsDir).toBeNull();
    expect(resolveConfig({ GUIDE_DRAFTS_DIR: "  " }).guideDraftsDir).toBeNull();
    expect(resolveConfig({ GUIDE_DRAFTS_DIR: " /srv/secret/guides " }).guideDraftsDir).toBe("/srv/secret/guides");
    expect(resolveConfig({ EXPERIENCE_API_MODE: "mock", GUIDE_DRAFTS_DIR: "C:\\drafts\\guides" }).guideDraftsDir).toBe("C:\\drafts\\guides");
    expect(resolveConfig({ EXPERIENCE_API_MODE: "http", GUIDE_DRAFTS_DIR: "/srv/secret/guides" }).guideDraftsDir).toBeNull();
  });

  it("fails at start-up on a relative path in mock mode, and ignores it in http mode", () => {
    expect(() => resolveConfig({ GUIDE_DRAFTS_DIR: "drafts" })).toThrow(/GUIDE_DRAFTS_DIR must be an absolute path/);
    expect(() => resolveConfig({ GUIDE_DRAFTS_DIR: "./drafts" })).toThrow(/GUIDE_DRAFTS_DIR must be an absolute path/);
    expect(() => resolveConfig({ GUIDE_DRAFTS_DIR: "~/drafts" })).toThrow(/GUIDE_DRAFTS_DIR must be an absolute path/);
    expect(() => resolveConfig({ EXPERIENCE_API_MODE: "http", GUIDE_DRAFTS_DIR: "drafts" })).not.toThrow();
  });
});

describe("public guide source", () => {
  const database = {
    EXPERIENCE_API_MODE: "http",
    EXPERIENCE_GUIDE_PUBLIC_SOURCE: "database",
    EXPERIENCE_DATABASE_URL: "postgresql://synthetic.invalid/experience",
    GUIDE_MEDIA_BUCKET: "synthetic-private-guide-media",
  };

  it("defaults to static and ignores the database source outside http mode", () => {
    expect(resolveConfig({}).guidePublicSource).toBe("static");
    expect(resolveConfig({ EXPERIENCE_GUIDE_PUBLIC_SOURCE: "database" }).guidePublicSource).toBe("static");
    expect(resolveConfig({ EXPERIENCE_API_MODE: "http", EXPERIENCE_GUIDE_PUBLIC_SOURCE: "DATABASE" }).guidePublicSource).toBe("static");
  });

  it("opens database mode only with both server-side dependencies", () => {
    expect(resolveConfig(database).guidePublicSource).toBe("database");
    expect(() => resolveConfig({ ...database, EXPERIENCE_DATABASE_URL: "" })).toThrow(/EXPERIENCE_DATABASE_URL/);
    expect(() => resolveConfig({ ...database, GUIDE_MEDIA_BUCKET: "" })).toThrow(/GUIDE_MEDIA_BUCKET/);
  });
});

describe("editor site entrance (#254)", () => {
  it("stays hidden until set, then keeps only an https origin (loopback http in development)", () => {
    expect(resolveConfig({}).guideEditorSiteOrigin).toBe("");
    expect(resolveConfig({ GUIDE_EDITOR_SITE_ORIGIN: " " }).guideEditorSiteOrigin).toBe("");
    expect(resolveConfig({ GUIDE_EDITOR_SITE_ORIGIN: "https://editor.example/" }).guideEditorSiteOrigin).toBe("https://editor.example");
    expect(resolveConfig({ EXPERIENCE_API_MODE: "http", GUIDE_EDITOR_SITE_ORIGIN: "https://editor.example" }).guideEditorSiteOrigin).toBe("https://editor.example");
    expect(resolveConfig({ GUIDE_EDITOR_SITE_ORIGIN: "http://127.0.0.1:4320" }).guideEditorSiteOrigin).toBe("http://127.0.0.1:4320");
    for (const origin of ["http://editor.example", "editor.example", "https://editor.example/p/new", "https://editor.example/?from=footer", "https://user:pass@editor.example", "javascript:alert(1)"]) {
      expect(() => resolveConfig({ GUIDE_EDITOR_SITE_ORIGIN: origin }), origin).toThrow(/GUIDE_EDITOR_SITE_ORIGIN/);
    }
  });
});

describe("editor public guide source (#252, contract v1)", () => {
  const editor = {
    EXPERIENCE_API_MODE: "http",
    EXPERIENCE_GUIDE_PUBLIC_SOURCE: "editor",
    GUIDE_EDITOR_API_BASE_URL: "https://api.editor.example/v1/",
    GUIDE_EDITOR_API_HANDLE: "exp",
    GUIDE_EDITOR_API_TOKEN: "synthetic-editor-token",
  };

  it("cannot be chosen in mock mode and leaves every editor setting empty otherwise", () => {
    expect(resolveConfig({ ...editor, EXPERIENCE_API_MODE: "mock" })).toMatchObject({
      guidePublicSource: "static",
      guideEditorApiBaseUrl: "",
      guideEditorApiHandle: "",
      guideEditorApiToken: "",
      guideEditorAssetOrigins: [],
    });
    expect(resolveConfig({ ...editor, EXPERIENCE_GUIDE_PUBLIC_SOURCE: "EDITOR" }).guidePublicSource).toBe("static");
  });

  it("opens with the three required settings, trimming the base URL's trailing slash", () => {
    expect(resolveConfig(editor)).toMatchObject({
      guidePublicSource: "editor",
      guideEditorApiBaseUrl: "https://api.editor.example/v1",
      guideEditorApiHandle: "exp",
      guideEditorApiToken: "synthetic-editor-token",
      guideEditorAssetOrigins: ["https://api.editor.example"],
    });
  });

  it("keeps NIHO app cards off by default and enables them only in the HTTP runtime", () => {
    expect(resolveConfig(editor).guideAppCardsEnabled).toBe(false);
    expect(resolveConfig({ ...editor, EXPERIENCE_GUIDE_APP_CARDS_ENABLED: "true" }).guideAppCardsEnabled).toBe(true);
    expect(resolveConfig({ ...editor, EXPERIENCE_API_MODE: "mock", EXPERIENCE_GUIDE_APP_CARDS_ENABLED: "true" }).guideAppCardsEnabled).toBe(false);
  });

  it("refuses to start without any of them, without falling back to static guides", () => {
    expect(() => resolveConfig({ ...editor, GUIDE_EDITOR_API_BASE_URL: "" })).toThrow(/GUIDE_EDITOR_API_BASE_URL/);
    expect(() => resolveConfig({ ...editor, GUIDE_EDITOR_API_HANDLE: " " })).toThrow(/GUIDE_EDITOR_API_HANDLE/);
    expect(() => resolveConfig({ ...editor, GUIDE_EDITOR_API_TOKEN: "" })).toThrow(/GUIDE_EDITOR_API_TOKEN/);
    expect(() => resolveConfig({ ...editor, GUIDE_EDITOR_API_HANDLE: "a/b" })).toThrow(/GUIDE_EDITOR_API_HANDLE/);
  });

  it("reads the editor as the face exp only: another face or an owner's site would list nothing here", () => {
    expect(resolveConfig({ ...editor, GUIDE_EDITOR_API_HANDLE: " exp " }).guideEditorApiHandle).toBe("exp");
    for (const handle of ["niho", "niho-experience", "EXP", "sample-site"]) {
      expect(() => resolveConfig({ ...editor, GUIDE_EDITOR_API_HANDLE: handle }), handle).toThrow(/GUIDE_EDITOR_API_HANDLE must be exp/);
    }
  });

  it("accepts https, or http on loopback only, and never echoes the token in an error", () => {
    expect(resolveConfig({ ...editor, GUIDE_EDITOR_API_BASE_URL: "http://127.0.0.1:4319/v1" }).guideEditorApiBaseUrl).toBe("http://127.0.0.1:4319/v1");
    expect(resolveConfig({ ...editor, GUIDE_EDITOR_API_BASE_URL: "http://localhost:4319/api/public/v1" }).guideEditorApiBaseUrl).toBe("http://localhost:4319/api/public/v1");
    expect(resolveConfig({ ...editor, GUIDE_EDITOR_API_BASE_URL: "http://[::1]:4319/v1" }).guideEditorApiBaseUrl).toBe("http://[::1]:4319/v1");
    for (const base of ["http://api.editor.example/v1", "ftp://api.editor.example/v1", "api.editor.example/v1", "https://user:pass@api.editor.example/v1", "https://api.editor.example/v1?x=1"]) {
      expect(() => resolveConfig({ ...editor, GUIDE_EDITOR_API_BASE_URL: base }), base).toThrow(/GUIDE_EDITOR_API_BASE_URL/);
    }
    let message = "";
    try {
      resolveConfig({ ...editor, GUIDE_EDITOR_API_BASE_URL: "http://api.editor.example/v1" });
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/GUIDE_EDITOR_API_BASE_URL/);
    expect(message).not.toContain(editor.GUIDE_EDITOR_API_TOKEN);
  });

  it("reads the photo origins as https origins only", () => {
    expect(resolveConfig({ ...editor, GUIDE_EDITOR_ASSET_ORIGINS: " https://assets.editor.example , https://cdn.editor.example,https://assets.editor.example " }).guideEditorAssetOrigins)
      .toEqual(["https://assets.editor.example", "https://cdn.editor.example"]);
    expect(() => resolveConfig({ ...editor, GUIDE_EDITOR_ASSET_ORIGINS: "http://assets.editor.example" })).toThrow(/GUIDE_EDITOR_ASSET_ORIGINS/);
    expect(() => resolveConfig({ ...editor, GUIDE_EDITOR_ASSET_ORIGINS: "https://assets.editor.example/photos" })).toThrow(/GUIDE_EDITOR_ASSET_ORIGINS/);
    expect(() => resolveConfig({ ...editor, GUIDE_EDITOR_ASSET_ORIGINS: "assets" })).toThrow(/GUIDE_EDITOR_ASSET_ORIGINS/);
  });
});

describe("OTA channel flags (start-up gate for the deploy table)", () => {
  // Synthetic values only. The host and Admin consoles complete, the experience DB and the Google OAuth client.
  const base = {
    EXPERIENCE_API_MODE: "http",
    SITE_URL: "https://experience.example",
    HOST_CONSOLE_ENABLED: "true",
    HOST_SESSION_SECRET: "s".repeat(32),
    ADMIN_SUPPORT_CONSOLE_ENABLED: "true",
    ADMIN_SESSION_SECRET: "a".repeat(32),
    NIHO_FIREBASE_WEB_API_KEY: "firebase-key",
    NIHO_EXPERIENCE_ADMIN_ORIGIN: "https://experience.example",
    EXPERIENCE_DATABASE_URL: "postgresql://synthetic.invalid/experience",
    EXPERIENCE_GOOGLE_CLIENT_ID: "synthetic-client-id",
    EXPERIENCE_GOOGLE_CLIENT_SECRET: "synthetic-client-secret",
    EXPERIENCE_GOOGLE_TOKEN_KEY: "synthetic-token-key",
  };
  const watchdog = {
    EXPERIENCE_CHANNEL_WATCHDOG_ENABLED: "true",
    EXPERIENCE_CHANNEL_WATCHDOG_AUDIENCE: "https://experience.example",
    EXPERIENCE_CHANNEL_WATCHDOG_SERVICE_ACCOUNT_EMAIL: "experience-ota-watchdog@sample-project.iam.gserviceaccount.com",
  };
  const manager = { EXPERIENCE_CHANNEL_MANAGER_ENABLED: "true" };
  const runtime = {
    ...watchdog,
    ...manager,
    EXPERIENCE_CHANNEL_RUNTIME_ENABLED: "true",
    EXPERIENCE_CHANNEL_SUPPORTED_ADAPTERS: "GetYourGuide/gyg-browser@1=observe+close+open+create;Airbnb/airbnb-google-busy@1=observe+open+close",
  };
  const resourceGoogle = { EXPERIENCE_RESOURCE_GOOGLE_ENABLED: "true" };
  const resourceGoogleWatch = {
    ...resourceGoogle,
    EXPERIENCE_RESOURCE_GOOGLE_WATCH_ENABLED: "true",
    EXPERIENCE_RESOURCE_GOOGLE_WEBHOOK_URL: "https://experience.example/api/google/calendar/watch",
  };
  const airbnbSetup = { EXPERIENCE_AIRBNB_GOOGLE_SETUP_ENABLED: "true" };
  const airbnbDelivery = { ...runtime, EXPERIENCE_AIRBNB_GOOGLE_DELIVERY_ENABLED: "true" };

  // What each console and backing setting takes in http mode, so a row can start with only what it needs.
  const HOST = ["HOST_CONSOLE_ENABLED", "HOST_SESSION_SECRET"];
  const ADMIN = ["ADMIN_SUPPORT_CONSOLE_ENABLED", "ADMIN_SESSION_SECRET", "NIHO_FIREBASE_WEB_API_KEY", "NIHO_EXPERIENCE_ADMIN_ORIGIN"];
  const DB = ["EXPERIENCE_DATABASE_URL"];
  const OAUTH = ["EXPERIENCE_GOOGLE_CLIENT_ID", "EXPERIENCE_GOOGLE_CLIENT_SECRET", "EXPERIENCE_GOOGLE_TOKEN_KEY"];

  type Row = {
    key: keyof ReturnType<typeof resolveConfig>;
    env: string;
    vars: Record<string, string>;
    /** The base settings it takes, directly or through the flags it needs. */
    context: readonly string[];
    /** Each setting it needs: removed (or the console turned off), the start-up names it. */
    needs: readonly string[];
  };
  const rows: Row[] = [
    { key: "channelWatchdogEnabled", env: "EXPERIENCE_CHANNEL_WATCHDOG_ENABLED", vars: watchdog, context: [...HOST, ...DB], needs: ["HOST_CONSOLE_ENABLED", "EXPERIENCE_DATABASE_URL", "EXPERIENCE_CHANNEL_WATCHDOG_AUDIENCE", "EXPERIENCE_CHANNEL_WATCHDOG_SERVICE_ACCOUNT_EMAIL"] },
    { key: "channelManagerEnabled", env: "EXPERIENCE_CHANNEL_MANAGER_ENABLED", vars: manager, context: [...ADMIN, ...DB], needs: ["ADMIN_SUPPORT_CONSOLE_ENABLED", "EXPERIENCE_DATABASE_URL"] },
    { key: "channelRuntimeEnabled", env: "EXPERIENCE_CHANNEL_RUNTIME_ENABLED", vars: runtime, context: [...HOST, ...ADMIN, ...DB], needs: ["EXPERIENCE_CHANNEL_MANAGER_ENABLED", "EXPERIENCE_CHANNEL_WATCHDOG_ENABLED", "EXPERIENCE_DATABASE_URL", "EXPERIENCE_CHANNEL_SUPPORTED_ADAPTERS"] },
    { key: "resourceGoogleEnabled", env: "EXPERIENCE_RESOURCE_GOOGLE_ENABLED", vars: resourceGoogle, context: [...HOST, ...DB, ...OAUTH], needs: ["HOST_CONSOLE_ENABLED", "EXPERIENCE_DATABASE_URL", ...OAUTH] },
    { key: "resourceGoogleWatchEnabled", env: "EXPERIENCE_RESOURCE_GOOGLE_WATCH_ENABLED", vars: resourceGoogleWatch, context: [...HOST, ...DB, ...OAUTH], needs: ["EXPERIENCE_RESOURCE_GOOGLE_ENABLED", "EXPERIENCE_RESOURCE_GOOGLE_WEBHOOK_URL"] },
    { key: "airbnbGoogleSetupEnabled", env: "EXPERIENCE_AIRBNB_GOOGLE_SETUP_ENABLED", vars: airbnbSetup, context: [...HOST, ...DB, ...OAUTH], needs: ["HOST_CONSOLE_ENABLED", "EXPERIENCE_DATABASE_URL", ...OAUTH] },
    { key: "airbnbGoogleActivationEnabled", env: "EXPERIENCE_AIRBNB_GOOGLE_ACTIVATION_ENABLED", vars: { ...airbnbSetup, EXPERIENCE_AIRBNB_GOOGLE_ACTIVATION_ENABLED: "true" }, context: [...HOST, ...DB, ...OAUTH], needs: ["EXPERIENCE_AIRBNB_GOOGLE_SETUP_ENABLED"] },
    { key: "airbnbGoogleDeliveryEnabled", env: "EXPERIENCE_AIRBNB_GOOGLE_DELIVERY_ENABLED", vars: airbnbDelivery, context: [...HOST, ...ADMIN, ...DB], needs: ["EXPERIENCE_CHANNEL_RUNTIME_ENABLED"] },
    { key: "airbnbGoogleObservationEnabled", env: "EXPERIENCE_AIRBNB_GOOGLE_OBSERVATION_ENABLED", vars: { ...airbnbDelivery, EXPERIENCE_AIRBNB_GOOGLE_OBSERVATION_ENABLED: "true" }, context: [...HOST, ...ADMIN, ...DB], needs: ["EXPERIENCE_AIRBNB_GOOGLE_DELIVERY_ENABLED"] },
  ];
  const minimal = (row: Row): Record<string, string> => ({
    EXPERIENCE_API_MODE: "http",
    SITE_URL: base.SITE_URL,
    ...Object.fromEntries(row.context.map((name) => [name, base[name as keyof typeof base]])),
    ...row.vars,
  });

  /** Without one setting: a console or flag is turned off, anything else is removed. */
  function without(env: Record<string, string>, setting: string): Record<string, string> {
    const copy = { ...env };
    if (setting.endsWith("_ENABLED")) copy[setting] = "false";
    else delete copy[setting];
    return copy;
  }

  it("keeps every flag off by default and in mock mode", () => {
    const keys = rows.map((row) => row.key);
    expect(resolveConfig({})).toMatchObject(Object.fromEntries(keys.map((key) => [key, false])));
    expect(resolveConfig(base)).toMatchObject(Object.fromEntries(keys.map((key) => [key, false])));
  });

  it.each(rows)("$env turns $key on with what it needs only", (row) => {
    expect(resolveConfig(minimal(row))[row.key]).toBe(true);
    expect(resolveConfig({ ...base, ...row.vars })[row.key]).toBe(true);
    // Flags are exact "true".
    expect(resolveConfig({ ...minimal(row), [row.env]: "1" })[row.key]).toBe(false);
  });

  it.each(rows)("$env stops the start-up when one of its needs is missing, naming it", (row) => {
    for (const setting of row.needs) {
      const message = (() => {
        try {
          resolveConfig(without(minimal(row), setting));
        } catch (error) {
          return (error as Error).message;
        }
        return "";
      })();
      expect(message, setting).toContain(setting);
      expect(message, setting).toMatch(/needs .* in http mode$/);
      // It names the setting, never a value.
      expect(message, setting).not.toMatch(/synthetic|sample-project|experience\.example/);
    }
  });

  it.each(rows)("$env stays false in mock mode even with everything set, without stopping", ({ key, vars }) => {
    expect(resolveConfig({ ...base, ...vars, EXPERIENCE_API_MODE: "mock" })[key]).toBe(false);
    expect(resolveConfig({ ...vars, EXPERIENCE_API_MODE: "mock" })[key]).toBe(false);
  });

  it("refuses a watchdog audience that is not an https origin, and a malformed service account", () => {
    for (const audience of ["", "http://experience.example", "https://experience.example/internal/ota", "https://experience.example?x=1", "https://user:pw@experience.example", "experience.example"]) {
      expect(() => resolveConfig({ ...base, ...watchdog, EXPERIENCE_CHANNEL_WATCHDOG_AUDIENCE: audience }), audience).toThrow(/EXPERIENCE_CHANNEL_WATCHDOG_ENABLED=true needs EXPERIENCE_CHANNEL_WATCHDOG_AUDIENCE/);
    }
    expect(resolveConfig({ ...base, ...watchdog, EXPERIENCE_CHANNEL_WATCHDOG_AUDIENCE: "https://experience.example/" }).channelWatchdogEnabled).toBe(true);
    for (const email of ["", "watchdog@example.com", "Watchdog@sample-project.iam.gserviceaccount.com"]) {
      expect(() => resolveConfig({ ...base, ...watchdog, EXPERIENCE_CHANNEL_WATCHDOG_SERVICE_ACCOUNT_EMAIL: email }), email).toThrow(/EXPERIENCE_CHANNEL_WATCHDOG_SERVICE_ACCOUNT_EMAIL/);
    }
  });

  it("refuses the worker runtime with an empty or malformed adapter allowlist, and accepts the JSON form", () => {
    for (const adapters of ["", "{}", "{not json", '{"GetYourGuide/gyg-browser@1":{"canObserve":"yes"}}', "GetYourGuide/gyg-browser@1=observe,close", "GetYourGuide/gyg-browser@1=fly"]) {
      expect(() => resolveConfig({ ...base, ...runtime, EXPERIENCE_CHANNEL_SUPPORTED_ADAPTERS: adapters }), adapters).toThrow(/EXPERIENCE_CHANNEL_RUNTIME_ENABLED=true needs EXPERIENCE_CHANNEL_SUPPORTED_ADAPTERS/);
    }
    expect(resolveConfig({ ...base, ...runtime, EXPERIENCE_CHANNEL_SUPPORTED_ADAPTERS: '{"GetYourGuide/gyg-browser@1":{"canObserve":true,"canReadReservations":false,"canClose":true,"canOpen":true}}' }).channelRuntimeEnabled).toBe(true);
  });

  it("refuses a Google watch webhook that is not the public https /api/google/calendar/watch", () => {
    for (const url of [
      "",
      "http://experience.example/api/google/calendar/watch",
      "https://localhost/api/google/calendar/watch",
      "https://127.0.0.1/api/google/calendar/watch",
      "https://experience.example/api/google/calendar",
      "https://experience.example/api/google/calendar/watch/",
      "https://experience.example/",
      "/api/google/calendar/watch",
    ]) {
      expect(() => resolveConfig({ ...base, ...resourceGoogleWatch, EXPERIENCE_RESOURCE_GOOGLE_WEBHOOK_URL: url }), url).toThrow(/EXPERIENCE_RESOURCE_GOOGLE_WATCH_ENABLED=true needs EXPERIENCE_RESOURCE_GOOGLE_WEBHOOK_URL/);
    }
  });

  it("keeps the watchdog deploys of today starting (host console, DB, audience and service account)", () => {
    expect(resolveConfig({ ...base, ADMIN_SUPPORT_CONSOLE_ENABLED: "false", ...watchdog })).toMatchObject({ channelWatchdogEnabled: true, channelManagerEnabled: false, channelRuntimeEnabled: false });
  });
});
