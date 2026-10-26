import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

// ホーム's 次にすること and メッセージ (#106) on synthetic data. Runs against the second server
// (HOST_CONSOLE_ENABLED=true, mock mode; see playwright.config.ts). 英語にする asks the server
// action for the preview's English; 承認 and 送る change this screen only, and nothing is sent.

const EMMA_JA = "ご質問ありがとうございます。お子さまも大歓迎です。子ども料金（¥12,000）があり、苦手な食材を前日までに教えていただければ、別の料理をご用意します。";
const EMMA_EN = "Thank you for asking! Children are very welcome. There is a child price (¥12,000), and if you tell us by the day before what she doesn't eat, we will make something else for her.";
const PREVIEW_EN = "[Preview] NIHO's English draft of your message appears here.";
const STALE = "日本語を変えました。英語を作り直してください";
const DRAFT_FAILED = "英語にできませんでした。作り直すか、英語を直接書いてください";

const isDesktop = (projectName: string) => projectName === "host-desktop";
const menu = (page: Page) => page.getByRole("navigation", { name: "ホストのメニュー" });
const todos = (page: Page) => page.getByRole("region", { name: "次にすること" }).getByRole("listitem");
const list = (page: Page) => page.getByRole("region", { name: "メッセージの一覧" });
const row = (page: Page, guest: string) => list(page).getByRole("link", { name: new RegExp(`^${guest}`) });
const thread = (page: Page, heading: string) => page.getByRole("region", { name: heading, exact: true });
const messages = (view: Locator) => view.getByRole("list", { name: "やりとり" }).getByRole("listitem");
const overflowX = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function signIn(page: Page, query = "") {
  await page.goto(`/host/auth/mock-login${query}`);
  await page.waitForURL(/\/host\/home(\?|$)/);
}

async function audit(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), label).toEqual([]);
}

/** What leaves the browser besides page loads (the server actions are POSTs). */
function recordSent(page: Page): string[] {
  const sent: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") sent.push(`${request.method()} ${request.url()} ${request.postData() ?? ""}`);
  });
  return sent;
}

test("ホーム lists each request with the time left, then the threads waiting longest; 承認 asks first and takes the row away", async ({ page }) => {
  await signIn(page);
  const rows = todos(page);
  await expect(rows).toHaveCount(10);
  for (const text of ["承認待ち", "あと 6 時間", "Lucas & Mia Chen さん · 10/22（木）18:00 · Kamakura Community Dinner with Locals · 2名 · ¥60,000", "期限を過ぎると自動でお断りになります"]) await expect(rows.nth(0)).toContainText(text);
  for (const text of ["あと 44 時間", "Ana Souza さん · 10/29（木）18:00 · Kamakura Community Dinner with Locals · 3名 · ¥72,000"]) await expect(rows.nth(1)).toContainText(text);
  // The threads, the longest wait first: an untranslated question reads in the original.
  for (const text of ["返信待ち", "予約前の質問", "「안녕하세요.", "Jiwoo Han さん · 6 時間前 · 翻訳できませんでした"]) await expect(rows.nth(2)).toContainText(text);
  for (const text of ["予約者からの連絡", "「ありがとうございます！ 電車は 17:40 ごろに着きます。", "Sofia Rossi さん · 4 時間前 · 英語から翻訳"]) await expect(rows.nth(3)).toContainText(text);
  for (const text of ["予約前の質問", "「こんにちは！ 9 歳の娘と一緒にディナーに参加できますか？", "Emma Wilson さん · 2 時間前 · 英語から翻訳"]) await expect(rows.nth(4)).toContainText(text);
  await expect(rows.nth(0).getByRole("link", { name: "詳しく見る" })).toHaveAttribute("href", "/host/bookings?booking=bk-2041");
  await expect(rows.nth(4).getByRole("link", { name: "返信する" })).toHaveAttribute("href", "/host/messages?thread=th-3012");

  const sent = recordSent(page);
  const ask = page.getByRole("dialog", { name: "申込を承認しますか？" });
  const approve = rows.nth(0).getByRole("button", { name: "承認する" });
  await approve.click();
  for (const text of ["Lucas & Mia Chen", "10月22日（木）18:00–20:00 · Dinner", "¥60,000"]) await expect(ask).toContainText(text);
  await expect(ask.getByRole("button", { name: "やめる" })).toBeFocused();
  await ask.getByRole("button", { name: "やめる" }).click();
  await expect(ask).toHaveCount(0);
  await expect(rows).toHaveCount(10);

  await approve.click();
  await ask.getByRole("button", { name: "決済して承認" }).click();
  await expect(ask).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Lucas & Mia Chen さんの申込を承認しました" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "次にすること" })).toBeFocused();
  await expect(rows).toHaveCount(9);
  await expect(rows.filter({ hasText: "Lucas & Mia Chen" })).toHaveCount(0);
  await expect(rows.nth(0)).toContainText("Ana Souza さん");
  expect(sent).toEqual([]);
});

