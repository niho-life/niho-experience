import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_HOST_CALENDAR_PORT ?? 3112);
const baseURL = `http://127.0.0.1:${PORT}`;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /(?:host-calendar|host-airbnb-google-setup|admin-channel-workspace)\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL, serviceWorkers: "block", trace: "retain-on-failure", launchOptions: { executablePath } },
  projects: [
    { name: "calendar-mobile-320", use: { ...devices["Pixel 5"], viewport: { width: 320, height: 720 }, launchOptions: { executablePath } } },
    { name: "calendar-mobile-360", use: { ...devices["Pixel 5"], viewport: { width: 360, height: 780 }, launchOptions: { executablePath } } },
    { name: "calendar-desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 }, launchOptions: { executablePath } } },
  ],
  webServer: {
    command: process.env.CI ? "sh scripts/start-standalone.sh" : `npm run dev -- --hostname 127.0.0.1 --port ${PORT}`,
    url: `${baseURL}/host`,
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
    env: {
      HOSTNAME: "127.0.0.1", PORT: String(PORT), SITE_URL: baseURL, NEXT_TELEMETRY_DISABLED: "1",
      EXPERIENCE_API_MODE: "mock", HOST_CONSOLE_ENABLED: "true", SITE_INDEXING: "block", ADMIN_SUPPORT_CONSOLE_ENABLED: "true", EXPERIENCE_CHANNEL_WORKSPACE_PREVIEW_ENABLED: "true",
      NIHO_HOST_START_URL: "https://niho.life/experiences/provider",
    },
  },
});
