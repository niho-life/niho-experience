import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { japaneseTextOutsideNihoSans } from "./support/japanese-type";

const ID = "00000000-0000-4000-8000-000000000478";
const COVER_ID = "00000000-0000-4000-8000-000000000479";
const UPDATED = "2026-11-08T01:00:00.000Z";
const auditSerious = async (page: Page) => {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.filter((item) => item.impact === "serious" || item.impact === "critical").map((item) => item.id)).toEqual([]);
};

type SyntheticGuide = {
  id: string;
  slug: string;
  subject: { kind: "PROVIDER"; providerId: string };
  title: string;
  description: string;
  categorySlug?: string;
  content: { markdown: string; language: "en"; author?: { name: string; role: string; bio: string } };
  cover?: { assetId: string; alt: string; credit: string; webConfirmed: boolean };
  draftProductLinks: readonly { providerId: string; productId: string }[];
  status: "DRAFT" | "PUBLISHED" | "STOPPED" | "OPS_STOPPED";
  revision: number;
  currentPublication?: { id: number; number: number; sourceRevision: number; visibility: "PUBLIC" | "UNLISTED"; publishedAtUtc: string };
  createdAtUtc: string;
  updatedAtUtc: string;
};

function initialGuide(): SyntheticGuide {
  return {
    id: ID, slug: "slow-kamakura-morning", subject: { kind: "PROVIDER", providerId: "provider-e2e" },
    title: "A slow Kamakura morning", description: "A quiet guide to the neighborhood.", categorySlug: "local-life",
    content: { markdown: "## Start with the market\n\nWalk slowly and greet the neighbors.", language: "en", author: { name: "Sample Writer", role: "Local host", bio: "Writes about everyday Kamakura." } },
    draftProductLinks: [], status: "DRAFT", revision: 1,
    createdAtUtc: "2026-11-08T00:00:00.000Z", updatedAtUtc: UPDATED,
  };
}

