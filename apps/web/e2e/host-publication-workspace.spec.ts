import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { build } from "vite";

// Exercise the real host component with synthetic responses; no host account or live API.
const ORIGIN = "https://publication.example.test";
let bundle: string;
test.beforeAll(async () => {
  const result = await build({
    configFile: false, envDir: false, logLevel: "error",
    root: fileURLToPath(new URL("..", import.meta.url)),
    resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } },
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    build: {
      lib: { entry: fileURLToPath(new URL("./fixtures/host-publication-client.tsx", import.meta.url)), name: "HostPublicationTest", formats: ["iife"] },
      write: false, minify: false,
    },
  });
  const outputs = Array.isArray(result) ? result : "output" in result ? [result] : [];
  const chunk = outputs.flatMap((output) => output.output).find((output) => output.type === "chunk");
  if (!chunk) throw new Error("Synthetic publication client was not built");
  bundle = chunk.code;
});

test("an admin can choose instant payment when preparing a managed experience", async ({ page }) => {
  await page.route(`${ORIGIN}/`, (route) => route.fulfill({ contentType: "text/html", body: '<!doctype html><meta charset="utf-8"><div id="root"></div>' }));
  await page.route(`${ORIGIN}/synthetic/products`, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { products: [], managedSalesAvailable: true } });
    } else {
      await route.fulfill({ status: 201, json: { product: { id: "synthetic-product" } } });
    }
  });
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(() => Object.defineProperty(globalThis, "process", { value: { env: { NODE_ENV: "development" } } }));
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => window.mountHostPublication(true));

  await page.getByLabel("公開URL用の英数字slug").fill("synthetic-managed");
  await page.getByLabel("商品名（公開用）").fill("Synthetic managed experience");
  await page.getByLabel("大人1人の基本料金（税込・円）").fill("10000");
  await page.getByRole("checkbox", { name: /この体験をNIHO完全代行/ }).check();
  await page.getByRole("checkbox", { name: "開催枠ごとに1組貸切にする" }).check();
  await expect(page.getByText(/開催月末締め・翌月末日払い/)).toBeVisible();
  const agreement = page.getByRole("checkbox", { name: /書面・メッセージで条件を明示/ });
  const submit = page.getByRole("button", { name: "下書きを作成" });
  await expect(submit).toBeDisabled();
  await page.getByLabel("予約の受付方法").selectOption("INSTANT");
  await expect(submit).toBeDisabled();
  await agreement.check();
  await expect(submit).toBeEnabled();

  const sent = page.waitForRequest((request) => request.url() === `${ORIGIN}/synthetic/products` && request.method() === "POST");
  await submit.click();
  expect((await sent).postDataJSON()).toMatchObject({
    managedSales: { enabled: true, acceptanceMode: "INSTANT", privateGroup: true, sellerConfirmationMethod: "WRITTEN" },
  });
});

type Page = import("@playwright/test").Page;

const baseProduct = (over: Record<string, unknown> = {}, content: Record<string, unknown> = {}) => ({
  id: "synthetic-product", version: "1", status: "DRAFT", publicationNeedsUpdate: false,
  publicationBlockers: [], sellerDisplayName: "Synthetic seller", saleTerms: null, offers: [], media: [],
  draft: { slug: "synthetic-product", publicTitle: "Synthetic product", currency: "JPY", unitAmount: 5000, content: {
    ja: { title: "合成の商品", lead: "合成の紹介", description: "合成の説明", language: "日本語", highlights: ["一つ目"], included: [], notIncluded: [], knowBeforeYouGo: [], notSuitableFor: [], timeline: [] },
    lead: "Synthetic lead", description: "Synthetic description", facts: { language: "English" },
    highlights: ["First"], included: [], notIncluded: [], knowBeforeYouGo: [], notSuitableFor: [], ...content,
  } },
  ...over,
});

