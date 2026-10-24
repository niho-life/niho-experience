import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// 日本語で書いて英語の下書きを確かめる・参加の条件 (#110) on synthetic data. Runs against the second
// server (HOST_CONSOLE_ENABLED=true, mock mode; see playwright.config.ts). The sample kitchen's
// Community Dinner is written in Japanese with its English confirmed; the sample studio's
// calligraphy draft is written in Japanese with no English yet and no condition set. NIHO's English
// draft is the preview's synthetic one; nothing is saved or published.

const DINNER = "/host/experiences/community-dinner";
const CALLIGRAPHY = "/host/experiences/calligraphy?providerId=sample-provider-studio";
const NEW_DESCRIPTION = "季節の料理を、鎌倉に暮らす人たちといっしょに作って食べる夜です。";
const DRAFT_FAILED = "英語の下書きを作れませんでした。もう一度試すか、英語を直接書いてください";
const PREVIEW_ENGLISH = "[Preview] English draft from NIHO.";
const BEHIND = "公開中の英語は前に確定したままです";

const isDesktop = (projectName: string) => projectName === "host-desktop";
const panel = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const saveButton = (page: Page) => page.getByRole("button", { name: "保存", exact: true });
const savedNotice = (page: Page) => page.getByRole("status").filter({ hasText: "保存しました" });
const japaneseTab = (page: Page) => page.getByRole("tab", { name: "日本語で書く" });
const englishTab = (page: Page) => page.getByRole("tab", { name: /^英語（公開）/ });
const englishState = (page: Page) => panel(page, "英語の状態");
/** The header's title: the one in the language the page is written in (英語の題名 is the English one). */
const titleField = (page: Page) => page.getByRole("textbox", { name: "題名", exact: true });
const field = (page: Page, name: string) => panel(page, name).getByRole("textbox");
const overflowX = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function signIn(page: Page) {
  await page.goto("/host/auth/mock-login");
  await page.waitForURL(/\/host\/home(\?|$)/);
}

async function openEditor(page: Page, path: string) {
  await page.goto(path);
  await expect(titleField(page)).toBeVisible();
}

async function audit(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), label).toEqual([]);
}

/** The modal dialog sits inside the viewport, with its buttons reachable. */
async function fitsInViewport(page: Page, dialogName: string, buttons: string[]) {
  const dialog = page.getByRole("dialog", { name: dialogName });
  await expect(dialog).toBeVisible();
  const width = page.viewportSize()!.width;
  const box = (await dialog.boundingBox())!;
  expect(box.x, dialogName).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, dialogName).toBeLessThanOrEqual(width);
  for (const name of buttons) {
    const button = dialog.getByRole("button", { name, exact: true });
    await button.scrollIntoViewIfNeeded();
    await expect(button, `${dialogName}: ${name}`).toBeInViewport();
  }
  expect(await overflowX(page), dialogName).toBeLessThanOrEqual(0);
}

