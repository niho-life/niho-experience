import { expect, test, type Page, type Route } from "@playwright/test";

/*
 * 運営者 (#542): /admin/operators with ADMIN_PRODUCT_OPERATORS_PREVIEW_ENABLED (mock mode). The page draws a synthetic
 * snapshot (src/admin/product-operators-preview.ts); every API call of the browser is stubbed here, so nothing is saved.
 */

const K = { providerId: "provider-sample-kitchen", productId: "product-sample-kitchen-dinner" };
const W = { providerId: "provider-sample-workshop", productId: "product-sample-craft-workshop" };
const T = { providerId: "provider-sample-kitchen", productId: "product-sample-tea-hour" };
const INVITATION_PENDING = "7b1f0a52-3c64-4d8e-9a1b-2c3d4e5f6a01";
const USER_TEA = "22222222-2222-4222-8222-222222222222";
const LINK = "https://experience.example.test/host/invitations/00000000-0000-4000-8000-000000000001#sample-token";

const base = (product: typeof K, title: string, seller: string) => ({ ...product, productTitle: title, sellerDisplayName: seller });
const kitchen = base(K, "Sample Kitchen Dinner", "サンプルの台所");
const workshop = base(W, "Sample Craft Workshop", "サンプル工房");
const tea = base(T, "Sample Tea Hour", "サンプルの台所");
// Archived: not among `products`, but its assignment is still active.
const archived = base({ providerId: "provider-sample-workshop", productId: "product-sample-archived-walk" }, "Sample Archived Walk", "サンプル工房");

interface Snapshot { products: unknown[]; invitations: Record<string, unknown>[]; grants: Record<string, unknown>[] }

interface Backend {
  snapshot: Snapshot;
  posts: Record<string, unknown>[];
  /** The answers to the next POSTs, first in first out; "ok" once the list is empty. */
  next: ("ok" | "client" | "unavailable")[];
  /** The link the next createInvitation returns; null for the repeated answer. */
  link: string | null;
}

const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", headers: { "cache-control": "private, no-store" }, body: JSON.stringify(body) });

