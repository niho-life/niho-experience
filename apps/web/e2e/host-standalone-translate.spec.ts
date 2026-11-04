import { expect, test, type Page, type Route } from "@playwright/test";

const PROVIDER = "sample-provider-kitchen";
const BASE_PATH = `/host/api/translate/standalone/providers/${PROVIDER}/rooms`;
const expiresAt = "2099-11-04T02:30:00.000Z";
const inviteExpiresAt = "2099-11-04T01:15:00.000Z";
const invite = (role: "host" | "guest", generation = 1) => ({ inviteUrl: `https://app-stg.niho.life/t#${role === "host" ? "h" : "g"}${String(generation).padStart(2, "0")}${"x".repeat(40)}`, expiresAt: inviteExpiresAt });

function syntheticStandaloneRoute(page: Page, inviteExpiry: Partial<Record<"host" | "guest", string>> = {}) {
  let current: Record<string, unknown> | null = null;
  let hostGeneration = 1;
  let guestGeneration = 1;
  let statusReads = 0;
  const roleInvite = (role: "host" | "guest", generation: number) => ({ ...invite(role, generation), expiresAt: inviteExpiry[role] ?? inviteExpiresAt });
  const room = () => current as {
    roomId: string; state: string; hostLanguage: string; guestLanguage: string; expiresAt: string;
    participants: { role: "host" | "guest"; joined: boolean; ready: boolean }[]; usageMinutes: number;
  };
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body), headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" } });
  return page.route("**/host/api/translate/standalone/providers/*/rooms**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!path.startsWith(BASE_PATH)) return route.continue();
    if (request.method() === "GET" && path === `${BASE_PATH}/current`) return json(route, 200, { room: current });
    if (request.method() === "POST" && path === BASE_PATH) {
      if (current) return json(route, 409, { error: "conflict" });
      const body = request.postDataJSON() as { hostLanguage: "ja" | "en" };
      current = {
        roomId: "synthetic-room-1", state: "waiting", hostLanguage: body.hostLanguage, guestLanguage: body.hostLanguage === "ja" ? "en" : "ja", expiresAt,
        participants: [{ role: "host", joined: false, ready: false }, { role: "guest", joined: false, ready: false }], usageMinutes: 0,
      };
      return json(route, 201, { room: current, host: roleInvite("host", hostGeneration), guest: roleInvite("guest", guestGeneration) });
    }
    if (!current) return json(route, 404, { error: "not_found" });
    if (request.method() === "GET" && path === `${BASE_PATH}/${room().roomId}`) {
      statusReads += 1;
      if (statusReads >= 2) room().participants[0] = { role: "host", joined: true, ready: true };
      return json(route, 200, current);
    }
    const inviteMatch = path.match(/\/invites\/(host|guest)$/);
    if (request.method() === "POST" && inviteMatch) {
      const role = inviteMatch[1] as "host" | "guest";
      if (role === "host") hostGeneration += 1; else guestGeneration += 1;
      room().participants[role === "host" ? 0 : 1] = { role, joined: false, ready: false };
      return json(route, 200, { roomId: room().roomId, role, invite: roleInvite(role, role === "host" ? hostGeneration : guestGeneration) });
    }
    if (request.method() === "POST" && path.endsWith("/end")) {
      const roomId = room().roomId;
      current = null;
      return json(route, 200, { roomId, state: "ended" });
    }
    return json(route, 404, { error: "not_found" });
  });
}

