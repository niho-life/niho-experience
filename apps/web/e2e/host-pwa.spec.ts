import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// The console as an installable app (#177, docs/host-pwa.md). Runs against the second server
// (HOST_CONSOLE_ENABLED=true, HOST_PWA_ENABLED=true, mock mode; see playwright.config.ts), the
// only spec there that lets the service worker register. "Inside the app" is emulated by
// answering `(display-mode: standalone)` as an installed app's page does.

test.use({ serviceWorkers: "allow" });

async function insideTheApp(page: Page) {
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query: string) =>
      query.includes("display-mode: standalone")
        ? ({ matches: true, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false } as MediaQueryList)
        : original(query);
  });
}

const loginLink = (page: Page) => page.getByRole("link", { name: "NIHO でログイン" });
const manifestLinks = (page: Page) => page.locator('link[rel="manifest"]');
const registrations = (page: Page) => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((registration) => new URL(registration.scope).pathname));

test("traveler pages have no manifest and no worker; the console's pages link both", async ({ page }) => {
  for (const path of ["/", "/experiences", "/host"]) {
    await page.goto(path);
    await expect(manifestLinks(page), path).toHaveCount(0);
  }
  expect(await registrations(page)).toEqual([]);

  await page.goto("/host/launch");
  await expect(manifestLinks(page)).toHaveAttribute("href", "/host/manifest.webmanifest");
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", "/host-app/apple-touch-icon.png");
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute("content", "体験ホスト");
  // The worker is the console's alone: its scope is /host/, not the site and not the introduction.
  const worker = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return { scope: new URL(registration.scope).pathname, script: new URL(registration.active!.scriptURL).pathname };
  });
  expect(worker).toEqual({ scope: "/host/", script: "/host/sw.js" });
});

test("the manifest opens the console's start page and stays inside /host/", async ({ request }) => {
  const response = await request.get("/host/manifest.webmanifest");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/manifest+json");
  expect(response.headers()["cache-control"]).toContain("no-store");
  const manifest = await response.json();
  expect(manifest).toMatchObject({ id: "/host/", name: "NIHO 体験ホスト", short_name: "体験ホスト", lang: "ja", start_url: "/host/launch?source=pwa", scope: "/host/", display: "standalone" });
  expect(manifest.shortcuts.map((shortcut: { name: string }) => shortcut.name)).toEqual(["承認待ち", "今日の回", "メッセージ", "カレンダー"]);
  for (const icon of manifest.icons as { src: string }[]) expect((await request.get(icon.src)).headers()["content-type"]).toBe("image/png");

  const worker = await request.get("/host/sw.js");
  expect(worker.headers()["content-type"]).toBe("text/javascript; charset=utf-8");
  expect(await worker.text()).not.toContain("caches.open");
});

test("in a browser, /host/launch signs in as usual and forwards a signed-in host to ホーム", async ({ page }) => {
  await page.goto("/host/launch");
  await expect(page.getByRole("heading", { level: 1, name: "NIHO 体験ホスト" })).toBeVisible();
  await expect(loginLink(page)).toHaveAttribute("href", "/host/auth/login");
  await loginLink(page).click();
  await page.waitForURL(/\/host\/home$/);
  await page.goto("/host/launch");
  await page.waitForURL(/\/host\/home$/);
});

test("inside the app, a browser session is never used: the app signs in on its own and signs out to its start page", async ({ page }) => {
  await insideTheApp(page);
  await page.goto("/host/launch?source=pwa");
  await expect(loginLink(page)).toHaveAttribute("href", "/host/auth/login?surface=app");

  // A browser session, as iOS and macOS Safari copy it into the app: the console sends it back to the start page.
  await page.goto("/host/auth/mock-login");
  await page.waitForURL(/\/host\/launch$/);
  await expect(loginLink(page)).toHaveAttribute("href", "/host/auth/login?surface=app");
  // The refresh call refuses it too, without renewing or clearing it.
  const refresh = await page.evaluate(async () => {
    const response = await fetch("/host/auth/refresh", { method: "POST", headers: { "x-niho-host-display": "standalone" } });
    return { status: response.status, body: await response.json() };
  });
  expect(refresh).toEqual({ status: 401, body: { error: "app_sign_in_required" } });

  await loginLink(page).click();
  await page.waitForURL(/\/host\/home$/);
  await expect(page.getByRole("heading", { level: 1, name: "ホーム" })).toBeVisible();
  // The app's own session opens ホーム from the start page.
  await page.goto("/host/launch?source=pwa");
  await page.waitForURL(/\/host\/home$/);

  await page.goto("/host/settings");
  const device = page.getByRole("region", { name: "この端末" });
  await expect(device.getByRole("group", { name: "アプリ" })).toHaveText("この端末ではアプリとして使っています。");
  await page.getByRole("region", { name: "アカウント" }).getByRole("button", { name: "ログアウト" }).click();
  await page.waitForURL(/\/host\/launch$/);
  await expect(loginLink(page)).toHaveAttribute("href", "/host/auth/login?surface=app");
});