test("Community Dinner: Japanese changed → 古い with the field marked → 英語を作り直す (asks about corrected English) → 英語を確定 → 保存", async ({ page }) => {
  await signIn(page);
  await openEditor(page, DINNER);
  const listing = panel(page, "掲載");
  await expect(japaneseTab(page)).toHaveAttribute("aria-selected", "true");
  // Confirmed English: the tab says nothing more, and the public English is the page's.
  await expect(englishTab(page)).toHaveAccessibleName("英語（公開）");
  await expect(listing).not.toContainText(BEHIND);

  const description = field(page, "詳しい説明");
  await expect(description).toHaveValue(/^私たちのシェアリビングは/);
  await description.fill(NEW_DESCRIPTION);
  await expect(saveButton(page)).toBeVisible();
  await expect(listing).toContainText(BEHIND);
  await expect(englishTab(page)).toHaveAccessibleName(/^英語（公開）\s*古い$/);

  await englishTab(page).click();
  await expect(englishTab(page)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "editor-tab-en");
  const state = englishState(page);
  await expect(state).toContainText("古い");
  await expect(state).toContainText("日本語を変えました。英語を作り直すか、英語を直してから確定してください");
  // The field whose Japanese changed is marked; the others are not. Its English is still the confirmed one.
  await expect(panel(page, "詳しい説明")).toContainText("日本語を変えました");
  for (const name of ["英語の題名", "ひとこと紹介", "見どころ", "参加の条件", "当日の流れ", "申込の設定"]) await expect(panel(page, name), name).not.toContainText("日本語を変えました");
  await expect(description).toHaveValue(/^Our shared living room/);
  await expect(description).toHaveAttribute("lang", "en");
  await expect(field(page, "英語の題名")).toHaveValue("Kamakura Community Dinner with Locals");
  // The header keeps the Japanese title.
  await expect(titleField(page)).toHaveValue("鎌倉の地元の人と囲むコミュニティディナー");

  // The host corrects the English of ひとこと紹介: 英語を作り直す asks before it replaces it.
  const lead = field(page, "ひとこと紹介");
  await lead.fill("Spend an evening with Kamakura locals.");
  await state.getByRole("button", { name: "英語を作り直す" }).click();
  const ask = page.getByRole("dialog", { name: "直した英語を置き換えますか？" });
  await expect(ask).toContainText("直した英語 1 か所を作り直した英語で置き換えます。");
  await expect(ask.getByRole("button", { name: "やめる" })).toBeFocused();
  await ask.getByRole("button", { name: "やめる" }).click();
  await expect(ask).toHaveCount(0);
  await expect(lead).toHaveValue("Spend an evening with Kamakura locals.");
  await state.getByRole("button", { name: "英語を作り直す" }).click();
  await ask.getByRole("button", { name: "置き換えて作り直す" }).click();

  // 下書き: NIHO's English for the Japanese (the preview's sentence for the new description).
  await expect(state.getByText("下書き", { exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "英語の下書きを作りました" })).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "英語の状態" })).toBeFocused();
  await expect(description).toHaveValue(PREVIEW_ENGLISH);
  await expect(lead).toHaveValue(/^Spend an evening the way locals do/);
  await expect(page.getByText("日本語を変えました", { exact: true })).toHaveCount(0);
  await expect(englishTab(page)).toHaveAccessibleName(/^英語（公開）\s*下書き$/);
  await expect(listing).toContainText(BEHIND);

  // The English is corrected and confirmed: 確定済み, and the public line goes.
  await description.fill("An evening of seasonal food, cooked and eaten with people who live in Kamakura.");
  await state.getByRole("button", { name: "英語を確定" }).click();
  await expect(state.getByText("確定済み", { exact: true })).toBeVisible();
  await expect(state.getByRole("button")).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "英語を確定しました" })).toHaveCount(1);
  await expect(englishTab(page)).toHaveAccessibleName("英語（公開）");
  await expect(listing).not.toContainText(BEHIND);

  await saveButton(page).click();
  await expect(savedNotice(page)).toBeVisible();
  await expect(saveButton(page)).toHaveCount(0);
  // Both languages are kept as written.
  await expect(description).toHaveValue("An evening of seasonal food, cooked and eaten with people who live in Kamakura.");
  await japaneseTab(page).click();
  await expect(description).toHaveValue(NEW_DESCRIPTION);
});

test("the calligraphy draft: 英語の確定 is needed; the draft locks the English while it is made and keeps everything when it fails", async ({ page }) => {
  await signIn(page);
  await openEditor(page, CALLIGRAPHY);
  const needs = panel(page, "掲載").getByRole("list", { name: "掲載までに必要" }).getByRole("listitem");
  await expect(needs).toHaveText(["表紙写真", "料金", "英語の確定"]);
  await expect(englishTab(page)).toHaveAccessibleName(/^英語（公開）\s*未作成$/);

  await englishTab(page).click();
  const state = englishState(page);
  await expect(state).toContainText("未作成");
  await expect(state).toContainText("英語はまだありません");
  const lead = field(page, "ひとこと紹介");
  await expect(lead).toHaveValue("");

  // The server action's POST fails on its way: an alert, and nothing written is lost.
  const route = "**/host/experiences/calligraphy**";
  await page.route(route, (request) => (request.request().method() === "POST" ? request.abort("failed") : request.continue()));
  await state.getByRole("button", { name: "英語の下書きを作る" }).click();
  await expect(state.getByRole("alert")).toHaveText(DRAFT_FAILED);
  await expect(state).toContainText("未作成");
  await expect(titleField(page)).toHaveValue("鎌倉の書家と、自分の漢字を書く");
  await expect(field(page, "英語の題名")).toHaveValue("Write Your Own Kanji with a Kamakura Calligrapher");
  await expect(needs).toHaveText(["表紙写真", "料金", "英語の確定"]);
  await page.unroute(route);

  // Again, a little slowly: the English is locked meanwhile, the Japanese tab stays open to write.
  await page.route(route, async (request) => {
    if (request.request().method() === "POST") await new Promise((resolve) => setTimeout(resolve, 1200));
    await request.continue();
  });
  await state.getByRole("button", { name: "英語の下書きを作る" }).click();
  await expect(state.getByRole("button", { name: "英語の下書きを作っています…" })).toBeDisabled();
  await expect(lead).toBeDisabled();
  await japaneseTab(page).click();
  await expect(field(page, "ひとこと紹介")).toBeEnabled();
  await expect(field(page, "ひとこと紹介")).toHaveValue(/^墨をすり/);
  await englishTab(page).click();
  await expect(state.getByText("下書き", { exact: true })).toBeVisible();
  await page.unroute(route);
  await expect(state.getByRole("alert")).toHaveCount(0);
  await expect(lead).toBeEnabled();
  await expect(lead).toHaveValue(/^Grind your own ink/);
  await expect(panel(page, "見どころ").getByRole("textbox", { name: "見どころ 1" })).toHaveValue("Practice the eight basic strokes with a real brush.");

  await state.getByRole("button", { name: "英語を確定" }).click();
  await expect(state.getByText("確定済み", { exact: true })).toBeVisible();
  await expect(needs).toHaveText(["表紙写真", "料金"]);
  await expect(saveButton(page)).toBeVisible();
});

