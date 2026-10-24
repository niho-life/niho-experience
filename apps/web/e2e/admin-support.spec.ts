import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const ADMIN_COOKIE = "__Secure-niho_admin_preview";

async function hostSignIn(page: Page) {
  await page.goto("/host");
  await page.getByRole("link", { name: "NIHO でログイン" }).click();
  await page.waitForURL(/\/host\/home/);
}

async function adminSignIn(page: Page) {
  await page.goto("/admin");
  await page.getByRole("button", { name: "合成Adminとして開く" }).click();
  await page.waitForURL(/\/admin\/bookings/);
}

const overflowX = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("admin has a separate session and ordinary hosts cannot enter", async ({ page, context }) => {
  await page.goto("/admin/bookings");
  await expect(page).toHaveURL(/\/admin$/);
  await hostSignIn(page);
  await page.goto("/admin/bookings");
  await expect(page).toHaveURL(/\/admin$/);
  await adminSignIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "予約支援" })).toBeVisible();
  const cookie = (await context.cookies()).find((item) => item.name === ADMIN_COOKIE);
  expect(cookie).toMatchObject({ path: "/admin", httpOnly: true, secure: true, sameSite: "Lax" });
  expect((await context.cookies()).find((item) => item.name === "__Secure-niho_host_session")?.path).toBe("/host");
  const headers = (await page.goto("/admin/bookings"))!.headers();
  expect(headers["cache-control"]).toContain("no-store");
  expect(headers["x-robots-tag"]).toContain("noindex");
  expect(await page.locator('script[src*="umami"]').count()).toBe(0);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});

test("admin searches across hosts and reads ON and OFF booking details", async ({ page }) => {
  await adminSignIn(page);
  const search = page.getByRole("searchbox", { name: "予約番号・予約者を検索" });
  await search.fill("2101");
  await expect(page.getByRole("region", { name: "予約一覧" })).toContainText("Amelia Jones");
  await expect(page.getByRole("region", { name: "予約一覧" })).not.toContainText("Lucas");
  await search.fill("");
  const filterToggle = page.getByRole("button", { name: /詳細条件/ });
  if (await filterToggle.isVisible()) await filterToggle.click();
  await page.getByRole("combobox", { name: "サポート" }).selectOption("off");
  await expect(page.getByRole("region", { name: "予約一覧" })).toContainText("支援OFF");
  await page.getByRole("button", { name: /Amelia Jones/ }).click();
  const detail = page.getByRole("article");
  await expect(detail).toContainText("手数料 10%（受付時）");
  await expect(detail).toContainText("閲覧だけができます");
  await expect(detail.getByRole("button", { name: "承認する" })).toHaveCount(0);
});

test("browser history keeps the selected booking in sync with the URL", async ({ page }) => {
  await adminSignIn(page);
  await page.getByRole("button", { name: /Lucas & Mia Chen/ }).click();
  await expect(page).toHaveURL(/booking=bk-2041/);
  await expect(page.getByRole("article")).toContainText("Lucas & Mia Chen");
  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/bookings$/);
  await expect(page.getByRole("region", { name: "予約一覧" })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/booking=bk-2041/);
  await expect(page.getByRole("article")).toContainText("Lucas & Mia Chen");
  await page.goBack();
  await page.getByRole("button", { name: /Amelia Jones/ }).click();
  await expect(page).toHaveURL(/booking=bk-studio-101/);
  await expect(page.getByRole("article")).toContainText("Amelia Jones");
});

test("notification navigation keeps unread state and opens the opaque booking target", async ({ page }) => {
  await adminSignIn(page);
  const notificationLink = page.getByRole("link", { name: /通知/ });
  await expect(notificationLink).toHaveAccessibleName(/通知.*未読5件/);
  await notificationLink.click();
  await expect(page).toHaveURL(/\/admin\/notifications$/);
  await expect(notificationLink).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 1, name: "通知" })).toBeVisible();
  const changed = page.getByRole("article").filter({ hasText: "申込内容が変更されました" });
  await changed.getByRole("button", { name: "既読にする" }).click();
  await expect(changed).toContainText("既読");
  await expect(notificationLink).toHaveAccessibleName(/通知.*未読4件/);
  await page.reload();
  await expect(page.getByRole("article").filter({ hasText: "申込内容が変更されました" })).toContainText("既読");
  await page.getByRole("article").filter({ hasText: "申込内容が変更されました" }).getByRole("link", { name: "予約を見る" }).click();
  await expect(page).toHaveURL(/\/admin\/bookings\?booking=bk-2041$/);
  await expect(page.getByRole("article")).toContainText("Lucas & Mia Chen");
});