// Mounts the host editor on synthetic responses. PATCH answers with the posted draft so the form is level with the server again.
async function mountHost(page: Page, product: ReturnType<typeof baseProduct>, patches: Array<Record<string, unknown>> = []) {
  await page.route(`${ORIGIN}/`, (route) => route.fulfill({ contentType: "text/html", body: '<!doctype html><meta charset="utf-8"><div id="root"></div>' }));
  await page.route(`${ORIGIN}/synthetic/products/synthetic-product`, async (route) => {
    if (route.request().method() === "PATCH") {
      const posted = route.request().postDataJSON() as { draft: Record<string, unknown> };
      patches.push(posted.draft);
      await route.fulfill({ json: { product: { ...product, version: "2", draft: { ...product.draft, ...posted.draft } } } });
    } else await route.fulfill({ json: { product } });
  });
  await page.route(`${ORIGIN}/host/api/provider-media`, (route) => route.fulfill({ json: { providerMedia: { version: 1, assets: [] } } }));
  await page.route(`${ORIGIN}/host/api/products/synthetic-product/classification`, (route) => route.fulfill({ status: 404, json: {} }));
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(() => Object.defineProperty(globalThis, "process", { value: { env: { NODE_ENV: "development" } } }));
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => window.mountHostPublication());
}

test("the host editor opens on the English tab with four in-page tabs and translates only into English", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mountHost(page, baseProduct());
  await expect(page.getByRole("tab")).toHaveText(["体験ページ", "料金・予約", "日程", "掲載設定"]);
  // 英語 first; a draft that never remembered a Japanese version also shows the small mark in its name.
  await expect(page.getByRole("group", { name: "原稿の言語" }).getByRole("button").first()).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Synthetic product");
  await expect(page.getByRole("button", { name: "日本語から翻訳", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "英語から翻訳", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "日本語", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("合成の商品");
  await expect(page.getByRole("button", { name: "日本語から翻訳", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "英語から翻訳", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "集合の概要" })).toHaveCount(0);
  for (const name of ["料金・予約", "日程", "掲載設定", "体験ページ"]) await page.getByRole("tab", { name }).click();
  expect(errors).toEqual([]);
});

test("rows are typed one per line, empty rows are dropped on save, and saving confirms the English", async ({ page }) => {
  const patches: Array<Record<string, unknown>> = [];
  await mountHost(page, baseProduct(), patches);
  // Both languages are written and nothing remembers the Japanese yet: the notice is there, and saving does not hide it.
  await expect(page.getByText("日本語を変えたあと、英語は変わっていません")).toBeVisible();
  await page.getByRole("button", { name: "このままでよい" }).click();
  const group = page.getByRole("group", { name: "見どころ" });
  await group.getByRole("textbox", { name: "見どころ 1" }).fill("Second");
  await group.getByRole("button", { name: "＋ 行を足す" }).click();
  await expect(group.getByRole("textbox", { name: "見どころ 2" })).toBeFocused();
  await expect(page.getByText("未保存の変更があります")).toBeVisible();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("未保存の変更があります")).toHaveCount(0);
  expect(patches).toHaveLength(1);
  const content = patches[0]!.content as { highlights: string[]; translation: Record<string, string>; languageSync: { englishSourceFingerprint: string } };
  expect(content.highlights).toEqual(["Second"]);
  expect(content.translation.confirmedSourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(content.languageSync.englishSourceFingerprint).toBe(content.translation.sourceFingerprint);
  await expect(group.getByRole("textbox")).toHaveCount(1);
  await expect(page.getByText("日本語を変えたあと、英語は変わっていません")).toHaveCount(0);
});

test("Enter in a row moves on and never saves", async ({ page }) => {
  const patches: Array<Record<string, unknown>> = [];
  await mountHost(page, baseProduct(), patches);
  const group = page.getByRole("group", { name: "見どころ" });
  await group.getByRole("textbox", { name: "見どころ 1" }).press("Enter");
  await expect(group.getByRole("textbox", { name: "見どころ 2" })).toBeFocused();
  await group.getByRole("textbox", { name: "見どころ 2" }).fill("Second");
  await group.getByRole("textbox", { name: "見どころ 1" }).press("Enter");
  await expect(group.getByRole("textbox", { name: "見どころ 2" })).toBeFocused();
  await expect(group.getByRole("textbox")).toHaveCount(2);
  expect(patches).toHaveLength(0);
});

test("a Japanese change after the English was made level is told on the English tab only, and 「このままでよい」 clears it", async ({ page }) => {
  await mountHost(page, baseProduct({}, { languageSync: { englishSourceFingerprint: "older-japanese" } }));
  await expect(page.getByText("日本語を変えたあと、英語は変わっていません")).toBeVisible();
  // The page has no stylesheet here: the dot is in the page but has no size.
  await expect(page.getByRole("img", { name: "日本語のほうが新しい" })).toHaveCount(1);
  await page.getByRole("button", { name: "日本語", exact: true }).click();
  await expect(page.getByText("日本語を変えたあと、英語は変わっていません")).toHaveCount(0);
  await page.getByRole("group", { name: "原稿の言語" }).getByRole("button").first().click();
  await page.getByRole("button", { name: "このままでよい" }).click();
  await expect(page.getByText("日本語を変えたあと、英語は変わっていません")).toHaveCount(0);
  await expect(page.getByText("未保存の変更があります")).toBeVisible();
});

test("a Japanese-only page shows only Japanese, and the photo dialog asks one description", async ({ page }) => {
  await mountHost(page, baseProduct({}, { japaneseOnly: true }));
  await expect(page.getByRole("group", { name: "原稿の言語" })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("合成の商品");
  await page.getByRole("button", { name: "＋ 写真を追加" }).click();
  const dialog = page.getByRole("dialog", { name: "写真を追加" });
  await expect(dialog.getByRole("textbox", { name: "写真の説明（日本語）", exact: true })).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "写真の説明（英語）", exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("写真の用途")).toHaveCount(0);
});

test("the photo dialog asks both descriptions on a page in both languages", async ({ page }) => {
  await mountHost(page, baseProduct());
  await page.getByRole("button", { name: "＋ 写真を追加" }).click();
  const dialog = page.getByRole("dialog", { name: "写真を追加" });
  await expect(dialog.getByRole("textbox", { name: "写真の説明（英語）", exact: true })).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "写真の説明（日本語）", exact: true })).toBeVisible();
  await expect(dialog.getByLabel("写真の用途")).toHaveCount(0);
});