test("参加の条件: 未設定 rows, a dialog per kind, choices shared by both tabs, notes per language, and 保存", async ({ page }) => {
  await signIn(page);
  await openEditor(page, CALLIGRAPHY);
  const conditions = panel(page, "参加の条件");
  const rows = conditions.getByRole("listitem");
  await expect(rows).toHaveCount(6);
  await expect(rows).toHaveText([/^年齢未設定/, /^体の負担未設定/, /^ホストの言語未設定/, /^食べもの未設定/, /^段差・車いす未設定/, /^雨の日未設定/]);
  await expect(saveButton(page)).toHaveCount(0);

  // 年齢: the lowest age, children with an adult, and a note in Japanese.
  await conditions.getByRole("button", { name: /^年齢/ }).click();
  const age = page.getByRole("dialog", { name: "年齢" });
  await expect(age.getByRole("spinbutton", { name: "下限の年齢" })).toBeFocused();
  await age.getByRole("spinbutton", { name: "下限の年齢" }).fill("10");
  await age.getByRole("checkbox", { name: "子どもは大人と一緒に参加" }).check();
  await age.getByRole("textbox", { name: "補足（任意）" }).fill("10 歳未満のお子さまはご相談ください");
  await age.getByRole("button", { name: "保存", exact: true }).click();
  await expect(age).toHaveCount(0);
  await expect(rows.nth(0)).toContainText("10 歳以上 · 子どもは大人と一緒");
  await expect(rows.nth(0)).toContainText("10 歳未満のお子さまはご相談ください");
  await expect(saveButton(page)).toBeVisible();

  // 食べもの: what is served must be chosen before 保存.
  await conditions.getByRole("button", { name: /^食べもの/ }).click();
  const food = page.getByRole("dialog", { name: "食べもの" });
  await food.getByRole("checkbox", { name: "ベジタリアン" }).check();
  await food.getByRole("checkbox", { name: "アレルギーは相談" }).check();
  await food.getByRole("button", { name: "保存", exact: true }).click();
  await expect(food).toBeVisible();
  expect(await food.getByRole("radio", { name: "軽食" }).evaluate((input: HTMLInputElement) => input.validity.valueMissing)).toBe(true);
  await food.getByRole("radio", { name: "軽食" }).check();
  await food.getByRole("button", { name: "保存", exact: true }).click();
  await expect(food).toHaveCount(0);
  await expect(rows.nth(3)).toContainText("軽食あり · ベジタリアンに対応 · アレルギーは相談");

  // 雨の日.
  await conditions.getByRole("button", { name: /^雨の日/ }).click();
  const rain = page.getByRole("dialog", { name: "雨の日" });
  await rain.getByRole("radio", { name: "小雨なら開催" }).check();
  await rain.getByRole("button", { name: "保存", exact: true }).click();
  await expect(rows.nth(5)).toContainText("小雨なら開催");

  // 英語（公開）: the same choices; the note is the English one (none yet).
  await englishTab(page).click();
  await expect(rows.nth(0)).toContainText("10 歳以上 · 子どもは大人と一緒");
  await expect(rows.nth(0)).not.toContainText("10 歳未満");
  await conditions.getByRole("button", { name: /^年齢/ }).click();
  await expect(age.getByRole("spinbutton", { name: "下限の年齢" })).toHaveValue("10");
  await expect(age.getByRole("textbox", { name: "補足（任意）" })).toHaveAttribute("lang", "en");
  await age.getByRole("textbox", { name: "補足（任意）" }).fill("Under 10s, please ask first.");
  await age.getByRole("button", { name: "保存", exact: true }).click();
  await expect(rows.nth(0)).toContainText("Under 10s, please ask first.");

  // 未設定に戻す takes a kind away.
  await conditions.getByRole("button", { name: /^雨の日/ }).click();
  await rain.getByRole("button", { name: "未設定に戻す" }).click();
  await expect(rain).toHaveCount(0);
  await expect(rows.nth(5)).toHaveText(/^雨の日未設定/);

  await saveButton(page).click();
  await expect(savedNotice(page)).toBeVisible();
  await japaneseTab(page).click();
  await expect(rows.nth(0)).toContainText("10 歳未満のお子さまはご相談ください");
  await expect(rows.nth(3)).toContainText("軽食あり");
});