async function installStubs(page: Page): Promise<Backend> {
  const backend: Backend = {
    snapshot: {
      products: [kitchen, workshop, tea],
      invitations: [
        { ...kitchen, id: INVITATION_PENDING, assignmentLabel: "合成 招待A", state: "PENDING", expiresAtUtc: "2099-12-24T00:00:00.000Z", revision: 1, createdAtUtc: "2026-11-01T00:00:00.000Z" },
        { ...tea, id: "7b1f0a52-3c64-4d8e-9a1b-2c3d4e5f6a02", assignmentLabel: "合成 招待B", state: "PENDING", expiresAtUtc: "2020-01-08T00:00:00.000Z", revision: 1, createdAtUtc: "2020-01-01T00:00:00.000Z" },
        { ...tea, id: "7b1f0a52-3c64-4d8e-9a1b-2c3d4e5f6a03", assignmentLabel: "合成 失効済みC", state: "REVOKED", expiresAtUtc: "2099-12-24T00:00:00.000Z", revokedAtUtc: "2026-11-02T00:00:00.000Z", revision: 2, createdAtUtc: "2026-11-01T00:00:00.000Z" },
      ],
      grants: [
        { ...kitchen, nihoUserId: "11111111-1111-4111-8111-111111111111", assignmentLabel: "合成 担当A", active: true, version: 3, grantedAtUtc: "2026-10-20T00:00:00.000Z" },
        { ...tea, nihoUserId: USER_TEA, assignmentLabel: "合成 担当D", active: true, expiresAtUtc: "2099-12-31T00:00:00.000Z", version: 1, grantedAtUtc: "2026-10-21T00:00:00.000Z" },
        { ...tea, nihoUserId: "33333333-3333-4333-8333-333333333333", assignmentLabel: "合成 解除済みE", active: false, version: 4, grantedAtUtc: "2026-10-01T00:00:00.000Z", revokedAtUtc: "2026-10-15T00:00:00.000Z" },
        { ...archived, nihoUserId: "44444444-4444-4444-8444-444444444444", assignmentLabel: "合成 担当F", active: true, version: 2, grantedAtUtc: "2026-09-01T00:00:00.000Z" },
      ],
    },
    posts: [],
    next: [],
    link: LINK,
  };
  await page.route("**/admin/api/operators", async (route) => {
    const request = route.request();
    if (request.method() === "GET") return json(route, 200, backend.snapshot);
    const body = request.postDataJSON() as Record<string, unknown>;
    backend.posts.push(body);
    const outcome = backend.next.shift() ?? "ok";
    if (outcome === "client") return json(route, 409, { error: "conflict" });
    if (outcome === "unavailable") return json(route, 503, { error: "unavailable" });
    if (body.action === "createInvitation") {
      const owner = [kitchen, workshop, tea].find((item) => item.productId === body.productId) ?? kitchen;
      backend.snapshot.invitations.push({ ...owner, id: "7b1f0a52-3c64-4d8e-9a1b-2c3d4e5f6b01", assignmentLabel: body.assignmentLabel, state: "PENDING", expiresAtUtc: "2099-12-30T00:00:00.000Z", revision: 1, createdAtUtc: "2026-11-10T00:00:00.000Z" });
      return json(route, 200, backend.link ? { link: backend.link, repeated: false } : { repeated: true });
    }
    if (body.action === "revokeInvitation") backend.snapshot.invitations = backend.snapshot.invitations.map((item) => item.id === body.invitationId ? { ...item, state: "REVOKED" } : item);
    if (body.action === "revokeGrant") backend.snapshot.grants = backend.snapshot.grants.map((item) => item.nihoUserId === body.nihoUserId ? { ...item, active: false } : item);
    return json(route, 200, { repeated: false });
  });
  return backend;
}

async function openPage(page: Page): Promise<Backend> {
  const backend = await installStubs(page);
  await page.goto("/admin");
  await page.getByRole("button", { name: "合成Adminとして開く" }).click();
  await page.waitForURL(/\/admin\/bookings/);
  await page.goto("/admin/operators");
  await expect(page.getByRole("heading", { level: 1, name: "運営者" })).toBeVisible();
  return backend;
}

const surface = (page: Page, title: string) => page.getByRole("region", { name: title });
const accountSummary = (page: Page) => page.locator("summary:visible", { hasText: "のアカウントメニュー" });

test("the frame is the host console's: the menu shows only what this sign-in can use", async ({ page }, testInfo) => {
  await openPage(page);
  const menu = page.getByRole("navigation", { name: "管理メニュー" });
  await expect(menu.getByRole("link", { name: "運営者" })).toHaveAttribute("aria-current", "page");
  for (const name of ["予約支援", "予約"]) await expect(menu.getByRole("link", { name, exact: true })).toBeVisible();
  await expect(menu.getByRole("link", { name: /通知/ })).toBeVisible();
  // Not on in this server: no dead links.
  for (const name of ["提供者", "掲載先"]) await expect(menu.getByRole("link", { name, exact: true })).toHaveCount(0);
  const phone = testInfo.project.name.includes("mobile");
  if (phone) {
    await expect(menu.getByRole("link")).not.toHaveCount(0);
    expect((await menu.getByRole("link").count())).toBeLessThanOrEqual(5);
  } else {
    expect((await page.locator("header").first().boundingBox())?.width).toBe(232);
  }
  await accountSummary(page).click();
  await expect(page.getByRole("button", { name: "ログアウト" })).toBeVisible();
  await expect(page.getByRole("link", { name: "体験サイトを見る" })).toHaveAttribute("href", "/experiences");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "ログアウト" })).toBeHidden();
});