test("「同意して公開」 names what is missing only when pressed, and asks for consent when nothing is", async ({ page }) => {
  await mountHost(page, baseProduct({ publicationBlockers: ["SCHEDULE_REQUIRED", "PRICE_REQUIRED", "CONNECT_NOT_READY"] }));
  await expect(page.getByText("あと2つ必要です")).toHaveCount(0);
  await expect(page.getByRole("img", { name: "確認が必要" })).toHaveCount(0);
  await page.getByRole("button", { name: "同意して公開", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "公開するには、あと3つ必要です" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("link", { name: "カレンダーを開く" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "入力する" })).toHaveCount(1);
  await dialog.getByRole("button", { name: "閉じる" }).click();
  await expect(page.getByRole("tab", { name: /料金・予約/ }).getByRole("img", { name: "確認が必要" })).toHaveCount(1);
  await expect(page.getByRole("tab", { name: /日程/ }).getByRole("img", { name: "確認が必要" })).toHaveCount(0);
});

test("with nothing missing the main button opens the publish confirmation", async ({ page }) => {
  await mountHost(page, baseProduct());
  await page.getByRole("button", { name: "同意して公開", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "この商品を公開しますか？" })).toBeVisible();
});

test("「同意して公開」 confirms manuscripts that were saved without a confirmation, with no edit needed", async ({ page }) => {
  // Written in both languages under the old screen but never confirmed: nothing is unsaved, and the server holds MANUSCRIPT_REQUIRED.
  const product = baseProduct({ publicationBlockers: ["MANUSCRIPT_REQUIRED"] });
  await mountHost(page, product);
  const drafts: Array<{ content: { translation?: Record<string, unknown> } }> = [];
  await page.route(`${ORIGIN}/synthetic/products/synthetic-product`, async (route) => {
    if (route.request().method() !== "PATCH") { await route.fallback(); return; }
    const posted = route.request().postDataJSON() as { draft: { content: { translation?: Record<string, unknown> } } };
    drafts.push(posted.draft);
    await route.fulfill({ json: { product: { ...product, version: "2", publicationBlockers: [], draft: { ...product.draft, ...posted.draft } } } });
  });
  await page.getByRole("button", { name: "同意して公開", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "この商品を公開しますか？" })).toBeVisible();
  expect(drafts).toHaveLength(1);
  const translation = drafts[0]!.content.translation ?? {};
  expect(typeof translation.sourceFingerprint).toBe("string");
  expect(translation.confirmedSourceFingerprint).toBe(translation.sourceFingerprint);
  expect(typeof translation.confirmedEnglishFingerprint).toBe("string");
});