async function mockWriterApi(page: Page, withCover = false) {
  let guide: SyntheticGuide = withCover ? {
    ...initialGuide(),
    content: { ...initialGuide().content, markdown: `${initialGuide().content.markdown}\n\n![A table at NIHO](niho-guide-asset:${COVER_ID})` },
    cover: { assetId: COVER_ID, alt: "A table at NIHO", credit: "NIHO", webConfirmed: true },
  } : initialGuide();
  let createAttempts = 0;
  const createIds: string[] = [];
  const events: string[] = [];
  let nextSave: "ok" | "401" | "409" = "ok";

  await page.context().route("**/host/auth/write-bridge?**", async (route) => {
    events.push("relogin");
    await route.fulfill({ status: 200, contentType: "text/html", body: "<title>Signed in</title><p>Signed in</p>" });
  });
  await page.context().route(`**/write/${ID}/preview`, async (route) => {
    events.push("preview");
    await route.fulfill({ status: 200, contentType: "text/html", body: `<title>Private preview</title><h1>${guide.title}</h1><p>${guide.content.markdown}</p>` });
  });
  await page.context().route("**/guides/*", async (route) => {
    events.push("public");
    await route.fulfill({ status: 200, contentType: "text/html", body: `<title>Public guide</title><h1>${guide.title}</h1>` });
  });
  await page.route("**/write/api/guides**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.pathname === "/write/api/guides" && method === "POST") {
      const body = request.postDataJSON() as { id: string };
      createIds.push(body.id); createAttempts++;
      if (createAttempts === 1) { await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) }); return; }
      events.push("create");
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ guide: { id: ID }, created: true, experienceLinked: true }) }); return;
    }
    if (url.pathname === `/write/api/guides/${ID}` && method === "PATCH") {
      if (nextSave === "401") { nextSave = "ok"; await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "unauthenticated" }) }); return; }
      if (nextSave === "409") { await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "conflict" }) }); return; }
      const body = request.postDataJSON() as Record<string, unknown> & { expectedRevision: number; content: SyntheticGuide["content"] };
      const { expectedRevision, ...draft } = body;
      expect(expectedRevision).toBe(guide.revision);
      guide = { ...guide, ...draft, cover: draft.cover === null ? undefined : draft.cover as SyntheticGuide["cover"], revision: guide.revision + 1, updatedAtUtc: UPDATED };
      events.push(`save:${guide.revision}`);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ guide }) }); return;
    }
    if (url.pathname === `/write/api/guides/${ID}` && method === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ guide: { ...guide, revision: guide.revision + 4, title: "Server latest" } }) }); return;
    }
    if (url.pathname === `/write/api/guides/${ID}/media/${COVER_ID}` && method === "DELETE") {
      const body = request.postDataJSON() as { expectedRevision: number };
      expect(body.expectedRevision).toBe(guide.revision);
      guide = { ...guide, cover: undefined, revision: guide.revision + 1 };
      events.push("revoke-cover");
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ guide }) }); return;
    }
    if (url.pathname === `/write/api/guides/${ID}/publication` && method === "POST") {
      const body = request.postDataJSON() as { expectedRevision: number; visibility: "PUBLIC" | "UNLISTED" };
      expect(body.expectedRevision).toBe(guide.revision);
      guide = { ...guide, status: "PUBLISHED", revision: guide.revision + 1, currentPublication: { id: 1, number: 1, sourceRevision: body.expectedRevision, visibility: body.visibility, publishedAtUtc: UPDATED } };
      events.push(`publish:${body.expectedRevision}`);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ guide, publication: { status: "PUBLISHED", visibility: body.visibility, url: `/guides/${guide.slug}` } }) }); return;
    }
    if (url.pathname === `/write/api/guides/${ID}/publication` && method === "DELETE") {
      const body = request.postDataJSON() as { expectedRevision: number };
      expect(body.expectedRevision).toBe(guide.revision);
      guide = { ...guide, status: "STOPPED", revision: guide.revision + 1 };
      events.push("stop");
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ guide, publication: { status: "STOPPED", url: `/guides/${guide.slug}` } }) }); return;
    }
    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not_found" }) });
  });
  return { get guide() { return guide; }, createIds, events, setNextSave(value: "401" | "409") { nextSave = value; } };
}

test("opening an existing article does not create an unpublished revision", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "write-desktop", "desktop editor lifecycle");
  const api = await mockWriterApi(page);
  await page.goto(`/write/write-e2e-fixture/edit/${ID}`);
  await expect(page.getByRole("heading", { name: "記事の設定" })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "ホストのメニュー" });
  await expect(nav).toBeVisible();
  await expect(nav.getByRole("link", { name: /A slow Kamakura morning/ })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: /A slow Kamakura morning/ })).toContainText("下書き");
  await page.getByRole("button", { name: "サイドバーを閉じる" }).click();
  await expect(nav).toBeHidden();
  await page.getByRole("button", { name: "サイドバーを開く" }).click();
  await expect(nav).toBeVisible();
  await page.waitForTimeout(1200); // Exceeds the editor's 900ms autosave debounce.
  expect(api.events.filter((event) => event.startsWith("save:"))).toEqual([]);
  expect(api.guide.revision).toBe(1);
});

test("画面の日本語は NIHO Sans、英語の記事の題と本文は英語のサイトと同じ書体（#615）", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "write-desktop", "the type is the same at every width");
  await mockWriterApi(page);
  await page.goto(`/write/write-e2e-fixture/edit/${ID}`);
  await expect(page.getByRole("heading", { name: "記事の設定" })).toBeVisible();
  expect(await japaneseTextOutsideNihoSans(page)).toEqual([]);
  const family = (selector: string) => page.locator(selector).first().evaluate((element) => getComputedStyle(element).fontFamily);
  expect(await family("#write-settings-title")).toMatch(/^"Nunito Variable", "NIHO Sans"/);
  // 英語の記事（fixture は language: "en"）は、公開される英語のページと同じ見た目で書く
  await expect(page.locator("#write-title")).toHaveAttribute("lang", "en");
  expect(await family("#write-title")).toMatch(/^"Fraunces Variable"/);
  expect(await family(".write-prosemirror")).toMatch(/^"Nunito Variable", "Hiragino Sans"/);
});

