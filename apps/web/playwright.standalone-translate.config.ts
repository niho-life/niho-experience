import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_TRANSLATE_PORT ?? 3146);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /host-standalone-translate\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: "list",
  use: { baseURL, serviceWorkers: "block", trace: "retain-on-failure" },
  projects: [
    { name: "translate-mobile-320", use: { ...devices["iPhone 13"], browserName: "chromium", viewport: { width: 320, height: 720 } } },
    { name: "translate-mobile-390", use: { ...devices["iPhone 13"], browserName: "chromium", viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: process.env.CI ? "sh scripts/start-standalone.sh" : `npm run dev -- --hostname 127.0.0.1 --port ${port}`,
    url: `${baseURL}/host`,
    timeout: 60_000,
    reuseExistingServer: false,
    env: {
      HOSTNAME: "127.0.0.1", PORT: String(port), SITE_URL: baseURL,
      NEXT_TELEMETRY_DISABLED: "1", EXPERIENCE_API_MODE: "mock", HOST_CONSOLE_ENABLED: "true",
      SITE_INDEXING: "block", NIHO_HOST_START_URL: "https://niho.life/experiences/provider",
    },
  },
});
