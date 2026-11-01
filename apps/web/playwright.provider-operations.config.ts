import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PROVIDER_OPERATIONS_PORT ?? 3111);
const baseURL = `http://127.0.0.1:${PORT}`;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

export default defineConfig({
  testDir: "./e2e",
  // Also 予約's one list of NIHO's bookings and this site's (#84), which needs the provider operations preview.
  testMatch: /(provider-operations|host-bookings-unified)\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { baseURL, trace: "retain-on-failure", launchOptions: { executablePath } },
  projects: [
    { name: "provider-ops-mobile-320", use: { ...devices["Pixel 5"], viewport: { width: 320, height: 720 }, launchOptions: { executablePath } } },
    { name: "provider-ops-mobile-360", use: { ...devices["Pixel 5"], viewport: { width: 360, height: 780 }, launchOptions: { executablePath } } },
    { name: "provider-ops-desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 }, launchOptions: { executablePath } } },
  ],
  webServer: {
    command: `npm run dev -- --hostname 127.0.0.1 --port ${PORT}`,
    url: `${baseURL}/host`,
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
    env: {
      HOSTNAME: "127.0.0.1", PORT: String(PORT), SITE_URL: baseURL, NEXT_TELEMETRY_DISABLED: "1",
      EXPERIENCE_API_MODE: "mock", HOST_CONSOLE_ENABLED: "true",
      EXPERIENCE_PROVIDER_OPERATIONS_PREVIEW_ENABLED: "true", SITE_INDEXING: "block",
    },
  },
});
