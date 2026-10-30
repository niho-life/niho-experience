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

  it("allows the labelled development key in mock mode only", () => {
    expect(resolveConfig({ HOST_CONSOLE_ENABLED: "true" }).hostSessionSecret).toBe(DEV_ONLY_HOST_SESSION_SECRET);
    expect(resolveConfig({ EXPERIENCE_API_MODE: "http" }).hostSessionSecret).toBe("");
  });

  it("does not need secrets while the console is off in http mode", () => {
    expect(() => resolveConfig({ EXPERIENCE_API_MODE: "http" })).not.toThrow();
  });

  it("fails at start-up when an enabled http console lacks its secret or Firebase key", () => {
    expect(() => resolveConfig({ ...http, NIHO_FIREBASE_WEB_API_KEY: "key" })).toThrow(/HOST_SESSION_SECRET/);
    expect(() => resolveConfig({ ...http, HOST_SESSION_SECRET: "short", NIHO_FIREBASE_WEB_API_KEY: "key" })).toThrow(/HOST_SESSION_SECRET/);
    expect(() => resolveConfig({ ...http, HOST_SESSION_SECRET: DEV_ONLY_HOST_SESSION_SECRET, NIHO_FIREBASE_WEB_API_KEY: "key" })).toThrow(/HOST_SESSION_SECRET/);
    expect(() => resolveConfig({ ...http, HOST_SESSION_SECRET: `${secret},short`, NIHO_FIREBASE_WEB_API_KEY: "key" })).toThrow(/HOST_SESSION_SECRET/);
    expect(() => resolveConfig({ ...http, HOST_SESSION_SECRET: secret })).toThrow(/NIHO_FIREBASE_WEB_API_KEY/);
    const ok = resolveConfig({ ...http, HOST_SESSION_SECRET: ` ${secret} `, NIHO_FIREBASE_WEB_API_KEY: " key " });
    expect(ok).toMatchObject({ hostConsoleEnabled: true, hostSessionSecret: secret, nihoFirebaseWebApiKey: "key" });
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

  it("opens the translate rooms BFF in http mode only with its own flag and the host console", () => {
    expect(resolveConfig({}).experienceTranslateApiEnabled).toBe(false);
    expect(resolveConfig({ EXPERIENCE_TRANSLATE_API_ENABLED: "true", HOST_CONSOLE_ENABLED: "true" }).experienceTranslateApiEnabled).toBe(false);
    expect(resolveConfig({ EXPERIENCE_API_MODE: "http", EXPERIENCE_TRANSLATE_API_ENABLED: "true" }).experienceTranslateApiEnabled).toBe(false);
    expect(resolveConfig({ EXPERIENCE_API_MODE: "http", HOST_CONSOLE_ENABLED: "true", HOST_SESSION_SECRET: "s".repeat(32), NIHO_FIREBASE_WEB_API_KEY: "key", EXPERIENCE_TRANSLATE_API_ENABLED: "true" }).experienceTranslateApiEnabled).toBe(true);
  });

  it("keeps 設定 › 通知 in the experience DB only in http mode with its own flag and the host console (#109)", () => {
    expect(resolveConfig({}).hostNotificationSettingsEnabled).toBe(false);
    expect(resolveConfig({ HOST_NOTIFICATION_SETTINGS_ENABLED: "true", HOST_CONSOLE_ENABLED: "true" }).hostNotificationSettingsEnabled).toBe(false);
    expect(resolveConfig({ EXPERIENCE_API_MODE: "http", HOST_NOTIFICATION_SETTINGS_ENABLED: "true" }).hostNotificationSettingsEnabled).toBe(false);
    expect(resolveConfig({ EXPERIENCE_API_MODE: "http", HOST_CONSOLE_ENABLED: "true", HOST_SESSION_SECRET: "s".repeat(32), NIHO_FIREBASE_WEB_API_KEY: "key", HOST_NOTIFICATION_SETTINGS_ENABLED: "true" }).hostNotificationSettingsEnabled).toBe(true);
  });

  it("keeps questions to the host in the experience DB only in http mode with their own flag (#105 #106)", () => {
    expect(resolveConfig({}).guestQuestionsEnabled).toBe(false);
    expect(resolveConfig({ EXPERIENCE_GUEST_QUESTIONS_ENABLED: "true" }).guestQuestionsEnabled).toBe(false);
    const host = { EXPERIENCE_API_MODE: "http", HOST_CONSOLE_ENABLED: "true", HOST_SESSION_SECRET: "s".repeat(32), NIHO_FIREBASE_WEB_API_KEY: "key" };
    expect(resolveConfig({ ...host, EXPERIENCE_GUEST_QUESTIONS_ENABLED: "1" }).guestQuestionsEnabled).toBe(false);
    expect(resolveConfig({ ...host, EXPERIENCE_GUEST_QUESTIONS_ENABLED: "true" }).guestQuestionsEnabled).toBe(true);
  });

  it("takes no question the OWNER could not read (#106)", () => {
    // No host console: nobody would see the question.
    expect(resolveConfig({ EXPERIENCE_API_MODE: "http", EXPERIENCE_GUEST_QUESTIONS_ENABLED: "true" }).guestQuestionsEnabled).toBe(false);
    // メッセージ shows NIHO's booking messages instead of the questions.
    const host = { EXPERIENCE_API_MODE: "http", HOST_CONSOLE_ENABLED: "true", HOST_SESSION_SECRET: "s".repeat(32), NIHO_FIREBASE_WEB_API_KEY: "key" };
    expect(resolveConfig({ ...host, EXPERIENCE_PROVIDER_OPERATIONS_API_ENABLED: "true", EXPERIENCE_GUEST_QUESTIONS_ENABLED: "true" }).guestQuestionsEnabled).toBe(false);
  });

  it("sells on this site only in http mode with its own flag, and refuses to start without what a sale needs (#285)", () => {
    const sale = {
      EXPERIENCE_API_MODE: "http",
      SITE_URL: "https://experience.example",
      EXPERIENCE_GUEST_BOOKING_ENABLED: "true",
      EXPERIENCE_DATABASE_URL: "postgresql://synthetic@127.0.0.1/unused",
      EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY: "sk_test_sample",
      EXPERIENCE_STRIPE_WEBHOOK_SECRET: "whsec_sample",
      EXPERIENCE_BOOKING_CONSENT_VERSION: "sample-terms-2026-10",
    };
    expect(resolveConfig({})).toMatchObject({ guestBookingEnabled: false, guestBookingConsentVersion: "" });
    // The mock keeps NIHO's contract on the api-client mock, whatever is set; "1" is not "true".
    expect(resolveConfig({ ...sale, EXPERIENCE_API_MODE: "mock" }).guestBookingEnabled).toBe(false);
    expect(resolveConfig({ ...sale, EXPERIENCE_GUEST_BOOKING_ENABLED: "1" }).guestBookingEnabled).toBe(false);
    expect(resolveConfig(sale)).toMatchObject({ guestBookingEnabled: true, guestBookingConsentVersion: "sample-terms-2026-10" });
    expect(resolveConfig({ ...sale, EXPERIENCE_BOOKING_CONSENT_VERSION: "  sample-terms-2026-10 " }).guestBookingConsentVersion).toBe("sample-terms-2026-10");
    expect(resolveConfig({ ...sale, SITE_URL: "http://localhost:3000" }).guestBookingEnabled).toBe(true);

    for (const name of ["EXPERIENCE_DATABASE_URL", "EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY", "EXPERIENCE_STRIPE_WEBHOOK_SECRET", "EXPERIENCE_BOOKING_CONSENT_VERSION"]) {
      expect(() => resolveConfig({ ...sale, [name]: undefined })).toThrow(name);
      expect(() => resolveConfig({ ...sale, [name]: " " })).toThrow(name);
    }
    for (const version of ["two words", "x".repeat(101), "terms\u0000"]) {
      expect(() => resolveConfig({ ...sale, EXPERIENCE_BOOKING_CONSENT_VERSION: version })).toThrow(/EXPERIENCE_BOOKING_CONSENT_VERSION/);
    }
    expect(() => resolveConfig({ ...sale, SITE_URL: "http://experience.example" })).toThrow(/HTTPS/);
    // A refused setting is named, never repeated.
    try {
      resolveConfig({ ...sale, EXPERIENCE_DATABASE_URL: undefined });
    } catch (error) {
      expect(String(error)).not.toMatch(/sk_test_sample|whsec_sample/);
    }
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

describe("editor public guide source (#252, provisional contract)", () => {
  const editor = {
    EXPERIENCE_API_MODE: "http",
    EXPERIENCE_GUIDE_PUBLIC_SOURCE: "editor",
    GUIDE_EDITOR_API_BASE_URL: "https://api.editor.example/v1/",
    GUIDE_EDITOR_API_HANDLE: "niho-experience",
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
      guideEditorApiHandle: "niho-experience",
      guideEditorApiToken: "synthetic-editor-token",
      guideEditorAssetOrigins: ["https://api.editor.example"],
    });
  });

  it("refuses to start without any of them, without falling back to static guides", () => {
    expect(() => resolveConfig({ ...editor, GUIDE_EDITOR_API_BASE_URL: "" })).toThrow(/GUIDE_EDITOR_API_BASE_URL/);
    expect(() => resolveConfig({ ...editor, GUIDE_EDITOR_API_HANDLE: " " })).toThrow(/GUIDE_EDITOR_API_HANDLE/);
    expect(() => resolveConfig({ ...editor, GUIDE_EDITOR_API_TOKEN: "" })).toThrow(/GUIDE_EDITOR_API_TOKEN/);
    expect(() => resolveConfig({ ...editor, GUIDE_EDITOR_API_HANDLE: "a/b" })).toThrow(/GUIDE_EDITOR_API_HANDLE/);
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

describe("editor console settings", () => {
  const configured = {
    EXPERIENCE_API_MODE: "http",
    EDITOR_CONSOLE_ENABLED: "true",
    EDITOR_SESSION_SECRET: "e".repeat(32),
    NIHO_FIREBASE_WEB_API_KEY: "firebase-key",
    NIHO_EXPERIENCE_EDITOR_ORIGIN: "https://experience.example",
    SITE_URL: "https://experience.example",
  };

  it("stays closed by default, in mock mode, or when any dedicated setting is missing", () => {
    expect(resolveConfig({})).toMatchObject({ editorConsoleEnabled: false, editorSessionSecret: "", editorOrigin: "" });
    expect(resolveConfig({ ...configured, EXPERIENCE_API_MODE: "mock" }).editorConsoleEnabled).toBe(false);
    expect(resolveConfig({ ...configured, EDITOR_CONSOLE_ENABLED: "1" }).editorConsoleEnabled).toBe(false);
    expect(resolveConfig({ ...configured, EDITOR_SESSION_SECRET: "" }).editorConsoleEnabled).toBe(false);
    expect(resolveConfig({ ...configured, EDITOR_SESSION_SECRET: "short" }).editorConsoleEnabled).toBe(false);
    expect(resolveConfig({ ...configured, HOST_SESSION_SECRET: configured.EDITOR_SESSION_SECRET }).editorConsoleEnabled).toBe(false);
    expect(resolveConfig({ ...configured, ADMIN_SESSION_SECRET: configured.EDITOR_SESSION_SECRET }).editorConsoleEnabled).toBe(false);
    expect(resolveConfig({ ...configured, NIHO_FIREBASE_WEB_API_KEY: "" }).editorConsoleEnabled).toBe(false);
    expect(resolveConfig({ ...configured, NIHO_EXPERIENCE_EDITOR_ORIGIN: "" }).editorConsoleEnabled).toBe(false);
  });

  it("opens only for an exact secure origin and an independently keyed cookie", () => {
    expect(resolveConfig(configured)).toMatchObject({
      editorConsoleEnabled: true,
      editorSessionSecret: "e".repeat(32),
      editorOrigin: "https://experience.example",
    });
    expect(() => resolveConfig({ ...configured, NIHO_EXPERIENCE_EDITOR_ORIGIN: "https://other.example" })).toThrow(/exactly match/);
    expect(() => resolveConfig({ ...configured, SITE_URL: "http://experience.example", NIHO_EXPERIENCE_EDITOR_ORIGIN: "http://experience.example" })).toThrow(/HTTPS/);
    expect(() => resolveConfig({ ...configured, NEXT_PUBLIC_NIHO_WEB_ORIGIN: "http://niho.example" })).toThrow(/NEXT_PUBLIC_NIHO_WEB_ORIGIN.*HTTPS/);
    expect(resolveConfig({ ...configured, SITE_URL: "http://localhost:3000", NIHO_EXPERIENCE_EDITOR_ORIGIN: "http://localhost:3000" }).editorOrigin).toBe("http://localhost:3000");
  });
});