test("返信する opens the thread; the English is made, checked and only then sent", async ({ page }, testInfo) => {
  await signIn(page);
  await todos(page).filter({ hasText: "Emma Wilson さん" }).getByRole("link", { name: "返信する" }).click();
  await expect(page).toHaveURL(/\/host\/messages\?thread=th-3012$/);
  const emma = thread(page, "Emma Wilson さんの質問");
  await expect(emma).toBeVisible();
  if (isDesktop(testInfo.project.name)) {
    // The list on the left and the thread on the right; the menu keeps ホーム.
    const listBox = (await list(page).boundingBox())!;
    const threadBox = (await emma.boundingBox())!;
    expect(threadBox.x).toBeGreaterThan(listBox.x + listBox.width);
    await expect(row(page, "Emma Wilson")).toHaveAttribute("aria-current", "true");
    await expect(menu(page).getByRole("link", { name: "ホーム" })).toHaveAttribute("aria-current", "page");
  } else {
    // "‹ メッセージ" instead of the brand header, and no bottom tabs.
    await expect(list(page)).toBeHidden();
    await expect(menu(page)).toHaveCount(0);
    await expect(page.getByRole("banner")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "メッセージへ戻る" })).toHaveText("メッセージ");
  }
  for (const text of ["Kamakura Community Dinner with Locals", "予約前 · 子ども"]) await expect(emma).toContainText(text);
  await expect(emma.getByRole("link", { name: "予約を見る" })).toHaveCount(0);

  // The guest's words in Japanese, with the original under it.
  const question = messages(emma);
  await expect(question).toHaveCount(1);
  await expect(question.first()).toContainText("こんにちは！ 9 歳の娘と一緒にディナーに参加できますか？");
  await expect(question.first().locator('[lang="en"]')).toHaveText(/Hi! Can I bring my 9-year-old daughter to the dinner\?/);
  for (const text of ["英語から翻訳", "10/21 13:24"]) await expect(question.first()).toContainText(text);

  const japanese = emma.getByRole("textbox", { name: "日本語で書く" });
  const send = emma.getByRole("button", { name: "この英語で送る" });
  await expect(emma).toContainText("Emma Wilson さんにはメールで届きます");
  await expect(emma.getByRole("button", { name: "英語にする" })).toBeDisabled();
  await expect(send).toBeDisabled();
  await japanese.fill(EMMA_JA);
  await emma.getByRole("button", { name: "英語にする" }).click();
  await expect(emma).toContainText("Emma Wilson さんに届く英語");
  await expect(emma.getByText(EMMA_EN)).toBeVisible();
  await expect(send).toBeEnabled();

  // Changing the Japanese stops the English made from the old one.
  await japanese.fill(`${EMMA_JA}当日お会いできるのを楽しみにしています。`);
  await expect(emma.getByRole("status").filter({ hasText: STALE })).toBeVisible();
  await expect(send).toBeDisabled();
  await emma.getByRole("button", { name: "英語を作り直す" }).click();
  await expect(emma.getByText(PREVIEW_EN)).toBeVisible();
  await expect(emma.getByText(STALE)).toHaveCount(0);
  await expect(send).toBeEnabled();

  // 英語を直す makes the English the host's own: changing the Japanese then does not stop it.
  await emma.getByRole("button", { name: "英語を直す" }).click();
  const english = emma.getByRole("textbox", { name: "Emma Wilson さんに届く英語" });
  await expect(english).toBeFocused();
  await expect(english).toHaveValue(PREVIEW_EN);
  await english.fill(`${EMMA_EN} We look forward to meeting you both.`);
  await japanese.fill(`${EMMA_JA}お二人にお会いできるのを楽しみにしています。`);
  await expect(emma.getByText(STALE)).toHaveCount(0);
  await expect(send).toBeEnabled();

  const sent = recordSent(page);
  await send.click();
  await expect(emma.getByRole("status").filter({ hasText: "送りました" })).toBeVisible();
  await expect(japanese).toHaveValue("");
  await expect(japanese).toBeFocused();
  await expect(english).toHaveCount(0);
  await expect(send).toBeDisabled();
  await expect(question).toHaveCount(2);
  const reply = question.last();
  await expect(reply).toContainText("お二人にお会いできるのを楽しみにしています。");
  await expect(reply).toContainText("送信済み");
  await expect(reply.getByText(/We look forward to meeting you both\./)).toBeHidden();
  await reply.getByText("送った英語").click();
  await expect(reply.getByText(/We look forward to meeting you both\./)).toBeVisible();
  // The preview keeps the reply on this screen: nothing was sent.
  expect(sent).toEqual([]);

  // The thread no longer waits.
  if (!isDesktop(testInfo.project.name)) {
    await page.getByRole("link", { name: "メッセージへ戻る" }).click();
    await expect(page).toHaveURL(/\/host\/messages$/);
    await expect(row(page, "Emma Wilson")).toBeFocused();
  }
  await expect(row(page, "Emma Wilson")).not.toContainText("返信待ち");
  await expect(row(page, "Emma Wilson")).toContainText("お二人にお会いできるのを楽しみにしています。");
  await expect(row(page, "Jiwoo Han")).toContainText("返信待ち");
});

