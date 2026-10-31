import { readFileSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// editor.niho.life as the guide source (#252 #253, contract v1), end to end: the site in http mode reads the
// synthetic fixture from a local stand-in for the editor's public API, and the rest of NIHO's API from a local mock.
// Nothing here reaches a real service, and every value is synthetic.
const PORT = Number(process.env.E2E_GUIDE_EDITOR_PORT ?? 3270);
const NIHO_API_PORT = Number(process.env.E2E_GUIDE_EDITOR_NIHO_PORT ?? 3271);
const EDITOR_API_PORT = Number(process.env.E2E_GUIDE_EDITOR_API_PORT ?? 3272);
const baseURL = `http://127.0.0.1:${PORT}`;
const fixture = JSON.parse(readFileSync(new URL("./src/lib/editor-publication/fixtures/editor-publications.json", import.meta.url), "utf8")) as { handle: string; token: string; assetOrigin: string };
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /guides-editor-source\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL, trace: "retain-on-failure", launchOptions: { executablePath } },
  projects: [
    { name: "guide-editor-desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 }, launchOptions: { executablePath } } },
    { name: "guide-editor-mobile-360", use: { ...devices["Pixel 5"], viewport: { width: 360, height: 780 }, launchOptions: { executablePath } } },
  ],
  webServer: [
    // Any path answers 401 without the fixture's Bearer token, which Playwright counts as up.
    // Four items per list page: the site follows nextCursor across several pages.
    { command: "node scripts/editor-publication-fixture-server.mjs", url: `http://127.0.0.1:${EDITOR_API_PORT}/v1/`, timeout: 15_000, reuseExistingServer: !process.env.CI, env: { EDITOR_FIXTURE_PORT: String(EDITOR_API_PORT), EDITOR_FIXTURE_PAGE_SIZE: "4" } },
    { command: "node e2e/support/document-api.mjs", url: `http://127.0.0.1:${NIHO_API_PORT}/__test/reset`, timeout: 15_000, reuseExistingServer: !process.env.CI, env: { DOCUMENT_API_PORT: String(NIHO_API_PORT) } },
    {
      command: process.env.CI ? "sh scripts/start-standalone.sh" : `npm run dev -- --hostname 127.0.0.1 --port ${PORT}`,
      url: `${baseURL}/guides`,
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
      env: {
        HOSTNAME: "127.0.0.1", PORT: String(PORT), SITE_URL: baseURL, NEXT_TELEMETRY_DISABLED: "1",
        EXPERIENCE_API_MODE: "http", EXPERIENCE_PUBLIC_API_VERSION: "1.2", NEXT_PUBLIC_NIHO_WEB_ORIGIN: `http://127.0.0.1:${NIHO_API_PORT}`,
        // Indexing on, so the test can tell indexable guides from the noindex ones. A loopback server only.
        SITE_INDEXING: "allow",
        EXPERIENCE_GUIDE_PUBLIC_SOURCE: "editor",
        GUIDE_EDITOR_API_BASE_URL: `http://127.0.0.1:${EDITOR_API_PORT}/v1`,
        GUIDE_EDITOR_API_HANDLE: fixture.handle,
        GUIDE_EDITOR_API_TOKEN: fixture.token,
        GUIDE_EDITOR_ASSET_ORIGINS: fixture.assetOrigin,
        GUIDE_EDITOR_SITE_ORIGIN: "https://editor.example",
      },
    },
  ],
});