test("notification unread filter reaches an honest empty state", async ({ page }) => {
  await adminSignIn(page);
  await page.getByRole("link", { name: /通知/ }).click();
  await expect(page.getByRole("button", { name: "すべて既読にする" })).toBeEnabled();
  await page.getByRole("button", { name: "すべて既読にする" }).click();
  await expect(page.getByRole("button", { name: "未読 0件" })).toBeVisible();
  await page.getByRole("button", { name: "未読 0件" }).click();
  await expect(page.getByText("未読の通知はありません。")).toBeVisible();
  await expect(page.getByRole("link", { name: /未読\d+件/ })).toHaveCount(0);
});

test("notification read API rejects unsigned, cross-site and unknown receipts", async ({ page }) => {
  await page.goto("/admin");
  const signedOut = await page.request.get("/admin/api/preview-notifications");
  expect(signedOut.status()).toBe(401);
  expect(signedOut.headers()["cache-control"]).toContain("no-store");
  await adminSignIn(page);
  const crossSite = await page.request.post("/admin/api/preview-notifications", {
    headers: { origin: "https://evil.example.test", "sec-fetch-site": "cross-site" },
    data: { notificationIds: ["notice-new-booking-2041"] },
  });
  expect(crossSite.status()).toBe(403);
  expect(crossSite.headers()["cache-control"]).toContain("no-store");
  const unknown = await page.evaluate(() => fetch("/admin/api/preview-notifications", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ notificationIds: ["notice-new-booking-2041", "unknown-notification"] }),
  }).then((response) => response.status));
  expect(unknown).toBe(400);
  await page.getByRole("link", { name: /通知/ }).click();
  await expect(page.getByRole("button", { name: "未読 5件" })).toBeVisible();
});

test("notification load and read failures keep state and can retry", async ({ page }) => {
  await adminSignIn(page);
  let getAttempts = 0;
  await page.route("**/admin/api/preview-notifications", async (route) => {
    if (route.request().method() === "GET" && getAttempts++ === 0) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ notifications: [null], unreadCount: 1 }) });
      return;
    }
    await route.continue();
  });
  await page.getByRole("link", { name: /通知/ }).click();
  await expect(page.getByRole("region", { name: "通知一覧" }).getByRole("alert")).toContainText("通知を読み込めませんでした");
  await page.getByRole("button", { name: "もう一度試す" }).click();
  await expect(page.getByRole("article")).toHaveCount(5);

  await page.unroute("**/admin/api/preview-notifications");
  await page.route("**/admin/api/preview-notifications", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ notifications: [{ kind: "unknown" }], unreadCount: 4 }) });
      return;
    }
    await route.continue();
  });
  const first = page.getByRole("article").first();
  await expect(first).toContainText("未読");
  await first.getByRole("button", { name: "既読にする" }).click();
  await expect(page.getByRole("region", { name: "通知一覧" }).getByRole("alert")).toContainText("表示は更新していません");
  await expect(first).toContainText("未読");
  await expect(page.getByRole("link", { name: /未読5件/ })).toBeVisible();
});