test("an email answer and an untranslated question read as they are, and 予約 opens the same thread", async ({ page }) => {
  await signIn(page);
  await page.goto("/host/bookings?booking=bk-2031");
  await page.getByRole("region", { name: "Sofia Rossi", exact: true }).getByRole("link", { name: "やりとりを開く" }).click();
  await expect(page).toHaveURL(/\/host\/messages\?thread=th-3004$/);
  const sofia = thread(page, "Sofia Rossi さんとの連絡");
  for (const text of ["Kamakura Community Dinner with Locals", "10/27（火）18:00 · 3名"]) await expect(sofia).toContainText(text);
  await expect(sofia.getByRole("link", { name: "予約を見る" })).toHaveAttribute("href", "/host/bookings?booking=bk-2031");
  const items = messages(sofia);
  await expect(items).toHaveCount(2);
  // The host's note before the dinner (moved from the booking), and Sofia's answer by email.
  for (const text of ["ご予約ありがとうございます！", "送信済み", "10/16 09:20"]) await expect(items.nth(0)).toContainText(text);
  for (const text of ["スーツケースを置いておける場所はありますか？", "Is there somewhere we can leave our suitcases", "英語から翻訳", "メールで返信", "10/21 11:05"]) await expect(items.nth(1)).toContainText(text);
  await expect(page.locator("main")).not.toContainText("@");

  await page.goto("/host/messages?thread=th-3010");
  const jiwoo = thread(page, "Jiwoo Han さんの質問");
  const question = messages(jiwoo).first();
  await expect(question.locator('[lang="ko"]')).toHaveText("안녕하세요. 휠체어로도 참가할 수 있을까요? 엘리베이터가 있는지 궁금합니다.");
  await expect(question).toContainText("翻訳できませんでした");
  await expect(jiwoo).toContainText("予約前");
  // It can still be answered.
  await jiwoo.getByRole("textbox", { name: "日本語で書く" }).fill("お問い合わせありがとうございます。会場は 2 階で、エレベーターがありません。ご不便をおかけして申し訳ありません。");
  await jiwoo.getByRole("button", { name: "英語にする" }).click();
  await expect(jiwoo.getByText("The kitchen is on the second floor and there is no elevator.", { exact: false })).toBeVisible();
  await expect(jiwoo.getByRole("button", { name: "この英語で送る" })).toBeEnabled();
});

test("英語にする keeps the Japanese when it fails, and the English can be written directly", async ({ page }) => {
  await signIn(page);
  await page.goto("/host/messages?thread=th-3012");
  const emma = thread(page, "Emma Wilson さんの質問");
  const japanese = emma.getByRole("textbox", { name: "日本語で書く" });
  await japanese.fill(EMMA_JA);
  // The server action's POST fails on its way.
  await page.route("**/host/messages**", (route) => (route.request().method() === "POST" ? route.abort("failed") : route.continue()));
  await emma.getByRole("button", { name: "英語にする" }).click();
  await expect(emma.getByRole("alert")).toHaveText(DRAFT_FAILED);
  await expect(japanese).toHaveValue(EMMA_JA);
  await expect(emma.getByRole("button", { name: "英語にする" })).toBeEnabled();
  await expect(emma.getByRole("button", { name: "この英語で送る" })).toBeDisabled();
  await page.unroute("**/host/messages**");

  await emma.getByRole("button", { name: "英語を直接書く" }).click();
  const english = emma.getByRole("textbox", { name: "Emma Wilson さんに届く英語" });
  await expect(english).toBeFocused();
  await english.fill(EMMA_EN);
  await expect(emma.getByRole("button", { name: "この英語で送る" })).toBeEnabled();
  // Trying again works and replaces the English with NIHO's.
  await emma.getByRole("button", { name: "英語を作り直す" }).click();
  await expect(emma.getByRole("alert")).toHaveCount(0);
  await expect(emma.getByText(EMMA_EN, { exact: true })).toBeVisible();
  await expect(english).toHaveCount(0);
});

