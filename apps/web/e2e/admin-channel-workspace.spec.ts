import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const providers = [{ id: "synthetic-a", displayName: "サンプルの台所" }, { id: "synthetic-b", displayName: "サンプル工房" }];
const stamp = "2099-01-01T00:00:00.000Z";
const account = { id: "account-a", providerId: "synthetic-a", site: "Viator", externalAccountId: "synthetic-external", displayName: "合成アカウント", operatingModel: 4, active: false, version: 1, quarantined: false, createdAtUtc: stamp, updatedAtUtc: stamp };
const listing = { id: "listing-a", providerId: "synthetic-a", productId: "tea", accountId: "account-a", externalProductId: "synthetic-product", adapter: "synthetic-browser", adapterVersion: "1", connectionMode: "BROWSER", capabilities: {}, active: false, mappingVersion: 1, timeZone: "Asia/Tokyo", createdAtUtc: stamp, updatedAtUtc: stamp };
const room = { id: "room", providerId: "synthetic-a", kind: "VENUE", displayName: "合成の会場", active: true, version: 1, createdAtUtc: stamp, updatedAtUtc: stamp };
const snapshot = (providerId = "synthetic-a") => ({ providerId, resources: providerId === "synthetic-a" ? [room] : [], products: [{ id: "tea", publicTitle: providerId === "synthetic-a" ? "合成の茶道" : "合成の書道", sellerDisplayName: "Synthetic", status: "PUBLISHED" }] });

async function signIn(page: Page) {
  await page.goto("/admin");
  await page.getByRole("button", { name: "合成Adminとして開く", exact: true }).click();
  await page.waitForURL(/\/admin\/bookings/);
}

const runtimeOverview = (providerId: string) => ({
  providerId, generatedAtUtc: stamp, watchdogLastRunAtUtc: stamp, watchdogStale: false, openHold: true, unclosedOccurrences: 2,
  workers: [{ id: "worker-a", displayName: "合成Studio", lastHeartbeatAtUtc: stamp, health: "DOWN", openHold: true, openHoldSinceUtc: stamp, assignedAccounts: 1 }],
  accounts: [{
    id: "account-a", site: "Viator", displayName: "合成アカウント", active: true, version: 1, quarantineReason: "AUTH_REQUIRED", quarantinedAtUtc: stamp,
    sync: { closePending: 2, openPending: 1, overdue: 1, heldOpen: 1 }, reservationReads: { listings: 1, halted: 1, lastSuccessAtUtc: stamp },
    listings: [{ listingId: "listing-a", productTitle: "合成の茶道", closePending: 2, openPending: 1, overdue: 1, reservationReads: true, readHalted: true, readLastError: "READ_INCOMPLETE" }],
  }],
  incidents: [{ id: "7", kind: "WORKER_STALE", subjectType: "worker", subjectId: "worker-a", openedAtUtc: stamp, escalated: true, acknowledged: false, assignedToMe: false, detail: { closePending: 2 } }],
});

async function stub(page: Page, mutation?: (route: Route, body: Record<string, unknown>) => Promise<void>, runtime?: (providerId: string) => unknown) {
  await page.route("**/admin/api/channel-workspace**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { providers, selected: snapshot(new URL(route.request().url()).searchParams.get("providerId") ?? "synthetic-a") } });
    } else if (mutation) await mutation(route, route.request().postDataJSON());
    else await route.fulfill({ status: 200, json: { receipt: { version: 2 } } });
  });
  await page.route("**/admin/api/channels", async (route) => {
    const body = route.request().postDataJSON();
    if (body.action === "listAccounts") await route.fulfill({ json: { accounts: body.providerId === "synthetic-a" ? [account] : [] } });
    else if (body.action === "listListings") await route.fulfill({ json: { listings: body.providerId === "synthetic-a" ? [listing] : [] } });
    else if (body.action === "runtimeOverview") await route.fulfill(runtime ? { json: { overview: runtime(body.providerId) } } : { status: 404, json: { error: "not_found" } });
    else if (mutation) await mutation(route, body);
    else await route.fulfill({ json: { saved: true } });
  });
}