test("1280px and 1024px keep the paper and publish checks aligned in two columns", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "write-desktop", "desktop editor layout");
  await mockWriterApi(page);
  for (const width of [1280, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/write/write-e2e-fixture/edit/${ID}`);
    const paper = page.locator(".write-rail");
    const checks = page.locator(".write-check-panel");
    await expect(paper).toBeVisible();
    await expect(checks).toBeVisible();
    const [paperBox, checksBox] = await Promise.all([paper.boundingBox(), checks.boundingBox()]);
    expect(paperBox).not.toBeNull();
    expect(checksBox).not.toBeNull();
    expect(Math.abs(paperBox!.y - checksBox!.y)).toBeLessThanOrEqual(2);
    expect(checksBox!.x).toBeGreaterThan(paperBox!.x + paperBox!.width);
    expect(paperBox!.y).toBeLessThan(900);
    expect(checksBox!.y).toBeLessThan(900);
    const titleFontSize = await page.getByLabel("タイトル", { exact: true }).evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
    expect(titleFontSize).toBeLessThanOrEqual(44);
  }
});

test("article list filters and searches, distinguishes empty results, and creates only after dialog submit", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "write-desktop", "desktop list and dialog");
  const api = await mockWriterApi(page);
  await page.goto("/write/write-e2e-fixture/list");
  await expect(page.getByRole("heading", { level: 1, name: "記事" })).toBeVisible();
  const hostNavigation = page.getByRole("navigation", { name: "ホストのメニュー" });
  const guideList = page.locator(".write-guide-list");
  await expect(hostNavigation.getByRole("link", { name: "記事", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("3件", { exact: true })).toBeVisible();
  await expect(guideList.getByRole("link", { name: /A slow Kamakura morning/ }).locator("img")).toHaveAttribute("src", `/write/api/guides/${ID}/media/${COVER_ID}`);

  await page.getByRole("button", { name: /公開停止中/ }).click();
  await expect(guideList.getByRole("link", { name: /Stopped neighborhood story/ })).toBeVisible();
  await page.getByRole("button", { name: /公開中/ }).click();
  await expect(guideList.getByRole("link", { name: /Published neighborhood story/ })).toBeVisible();
  await expect(guideList.getByRole("link", { name: /A slow Kamakura morning/ })).toHaveCount(0);
  await page.getByPlaceholder("題名・URLで検索").fill("published-neighborhood-story");
  await expect(guideList.getByRole("link", { name: /Published neighborhood story/ })).toBeVisible();
  await page.getByPlaceholder("題名・URLで検索").fill("does-not-exist");
  await expect(page.getByRole("heading", { name: "条件に合う記事はありません" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "最初の記事を書きましょう" })).toHaveCount(0);

  const sidebarTrigger = hostNavigation.getByRole("button", { name: "新しい記事" });
  await sidebarTrigger.click();
  const dialog = page.getByRole("dialog", { name: "新しい記事" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(sidebarTrigger).toBeFocused();

  const trigger = page.locator(".write-page-head").getByRole("button", { name: /新しい記事/ });
  await trigger.click();
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((element: HTMLDialogElement) => element.matches(":modal"))).toBe(true);
  expect(api.createIds).toHaveLength(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(api.createIds).toHaveLength(0);

  await trigger.click();
  await dialog.getByLabel("記事タイトル").fill("A new local story");
  await dialog.getByRole("button", { name: "下書きを作成" }).click();
  await expect(dialog.locator(".write-error")).toContainText("同じ作成IDで再試行");
  await dialog.getByRole("button", { name: "下書きを作成" }).click();
  await expect(page).toHaveURL(new RegExp(`/write/write-e2e-fixture/edit/${ID}$`));
  expect(api.createIds).toHaveLength(2);
  expect(api.createIds[0]).toBe(api.createIds[1]);
});

test("empty list, multi-provider choice and direct /new dialog keep their distinct safe states", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "write-desktop", "desktop list states");
  const api = await mockWriterApi(page);
  await page.goto("/write/write-e2e-fixture/list-empty");
  await expect(page.getByRole("heading", { name: "最初の記事を書きましょう" })).toBeVisible();
  await expect(page.locator(".write-empty")).toContainText("下書きを作る");
  await page.goto("/write/write-e2e-fixture/list-multi");
  await page.locator(".write-page-head").getByRole("button", { name: /新しい記事/ }).click();
  await expect(page.getByLabel("記事を書く提供者")).toBeVisible();
  await page.getByRole("button", { name: "新しい記事を閉じる" }).click();
  await page.goto("/write/write-e2e-fixture/new-direct");
  await expect(page.getByRole("dialog", { name: "新しい記事" })).toBeVisible();
  expect(api.createIds).toHaveLength(0);
  await auditSerious(page);
});

test("login entry → idempotent create retry → latest save → private preview → publish → public guide → stop", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "write-desktop", "desktop flow");
  const api = await mockWriterApi(page);
  await page.goto("/write/write-e2e-fixture");
  await page.getByRole("link", { name: "NIHOでログインして記事を書く" }).click();
  await page.getByLabel("記事タイトル").fill("A new local story");
  await page.getByRole("button", { name: "下書きを作成" }).click();
  await expect(page.locator(".write-error")).toContainText("同じ作成IDで再試行");
  await page.getByRole("button", { name: "下書きを作成" }).click();
  await expect(page).toHaveURL(new RegExp(`/write/write-e2e-fixture/edit/${ID}$`));
  expect(api.createIds).toHaveLength(2);
  expect(api.createIds[0]).toBe(api.createIds[1]);

  const body = page.locator(".write-prosemirror");
  await body.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Last sentence.");
  const popupPromise = page.context().waitForEvent("page");
  await page.getByRole("button", { name: "プレビュー" }).click();
  const preview = await popupPromise;
  await expect(preview).toHaveTitle("Private preview");
  expect(api.guide.content.markdown).toContain("Last sentence");
  expect(api.events.indexOf("preview")).toBeGreaterThan(api.events.findIndex((event) => event.startsWith("save:")));

  await page.getByRole("button", { name: "公開する" }).click();
  await page.getByRole("dialog", { name: "記事を公開" }).getByRole("button", { name: "公開する" }).click();
  await expect(page.locator(".write-editor-header .write-publication-status")).toHaveText("公開中");
  await expect(page.getByRole("navigation", { name: "ホストのメニュー" }).getByRole("link", { name: /A slow Kamakura morning/ })).toContainText("公開中");
  await expect(page.getByRole("heading", { name: "記事の設定" })).toBeVisible();
  await expect(page.getByLabel("記事URL")).toHaveAttribute("readonly", "");
  await expect(page.getByRole("status").filter({ hasText: "記事を公開しました。" })).toBeVisible();
  await expect(page.getByRole("link", { name: "公開ページを見る" })).toHaveAttribute("href", `/guides/${api.guide.slug}`);
  const publicPagePromise = page.context().waitForEvent("page");
  await page.getByRole("link", { name: /\/guides\/slow-kamakura-morning/ }).click();
  const publicPage = await publicPagePromise;
  await expect(publicPage).toHaveTitle("Public guide");

  await body.click(); await page.keyboard.press("End"); await page.keyboard.type(" Unpublished edit.");
  await expect(page.locator(".write-editor-header .write-publication-status")).toHaveText("公開中・未公開の変更あり");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByLabel("記事のその他の操作", { exact: true }).click();
  await page.getByRole("button", { name: "公開を停止" }).click();
  await expect(page.getByRole("button", { name: "再公開" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "公開を停止しました。" })).toBeVisible();
  expect(api.events).toContain("stop");
});

test("401 keeps the editor mounted for a separate-tab relogin, then 409 freezes without overwrite", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "write-desktop", "desktop states");
  const api = await mockWriterApi(page);
  await page.goto(`/write/write-e2e-fixture/edit/${ID}`);
  await expect(page.locator(".write-prosemirror")).toBeVisible();
  api.setNextSave("401");
  await page.getByLabel("タイトル", { exact: true }).fill("A title kept through relogin");
  await expect(page.getByText("ログインの有効期限が切れました。編集内容はこのタブに残っています。")).toBeVisible();
  await expect(page.getByLabel("タイトル", { exact: true })).toHaveValue("A title kept through relogin");
  const loginPagePromise = page.context().waitForEvent("page");
  await page.getByRole("link", { name: "別タブで再ログイン" }).click();
  const loginPage = await loginPagePromise;
  await expect(loginPage).toHaveTitle("Signed in");
  await page.getByRole("button", { name: "再ログイン後に保存を再試行" }).click();
  await expect(page.getByText(/保存済み/)).toBeVisible();
  await expect(page.getByRole("navigation", { name: "ホストのメニュー" }).getByRole("link", { name: /A title kept through relogin/ })).toBeVisible();

  api.setNextSave("409");
  await page.getByLabel("タイトル", { exact: true }).fill("Conflicting local title");
  await expect(page.getByText("自動保存を停止しました。このタブの入力を上書きせず、古いrevisionも再送しません。")).toBeVisible();
  await page.getByRole("button", { name: "サーバーの最新版を確認" }).click();
  await expect(page.getByText(/最新版: revision .*Server latest/)).toBeVisible();
  await expect(page.getByLabel("タイトル", { exact: true })).toHaveValue("Conflicting local title");
});

test("cover rights revocation waits for the saved revision and completes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "write-desktop", "desktop rights flow");
  const api = await mockWriterApi(page, true);
  await page.goto(`/write/write-e2e-fixture/edit-photo/${ID}`);
  await expect(page.getByRole("heading", { name: "記事の設定" })).toBeVisible();
  await page.getByText("カバー写真を編集", { exact: true }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "掲載権利を取り消す" }).click();
  await expect.poll(() => api.events.includes("revoke-cover")).toBe(true);
  await expect(page.getByRole("button", { name: "掲載権利を取り消す" })).toHaveCount(0);
  await expect.poll(() => api.guide.content.markdown.includes(`niho-guide-asset:${COVER_ID}`)).toBe(false);
  await expect(page.locator(`.write-figure[data-asset-id="${COVER_ID}"]`)).toHaveCount(0);
});

test("operations stop remains explicit and cannot publish", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "write-desktop", "desktop operations stop");
  await mockWriterApi(page);
  await page.goto(`/write/write-e2e-fixture/edit-ops/${ID}`);
  await expect(page.getByRole("alert").filter({ hasText: "運営により公開が停止されています" })).toContainText("Synthetic policy review");
  await expect(page.getByRole("button", { name: "公開する" })).toBeDisabled();
});

test("secondary list failures keep the authorized article body mounted and preserve settings", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "write-desktop", "desktop auxiliary failure");
  const api = await mockWriterApi(page);
  await page.goto(`/write/write-e2e-fixture/edit-aux/${ID}`);
  await expect(page.getByText("一部の設定を読み込めませんでした。本文の編集は続けられます。")).toBeVisible();
  await expect(page.locator(".write-prosemirror")).toBeVisible();
  await page.waitForTimeout(1200);
  expect(api.events.filter((event) => event.startsWith("save:"))).toEqual([]);

  await page.goto(`/write/write-e2e-fixture/edit-list-error/${ID}`);
  await expect(page.getByRole("status").filter({ hasText: "記事一覧を読み込めませんでした" })).toBeVisible();
  await expect(page.locator(".write-prosemirror")).toBeVisible();
  await expect(page.getByText("まだ記事はありません")).toHaveCount(0);

  await page.goto(`/write/write-e2e-fixture/edit-multi-provider/${ID}`);
  const navigation = page.getByRole("navigation", { name: "ホストのメニュー" });
  await expect(page.locator(".write-workspace > header > details > summary")).toContainText("Second Owner");
  await expect(navigation.getByRole("link", { name: "ホーム" })).toHaveAttribute("href", /providerId=provider-two/);
});

test("publish checks open a closed settings section and focus the field to fix", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "write-desktop", "desktop checklist focus");
  await mockWriterApi(page);
  await page.goto(`/write/write-e2e-fixture/edit/${ID}`);
  await page.getByText("著者", { exact: true }).click();
  await page.getByLabel("名前").fill("");
  await page.getByLabel("タイトル", { exact: true }).fill("A title that must remain here");
  await page.getByText("著者", { exact: true }).click();
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.getByRole("navigation", { name: "ホストのメニュー" }).getByRole("link", { name: /Published neighborhood story/ }).click();
  await expect(page).toHaveURL(new RegExp(`/write/write-e2e-fixture/edit/${ID}$`));
  await expect(page.getByLabel("タイトル", { exact: true })).toHaveValue("A title that must remain here");
  const requirement = page.locator(".write-check-panel li").filter({ hasText: "公開する著者名" });
  await requirement.getByRole("button", { name: "直す" }).click();
  await expect(page.getByLabel("名前")).toBeVisible();
  await expect(page.getByLabel("名前")).toBeFocused();
});

test("360px and 320px keep primary actions and rails inside the viewport", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "write-desktop", "mobile layout");
  await mockWriterApi(page);
  await page.goto(`/write/write-e2e-fixture/edit/${ID}`);
  const title = page.getByLabel("タイトル", { exact: true });
  await title.fill("A long title about experiencing the slower side of Kamakura and finding beautiful places around the neighborhood");
  const titleMetrics = await title.evaluate((element) => ({ height: element.clientHeight, content: element.scrollHeight, width: element.clientWidth, contentWidth: element.scrollWidth }));
  expect(titleMetrics.height).toBeGreaterThan(100);
  expect(titleMetrics.content).toBeLessThanOrEqual(titleMetrics.height + 1);
  expect(titleMetrics.contentWidth).toBeLessThanOrEqual(titleMetrics.width + 1);
  await expect(page.getByRole("button", { name: "プレビュー" })).toBeVisible();
  await expect(page.getByRole("button", { name: "公開する" })).toBeVisible();
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await expect(page.getByRole("heading", { name: "記事の設定" })).toBeVisible();
  await page.getByLabel("カテゴリ").selectOption("");
  await page.getByRole("button", { name: "チェック", exact: true }).click();
  const categoryRequirement = page.locator(".write-check-panel li").filter({ hasText: "カテゴリ" });
  await categoryRequirement.getByRole("button", { name: "直す" }).click();
  await expect(page.getByLabel("カテゴリ")).toBeFocused();
  const metrics = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.width);
  for (const button of [page.getByRole("button", { name: "プレビュー" }), page.getByRole("button", { name: "公開する" })]) {
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(metrics.width);
  }
  await auditSerious(page);
  await page.getByRole("button", { name: "本文", exact: true }).click();
  // Long articles keep the formatting toolbar below the sticky mobile tabs.
  await page.locator(".write-prosemirror").evaluate((element) => { element.style.minHeight = "1500px"; });
  await page.evaluate(() => window.scrollTo(0, 700));
  await expect.poll(async () => {
    const tabs = await page.locator(".write-mobile-tabs").boundingBox();
    const toolbar = await page.locator(".write-toolbar").boundingBox();
    return toolbar && tabs ? toolbar.y - tabs.y - tabs.height : -1;
  }).toBeGreaterThanOrEqual(0);
});

test("desktop host sidebar shows 記事 only for the currently selected OWNER", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "write-desktop", "desktop host role gating");
  await page.goto("/host/auth/mock-login");
  await page.waitForURL(/\/host\/home/);
  const nav = page.getByRole("navigation", { name: "ホストのメニュー" });
  await expect(nav.getByRole("link", { name: "記事", exact: true })).toBeVisible();
  await page.goto("/host/home?providerId=sample-provider-studio");
  await expect(nav.getByRole("link", { name: "記事", exact: true })).toHaveCount(0);
});