test("書く言語: English asks first and keeps the Japanese, which comes back with 日本語", async ({ page }) => {
  await signIn(page);
  await openEditor(page, DINNER);
  const settings = panel(page, "ページ");
  await settings.getByRole("radio", { name: "English" }).click();
  const ask = page.getByRole("dialog", { name: "英語で書く形に戻しますか？" });
  await expect(ask).toContainText("日本語の原稿は残りますが、英語を直接書く形に戻ります。");
  await expect(ask.getByRole("button", { name: "やめる" })).toBeFocused();
  await ask.getByRole("button", { name: "やめる" }).click();
  await expect(ask).toHaveCount(0);
  await expect(settings.getByRole("radio", { name: "日本語" })).toBeChecked();
  await expect(page.getByRole("tablist", { name: "原稿の言語" })).toBeVisible();

  await settings.getByRole("radio", { name: "English" }).click();
  await ask.getByRole("button", { name: "英語で書く" }).click();
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await expect(settings.getByRole("radio", { name: "English" })).toBeChecked();
  await expect(titleField(page)).toHaveValue("Kamakura Community Dinner with Locals");
  await expect(field(page, "詳しい説明")).toHaveValue(/^Our shared living room/);
  await expect(panel(page, "掲載")).not.toContainText(BEHIND);
  await expect(saveButton(page)).toBeVisible();

  await settings.getByRole("radio", { name: "日本語" }).check();
  await expect(japaneseTab(page)).toHaveAttribute("aria-selected", "true");
  await expect(field(page, "詳しい説明")).toHaveValue(/^私たちのシェアリビングは/);
  await englishTab(page).click();
  await expect(englishState(page).getByText("確定済み", { exact: true })).toBeVisible();
});

test("a page written in English, then in Japanese: the English is the confirmed one and the Japanese starts empty", async ({ page }) => {
  await signIn(page);
  await openEditor(page, "/host/experiences/kintsugi");
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await expect(panel(page, "参加の条件").getByRole("listitem")).toHaveCount(6);
  await panel(page, "ページ").getByRole("radio", { name: "日本語" }).check();
  await expect(japaneseTab(page)).toHaveAttribute("aria-selected", "true");
  const title = titleField(page);
  await expect(title).toHaveValue("");
  await expect(field(page, "詳しい説明")).toHaveValue("");
  // The heading keeps a name while the Japanese title is empty.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Mend a Broken Bowl with a Kamakura Restorer");
  await title.fill("鎌倉の修復師と、欠けた器を直す");
  await englishTab(page).click();
  await expect(englishState(page)).toContainText("古い");
  await expect(panel(page, "英語の題名")).toContainText("日本語を変えました");
  await expect(field(page, "英語の題名")).toHaveValue("Mend a Broken Bowl with a Kamakura Restorer");
  await expect(panel(page, "詳しい説明")).not.toContainText("日本語を変えました");
});