test("the info tip opens a bubble and closes with Escape", async ({ page }) => {
  await mountHost(page, baseProduct());
  const tip = page.getByRole("button", { name: "写真の説明" });
  await tip.click();
  await expect(tip).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("1枚目が体験ページの表紙です。")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tip).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("1枚目が体験ページの表紙です。")).toBeHidden();
});

async function mountHostList(page: Page, host: "list" | "create", posts: Array<{ status: number; body: Record<string, unknown> }>, sent: Array<Record<string, unknown>>) {
  await page.route(`${ORIGIN}/`, (route) => route.fulfill({ contentType: "text/html", body: '<!doctype html><meta charset="utf-8"><div id="root"></div>' }));
  await page.route(`${ORIGIN}/synthetic/products`, async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { products: [] } });
    sent.push(route.request().postDataJSON() as Record<string, unknown>);
    const next = posts.shift() ?? { status: 201, body: { product: { id: "created" } } };
    return route.fulfill({ status: next.status, json: next.body });
  });
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(() => Object.defineProperty(globalThis, "process", { value: { env: { NODE_ENV: "development" } } }));
  await page.addScriptTag({ content: bundle });
  await page.evaluate((mode) => window.mountHostPublication(false, mode), host);
}

test("体験を作成 opens a dialog on the list and sends the name, price and an address made from the name", async ({ page }) => {
  const sent: Array<Record<string, unknown>> = [];
  await mountHostList(page, "list", [], sent);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "体験を作成" }).click();
  const dialog = page.getByRole("dialog", { name: "体験を作成" });
  await expect(dialog.getByRole("radio", { name: "英語と日本語" })).toBeChecked();
  await dialog.getByRole("radio", { name: "日本語のみ" }).check();
  await dialog.getByRole("textbox", { name: "体験名", exact: true }).fill("Cook and Share a Community Dinner with Kamakura Locals");
  await dialog.getByRole("textbox", { name: "大人1人の料金（税込・円）", exact: true }).fill("3500");
  await dialog.getByRole("button", { name: "作成" }).click();
  await expect.poll(() => sent.length).toBe(1);
  const body = sent[0] as { slug: string; publicTitle: string; unitAmount: number; content: { japaneseOnly?: boolean; ja: { title: string } }; managedSales?: unknown };
  expect(body.slug).toBe("cook-and-share-a-community-dinner");
  expect(body.publicTitle).toBe("Cook and Share a Community Dinner with Kamakura Locals");
  expect(body.unitAmount).toBe(3500);
  expect(body.content.japaneseOnly).toBe(true);
  expect(body.content.ja.title).toBe(body.publicTitle);
  expect(body.managedSales).toBeUndefined();
});

test("the create dialog tries a conflicting address once more with four digits", async ({ page }) => {
  const sent: Array<Record<string, unknown>> = [];
  await mountHostList(page, "create", [{ status: 409, body: { error: { code: "VERSION_CONFLICT" } } }], sent);
  const dialog = page.getByRole("dialog", { name: "体験を作成" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "体験名", exact: true }).fill("Tea ceremony");
  await dialog.getByRole("textbox", { name: "大人1人の料金（税込・円）", exact: true }).fill("0");
  await dialog.getByRole("button", { name: "作成" }).click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[0]!.slug).toBe("tea-ceremony");
  expect(sent[1]!.slug).toMatch(/^tea-ceremony-\d{4}$/);
  expect((sent[1]!.content as { japaneseOnly?: boolean }).japaneseOnly).toBeUndefined();
});