test("メッセージを送る starts a booking's thread; threads that are not the provider's do not open", async ({ page }) => {
  await signIn(page);
  await page.goto("/host/bookings?booking=bk-2035");
  await page.getByRole("region", { name: "Noah Williams", exact: true }).getByRole("link", { name: "メッセージを送る" }).click();
  await expect(page).toHaveURL(/\/host\/messages\?booking=bk-2035$/);
  const noah = thread(page, "Noah Williams さんとの連絡");
  await expect(noah).toContainText("10/24（土）18:00 · 1名");
  await expect(noah.getByRole("list", { name: "やりとり" })).toHaveCount(0);
  await noah.getByRole("button", { name: "英語を直接書く" }).click();
  await noah.getByRole("textbox", { name: "Noah Williams さんに届く英語" }).fill("See you on Saturday at 18:00!");
  await noah.getByRole("button", { name: "この英語で送る" }).click();
  await expect(noah.getByRole("status").filter({ hasText: "送りました" })).toBeVisible();
  await expect(messages(noah)).toHaveCount(1);
  await expect(messages(noah).first().locator('[lang="en"]')).toHaveText("See you on Saturday at 18:00!");
  await expect(page).toHaveURL(/\?booking=bk-2035$/);

  // A request that ended has nothing to start; another provider's thread is not this one's.
  expect((await page.goto("/host/messages?booking=bk-2026"))?.status()).toBe(404);
  expect((await page.goto("/host/messages?thread=no-such-thread"))?.status()).toBe(404);
  expect((await page.goto("/host/messages?providerId=sample-provider-studio&thread=th-3012"))?.status()).toBe(404);
});

test("メッセージ lists the waiting threads first; it is a screen under ホーム, and a provider without messages says so", async ({ page }, testInfo) => {
  await signIn(page, "?providerId=sample-provider-kitchen");
  await page.getByRole("region", { name: "次にすること" }).getByRole("link", { name: "メッセージを見る" }).click();
  await expect(page).toHaveURL(/\/host\/messages\?providerId=sample-provider-kitchen$/);
  await expect(page.getByRole("heading", { level: 1, name: "メッセージ" })).toBeVisible();
  const rows = list(page).getByRole("link");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText("Jiwoo Han");
  await expect(rows.nth(1)).toContainText("Sofia Rossi");
  await expect(rows.nth(2)).toContainText("Emma Wilson");
  await expect(rows.nth(3)).toContainText("Daniel Fischer");
  for (const index of [0, 1, 2]) await expect(rows.nth(index)).toContainText("返信待ち");
  await expect(rows.nth(3)).not.toContainText("返信待ち");
  for (const text of ["10/27（火）予約 · Kamakura Community Dinner with Locals", "11:05"]) await expect(rows.nth(1)).toContainText(text);
  for (const text of ["予約前 · Kamakura Community Dinner with Locals", "10/20", "はい、ご用意できます。"]) await expect(rows.nth(3)).toContainText(text);
  await expect(rows.nth(2)).toHaveAttribute("href", "/host/messages?providerId=sample-provider-kitchen&thread=th-3012");

  if (isDesktop(testInfo.project.name)) {
    // The longest wait shows beside the list until another is chosen.
    await expect(thread(page, "Jiwoo Han さんの質問")).toBeVisible();
    await expect(menu(page).getByRole("link", { name: "ホーム" })).toHaveAttribute("aria-current", "page");
  } else {
    // A screen under ホーム: "‹ ホーム", no bottom tabs, and the thread opens as its own screen.
    await expect(thread(page, "Jiwoo Han さんの質問")).toBeHidden();
    await expect(menu(page)).toHaveCount(0);
    const back = page.getByRole("link", { name: "ホームへ戻る" });
    await expect(back).toHaveAttribute("href", "/host/home?providerId=sample-provider-kitchen");
    await rows.nth(3).click();
    await expect(page).toHaveURL(/\?providerId=sample-provider-kitchen&thread=th-3007$/);
    await expect(thread(page, "Daniel Fischer さんの質問").getByRole("heading", { level: 2 })).toBeFocused();
    await page.goBack();
    await expect(list(page)).toBeVisible();
    await back.click();
    await page.waitForURL(/\/host\/home\?providerId=sample-provider-kitchen$/);
    await expect(menu(page)).toHaveCount(1);
  }

  expect((await page.goto("/host/messages?providerId=sample-provider-studio"))?.status()).toBe(404);
  await page.goto("/host/home?providerId=sample-provider-studio");
  await expect(todos(page).filter({ hasText: "返信待ち" })).toHaveCount(0);
});