const section = (page: Page, title: string) => page.locator("section").filter({ has: page.getByRole("heading", { name: title, exact: true }) });

test("channel workspace stays compact and creates an inactive account", async ({ page }, testInfo) => {
  await signIn(page);
  const posts: Record<string, unknown>[] = [];
  await stub(page, async (route, body) => { posts.push(body); await route.fulfill({ status: 201, json: { saved: true } }); });
  await page.goto("/admin/channels");
  await expect(page.getByText("合成の茶道", { exact: true }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await section(page, "外部アカウント").getByRole("button", { name: "追加", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "外部アカウントを追加" });
  await dialog.getByLabel("掲載サイト").selectOption("Jalan");
  await dialog.getByLabel("表示名").fill("合成のじゃらん");
  await dialog.getByLabel("外部アカウントID").fill("synthetic-jalan");
  await dialog.getByLabel("運営方式").selectOption("4");
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(axe.violations.map((item) => item.id)).toEqual([]);
  await testInfo.attach("channel-account", { body: await page.screenshot({ path: testInfo.outputPath("channel-account.png") }), contentType: "image/png" });
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(posts[0]).toMatchObject({ action: "createAccount", account: { site: "Jalan", operatingModel: 4, active: false } });
  expect(JSON.stringify(posts)).not.toMatch(/price|unitAmount|privateProfile|cookie|bearer/i);
});

test("runtime status says a stopped Studio does not close open occurrences and guards re-authentication", async ({ page }, testInfo) => {
  await signIn(page);
  const posts: Record<string, unknown>[] = [];
  await stub(page, async (route, body) => { posts.push(body); await route.fulfill({ json: { saved: true } }); }, runtimeOverview);
  await page.goto("/admin/channels");
  const runtime = section(page, "稼働状況");
  await expect(runtime.getByText("Studio 停止中。外部で受付中の回は自動では閉じません", { exact: true })).toBeVisible();
  await expect(runtime.getByText("閉じられていない回: 2件", { exact: true })).toBeVisible();
  await expect(page.getByText("停止済み")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  const axe = await new AxeBuilder({ page }).include("section[aria-labelledby='channel-runtime-title']").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(axe.violations.map((item) => item.id)).toEqual([]);
  await testInfo.attach("channel-runtime", { body: await page.screenshot({ path: testInfo.outputPath("channel-runtime.png"), fullPage: true }), contentType: "image/png" });

  await runtime.getByRole("button", { name: "再認証を確認して照合", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "再認証を確認して照合" });
  const submit = dialog.getByRole("button", { name: "照合する", exact: true });
  await expect(submit).toBeDisabled();
  await dialog.getByRole("checkbox", { name: "Studioの操作が止まっている" }).check();
  await expect(submit).toBeDisabled();
  await dialog.getByRole("checkbox", { name: "掲載先に再ログインした" }).check();
  await submit.click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toMatchObject({ action: "confirmReauth", accountId: "account-a", stopConfirmed: true, reauthConfirmed: true });
  await runtime.getByRole("button", { name: "担当する", exact: true }).click();
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1]).toMatchObject({ action: "acknowledgeIncident", incidentId: "7" });
  expect(JSON.stringify(posts)).not.toMatch(/password|cookie|bearer|externalAccountId/i);
});

test("unknown resource save can be retried inside its modal with the identical command", async ({ page }) => {
  await signIn(page);
  const posts: Record<string, unknown>[] = [];
  await stub(page, async (route, body) => {
    posts.push(body);
    if (posts.length === 1) await route.abort("connectionreset");
    else if (posts.length === 2) await route.fulfill({ status: 401, json: { error: "unauthenticated" } });
    else await route.fulfill({ json: { receipt: { version: 2 } } });
  });
  await page.goto("/admin/channels");
  await section(page, "共有資源").getByRole("button", { name: "設定", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "共有資源を編集" });
  await dialog.getByLabel("名前").fill("変更後の会場");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.getByText("保存結果を確認できません。", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "やめる", exact: true })).toBeDisabled();
  await expect(dialog.getByLabel("名前")).toBeDisabled();
  await dialog.getByRole("button", { name: "結果を確認", exact: true }).click();
  await expect(dialog.getByRole("link", { name: "ログイン", exact: true })).toBeVisible();
  await expect(dialog.getByLabel("名前")).toBeDisabled();
  await dialog.getByRole("button", { name: "結果を確認", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(posts).toHaveLength(3);
  expect(posts[1]).toEqual(posts[0]);
  expect(posts[2]).toEqual(posts[0]);
  expect(posts[0]).toMatchObject({ action: "saveResource", expectedVersion: 1, resource: { id: "room", kind: "VENUE", displayName: "変更後の会場" } });
});

test("409 keeps resource input and never silently adopts a new version", async ({ page }) => {
  await signIn(page);
  const posts: Record<string, unknown>[] = [];
  await stub(page, async (route, body) => { posts.push(body); await route.fulfill({ status: 409, json: { error: "stale" } }); });
  await page.goto("/admin/channels");
  await section(page, "共有資源").getByRole("button", { name: "設定", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "共有資源を編集" });
  await dialog.getByLabel("名前").fill("保持する入力");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.getByText(/入力は残っています/)).toBeVisible();
  await dialog.getByRole("button", { name: "一覧を再読込", exact: true }).click();
  await expect(dialog.getByLabel("名前")).toHaveValue("保持する入力");
  expect(posts).toHaveLength(1);
  await dialog.getByRole("button", { name: "やめる", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("listing edits preserve disabled product and account identities", async ({ page }) => {
  await signIn(page);
  const posts: Record<string, unknown>[] = [];
  await stub(page, async (route, body) => { posts.push(body); await route.fulfill({ json: { saved: true } }); });
  await page.goto("/admin/channels");
  await section(page, "掲載設定").getByRole("button", { name: "設定", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "掲載設定を編集" });
  await expect(dialog.getByRole("combobox", { name: "体験", exact: true })).toBeDisabled();
  await dialog.getByLabel("外部product ID").fill("synthetic-new-product");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(posts[0]).toMatchObject({ action: "updateListing", expectedVersion: 1, listing: { accountId: "account-a", productId: "tea", externalProductId: "synthetic-new-product" } });
});

test("private groups keep their capacity separate and save resource buffers", async ({ page }) => {
  await signIn(page);
  const posts: Record<string, unknown>[] = [];
  await stub(page, async (route, body) => { posts.push(body); await route.fulfill({ json: { saved: true } }); });
  await page.goto("/admin/channels");
  await section(page, "体験と掲載先").getByRole("button", { name: "資源", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "合成の茶道の資源" });
  await dialog.getByLabel("予約単位").selectOption("PRIVATE_GROUP");
  await dialog.getByRole("checkbox", { name: "合成の会場" }).check();
  await dialog.getByLabel("準備（分）").fill("15");
  await dialog.getByLabel("片付け（分）").fill("10");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(posts[0]).toMatchObject({ action: "saveProductInventory", expectedVersion: null, inventory: { bookingMode: "PRIVATE_GROUP", resources: [{ resourceId: "room", prepareMinutes: 15, cleanupMinutes: 10 }] } });
  expect(JSON.stringify(posts)).not.toContain('"capacity"');
});

test("a provider switch hides the previous product and rejects a delayed old response", async ({ page }) => {
  await signIn(page);
  await stub(page);
  let release!: () => void;
  let requested = false;
  let finished = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/admin/api/channel-workspace?providerId=synthetic-a", async (route) => {
    requested = true;
    await gate;
    try { await route.fulfill({ json: { providers, selected: snapshot() } }); } catch { /* request aborted */ }
    finished = true;
  });
  await page.goto("/admin/channels");
  await expect.poll(() => requested).toBe(true);
  await page.getByRole("combobox", { name: "提供者", exact: true }).selectOption("synthetic-b");
  await expect(page.getByText("合成の書道", { exact: true })).toBeVisible();
  release();
  await expect.poll(() => finished).toBe(true);
  await expect(page.getByText("合成の茶道", { exact: true })).toHaveCount(0);
});

test("synthetic preview never enables the real channel write API", async ({ page }) => {
  await signIn(page);
  const result = await page.request.post("/admin/api/channel-workspace", { data: { action: "saveResource" } });
  expect(result.status()).toBe(404);
});
