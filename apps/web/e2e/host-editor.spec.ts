import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

// The experience editor (#89) on synthetic data. Runs against the second server
// (HOST_CONSOLE_ENABLED=true, mock mode; see playwright.config.ts). Nothing is sent:
// 保存 keeps the page in the screen, photos stay in the browser, and 申請・停止・取り下げ
// change the state shown there.

const SAMPLE_PHOTO = fileURLToPath(new URL("../public/sample/photos/niho-cd-table-01.jpg", import.meta.url));

const isDesktop = (projectName: string) => projectName === "host-desktop";
const menu = (page: Page) => page.getByRole("navigation", { name: "ホストのメニュー" });
const panel = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const saveButton = (page: Page) => page.getByRole("button", { name: "保存", exact: true });
const savedNotice = (page: Page) => page.getByRole("status").filter({ hasText: "保存しました" });
const steps = (listing: Locator) => listing.getByRole("list", { name: "掲載までの流れ" }).getByRole("listitem");
const overflowX = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function signIn(page: Page) {
  await page.goto("/host/auth/mock-login");
  await page.waitForURL(/\/host\/home(\?|$)/);
}

async function openEditor(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByRole("textbox", { name: "題名" })).toBeVisible();
}

async function audit(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), label).toEqual([]);
}

test("the list opens the page: its title, eight photos and the live listing, and ‹ goes back", async ({ page }, testInfo) => {
  await signIn(page);
  await page.goto("/host/experiences");
  await page.getByRole("region", { name: "体験の一覧" }).getByRole("link").first().click();
  await page.waitForURL(/\/host\/experiences\/community-dinner$/);
  // Written in Japanese (#110): the title is the host's Japanese one, and the page opens on 日本語で書く.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("鎌倉の地元の人と囲むコミュニティディナー");
  await expect(page.getByRole("textbox", { name: "題名" })).toHaveValue("鎌倉の地元の人と囲むコミュニティディナー");
  await expect(page.getByRole("tab", { name: "日本語で書く" })).toHaveAttribute("aria-selected", "true");

  const photos = panel(page, "写真").getByRole("listitem");
  await expect(photos).toHaveCount(8);
  await expect(photos.first()).toContainText("表紙");
  await expect(photos.first().getByRole("button", { name: /^表紙にする/ })).toHaveCount(0);
  await expect(photos.nth(1).getByRole("button", { name: "表紙にする（写真 2）" })).toHaveCount(1);
  await expect(photos.nth(7).getByRole("button", { name: "写真 8 を外す" })).toHaveCount(1);

  const listing = panel(page, "掲載");
  await expect(steps(listing)).toHaveText(["下書き（済み）", "審査（済み）", "掲載中（現在）"]);
  await expect(listing).toContainText("体験サイトで公開中 · 2026年10月12日から");
  const site = listing.getByRole("link", { name: /^体験サイトで見る/ });
  await expect(site).toHaveAttribute("href", "/experiences/kamakura-community-dinner");
  await expect(site).toHaveAttribute("target", "_blank");
  await expect(listing.getByRole("button", { name: "掲載を止める" })).toBeEnabled();

  const offers = panel(page, "申込の設定").getByRole("listitem");
  await expect(offers).toHaveCount(2);
  // The offers' names are in the tab's language (日本語で書く).
  for (const text of ["ディナー", "18:00 · 120分 · 定員8", "¥30,000〜", "子ども ¥12,000"]) await expect(offers.nth(0)).toContainText(text);
  for (const text of ["ティータイム", "13:00 · 120分 · 定員8", "¥15,000〜"]) await expect(offers.nth(1)).toContainText(text);
  await expect(offers.nth(1)).not.toContainText("子ども");

  const pageSettings = panel(page, "ページ");
  await expect(pageSettings.getByRole("radio", { name: "日本語" })).toBeChecked();
  await expect(pageSettings.getByRole("radiogroup", { name: "書く言語" })).toBeVisible();
  await expect(pageSettings).toContainText("/experiences/kamakura-community-dinner");
  await expect(pageSettings.getByRole("button", { name: "URL をコピー" })).toBeVisible();

  // プレビュー opens the public page in a new tab.
  const preview = page.getByRole("link", { name: /^プレビュー/ });
  await expect(preview).toHaveAttribute("href", "/experiences/kamakura-community-dinner");
  await expect(preview).toHaveAttribute("target", "_blank");
  // 迎える人 is the provider, from 設定.
  const host = panel(page, "迎える人");
  await expect(host).toContainText("サンプルの台所");
  await expect(host.getByRole("link", { name: "紹介を編集" })).toHaveAttribute("href", "/host/settings");
  // Nothing has changed yet, so there is no 保存.
  await expect(saveButton(page)).toHaveCount(0);

  // PC: the 320px rail on the right of the page text. Phones: the rail first.
  const rail = (await listing.boundingBox())!;
  const text = (await panel(page, "写真").boundingBox())!;
  if (isDesktop(testInfo.project.name)) {
    expect(rail.width).toBe(320);
    expect(rail.x).toBeGreaterThan(text.x + text.width);
    expect(rail.y).toBeCloseTo(text.y, 0);
  } else {
    expect(rail.y + rail.height).toBeLessThan(text.y);
  }

  await page.getByRole("link", { name: "体験へ戻る" }).click();
  await page.waitForURL(/\/host\/experiences$/);
  await expect(page.getByRole("heading", { level: 1, name: "体験" })).toBeVisible();
});