test("ホーム and メッセージ have no WCAG 2.2 AA violations", async ({ page }) => {
  await signIn(page);
  await todos(page).first().getByRole("button", { name: "承認する" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await audit(page, "home: approve dialog");
  await page.getByRole("dialog").getByRole("button", { name: "決済して承認" }).click();
  await expect(page.getByRole("status").filter({ hasText: "申込を承認しました" })).toBeVisible();
  await audit(page, "home: approved");

  for (const path of ["/host/messages", "/host/messages?thread=th-3004", "/host/messages?thread=th-3010", "/host/messages?booking=bk-2035"]) {
    await page.goto(path);
    await expect(page.locator("main").getByRole("heading").first()).toBeVisible();
    await audit(page, path);
  }
  await page.goto("/host/messages?thread=th-3004");
  const sofia = thread(page, "Sofia Rossi さんとの連絡");
  await sofia.getByText("送った英語").click();
  const japanese = sofia.getByRole("textbox", { name: "日本語で書く" });
  await japanese.fill("はい、入口の横にスーツケースを置ける場所があります。17:40 ごろでしたら、そのままお越しください。");
  await sofia.getByRole("button", { name: "英語にする" }).click();
  await expect(sofia.getByText("Yes, there is room for suitcases", { exact: false })).toBeVisible();
  await audit(page, "thread: English made");
  await japanese.fill("はい。");
  await expect(sofia.getByText(STALE)).toBeVisible();
  await audit(page, "thread: English stale");
  await sofia.getByRole("button", { name: "英語を直す" }).click();
  await audit(page, "thread: English corrected");
  await page.route("**/host/messages**", (route) => (route.request().method() === "POST" ? route.abort("failed") : route.continue()));
  await sofia.getByRole("button", { name: "英語を作り直す" }).click();
  await expect(sofia.getByRole("alert")).toBeVisible();
  await audit(page, "thread: draft failed");
});

test.describe("320px narrow phone", () => {
  test.use({ viewport: { width: 320, height: 640 } });
  test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== "host-mobile-360"));

  test("ホーム, the list, a thread and its reply fit", async ({ page }) => {
    const inside = async (locator: Locator, label: string) => {
      await locator.scrollIntoViewIfNeeded();
      await expect(locator, label).toBeInViewport();
      const box = await locator.boundingBox();
      expect(box && box.x >= 0 && box.x + box.width <= 320, label).toBe(true);
    };
    await signIn(page);
    for (const path of ["/host/home", "/host/messages", "/host/messages?thread=th-3012", "/host/messages?thread=th-3004", "/host/messages?thread=th-3010", "/host/messages?booking=bk-2035"]) {
      await page.goto(path);
      await expect(page.locator("main").getByRole("heading").first()).toBeVisible();
      expect(await overflowX(page), path).toBeLessThanOrEqual(0);
    }
    await page.goto("/host/home");
    const lucas = todos(page).first();
    await inside(lucas.getByRole("button", { name: "承認する" }), "home: 承認する");
    await inside(lucas.getByRole("link", { name: "詳しく見る" }), "home: 詳しく見る");
    await inside(page.getByRole("link", { name: "メッセージを見る" }), "home: メッセージを見る");

    await page.goto("/host/messages?thread=th-3004");
    const sofia = thread(page, "Sofia Rossi さんとの連絡");
    // The reply stays at the bottom of the screen.
    await expect(sofia.getByRole("button", { name: "この英語で送る" })).toBeInViewport();
    await inside(page.getByRole("link", { name: "メッセージへ戻る" }), "‹ メッセージ");
    await inside(sofia.getByRole("link", { name: "予約を見る" }), "予約を見る");
    await sofia.getByRole("textbox", { name: "日本語で書く" }).fill("はい、入口の横にスーツケースを置ける場所があります。17:40 ごろでしたら、そのままお越しください。");
    await sofia.getByRole("button", { name: "英語にする" }).click();
    await expect(sofia.getByText("Yes, there is room for suitcases", { exact: false })).toBeVisible();
    for (const name of ["英語を作り直す", "英語を直す", "この英語で送る"]) await inside(sofia.getByRole("button", { name }), name);
    expect(await overflowX(page), "English made").toBeLessThanOrEqual(0);
  });
});
