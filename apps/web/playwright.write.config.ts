import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_WRITE_PORT ?? 3290);
const baseURL = `http://127.0.0.1:${PORT}`;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /write-ui\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL, serviceWorkers: "block", trace: "retain-on-failure", launchOptions: { executablePath } },
  projects: [
    { name: "write-desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 }, launchOptions: { executablePath } } },
    { name: "write-mobile-360", use: { ...devices["Pixel 5"], viewport: { width: 360, height: 780 }, launchOptions: { executablePath } } },
    { name: "write-mobile-320", use: { ...devices["Pixel 5"], viewport: { width: 320, height: 720 }, launchOptions: { executablePath } } },
  ],
  webServer: {
    command: `npm run dev -- --hostname 127.0.0.1 --port ${PORT}`,
    url: `${baseURL}/write/write-e2e-fixture`,
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
    env: {
      HOSTNAME: "127.0.0.1",
      PORT: String(PORT),
      SITE_URL: baseURL,
      NEXT_TELEMETRY_DISABLED: "1",
      EXPERIENCE_API_MODE: "mock",
      HOST_CONSOLE_ENABLED: "true",
      WRITE_UI_E2E_FIXTURE: "true",
    },
  },
});