test("one surface per experience, people as rows, and nothing for ended ones", async ({ page }) => {
  await openPage(page);
  const kitchenSurface = surface(page, "Sample Kitchen Dinner");
  await expect(kitchenSurface.getByText("合成 招待A")).toBeVisible();
  await expect(kitchenSurface.getByText("招待中")).toBeVisible();
  await expect(kitchenSurface.getByText("12月24日まで")).toBeVisible();
  const teaSurface = surface(page, "Sample Tea Hour");
  await expect(teaSurface.getByText("合成 担当D")).toBeVisible();
  await expect(teaSurface.getByText("12月31日まで")).toBeVisible();
  await expect(teaSurface.getByRole("button", { name: "解除" })).toBeVisible();
  // An experience with nobody still has its 招待.
  await expect(surface(page, "Sample Craft Workshop").getByRole("button", { name: "招待" })).toBeVisible();
  await expect(surface(page, "Sample Craft Workshop").getByRole("listitem")).toHaveCount(0);
  // A past expiry says 期限切れ and has no date line.
  const expired = teaSurface.getByRole("listitem").filter({ hasText: "合成 招待B" });
  await expect(expired.getByText("期限切れ")).toBeVisible();
  await expect(expired).not.toContainText("まで");
  // An experience that is not in the list (archived, or past the list's limit) keeps its surface, so that its people
  // can still be ended; nobody can be invited to it.
  const archivedSurface = surface(page, "Sample Archived Walk");
  await expect(archivedSurface.getByText("合成 担当F")).toBeVisible();
  await expect(archivedSurface.getByRole("button", { name: "解除" })).toBeVisible();
  await expect(archivedSurface.getByRole("button", { name: "招待" })).toHaveCount(0);
  // 受諾されていない招待と有効な担当だけ: 失効・解除済みは出ない。
  await expect(page.getByText("合成 失効済みC")).toHaveCount(0);
  await expect(page.getByText("合成 解除済みE")).toHaveCount(0);
  await expect(page.getByText("PENDING")).toHaveCount(0);
});

test("inviting: dialog, link shown once, then 招待中 in the list", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined);
  const backend = await openPage(page);
  await surface(page, "Sample Craft Workshop").getByRole("button", { name: "招待" }).click();
  let dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "運営者を招待" })).toBeVisible();
  await expect(dialog).toContainText("Sample Craft Workshop");
  const name = dialog.getByRole("textbox", { name: "担当者名" });
  await expect(name).toBeFocused();
  await expect(dialog.getByRole("button", { name: "招待リンクを作成" })).toBeDisabled();
  await name.fill("合成 招待F");
  await name.press("Enter");
  dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "招待リンク" })).toBeVisible();
  await expect(dialog).toContainText("合成 招待F · Sample Craft Workshop");
  await expect(dialog.getByRole("textbox", { name: "招待リンク" })).toHaveValue(LINK);
  await expect(dialog).toContainText("7日間有効 · 閉じると再表示できません");
  expect(backend.posts).toHaveLength(1);
  expect(backend.posts[0]).toMatchObject({ action: "createInvitation", ...W, assignmentLabel: "合成 招待F" });
  expect(typeof backend.posts[0]?.commandId).toBe("string");
  await dialog.getByRole("button", { name: "リンクをコピー" }).click();
  await expect(dialog.getByRole("button", { name: "コピーしました" }).or(dialog.getByText("リンクを選択してコピーしてください"))).toBeVisible();
  await dialog.getByRole("button", { name: "閉じる" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // The list was read again.
  await expect(surface(page, "Sample Craft Workshop").getByText("合成 招待F")).toBeVisible();
  await expect(surface(page, "Sample Craft Workshop").getByText("招待中")).toBeVisible();
});

