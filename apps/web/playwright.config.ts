import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);
// A second server with the host console on (#86); the first keeps today's /host (console off).
const HOST_PORT = Number(process.env.E2E_HOST_PORT ?? 3101);
const ADMIN_READ_PORT = Number(process.env.E2E_ADMIN_READ_PORT ?? 3102);
const ADMIN_CASE_PORT = Number(process.env.E2E_ADMIN_CASE_PORT ?? 3103);
const FEE_SUMMARY_PORT = Number(process.env.E2E_FEE_SUMMARY_PORT ?? 3104);
// The host console and its preview tests run against the second server.
const HOST_CONSOLE_SPEC = /(host-(console|screens|editor|editor-english|bookings|sales|messages|session|reviews|settings|support|pwa)|admin-support)\.spec\.ts/;
const SEPARATE_PREVIEW_SPEC = /(assisted-launch|provider-operations|host-calendar|admin-channel-workspace|guides-editor-source)\.spec\.ts/;
const ADMIN_READ_SPEC = /admin-http-read\.spec\.ts/;
const ADMIN_CASE_SPEC = /admin-(support-case|operations)\.spec\.ts/;
const FEE_SUMMARY_SPEC = /(admin|host)-fee-summary\.spec\.ts/;
// Synthetic guide drafts (docs/content/guides.md), shown on the first server only. An absolute path, as the setting requires.
const GUIDE_DRAFTS_DIR = fileURLToPath(new URL("./e2e/fixtures/guide-drafts", import.meta.url));
// Cloud sandboxes ship a pre-installed Chromium; CI installs the matching one.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;
const serverEnv = { HOSTNAME: "127.0.0.1", EXPERIENCE_API_MODE: "mock", EXPERIENCE_PUBLIC_API_VERSION: "1.2", SITE_INDEXING: "block", NEXT_TELEMETRY_DISABLED: "1", HOST_SIGNUP_MODE: "pilot", NIHO_HOST_START_URL: "https://niho.life/experiences/provider" };
const mobile = { ...devices["Pixel 5"], viewport: { width: 360, height: 780 }, launchOptions: { executablePath } };
const mobile320 = { ...devices["Pixel 5"], viewport: { width: 320, height: 720 }, launchOptions: { executablePath } };
const desktop = { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 }, launchOptions: { executablePath } };
const hostBaseURL = `http://127.0.0.1:${HOST_PORT}`;
// The second server offers the console as an app (#177), so its pages register /host/sw.js. Only host-pwa.spec.ts
// lets it register: a worker answering page loads would sit between the other specs and their page.route stubs.
const hostUse = { baseURL: hostBaseURL, serviceWorkers: "block" as const };
const adminReadBaseURL = `http://127.0.0.1:${ADMIN_READ_PORT}`;
const adminCaseBaseURL = `http://127.0.0.1:${ADMIN_CASE_PORT}`;
const feeSummaryBaseURL = `http://127.0.0.1:${FEE_SUMMARY_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // Assisted launch uses its one-server config; the default matrix starts five unrelated servers.
  testIgnore: SEPARATE_PREVIEW_SPEC,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    launchOptions: { executablePath },
  },
  projects: [
    { name: "mobile-360", testIgnore: [SEPARATE_PREVIEW_SPEC, HOST_CONSOLE_SPEC, ADMIN_READ_SPEC, ADMIN_CASE_SPEC, FEE_SUMMARY_SPEC], use: mobile },
    { name: "desktop", testIgnore: [SEPARATE_PREVIEW_SPEC, HOST_CONSOLE_SPEC, ADMIN_READ_SPEC, ADMIN_CASE_SPEC, FEE_SUMMARY_SPEC], use: desktop },
    { name: "host-mobile-360", testMatch: HOST_CONSOLE_SPEC, testIgnore: [SEPARATE_PREVIEW_SPEC, ADMIN_CASE_SPEC], use: { ...mobile, ...hostUse } },
    { name: "host-support-mobile-320", testMatch: /host-support\.spec\.ts/, testIgnore: SEPARATE_PREVIEW_SPEC, use: { ...mobile320, ...hostUse } },
    { name: "host-desktop", testMatch: HOST_CONSOLE_SPEC, testIgnore: [SEPARATE_PREVIEW_SPEC, ADMIN_CASE_SPEC], use: { ...desktop, ...hostUse } },
    { name: "admin-read-mobile-360", testMatch: ADMIN_READ_SPEC, testIgnore: [SEPARATE_PREVIEW_SPEC, ADMIN_CASE_SPEC], use: { ...mobile, baseURL: adminReadBaseURL } },
    { name: "admin-read-desktop", testMatch: ADMIN_READ_SPEC, testIgnore: [SEPARATE_PREVIEW_SPEC, ADMIN_CASE_SPEC], use: { ...desktop, baseURL: adminReadBaseURL } },
    { name: "admin-case-mobile-360", testMatch: ADMIN_CASE_SPEC, testIgnore: SEPARATE_PREVIEW_SPEC, use: { ...mobile, baseURL: adminCaseBaseURL } },
    { name: "admin-case-desktop", testMatch: ADMIN_CASE_SPEC, testIgnore: SEPARATE_PREVIEW_SPEC, use: { ...desktop, baseURL: adminCaseBaseURL } },
    { name: "fee-summary-mobile-360", testMatch: FEE_SUMMARY_SPEC, testIgnore: SEPARATE_PREVIEW_SPEC, use: { ...mobile, baseURL: feeSummaryBaseURL } },
    { name: "fee-summary-desktop", testMatch: FEE_SUMMARY_SPEC, testIgnore: SEPARATE_PREVIEW_SPEC, use: { ...desktop, baseURL: feeSummaryBaseURL } },
  ],
  webServer: [
    {
      command: "sh scripts/start-standalone.sh",
      url: `http://127.0.0.1:${PORT}/experiences`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { ...serverEnv, PORT: String(PORT), GUIDE_DRAFTS_DIR },
    },
    {
      command: "sh scripts/start-standalone.sh",
      url: `${hostBaseURL}/host`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      // SITE_URL is this server's origin: the console's same-origin check compares against it.
      // MOCK_CATALOG=pilot, as in the mock preview deployment: the console's experiences are the
      // pilot listings, so their public pages (the editor's プレビュー) open here too.
      env: { ...serverEnv, PORT: String(HOST_PORT), HOST_CONSOLE_ENABLED: "true", HOST_PWA_ENABLED: "true", HOST_PUSH_ENABLED: "true", HOST_SUPPORT_SETTINGS_PREVIEW_ENABLED: "true", ADMIN_SUPPORT_CONSOLE_ENABLED: "true", SITE_URL: hostBaseURL, MOCK_CATALOG: "pilot", GUIDE_EDITOR_SITE_ORIGIN: "https://editor.example" },
    },
    {
      command: "sh scripts/start-standalone.sh",
      url: `${adminReadBaseURL}/admin`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { ...serverEnv, PORT: String(ADMIN_READ_PORT), ADMIN_SUPPORT_CONSOLE_ENABLED: "true", ADMIN_SUPPORT_READ_PREVIEW_ENABLED: "true", SITE_URL: adminReadBaseURL },
    },
    {
      command: "sh scripts/start-standalone.sh",
      url: `${adminCaseBaseURL}/admin`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { ...serverEnv, PORT: String(ADMIN_CASE_PORT), ADMIN_SUPPORT_CONSOLE_ENABLED: "true", ADMIN_SUPPORT_READ_PREVIEW_ENABLED: "true", ADMIN_SUPPORT_CASE_PREVIEW_ENABLED: "true", ADMIN_OPERATIONS_PREVIEW_ENABLED: "true", SITE_URL: adminCaseBaseURL },
    },
    {
      command: "sh scripts/start-standalone.sh",
      url: `${feeSummaryBaseURL}/admin`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { ...serverEnv, PORT: String(FEE_SUMMARY_PORT), HOST_CONSOLE_ENABLED: "true", ADMIN_SUPPORT_CONSOLE_ENABLED: "true", ADMIN_SUPPORT_READ_PREVIEW_ENABLED: "true", EXPERIENCE_FEE_SUMMARY_PREVIEW_ENABLED: "true", SITE_URL: feeSummaryBaseURL },
    },
  ],
});