test("見どころ gets a row and 保存 says 保存しました; until then 掲載を止める waits", async ({ page }, testInfo) => {
  await signIn(page);
  await openEditor(page, "/host/experiences/community-dinner");
  const highlights = panel(page, "見どころ");
  await expect(highlights.getByRole("textbox")).toHaveCount(4);
  await highlights.getByRole("button", { name: "見どころに行を足す" }).click();
  const added = highlights.getByRole("textbox", { name: "見どころ 5" });
  await expect(added).toBeFocused();
  await added.fill("Take the recipes home on a postcard.");

  // 表紙にする moves the photo to the front (focus stays with it); × takes one out.
  const photos = panel(page, "写真").getByRole("listitem");
  await photos.nth(2).getByRole("button", { name: "表紙にする（写真 3）" }).click();
  await expect(photos.first().locator("img")).toHaveAttribute("src", "/sample/photos/niho-cd-food-trays.jpg");
  await expect(photos.first()).toContainText("表紙");
  await expect(photos.nth(1).locator("img")).toHaveAttribute("src", "/sample/photos/niho-cd-table-01.jpg");
  await expect(photos.first().getByRole("button", { name: "写真 1 を外す" })).toBeFocused();
  await photos.nth(7).getByRole("button", { name: "写真 8 を外す" }).click();
  await expect(photos).toHaveCount(7);

  const listing = panel(page, "掲載");
  const stop = listing.getByRole("button", { name: "掲載を止める" });
  await expect(stop).toBeDisabled();
  await expect(listing).toContainText("保存後に操作できます");

  // PC: a leaf pill floating at the bottom right. Phones: a full-width 48px band on the bottom edge, with no tabs under it.
  const save = saveButton(page);
  await expect(save).toBeInViewport();
  const viewport = page.viewportSize()!;
  const box = (await save.boundingBox())!;
  if (isDesktop(testInfo.project.name)) {
    expect(box.height).toBe(44);
    expect(box.x + box.width).toBeGreaterThan(viewport.width - 80);
    expect(box.y + box.height).toBeGreaterThan(viewport.height - 80);
  } else {
    expect(box.height).toBe(48);
    expect(box.width).toBe(viewport.width - 32);
    expect(box.y + box.height).toBeGreaterThan(viewport.height - 40);
    await expect(menu(page)).toHaveCount(0);
  }

  const sent: string[] = [];
  page.on("request", (request) => sent.push(`${request.method()} ${request.url()} ${request.postData() ?? ""}`));
  await save.click();
  await expect(savedNotice(page)).toBeVisible();
  await expect(save).toHaveCount(0);
  await expect(stop).toBeEnabled();
  await expect(highlights.getByRole("textbox")).toHaveCount(5);
  await expect(added).toHaveValue("Take the recipes home on a postcard.");
  await expect(photos).toHaveCount(7);
  // Nothing left the browser.
  expect(sent.filter((line) => !line.startsWith("GET ") || line.includes("postcard"))).toEqual([]);
  // The notice goes after a moment.
  await expect(savedNotice(page)).toHaveCount(0, { timeout: 5_000 });

  // 掲載を止める: the listing stops, and the way back is a new application.
  await stop.click();
  await expect(steps(listing)).toHaveText(["下書き（済み）", "審査（済み）", "掲載中"]);
  await expect(listing).toContainText("停止中");
  await expect(listing).toContainText("掲載を止めています");
  const apply = listing.getByRole("button", { name: "掲載を申請" });
  await expect(apply).toBeDisabled();
  await expect(page.getByRole("status").filter({ hasText: "掲載を止めました" })).toHaveCount(1);
  // The Japanese changed since the English was confirmed (#110): the new application waits for the English.
  await expect(listing.getByRole("list", { name: "掲載までに必要" }).getByRole("listitem")).toHaveText(["英語の確定"]);
  await page.getByRole("tab", { name: /^英語（公開）/ }).click();
  await page.getByRole("region", { name: "英語の状態" }).getByRole("button", { name: "英語を確定" }).click();
  await expect(listing).toContainText("保存後に申請できます");
  await saveButton(page).click();
  await expect(savedNotice(page)).toBeVisible();
  await listing.getByRole("checkbox", { name: "掲載の条件に同意する" }).check();
  await expect(apply).toBeEnabled();
});