test("a repeated command cannot show the link again", async ({ page }) => {
  const backend = await openPage(page);
  backend.link = null;
  await surface(page, "Sample Craft Workshop").getByRole("button", { name: "招待" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "担当者名" }).fill("合成 招待G");
  await dialog.getByRole("button", { name: "招待リンクを作成" }).click();
  await expect(page.getByRole("dialog")).toContainText("保存済みです。リンクは再表示できません。必要なら招待を取り消して作り直してください。");
  await expect(page.getByRole("textbox", { name: "招待リンク" })).toHaveCount(0);
  await page.getByRole("dialog").getByRole("button", { name: "閉じる" }).click();
});

test("cancelling an invitation and ending an assignment go through a confirmation", async ({ page }) => {
  const backend = await openPage(page);
  await surface(page, "Sample Kitchen Dinner").getByRole("button", { name: "取り消す" }).click();
  let dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "招待を取り消しますか？" })).toBeVisible();
  await expect(dialog).toContainText("合成 招待A · Sample Kitchen Dinner");
  await dialog.getByRole("button", { name: "やめる" }).click();
  expect(backend.posts).toHaveLength(0);
  await surface(page, "Sample Kitchen Dinner").getByRole("button", { name: "取り消す" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "取り消す" }).click();
  await expect(page.getByRole("status").filter({ hasText: "招待を取り消しました" })).toBeVisible();
  expect(backend.posts[0]).toMatchObject({ action: "revokeInvitation", invitationId: INVITATION_PENDING, expectedRevision: 1 });
  await expect(surface(page, "Sample Kitchen Dinner").getByText("合成 招待A")).toHaveCount(0);

  await surface(page, "Sample Tea Hour").getByRole("button", { name: "解除" }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "担当を解除しますか？" })).toBeVisible();
  await expect(dialog).toContainText("合成 担当D · Sample Tea Hour");
  await dialog.getByRole("button", { name: "解除する" }).click();
  await expect(page.getByRole("status").filter({ hasText: "担当を解除しました" })).toBeVisible();
  expect(backend.posts[1]).toMatchObject({ action: "revokeGrant", ...T, nihoUserId: USER_TEA, expectedVersion: 1 });
  await expect(surface(page, "Sample Tea Hour").getByText("合成 担当D")).toHaveCount(0);
});

test("a refused change says so and reads the list again", async ({ page }) => {
  const backend = await openPage(page);
  backend.next.push("client");
  await surface(page, "Sample Kitchen Dinner").getByRole("button", { name: "取り消す" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "取り消す" }).click();
  await expect(page.locator("main [role=alert]")).toHaveText("操作できません。権限と現在の状態を確認してください。");
  await expect(page.getByRole("button", { name: "結果を確認" })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("an unknown result is checked again with the same commandId", async ({ page }) => {
  const backend = await openPage(page);
  backend.next.push("unavailable");
  await surface(page, "Sample Tea Hour").getByRole("button", { name: "解除" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "解除する" }).click();
  await expect(page.locator("main [role=alert]")).toContainText("保存結果を確認できません。");
  // Until it is known, the other buttons wait.
  await expect(surface(page, "Sample Kitchen Dinner").getByRole("button", { name: "招待" })).toBeDisabled();
  await expect(surface(page, "Sample Kitchen Dinner").getByRole("button", { name: "取り消す" })).toBeDisabled();
  await page.getByRole("button", { name: "結果を確認" }).click();
  await expect(page.getByRole("status").filter({ hasText: "担当を解除しました" })).toBeVisible();
  expect(backend.posts).toHaveLength(2);
  expect(backend.posts[1]?.commandId).toBe(backend.posts[0]?.commandId);
  expect(backend.posts[1]).toEqual(backend.posts[0]);
  await expect(page.getByRole("button", { name: "結果を確認" })).toHaveCount(0);
  await expect(surface(page, "Sample Kitchen Dinner").getByRole("button", { name: "招待" })).toBeEnabled();
});

test("nothing scrolls sideways", async ({ page }) => {
  await openPage(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await surface(page, "Sample Tea Hour").getByRole("button", { name: "解除" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const withDialog = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(withDialog).toBeLessThanOrEqual(0);
});