const overflowX = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("予約なしcreate→QR→native link→reload/current→明示再発行→end", async ({ page }) => {
  await syntheticStandaloneRoute(page);
  await page.goto("/host/auth/mock-login");
  await expect(page.getByRole("heading", { level: 1, name: "ホーム" })).toBeVisible();
  await page.getByRole("link", { name: "通訳を開く" }).click();
  await expect(page).toHaveURL(/\/host\/translate(?:\?|$)/);
  await expect(page.getByRole("heading", { level: 1, name: "対面通訳" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "日本語" })).toBeChecked();
  await page.getByRole("button", { name: "通訳の部屋を作る" }).click();

  await expect(page.getByRole("img", { name: "相手用の招待QRコード" })).toBeVisible();
  await expect(page.getByText("相手のiPhone標準カメラで読み取ると、NIHOアプリが開きます。")).toBeVisible();
  await expect(page.getByRole("link", { name: "自分のNIHOアプリで開く" })).toHaveAttribute("href", /^https:\/\/app-stg\.niho\.life\/t#/);
  await expect(page.getByText(/最大90分/)).toBeVisible();
  await expect(page.getByText(/15分/).first()).toBeVisible();
  expect(await overflowX(page)).toBeLessThanOrEqual(0);

  await page.reload();
  await expect(page.getByRole("heading", { level: 2, name: "通訳の部屋" })).toBeVisible();
  await expect(page.getByRole("img", { name: "相手用の招待QRコード" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "自分のNIHOアプリで開く" })).toHaveCount(0);
  await page.getByRole("button", { name: "相手用QRを再発行" }).click();
  await expect(page.getByRole("img", { name: "相手用の招待QRコード" })).toBeVisible();

  await expect(page.getByRole("definition").first()).toContainText("接続中", { timeout: 10_000 });
  await page.getByRole("button", { name: "自分用リンクを再発行" }).click();
  const reissue = page.getByRole("dialog", { name: "自分用の招待を再発行しますか？" });
  await expect(reissue).toContainText("古い招待と接続は使えなくなります");
  await reissue.getByRole("button", { name: "再発行する" }).click();
  await expect(page.getByRole("link", { name: "自分のNIHOアプリで開く" })).toBeVisible();

  await page.getByRole("button", { name: "通訳を終了" }).click();
  await page.getByRole("dialog", { name: "通訳を終了しますか？" }).getByRole("button", { name: "通訳を終了する" }).click();
  await expect(page.getByRole("status")).toContainText("通訳を終了しました");
  await expect(page.getByRole("img", { name: "相手用の招待QRコード" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "通訳の部屋を作る" })).toBeVisible();
  expect(await overflowX(page)).toBeLessThanOrEqual(0);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});

test("OWNER以外にはホーム入口も直リンクも出さない", async ({ page }) => {
  await page.goto("/host/auth/mock-login?mock=cohost");
  await expect(page.getByRole("heading", { level: 1, name: "ホーム" })).toBeVisible();
  await expect(page.getByRole("link", { name: "通訳を開く" })).toHaveCount(0);
  expect((await page.goto(`/host/translate?providerId=${PROVIDER}`))?.status()).toBe(404);
});

test("通信断中も異なる期限のQRとリンクをそれぞれ失効させる", async ({ page, context }) => {
  await page.clock.install({ time: new Date("2026-11-04T01:00:00.000Z") });
  await syntheticStandaloneRoute(page, { guest: "2026-11-04T01:15:00.000Z", host: "2026-11-04T01:16:00.000Z" });
  await page.goto("/host/auth/mock-login");
  await page.goto(`/host/translate?providerId=${PROVIDER}`);
  await page.getByRole("button", { name: "通訳の部屋を作る" }).click();
  await expect(page.getByRole("img", { name: "相手用の招待QRコード" })).toBeVisible();
  await context.setOffline(true);
  await page.clock.fastForward(15 * 60_000 + 1);
  await expect(page.getByRole("img", { name: "相手用の招待QRコード" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "自分のNIHOアプリで開く" })).toBeVisible();
  await page.clock.fastForward(60_000);
  await expect(page.getByRole("link", { name: "自分のNIHOアプリで開く" })).toHaveCount(0);
  await context.setOffline(false);
});

for (const lateResult of ["success", "network-error"] as const) {
  test(`pending再発行中の終了後も新規作成でき、古い${lateResult}を破棄する`, async ({ page }) => {
    let current: Record<string, unknown> | null = null;
    let createCount = 0;
    let reissueStarted = false;
    let releaseReissue!: () => void;
    const pendingReissue = new Promise<void>((resolve) => { releaseReissue = resolve; });
    const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    await page.route("**/host/api/translate/standalone/providers/*/rooms**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (!path.startsWith(BASE_PATH)) return route.continue();
      if (request.method() === "GET" && path === `${BASE_PATH}/current`) return json(route, 200, { room: current });
      if (request.method() === "POST" && path === BASE_PATH) {
        createCount += 1;
        current = {
          roomId: `race-room-${createCount}`, state: "waiting", hostLanguage: "ja", guestLanguage: "en", expiresAt,
          participants: [{ role: "host", joined: false, ready: false }, { role: "guest", joined: false, ready: false }], usageMinutes: 0,
        };
        return json(route, 201, { room: current, host: invite("host", createCount), guest: invite("guest", createCount) });
      }
      if (request.method() === "POST" && path.endsWith("/invites/guest")) {
        reissueStarted = true;
        await pendingReissue;
        if (lateResult === "network-error") return route.abort("failed");
        return json(route, 200, { roomId: "race-room-1", role: "guest", invite: invite("guest", 9) });
      }
      if (request.method() === "GET" && /\/rooms\/race-room-\d+$/.test(path)) {
        if (!reissueStarted || !path.endsWith("/race-room-1")) return json(route, 200, current);
        const ended = { ...current, state: "ended" };
        current = null;
        await json(route, 200, ended);
        return;
      }
      return json(route, 404, { error: "not_found" });
    });

    await page.goto("/host/auth/mock-login");
    await page.goto(`/host/translate?providerId=${PROVIDER}`);
    await page.getByRole("button", { name: "通訳の部屋を作る" }).click();
    await page.getByRole("button", { name: "相手用を再発行" }).click();
    const createAgain = page.getByRole("button", { name: "通訳の部屋を作る" });
    await expect(createAgain).toBeEnabled({ timeout: 10_000 });
    await createAgain.click();
    await expect(page.getByRole("heading", { level: 2, name: "通訳の部屋" })).toBeVisible();
    await expect.poll(() => createCount).toBe(2);
    const lateResponse = lateResult === "network-error"
      ? page.waitForEvent("requestfailed", (request) => request.url().endsWith("/race-room-1/invites/guest"))
      : page.waitForResponse((response) => response.url().endsWith("/race-room-1/invites/guest"));
    releaseReissue();
    await lateResponse;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "自分のNIHOアプリで開く" })).toHaveAttribute("href", invite("host", 2).inviteUrl);
  });
}