test("a draft: what it needs, a photo and an offer, 保存, the consent and 掲載を申請", async ({ page }) => {
  await signIn(page);
  await openEditor(page, "/host/experiences/coffee");
  const listing = panel(page, "掲載");
  const needs = listing.getByRole("list", { name: "掲載までに必要" }).getByRole("listitem");
  await expect(steps(listing)).toHaveText(["下書き（現在）", "審査", "掲載中"]);
  await expect(needs).toHaveText(["表紙写真", "料金"]);
  const apply = listing.getByRole("button", { name: "掲載を申請" });
  await expect(apply).toBeDisabled();
  await expect(page.getByRole("button", { name: "保存後にプレビュー" })).toBeDisabled();

  // A photo from this computer becomes the cover.
  const chooser = page.waitForEvent("filechooser");
  await panel(page, "写真").getByRole("button", { name: "写真を追加" }).click();
  await (await chooser).setFiles(SAMPLE_PHOTO);
  const photos = panel(page, "写真").getByRole("listitem");
  await expect(photos).toHaveCount(1);
  await expect(photos.first()).toContainText("表紙");
  await expect(photos.first().locator("img")).toHaveAttribute("src", /^blob:/);
  await expect(needs).toHaveText(["料金"]);

  // An offer, from its dialog.
  const offers = panel(page, "申込の設定");
  await offers.getByRole("button", { name: "商品を追加" }).click();
  const dialog = page.getByRole("dialog", { name: "商品の追加" });
  const name = dialog.getByRole("textbox", { name: "商品名" });
  await expect(name).toBeFocused();
  await expect(dialog.getByRole("button", { name: "この商品を削除" })).toHaveCount(0);
  await name.fill("Roasting workshop");
  await dialog.getByRole("spinbutton", { name: /^大人の料金/ }).fill("9800");
  await dialog.getByRole("spinbutton", { name: /^定員/ }).fill("6");
  await dialog.getByRole("spinbutton", { name: /^所要時間/ }).fill("90");
  await dialog.getByLabel("開始時刻").fill("14:00");
  for (const day of ["土", "日"]) await dialog.getByRole("checkbox", { name: day, exact: true }).check();
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const row = offers.getByRole("listitem");
  await expect(row).toHaveCount(1);
  for (const text of ["Roasting workshop", "14:00 · 90分 · 定員6", "¥9,800〜"]) await expect(row).toContainText(text);

  // Nothing is missing now; the page is saved before it is submitted.
  await expect(listing.getByRole("list", { name: "掲載までに必要" })).toHaveCount(0);
  await listing.getByRole("checkbox", { name: "掲載の条件に同意する" }).check();
  await expect(apply).toBeDisabled();
  await expect(listing).toContainText("保存後に申請できます");
  await saveButton(page).click();
  await expect(page.getByRole("dialog", { name: "保存していない変更があります" })).toHaveCount(0);
  await expect(savedNotice(page)).toBeVisible();
  await expect(apply).toBeEnabled();
  await apply.click();

  await expect(steps(listing)).toHaveText(["下書き（済み）", "審査（現在）", "掲載中"]);
  await expect(listing).toContainText("審査待ち");
  await expect(listing).toContainText("10月21日に申請 · NIHO が確認中");
  await expect(listing.getByRole("button", { name: "申請を取り下げる" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "掲載を申請しました" })).toHaveCount(1);
  // Under review, プレビュー opens the public page.
  await expect(page.getByRole("link", { name: /^プレビュー/ })).toHaveAttribute("href", "/experiences/kamakura-coffee-roasting");
});