test("the tabs, the English and the conditions fit: no sideways scroll on phones, two columns on PC", async ({ page }, testInfo) => {
  await signIn(page);
  await openEditor(page, DINNER);
  const tabs = page.getByRole("tablist", { name: "原稿の言語" });
  expect(await overflowX(page), "日本語で書く").toBeLessThanOrEqual(0);
  await field(page, "詳しい説明").fill(NEW_DESCRIPTION);
  await englishTab(page).click();
  expect(await overflowX(page), "英語（公開）").toBeLessThanOrEqual(0);

  const tabsBox = (await tabs.boundingBox())!;
  const stateBox = (await englishState(page).boundingBox())!;
  const rail = (await panel(page, "掲載").boundingBox())!;
  const text = (await panel(page, "英語の題名").boundingBox())!;
  expect(tabsBox.y + tabsBox.height).toBeLessThanOrEqual(stateBox.y);
  if (isDesktop(testInfo.project.name)) {
    // The tabs and the English's state over both columns; the 320px rail on the right.
    expect(rail.width).toBe(320);
    expect(rail.x).toBeGreaterThan(text.x + text.width);
    expect(rail.y).toBeCloseTo(text.y, 0);
    expect(stateBox.width).toBeGreaterThan(rail.width + text.width);
  } else {
    expect(stateBox.y + stateBox.height).toBeLessThanOrEqual(rail.y);
    expect(rail.y + rail.height).toBeLessThan(text.y);
  }

  await panel(page, "参加の条件").getByRole("button", { name: /^食べもの/ }).click();
  await fitsInViewport(page, "食べもの", ["キャンセル", "保存", "未設定に戻す"]);
});

test("#110 screens have no WCAG 2.2 AA violations", async ({ page }) => {
  await signIn(page);
  await openEditor(page, DINNER);
  await audit(page, "日本語で書く");
  // Saved first: the stale English stays stale, and no 保存 band covers the page while it is checked.
  await field(page, "詳しい説明").fill(NEW_DESCRIPTION);
  await englishTab(page).click();
  await field(page, "ひとこと紹介").fill("Spend an evening with Kamakura locals.");
  await saveButton(page).click();
  await expect(savedNotice(page)).toBeVisible();
  await expect(englishState(page)).toContainText("古い");
  await audit(page, "英語（公開）: stale");
  await englishState(page).getByRole("button", { name: "英語を作り直す" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await audit(page, "replace dialog");
  await page.getByRole("dialog").getByRole("button", { name: "やめる" }).click();
  await panel(page, "参加の条件").getByRole("button", { name: /^体の負担/ }).click();
  await expect(page.getByRole("dialog", { name: "体の負担" })).toBeVisible();
  await audit(page, "condition dialog");
  await page.getByRole("dialog").getByRole("button", { name: "キャンセル" }).click();
  await panel(page, "ページ").getByRole("radio", { name: "English" }).click();
  await expect(page.getByRole("dialog", { name: "英語で書く形に戻しますか？" })).toBeVisible();
  await audit(page, "language dialog");
  await page.getByRole("dialog").getByRole("button", { name: "やめる" }).click();

  await openEditor(page, CALLIGRAPHY);
  await englishTab(page).click();
  await audit(page, "英語（公開）: none");
});

test.describe("320px narrow phone", () => {
  test.use({ viewport: { width: 320, height: 640 } });
  test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== "host-mobile-360"));

  test("the tabs, the English's state and a condition's dialog fit", async ({ page }) => {
    await signIn(page);
    await openEditor(page, CALLIGRAPHY);
    expect(await overflowX(page), "日本語で書く").toBeLessThanOrEqual(0);
    await englishTab(page).click();
    expect(await overflowX(page), "英語（公開）: none").toBeLessThanOrEqual(0);
    for (const name of ["日本語で書く", "英語（公開）"]) await expect(page.getByRole("tab", { name: new RegExp(`^${name}`) }), name).toBeInViewport();
    await expect(englishState(page).getByRole("button", { name: "英語の下書きを作る" })).toBeInViewport();
    await englishState(page).getByRole("button", { name: "英語の下書きを作る" }).click();
    await expect(englishState(page).getByText("下書き", { exact: true })).toBeVisible();
    expect(await overflowX(page), "英語（公開）: draft").toBeLessThanOrEqual(0);

    await panel(page, "参加の条件").getByRole("button", { name: /^段差・車いす/ }).click();
    await fitsInViewport(page, "段差・車いす", ["キャンセル", "保存"]);
    await page.getByRole("dialog").getByRole("radio", { name: "一部段差あり（相談）" }).check();
    await page.getByRole("dialog").getByRole("button", { name: "保存", exact: true }).click();
    await panel(page, "参加の条件").getByRole("button", { name: /^ホストの言語/ }).click();
    await fitsInViewport(page, "ホストの言語", ["キャンセル", "保存"]);
  });
});