test("busy action dialog ignores Escape and does not report into another booking", async ({ page }) => {
  await adminSignIn(page);
  let releaseResponse!: () => void;
  const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
  await page.route("**/admin/api/preview-action", async (route) => {
    const response = await route.fetch();
    await responseGate;
    await route.fulfill({ response });
  });

  await page.getByRole("button", { name: /Lucas & Mia Chen/ }).click();
  const detail = page.getByRole("article");
  await detail.getByRole("button", { name: "承認する" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("対応理由").fill("応答待ちの操作");
  await dialog.getByRole("button", { name: "予約を承認する" }).click();
  await expect(dialog.getByRole("button", { name: "処理しています…" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();

  await page.evaluate(() => window.history.pushState(null, "", "/admin/bookings?booking=bk-studio-101"));
  await expect(page.getByRole("article")).toContainText("Amelia Jones");
  releaseResponse();
  await expect(page.getByRole("article")).toContainText("Amelia Jones");
  await expect(page.getByRole("article").getByRole("status")).toHaveCount(0);
});

test("support ON operation confirms counterpart, amount and reason, then audits the actor", async ({ page }) => {
  await adminSignIn(page);
  await page.getByRole("button", { name: /Lucas & Mia Chen/ }).click();
  const detail = page.getByRole("article");
  await expect(detail).toContainText("手数料 15%（受付時）");
  await expect(detail).toContainText("承認期限が近づいています");
  await detail.getByRole("button", { name: "承認する" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Lucas & Mia Chen／サンプルの台所");
  await expect(dialog).toContainText("¥60,000 を決済");
  await dialog.getByLabel("対応理由").fill("ホストと受入条件を確認しました");
  await dialog.getByRole("button", { name: "予約を承認する" }).click();
  await expect(detail.getByRole("status")).toContainText("予約を承認しました");
  await expect(detail).not.toContainText("承認期限が近づいています");
  await expect(detail).toContainText("NIHO サポート 山本");
  await expect(detail).toContainText("承認 · ホストと受入条件を確認しました");
  await page.reload();
  await expect(page.getByRole("article")).toContainText("確定");
  await expect(page.getByRole("article")).toContainText("承認 · ホストと受入条件を確認しました");
  await expect(page.getByRole("article")).not.toContainText("承認期限が近づいています");
});

test("preview POST rejects cross-site and signed-out calls", async ({ page }) => {
  await page.goto("/admin");
  const signedOut = await page.evaluate(() => fetch("/admin/api/preview-action", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "signedout1" }, body: JSON.stringify({ bookingId: "bk-2041", operation: { action: "approve", reason: "確認" } }) }).then((response) => response.status));
  expect(signedOut).toBe(401);
  await adminSignIn(page);
  const crossSite = await page.request.post("/admin/api/preview-action", { headers: { origin: "https://evil.example.test", "sec-fetch-site": "cross-site", "idempotency-key": "crosssite1" }, data: { bookingId: "bk-2041", operation: { action: "approve", reason: "確認" } } });
  expect(crossSite.status()).toBe(403);
});

test("an idempotency key converges only for the same booking and payload", async ({ page }) => {
  await adminSignIn(page);
  const statuses = await page.evaluate(async () => {
    const send = (reason: string) => fetch("/admin/api/preview-action", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "same-key-123" }, body: JSON.stringify({ bookingId: "bk-garden-301", operation: { action: "contact", reason } }) });
    const first = await send("ホストへ候補者を共有");
    const repeat = await send("ホストへ候補者を共有");
    const mismatch = await send("別の内容へ変更");
    return [first.status, repeat.status, mismatch.status];
  });
  expect(statuses).toEqual([200, 200, 409]);
});

test("host settings link to the independent support page and booking history stays non-retroactive", async ({ page }) => {
  await hostSignIn(page);
  await page.goto("/host/settings");
  const support = page.getByRole("region", { name: "NIHOサポート" });
  await expect(support).toContainText("体験の設定とは分けて確認・変更します");
  await expect(support.getByRole("link", { name: "NIHOサポート設定を開く" })).toHaveAttribute("href", /\/host\/support\?hostKind=EXPERIENCE_PROVIDER&hostId=/);
  await page.goto("/host/bookings?booking=bk-2041");
  await expect(page.getByRole("region", { name: "NIHOサポート" })).toContainText("手数料 15%（受付時）");
  await expect(page.getByRole("region", { name: "NIHOサポート" })).toContainText("NIHO サポート 佐藤");
  await page.goto("/host/bookings?booking=bk-2038");
  await expect(page.getByRole("region", { name: "NIHOサポート" })).toContainText("手数料 10%（受付時）");
  await expect(page.getByRole("region", { name: "NIHOサポート" })).toContainText("現在の設定を変えても、受付時の条件は変わりません");
});

test.describe("admin accessibility and responsive layout", () => {
  test("keyboard, desktop and WCAG checks", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "host-desktop");
    await adminSignIn(page);
    await expect(page.getByRole("button", { name: /Lucas & Mia Chen/ })).toBeInViewport();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "本文へ移動" })).toBeFocused();
    await page.getByRole("link", { name: /通知/ }).press("Enter");
    await expect(page).toHaveURL(/\/admin\/notifications$/);
    await expect(page.getByRole("link", { name: /通知/ })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("article").first()).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze();
    expect(results.violations.filter((item) => item.impact === "serious" || item.impact === "critical")).toEqual([]);
    expect(await overflowX(page)).toBeLessThanOrEqual(0);
  });

  test("320px keeps list and detail inside the viewport", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "host-mobile-360");
    await page.setViewportSize({ width: 320, height: 640 });
    await adminSignIn(page);
    await expect(page.getByRole("button", { name: /Lucas & Mia Chen/ })).toBeInViewport();
    await page.getByRole("button", { name: /詳細条件/ }).click();
    await expect(page.getByRole("combobox", { name: "サポート" })).toBeVisible();
    expect(await overflowX(page)).toBeLessThanOrEqual(0);
    await page.getByRole("button", { name: /詳細条件/ }).click();
    expect(await overflowX(page)).toBeLessThanOrEqual(0);
    await page.getByRole("button", { name: /Lucas & Mia Chen/ }).click();
    await expect(page.getByRole("button", { name: "予約支援へ戻る" })).toBeVisible();
    expect(await overflowX(page)).toBeLessThanOrEqual(0);
    await page.getByRole("link", { name: /通知/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "通知" })).toBeVisible();
    await expect(page.getByRole("article").first()).toBeVisible();
    expect(await overflowX(page)).toBeLessThanOrEqual(0);
  });
});