test("under review: 申請を取り下げる makes the listing a draft again", async ({ page }) => {
  await signIn(page);
  await openEditor(page, "/host/experiences/kintsugi");
  const listing = panel(page, "掲載");
  await expect(steps(listing)).toHaveText(["下書き（済み）", "審査（現在）", "掲載中"]);
  await expect(listing).toContainText("10月19日に申請 · NIHO が確認中");
  await expect(page.getByRole("link", { name: /^プレビュー/ })).toHaveAttribute("href", "/experiences/kamakura-ceramic-mending");

  await listing.getByRole("button", { name: "申請を取り下げる" }).click();
  await expect(steps(listing)).toHaveText(["下書き（現在）", "審査", "掲載中"]);
  await expect(page.getByRole("status").filter({ hasText: "申請を取り下げました" })).toHaveCount(1);
  // The preview has no photo of this one: a draft asks for it before it can be submitted again.
  await expect(listing.getByRole("list", { name: "掲載までに必要" }).getByRole("listitem")).toHaveText(["表紙写真"]);
  await expect(listing.getByRole("button", { name: "掲載を申請" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "保存後にプレビュー" })).toBeDisabled();
});

test("an offer name made only of whitespace is rejected", async ({ page }) => {
  await signIn(page);
  await openEditor(page, "/host/experiences/coffee");
  const offers = panel(page, "申込の設定");
  await offers.getByRole("button", { name: "商品を追加" }).click();
  const dialog = page.getByRole("dialog", { name: "商品の追加" });
  const name = dialog.getByRole("textbox", { name: "商品名" });
  await name.fill("   ");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toBeVisible();
  expect(await name.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(false);

  await name.fill("Roasting workshop");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(offers.getByRole("listitem")).toHaveCount(1);
  await expect(offers.getByRole("listitem").first()).toContainText("Roasting workshop");
});

test("申込の設定: an offer's dialog, 並び替え and この商品を削除", async ({ page }) => {
  await signIn(page);
  await openEditor(page, "/host/experiences/community-dinner");
  // The offers' English names and questions (the prices are the same on 日本語で書く).
  await page.getByRole("tab", { name: /^英語（公開）/ }).click();
  const offers = panel(page, "申込の設定");
  const rows = offers.getByRole("listitem");
  const dialog = page.getByRole("dialog", { name: "商品の編集" });
  const child = dialog.getByRole("spinbutton", { name: /^子どもの料金/ });

  await rows.first().getByRole("button").click();
  await expect(dialog.getByRole("textbox", { name: "商品名" })).toHaveValue("Dinner");
  await expect(dialog.getByRole("spinbutton", { name: /^大人の料金/ })).toHaveValue("30000");
  await expect(child).toHaveValue("12000");
  for (const day of ["火", "木", "土"]) await expect(dialog.getByRole("checkbox", { name: day, exact: true })).toBeChecked();
  for (const day of ["月", "水", "金", "日"]) await expect(dialog.getByRole("checkbox", { name: day, exact: true })).not.toBeChecked();
  const daysOff = dialog.getByRole("group", { name: "休みの日" }).getByRole("listitem");
  await expect(daysOff).toHaveText(["12月31日（木）", "2027年1月1日（金）"]);
  await expect(dialog.getByRole("textbox", { name: "申込時の質問 1" })).toHaveValue("Any dietary preferences we should know about?");

  // キャンセル leaves the offer as it was.
  await child.fill("10000");
  await dialog.getByRole("button", { name: "キャンセル" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(rows.first()).toContainText("子ども ¥12,000");
  await expect(saveButton(page)).toHaveCount(0);

  // 保存 in the dialog hands the offer back to the page; the page's 保存 keeps it.
  await rows.first().getByRole("button").click();
  await child.fill("10000");
  await dialog.getByRole("checkbox", { name: "金", exact: true }).check();
  await dialog.getByLabel("休みにする日").fill("2026-11-03");
  await dialog.getByRole("button", { name: "追加", exact: true }).click();
  await dialog.getByRole("button", { name: "12月31日（木）を外す" }).click();
  await expect(daysOff).toHaveText(["11月3日（火）", "2027年1月1日（金）"]);
  await dialog.getByRole("button", { name: "質問を足す" }).click();
  const question = dialog.getByRole("textbox", { name: "申込時の質問 2" });
  await expect(question).toBeFocused();
  await question.fill("Is anyone in your group vegetarian?");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(rows.first()).toContainText("子ども ¥10,000");
  await expect(saveButton(page)).toBeVisible();
  await rows.first().getByRole("button").click();
  await expect(dialog.getByRole("checkbox", { name: "金", exact: true })).toBeChecked();
  await expect(daysOff).toHaveText(["11月3日（火）", "2027年1月1日（金）"]);
  await expect(question).toHaveValue("Is anyone in your group vegetarian?");
  await dialog.getByRole("button", { name: "閉じる" }).click();
  await expect(dialog).toHaveCount(0);

  // 並び替え: tea time to the top.
  await offers.getByRole("button", { name: "並び替え" }).click();
  await expect(offers.getByRole("button", { name: "Dinnerを上へ" })).toBeDisabled();
  await offers.getByRole("button", { name: "tea timeを上へ" }).click();
  await offers.getByRole("button", { name: "完了" }).click();
  await expect(rows.nth(0)).toContainText("tea time");
  await expect(rows.nth(1)).toContainText("Dinner");

  // この商品を削除.
  await rows.first().getByRole("button").click();
  await dialog.getByRole("button", { name: "この商品を削除" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Dinner");
  await expect(offers.getByRole("button", { name: "並び替え" })).toHaveCount(0);
});

test("browser back keeps unsaved edits behind the leave dialog", async ({ page }) => {
  await signIn(page);
  await page.goto("/host/experiences");
  await page.getByRole("region", { name: "体験の一覧" }).getByRole("link").first().click();
  await page.waitForURL((url) => url.pathname === "/host/experiences/community-dinner");
  const highlight = panel(page, "見どころ").getByRole("textbox", { name: "見どころ 1" });
  await highlight.fill("Unsaved browser history edit.");
  await expect(saveButton(page)).toBeVisible();

  await page.goBack();
  const ask = page.getByRole("dialog", { name: "保存していない変更があります" });
  await expect(ask).toBeVisible();
  await expect(page).toHaveURL((url) => url.pathname === "/host/experiences/community-dinner");
  await expect(highlight).toHaveValue("Unsaved browser history edit.");
  await ask.getByRole("button", { name: "保存せずに移動" }).click();
  await page.waitForURL((url) => url.pathname === "/host/experiences");
  await expect(page.getByRole("heading", { level: 1, name: "体験" })).toBeVisible();
  await page.goBack();
  await page.waitForURL((url) => url.pathname === "/host/home");
});

test("browser forward keeps unsaved edits behind the leave dialog", async ({ page }) => {
  await signIn(page);
  await page.goto("/host/experiences");
  await page.getByRole("region", { name: "体験の一覧" }).getByRole("link").first().click();
  await page.waitForURL((url) => url.pathname === "/host/experiences/community-dinner");
  await page.getByRole("link", { name: "体験へ戻る" }).click();
  await page.waitForURL((url) => url.pathname === "/host/experiences");
  await page.goBack();
  await page.waitForURL((url) => url.pathname === "/host/experiences/community-dinner");

  const highlight = panel(page, "見どころ").getByRole("textbox", { name: "見どころ 1" });
  await highlight.fill("Unsaved browser history edit.");
  await expect(saveButton(page)).toBeVisible();
  await page.goForward();
  const ask = page.getByRole("dialog", { name: "保存していない変更があります" });
  await expect(ask).toBeVisible();
  await expect(page).toHaveURL((url) => url.pathname === "/host/experiences/community-dinner");
  await expect(highlight).toHaveValue("Unsaved browser history edit.");
  await ask.getByRole("button", { name: "保存せずに移動" }).click();
  await page.waitForURL((url) => url.pathname === "/host/experiences");
  await expect(page.getByRole("heading", { level: 1, name: "体験" })).toBeVisible();
  await page.goBack();
  await page.waitForURL((url) => url.pathname === "/host/experiences/community-dinner");
  await page.goBack();
  await page.waitForURL((url) => url.pathname === "/host/experiences");
  await page.goBack();
  await page.waitForURL((url) => url.pathname === "/host/home");
});

test("leaving with unsaved changes asks on the page: 編集を続ける stays, 保存せずに移動 goes", async ({ page }) => {
  // No browser dialog (confirm / alert / prompt) is ever opened for a link.
  const browserDialogs: string[] = [];
  page.on("dialog", (dialog) => {
    browserDialogs.push(dialog.type());
    void dialog.dismiss();
  });
  await signIn(page);
  await openEditor(page, "/host/experiences/community-dinner");
  const firstHighlight = panel(page, "見どころ").getByRole("textbox", { name: "見どころ 1" });
  await firstHighlight.fill("Cook five seasonal Japanese dishes with Kamakura locals.");
  const back = page.getByRole("link", { name: "体験へ戻る" });
  const ask = page.getByRole("dialog", { name: "保存していない変更があります" });

  await back.click();
  await expect(ask).toBeVisible();
  await expect(ask).toContainText("保存せずに移動すると、この画面での変更は失われます。");
  // 編集を続ける is the default: it has the focus.
  await expect(ask.getByRole("button", { name: "編集を続ける" })).toBeFocused();
  await ask.getByRole("button", { name: "編集を続ける" }).click();
  await expect(ask).toHaveCount(0);
  await expect(page).toHaveURL(/\/host\/experiences\/community-dinner$/);
  await expect(firstHighlight).toHaveValue("Cook five seasonal Japanese dishes with Kamakura locals.");
  await expect(saveButton(page)).toBeVisible();

  await back.click();
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: "保存せずに移動" }).click();
  await page.waitForURL(/\/host\/experiences$/);
  await expect(page.getByRole("heading", { level: 1, name: "体験" })).toBeVisible();
  expect(browserDialogs).toEqual([]);
});

test("a reload asks through the browser, and 保存せずに移動 to another page does not ask again", async ({ page }, testInfo) => {
  const browserDialogs: string[] = [];
  page.on("dialog", (dialog) => {
    browserDialogs.push(dialog.type());
    void dialog.accept();
  });
  await signIn(page);
  await openEditor(page, "/host/experiences/community-dinner");
  const lead = panel(page, "ひとこと紹介").getByRole("textbox");
  await lead.click();
  await lead.fill("A shorter introduction.");

  // A reload: the browser's own prompt (beforeunload), then the page as it was.
  await page.reload();
  expect(browserDialogs).toEqual(["beforeunload"]);
  await expect(lead).toHaveValue(/^地元の人のように/);

  // PC: the sidebar's 体験サイトを見る loads another page. After 保存せずに移動 the browser does not ask a second time.
  if (isDesktop(testInfo.project.name)) {
    await lead.click();
    await lead.fill("A shorter introduction.");
    await page.getByRole("banner").getByRole("link", { name: "体験サイトを見る" }).click();
    const ask = page.getByRole("dialog", { name: "保存していない変更があります" });
    await ask.getByRole("button", { name: "保存せずに移動" }).click();
    await page.waitForURL(/\/experiences$/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(browserDialogs).toEqual(["beforeunload"]);
  }
});

test("プレビュー leads to the live experience's public page", async ({ page }) => {
  await signIn(page);
  await openEditor(page, "/host/experiences/community-dinner");
  const href = await page.getByRole("link", { name: /^プレビュー/ }).getAttribute("href");
  expect(href).toBe("/experiences/kamakura-community-dinner");
  // The host server runs the pilot catalog (playwright.config.ts), as the mock preview does.
  await page.goto(href!);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Kamakura Community Dinner with Locals");
});

test("another provider's experience keeps ?providerId= on its links", async ({ page }) => {
  await signIn(page);
  await openEditor(page, "/host/experiences/calligraphy?providerId=sample-provider-studio");
  await expect(page.getByRole("textbox", { name: "題名" })).toHaveValue("鎌倉の書家と、自分の漢字を書く");
  await expect(page.getByRole("link", { name: "体験へ戻る" })).toHaveAttribute("href", "/host/experiences?providerId=sample-provider-studio");
  const host = panel(page, "迎える人");
  await expect(host).toContainText("サンプル工房");
  await expect(host.getByRole("link", { name: "紹介を編集" })).toHaveAttribute("href", "/host/settings?providerId=sample-provider-studio");
  // The sample kitchen's experiences are not this provider's.
  expect((await page.goto("/host/experiences/community-dinner?providerId=sample-provider-studio"))?.status()).toBe(404);
});

test("phones: the rail comes first, the title follows the header, and there are no bottom tabs", async ({ page }, testInfo) => {
  test.skip(isDesktop(testInfo.project.name), "phone layout");
  await signIn(page);
  await openEditor(page, "/host/experiences/community-dinner");
  await expect(menu(page)).toHaveCount(0);
  const header = page.locator("main header");
  await expect(header.getByRole("link", { name: "体験へ戻る" })).toHaveText("体験");
  await expect(header.getByRole("link", { name: /^プレビュー/ })).toBeVisible();

  const title = page.getByRole("textbox", { name: "題名" });
  const order = await Promise.all([title, panel(page, "掲載"), panel(page, "申込の設定"), panel(page, "ページ"), panel(page, "写真")].map(async (locator) => (await locator.boundingBox())!.y));
  expect(order).toEqual([...order].sort((a, b) => a - b));
  // The input is 16px or larger: iOS does not zoom in.
  expect(await title.evaluate((input) => parseFloat(getComputedStyle(input).fontSize))).toBeGreaterThanOrEqual(16);
  expect(await panel(page, "見どころ").getByRole("textbox").first().evaluate((input) => getComputedStyle(input).fontSize)).toBe("16px");

  // The header follows the title as it is typed.
  await title.fill("Community Dinner");
  await expect(header).toContainText("Community Dinner");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Community Dinner");
});

test("editor screens have no WCAG 2.2 AA violations", async ({ page }) => {
  await signIn(page);
  await openEditor(page, "/host/experiences/community-dinner");
  await audit(page, "live");
  await panel(page, "見どころ").getByRole("button", { name: "見どころに行を足す" }).click();
  await audit(page, "unsaved");
  await page.getByRole("link", { name: "体験へ戻る" }).click();
  const ask = page.getByRole("dialog", { name: "保存していない変更があります" });
  await expect(ask).toBeVisible();
  await audit(page, "leave dialog");
  await ask.getByRole("button", { name: "編集を続ける" }).click();
  await expect(ask).toHaveCount(0);
  await saveButton(page).click();
  await expect(page.getByRole("dialog", { name: "保存していない変更があります" })).toHaveCount(0);
  await expect(savedNotice(page)).toBeVisible();
  await audit(page, "saved");
  await panel(page, "申込の設定").getByRole("listitem").first().getByRole("button").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await audit(page, "offer dialog");

  await openEditor(page, "/host/experiences/coffee");
  await audit(page, "draft");
  await openEditor(page, "/host/experiences/kintsugi");
  await audit(page, "review");
});

test.describe("320px narrow phone", () => {
  test.use({ viewport: { width: 320, height: 640 } });
  test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== "host-mobile-360"));

  test("the editor fits, with its dialog open and while 保存 shows", async ({ page }) => {
    await signIn(page);
    for (const path of ["/host/experiences/community-dinner", "/host/experiences/coffee", "/host/experiences/kintsugi"]) {
      await openEditor(page, path);
      expect(await overflowX(page), path).toBeLessThanOrEqual(0);
    }
    await openEditor(page, "/host/experiences/community-dinner");
    await panel(page, "見どころ").getByRole("button", { name: "見どころに行を足す" }).click();
    const save = saveButton(page);
    await expect(save).toBeInViewport();
    expect((await save.boundingBox())!.width).toBe(288);
    expect(await overflowX(page), "unsaved").toBeLessThanOrEqual(0);

    await page.getByRole("link", { name: "体験へ戻る" }).click();
    const ask = page.getByRole("dialog", { name: "保存していない変更があります" });
    await expect(ask).toBeVisible();
    const askBox = (await ask.boundingBox())!;
    expect(askBox.x).toBeGreaterThanOrEqual(0);
    expect(askBox.x + askBox.width).toBeLessThanOrEqual(320);
    for (const name of ["保存せずに移動", "編集を続ける"]) await expect(ask.getByRole("button", { name }), name).toBeInViewport();
    await ask.getByRole("button", { name: "編集を続ける" }).click();
    await expect(ask).toHaveCount(0);

    await panel(page, "申込の設定").getByRole("listitem").first().getByRole("button").click();
    const dialog = page.getByRole("dialog", { name: "商品の編集" });
    await expect(dialog).toBeVisible();
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
    for (const name of ["キャンセル", "保存", "この商品を削除"]) {
      const button = dialog.getByRole("button", { name, exact: true });
      await button.scrollIntoViewIfNeeded();
      await expect(button, name).toBeInViewport();
    }
    expect(await overflowX(page), "dialog").toBeLessThanOrEqual(0);
  });
});
