import { expect, test, type Page } from "@playwright/test";

const ID = "00000000-0000-4000-8000-000000000478";
const COVER_ID = "00000000-0000-4000-8000-000000000479";
const UPDATED = "2026-11-08T01:00:00.000Z";

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
  await expect(page.getByText("公開中", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "記事の設定" })).toBeVisible();
  await expect(page.getByLabel("記事URL")).toHaveAttribute("readonly", "");
  await expect(page.getByRole("status").filter({ hasText: "記事を公開しました。" })).toBeVisible();
  await expect(page.getByRole("link", { name: "公開ページを見る" })).toHaveAttribute("href", `/guides/${api.guide.slug}`);
  const publicPagePromise = page.context().waitForEvent("page");
  await page.getByRole("link", { name: /\/guides\/slow-kamakura-morning/ }).click();
  const publicPage = await publicPagePromise;
  await expect(publicPage).toHaveTitle("Public guide");

  await body.click(); await page.keyboard.press("End"); await page.keyboard.type(" Unpublished edit.");
  await expect(page.getByText("公開中・未公開の変更あり", { exact: true })).toBeVisible();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "公開を停止" }).click();
  await expect(page.getByRole("button", { name: "再公開" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "公開を停止しました。" })).toBeVisible();
  expect(api.events).toContain("stop");
});

test("401 keeps the editor mounted for a separate-tab relogin, then 409 freezes without overwrite", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "write-desktop", "desktop states");
  const api = await mockWriterApi(page);
  await page.goto(`/write/write-e2e-fixture/edit/${ID}`);
  api.setNextSave("401");
  await page.getByLabel("タイトル").fill("A title kept through relogin");
  await expect(page.getByText("ログインの有効期限が切れました。編集内容はこのタブに残っています。")).toBeVisible();
  await expect(page.getByLabel("タイトル")).toHaveValue("A title kept through relogin");
  const loginPagePromise = page.context().waitForEvent("page");
  await page.getByRole("link", { name: "別タブで再ログイン" }).click();
  const loginPage = await loginPagePromise;
  await expect(loginPage).toHaveTitle("Signed in");
  await page.getByRole("button", { name: "再ログイン後に保存を再試行" }).click();
  await expect(page.getByText(/保存済み/)).toBeVisible();

  api.setNextSave("409");
  await page.getByLabel("タイトル").fill("Conflicting local title");
  await expect(page.getByText("自動保存を停止しました。このタブの入力を上書きせず、古いrevisionも再送しません。")).toBeVisible();
  await page.getByRole("button", { name: "サーバーの最新版を確認" }).click();
  await expect(page.getByText(/最新版: revision .*Server latest/)).toBeVisible();
  await expect(page.getByLabel("タイトル")).toHaveValue("Conflicting local title");
});

test("cover rights revocation waits for the saved revision and completes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "write-desktop", "desktop rights flow");
  const api = await mockWriterApi(page, true);
  await page.goto(`/write/write-e2e-fixture/edit-photo/${ID}`);
  await expect(page.getByRole("heading", { name: "記事の設定" })).toBeVisible();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "掲載権利を取り消す" }).click();
  await expect.poll(() => api.events.includes("revoke-cover")).toBe(true);
  await expect(page.getByRole("button", { name: "掲載権利を取り消す" })).toHaveCount(0);
  await expect.poll(() => api.guide.content.markdown.includes(`niho-guide-asset:${COVER_ID}`)).toBe(false);
  await expect(page.locator(`.write-figure[data-asset-id="${COVER_ID}"]`)).toHaveCount(0);
});

test("360px and 320px keep primary actions and rails inside the viewport", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "write-desktop", "mobile layout");
  await mockWriterApi(page);
  await page.goto(`/write/write-e2e-fixture/edit/${ID}`);
  const title = page.getByLabel("タイトル");
  await title.fill("A long title about experiencing the slower side of Kamakura and finding beautiful places around the neighborhood");
  const titleMetrics = await title.evaluate((element) => ({ height: element.clientHeight, content: element.scrollHeight, width: element.clientWidth, contentWidth: element.scrollWidth }));
  expect(titleMetrics.height).toBeGreaterThan(100);
  expect(titleMetrics.content).toBeLessThanOrEqual(titleMetrics.height + 1);
  expect(titleMetrics.contentWidth).toBeLessThanOrEqual(titleMetrics.width + 1);
  await expect(page.getByRole("button", { name: "プレビュー" })).toBeVisible();
  await expect(page.getByRole("button", { name: "公開する" })).toBeVisible();
  const metrics = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.width);
  for (const button of [page.getByRole("button", { name: "プレビュー" }), page.getByRole("button", { name: "公開する" })]) {
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(metrics.width);
  }
});