test("設定 shows この端末 above アカウント", async ({ page }) => {
  await page.goto("/host/auth/mock-login");
  await page.waitForURL(/\/host\/home$/);
  await page.goto("/host/settings");
  const headings = await page.locator("main").getByRole("heading", { level: 2 }).allTextContents();
  expect(headings.slice(-2)).toEqual(["この端末", "アカウント"]);
  await expect(page.getByRole("region", { name: "この端末" }).getByRole("group", { name: "アプリ" })).not.toBeEmpty();
});

test("/host/launch has no WCAG 2.2 AA violations, in a browser and inside the app", async ({ page }) => {
  for (const app of [false, true]) {
    if (app) await insideTheApp(page);
    await page.goto("/host/launch");
    await expect(loginLink(page)).toHaveAttribute("href", app ? "/host/auth/login?surface=app" : "/host/auth/login");
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  }
});

// Push (#177 P2) in the preview: HOST_PUSH_ENABLED=true on this server; mock mode checks and answers, never stores or sends.
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const pushRow = (page: Page) => page.getByRole("region", { name: "この端末" }).getByRole("group", { name: "通知" });

/** A stand-in for the browser's Notification and PushManager; the subscription survives reloads in sessionStorage. */
async function stubPush(page: Page) {
  await page.addInitScript(() => {
    const KEY = "e2e-push-subscription";
    let permission: NotificationPermission = sessionStorage.getItem(KEY) ? "granted" : "default";
    const subscription = (key: number[]) => ({
      endpoint: "https://fcm.googleapis.com/fcm/send/e2e-device",
      options: { applicationServerKey: new Uint8Array(key).buffer, userVisibleOnly: true },
      toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/e2e-device", expirationTime: null, keys: { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" } }),
      unsubscribe: async () => { sessionStorage.removeItem(KEY); return true; },
    });
    const stored = () => {
      const raw = sessionStorage.getItem(KEY);
      return raw ? subscription(JSON.parse(raw) as number[]) : null;
    };
    class StubNotification {
      static get permission() { return permission; }
      static async requestPermission() { permission = "granted"; return permission; }
    }
    Object.defineProperty(window, "Notification", { configurable: true, writable: true, value: StubNotification });
    if (!("PushManager" in window)) Object.defineProperty(window, "PushManager", { configurable: true, value: function PushManager() {} });
    const manager = {
      getSubscription: async () => stored(),
      subscribe: async (options: { applicationServerKey: Uint8Array }) => {
        sessionStorage.setItem(KEY, JSON.stringify(Array.from(new Uint8Array(options.applicationServerKey))));
        return stored();
      },
    };
    Object.defineProperty(ServiceWorkerRegistration.prototype, "pushManager", { configurable: true, get: () => manager });
  });
}

function pushCalls(page: Page): string[] {
  const calls: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/host/api/push-subscriptions")) calls.push(`${request.method()} ${url.pathname}`);
  });
  return calls;
}

test.describe("通知 on an iPhone's browser tab", () => {
  test.use({ userAgent: IPHONE });

  test("points to the home-screen app instead of asking", async ({ page }) => {
    await page.goto("/host/auth/mock-login");
    await page.waitForURL(/\/host\/home$/);
    await page.goto("/host/settings");
    await expect(pushRow(page)).toHaveText("ホーム画面に追加したアプリから通知を受け取れます。");
    await expect(page.getByRole("region", { name: "この端末" })).toContainText("ロック画面には体験名・日時・人数だけを表示します。");
  });
});

test("通知 inside the app: on, checked again after a reload, a test, and off, each through the BFF", async ({ page }) => {
  await insideTheApp(page);
  await stubPush(page);
  const calls = pushCalls(page);
  await page.goto("/host/auth/mock-login?surface=app");
  await page.waitForURL(/\/host\/home$/);
  await page.goto("/host/settings");

  const row = pushRow(page);
  await row.getByRole("button", { name: "この端末で通知を受け取る" }).click();
  await expect(row).toContainText("この端末に通知が届きます");
  expect(calls).toEqual(["POST /host/api/push-subscriptions"]);

  // On every visit the server says whether this device is still the host's.
  await page.reload();
  await expect(row).toContainText("この端末に通知が届きます");
  expect(calls.at(-1)).toBe("POST /host/api/push-subscriptions/status");

  await row.getByRole("button", { name: "テスト通知を送る" }).click();
  await expect(page.getByText("プレビューでは通知を送りません。")).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);

  await row.getByRole("button", { name: "この端末の通知を止める" }).click();
  await expect(row.getByRole("button", { name: "この端末で通知を受け取る" })).toBeVisible();
  expect(calls).toEqual(["POST /host/api/push-subscriptions", "POST /host/api/push-subscriptions/status", "POST /host/api/push-subscriptions/test", "DELETE /host/api/push-subscriptions"]);
});
