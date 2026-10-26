import { describe, expect, it } from "vitest";
import { DEV_ONLY_HOST_SESSION_SECRET, resolveConfig } from "./resolve-config";

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
