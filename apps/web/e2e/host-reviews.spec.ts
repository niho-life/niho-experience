import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

// レビュー (#108) on synthetic data: ホーム's rows, the reviews screen and 体験's averages. Runs against
// the second server (HOST_CONSOLE_ENABLED=true, mock mode; see playwright.config.ts). 英語にする asks
// the server action for the preview's English; 返信を公開する and 報告 change this screen only, and
// nothing is sent.

const OLIVER_JA = "ディナーに来てくださってありがとうございました！ なすの味噌田楽をご家庭でも作ってくださって、とてもうれしいです。また鎌倉でお会いしましょう。";
const OLIVER_EN = "Thank you for coming to dinner! We are so happy you are making the miso aubergine at home. See you again in Kamakura.";
const PREVIEW_EN = "[Preview] NIHO's English draft of your message appears here.";
const STALE = "日本語を変えました。英語を作り直してください";
const DRAFT_FAILED = "英語にできませんでした。作り直すか、英語を直接書いてください";
const WAITING = "NIHO が確認中です。公開されたら返信できます";

const isDesktop = (projectName: string) => projectName === "host-desktop";
const menu = (page: Page) => page.getByRole("navigation", { name: "ホストのメニュー" });
const todos = (page: Page) => page.getByRole("region", { name: "次にすること" }).getByRole("listitem");
const list = (page: Page) => page.getByRole("region", { name: "レビューの一覧" });
/** One review of the list, by its heading ("Oliver さん · イギリス"); its good points are list items too, without a heading. */
const reviewItem = (page: Page, name: string) => list(page).getByRole("listitem").filter({ has: page.getByRole("heading", { level: 2, name, exact: true }) });
const reviewHeadings = (page: Page) => list(page).getByRole("heading", { level: 2 });
const replyForm = (item: Locator, name: string) => item.getByRole("form", { name: `${name} さんへの返信` });
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

test("ホーム's 読んで返信する opens the review; the reply's English is made, checked and only then published, and can be corrected", async ({ page }) => {
  await signIn(page);
  // After the threads: the published reviews without a reply, then the one NIHO is checking.
  const oliverRow = todos(page).filter({ hasText: "Oliver さん" });
  for (const text of ["未返信", "レビュー", "「ここに暮らす人たちと 6 品を作り、終電の時間まで話し込みまし…」", "Oliver さん · イギリス · Kamakura Community Dinner with Locals"]) await expect(oliverRow).toContainText(text);
  await expect(oliverRow.getByRole("img", { name: "5 点", exact: true })).toBeVisible();
  await expect(todos(page).nth(5)).toContainText("Oliver さん");
  await expect(todos(page).nth(6)).toContainText("Ella さん · オーストラリア");
  const yukiRow = todos(page).nth(7);
  for (const text of ["公開前", "由紀 さん · 日本"]) await expect(yukiRow).toContainText(text);
  await expect(yukiRow.getByRole("link", { name: "読む" })).toHaveAttribute("href", "/host/reviews#review-rv-5013");
  const open = oliverRow.getByRole("link", { name: "読んで返信する" });
  await expect(open).toHaveAttribute("href", "/host/reviews#review-rv-5020");

  await open.click();
  await expect(page).toHaveURL(/\/host\/reviews#review-rv-5020$/);
  const oliver = reviewItem(page, "Oliver さん · イギリス");
  const name = oliver.getByRole("heading", { level: 2 });
  await expect(name).toBeFocused();
  await expect(name).toBeInViewport();
  for (const text of ["10/17（土）Kamakura Community Dinner with Locals", "英語から翻訳"]) await expect(oliver).toContainText(text);
  await expect(oliver.getByRole("img", { name: "5 点中 5 点", exact: true })).toBeVisible();
  await expect(oliver.getByRole("list", { name: "よかった点" }).getByRole("listitem")).toHaveText(["初めてでも安心", "すてきなホスト", "値段に見合う"]);
  // The translation is the body, the guest's own words under it; the note for the host only, the same way.
  await expect(oliver.getByText("なすの味噌田楽は、日本で食べたなかでいちばんでした。", { exact: false })).toBeVisible();
  await expect(oliver.locator('p[lang="en"]', { hasText: "The miso-glazed aubergine was the best thing we ate in Japan." })).toBeVisible();
  await expect(oliver.getByRole("heading", { level: 3, name: "あなただけへのメモ" })).toBeVisible();
  await expect(oliver.getByText("レシピのカードをありがとうございました！", { exact: false })).toBeVisible();
  await expect(oliver.locator('p[lang="en"]', { hasText: "Thank you for the recipe card!" })).toBeVisible();
  await expect(oliver).not.toContainText("あなたの返信");

  await oliver.getByRole("button", { name: "返信する", exact: true }).click();
  const form = replyForm(oliver, "Oliver");
  const japanese = form.getByRole("textbox", { name: "日本語で書く" });
  const publish = form.getByRole("button", { name: "返信を公開する" });
  await expect(japanese).toBeFocused();
  await expect(form).toContainText("返信は体験のページに英語で公開されます");
  await expect(form.getByRole("button", { name: "英語にする" })).toBeDisabled();
  await expect(publish).toBeDisabled();
  await japanese.fill(OLIVER_JA);
  await form.getByRole("button", { name: "英語にする" }).click();
  await expect(form).toContainText("公開される英語");
  await expect(form.getByText(OLIVER_EN)).toBeVisible();
  await expect(publish).toBeEnabled();

  // Changing the Japanese stops the English made from the old one.
  await japanese.fill(`${OLIVER_JA}桜の頃にもぜひ。`);
  await expect(form.getByRole("status").filter({ hasText: STALE })).toBeVisible();
  await expect(publish).toBeDisabled();
  await form.getByRole("button", { name: "英語を作り直す" }).click();
  await expect(form.getByText(PREVIEW_EN)).toBeVisible();
  await expect(form.getByText(STALE)).toHaveCount(0);
  await expect(publish).toBeEnabled();

  const sent = recordSent(page);
  await publish.click();
  await expect(oliver.getByRole("status").filter({ hasText: "返信を公開しました" })).toBeVisible();
  await expect(form).toHaveCount(0);
  const yours = oliver.getByRole("heading", { level: 3, name: "あなたの返信" });
  await expect(yours).toBeFocused();
  await expect(oliver).toContainText("桜の頃にもぜひ。");
  await expect(oliver).toContainText("10月21日に公開");
  await expect(oliver.getByText(PREVIEW_EN)).toBeHidden();
  await oliver.getByText("公開した英語").click();
  await expect(oliver.getByText(PREVIEW_EN)).toBeVisible();
  // It has its reply now: 返信を直す instead of 返信する.
  await expect(oliver.getByRole("button", { name: "返信する", exact: true })).toHaveCount(0);
  expect(sent).toEqual([]);

  // 返信を直す starts from the published reply and waits for a change.
  await oliver.getByRole("button", { name: "返信を直す" }).click();
  const again = replyForm(oliver, "Oliver");
  await expect(again.getByRole("textbox", { name: "日本語で書く" })).toHaveValue(`${OLIVER_JA}桜の頃にもぜひ。`);
  await expect(again.getByText(PREVIEW_EN)).toBeVisible();
  await expect(again.getByRole("button", { name: "返信を公開する" })).toBeDisabled();
  await expect(again).toContainText("日本語か英語を直すと公開できます");
  await again.getByRole("button", { name: "英語を直す" }).click();
  const english = again.getByRole("textbox", { name: "公開される英語" });
  await expect(english).toBeFocused();
  await english.fill(`${OLIVER_EN} Come back in cherry blossom season too.`);
  await again.getByRole("button", { name: "返信を公開する" }).click();
  await expect(oliver.getByRole("status").filter({ hasText: "返信を直しました" })).toBeVisible();
  await expect(oliver).toContainText("10月21日に公開 · 10月21日に直しました");
  await oliver.getByText("公開した英語").click();
  await expect(oliver.getByText("Come back in cherry blossom season too.", { exact: false })).toBeVisible();
  expect(sent).toEqual([]);
});

test("one reply is open at a time and keeps what was written; やめる drops it; a failed 英語にする keeps the Japanese", async ({ page }) => {
  await signIn(page);
  await page.goto("/host/reviews");
  const oliver = reviewItem(page, "Oliver さん · イギリス");
  const ella = reviewItem(page, "Ella さん · オーストラリア");
  await oliver.getByRole("button", { name: "返信する", exact: true }).click();
  const oliverJapanese = replyForm(oliver, "Oliver").getByRole("textbox", { name: "日本語で書く" });
  await oliverJapanese.fill("ありがとうございました。");
  const experience = page.getByRole("combobox", { name: "体験" });
  await experience.selectOption("kintsugi");
  await expect(list(page)).toContainText("レビューはまだありません");
  await experience.selectOption("");
  await expect(oliverJapanese).toHaveValue("ありがとうございました。");
  await ella.getByRole("button", { name: "返信する", exact: true }).click();
  await expect(list(page).getByRole("form")).toHaveCount(1);
  await expect(replyForm(ella, "Ella")).toBeVisible();
  await expect(replyForm(oliver, "Oliver")).toBeHidden();
  await expect(oliver.getByRole("button", { name: "返信する", exact: true })).toBeVisible();
  await oliver.getByRole("button", { name: "返信する", exact: true }).click();
  await expect(oliverJapanese).toHaveValue("ありがとうございました。");
  await expect(replyForm(ella, "Ella")).toBeHidden();

  // The server action's POST fails on its way: the Japanese stays, and it can be tried again.
  await page.route("**/host/reviews**", (route) => (route.request().method() === "POST" ? route.abort("failed") : route.continue()));
  await replyForm(oliver, "Oliver").getByRole("button", { name: "英語にする" }).click();
  await expect(replyForm(oliver, "Oliver").getByRole("alert")).toHaveText(DRAFT_FAILED);
  await expect(oliverJapanese).toHaveValue("ありがとうございました。");
  await expect(replyForm(oliver, "Oliver").getByRole("button", { name: "返信を公開する" })).toBeDisabled();
  await page.unroute("**/host/reviews**");

  await replyForm(oliver, "Oliver").getByRole("button", { name: "やめる" }).click();
  await expect(replyForm(oliver, "Oliver")).toHaveCount(0);
  await expect(oliver.getByRole("button", { name: "返信する", exact: true })).toBeFocused();
  await oliver.getByRole("button", { name: "返信する", exact: true }).click();
  await expect(oliverJapanese).toHaveValue("");
});

test("a review NIHO is checking can be read and reported, not answered; a report asks for a reason and the review stays", async ({ page }) => {
  await signIn(page);
  await page.goto("/host/reviews#review-rv-5013");
  const yuki = reviewItem(page, "由紀 さん · 日本");
  await expect(yuki.getByRole("heading", { level: 2 })).toBeFocused();
  for (const text of ["公開前", "10/13（火）Kamakura Community Dinner with Locals", WAITING, "席が少し窮屈だったので、星は 4 つにしました。"]) await expect(yuki).toContainText(text);
  await expect(yuki.getByRole("img", { name: "5 点中 4 点", exact: true })).toBeVisible();
  // Written in Japanese: nothing to translate.
  await expect(yuki).not.toContainText("翻訳");
  await expect(yuki.getByRole("button", { name: /返信/ })).toHaveCount(0);
  await expect(yuki.getByRole("form")).toHaveCount(0);

  const sent = recordSent(page);
  const report = yuki.getByRole("button", { name: "報告する" });
  const ask = page.getByRole("dialog", { name: "このレビューを NIHO に報告しますか？" });
  const confirm = ask.getByRole("button", { name: "NIHO に報告する" });
  await report.click();
  await expect(ask).toContainText("報告してもレビューは隠れません。");
  await expect(ask.getByRole("radio", { name: "個人情報が書かれている" })).toBeFocused();
  await expect(confirm).toBeDisabled();
  await expect(ask).toContainText("理由を選ぶと報告できます");
  await ask.getByRole("button", { name: "やめる" }).click();
  await expect(ask).toHaveCount(0);
  await expect(report).toBeVisible();

  await report.click();
  await ask.getByRole("radio", { name: "事実と違う" }).check();
  await expect(ask).not.toContainText("理由を選ぶと報告できます");
  await ask.getByRole("textbox", { name: "ひとこと（任意）" }).fill("当日は満席ではありませんでした。");
  await confirm.click();
  await expect(ask).toHaveCount(0);
  await expect(yuki.getByRole("status").filter({ hasText: "報告しました · NIHO が確認します" })).toBeVisible();
  await expect(yuki.getByRole("heading", { level: 2 })).toBeFocused();
  await expect(yuki).toContainText("報告済み");
  await expect(yuki.getByRole("button", { name: "報告する" })).toHaveCount(0);
  // The review stays as it is: NIHO decides.
  await expect(yuki).toContainText("席が少し窮屈だったので");
  expect(sent).toEqual([]);
});

test("an untranslated review reads in the original; replies show in Japanese with the English published, and when", async ({ page }) => {
  await signIn(page);
  await page.goto("/host/reviews");
  await expect(reviewHeadings(page)).toHaveText(["由紀 さん · 日本", "Oliver さん · イギリス", "Lena さん · チェコ", "Grace さん · シンガポール", "Ella さん · オーストラリア", "Jonas さん · ドイツ"]);

  const lena = reviewItem(page, "Lena さん · チェコ");
  await expect(lena.locator('p[lang="cs"]')).toHaveText("Úžasný večer! Vařili jsme společně a všichni byli velmi milí. Děkujeme za recept na misopolévku.");
  await expect(lena).toContainText("翻訳できませんでした");
  await expect(lena).toContainText("あなたの返信");
  await expect(lena).toContainText("ご参加ありがとうございました。またいつでも鎌倉へお越しください。");
  await expect(lena.getByText("Come back to Kamakura any time.", { exact: false })).toBeHidden();
  await lena.getByText("公開した英語").click();
  await expect(lena.getByText("Come back to Kamakura any time.", { exact: false })).toBeVisible();
  await expect(lena).toContainText("9月29日に公開");
  await expect(lena.getByRole("button", { name: "返信を直す" })).toBeVisible();

  await expect(reviewItem(page, "Grace さん · シンガポール")).toContainText("9月15日に公開 · 9月16日に直しました");
  const jonas = reviewItem(page, "Jonas さん · ドイツ");
  await expect(jonas).toContainText("ドイツ語から翻訳");
  await expect(jonas.locator('p[lang="de"]')).toContainText("Ein wunderbarer Abend");
});

test("体験 links each experience's average to its reviews; レビュー is a screen under ホーム with a summary and the experience select", async ({ page }, testInfo) => {
  await signIn(page);
  await page.goto("/host/experiences");
  const rows = page.getByRole("region", { name: "体験の一覧" }).getByRole("listitem");
  const rating = rows.nth(0).getByRole("link", { name: "レビュー 4.8 点 · 5 件" });
  await expect(rating).toHaveAttribute("href", "/host/reviews?experience=community-dinner");
  await expect(rating).toContainText("★ 4.8");
  // The row's own link opens the editor, apart from the reviews; experiences without a published review have none.
  await expect(rows.nth(0).getByRole("link")).toHaveCount(2);
  await expect(rows.nth(0).getByRole("link").first()).toHaveAttribute("href", "/host/experiences/community-dinner");
  for (const index of [1, 2]) await expect(rows.nth(index).getByRole("link")).toHaveCount(1);

  await rating.click();
  await expect(page).toHaveURL(/\/host\/reviews\?experience=community-dinner$/);
  await expect(page.getByRole("heading", { level: 1, name: "レビュー" })).toBeVisible();
  const select = page.getByRole("combobox", { name: "体験" });
  await expect(select).toHaveValue("community-dinner");
  await expect(reviewHeadings(page)).toHaveCount(6);
  const summary = page.locator("main p", { hasText: "公開 5 件" });
  await expect(summary).toContainText("4.8");
  await expect(page.getByRole("list", { name: "レビューの要約" }).getByRole("listitem")).toHaveText(["公開前 1 件"]);
  if (isDesktop(testInfo.project.name)) {
    // The summary on the right of the title; the menu keeps ホーム.
    const titleBox = (await page.getByRole("heading", { level: 1 }).boundingBox())!;
    const summaryBox = (await summary.boundingBox())!;
    expect(summaryBox.x).toBeGreaterThan(titleBox.x + titleBox.width);
    await expect(menu(page).getByRole("link", { name: "ホーム" })).toHaveAttribute("aria-current", "page");
  } else {
    // "‹ ホーム" instead of the brand header, and no bottom tabs.
    await expect(menu(page)).toHaveCount(0);
    await expect(page.getByRole("banner")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "ホームへ戻る" })).toHaveAttribute("href", "/host/home");
  }

  await select.selectOption({ label: "Mend a Broken Bowl with a Kamakura Restorer" });
  await expect(page).toHaveURL(/\/host\/reviews\?experience=kintsugi$/);
  await expect(list(page)).toContainText("レビューはまだありません");
  await expect(summary).toHaveCount(0);
  await expect(page.getByRole("list", { name: "レビューの要約" })).toHaveCount(0);
  await select.selectOption({ label: "すべての体験" });
  await expect(page).toHaveURL(/\/host\/reviews$/);
  await expect(reviewHeadings(page)).toHaveCount(6);

  // A review the address leads to takes focus, also further down.
  await page.goto("/host/reviews?providerId=sample-provider-kitchen#review-rv-4906");
  const ella = reviewItem(page, "Ella さん · オーストラリア").getByRole("heading", { level: 2 });
  await expect(ella).toBeFocused();
  await expect(ella).toBeInViewport();
  if (!isDesktop(testInfo.project.name)) await expect(page.getByRole("link", { name: "ホームへ戻る" })).toHaveAttribute("href", "/host/home?providerId=sample-provider-kitchen");
});

test("a provider without reviews says so, and ホーム and 体験 show none", async ({ page }) => {
  await signIn(page, "?providerId=sample-provider-studio");
  await expect(todos(page).filter({ hasText: "レビュー" })).toHaveCount(0);
  await page.goto("/host/reviews?providerId=sample-provider-studio");
  await expect(page.getByRole("heading", { level: 1, name: "レビュー" })).toBeVisible();
  await expect(list(page)).toContainText("レビューはまだありません");
  // One experience: no select, and nothing to sum up.
  await expect(page.getByRole("combobox", { name: "体験" })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "レビューの要約" })).toHaveCount(0);
  await page.goto("/host/experiences?providerId=sample-provider-studio");
  await expect(page.getByRole("region", { name: "体験の一覧" }).getByRole("link", { name: /レビュー/ })).toHaveCount(0);
});

test("レビュー has no WCAG 2.2 AA violations", async ({ page }) => {
  await signIn(page);
  await page.goto("/host/reviews");
  await expect(reviewHeadings(page).first()).toBeVisible();
  await audit(page, "reviews");
  const oliver = reviewItem(page, "Oliver さん · イギリス");
  await oliver.getByRole("button", { name: "返信する", exact: true }).click();
  const form = replyForm(oliver, "Oliver");
  await form.getByRole("textbox", { name: "日本語で書く" }).fill(OLIVER_JA);
  await form.getByRole("button", { name: "英語にする" }).click();
  await expect(form.getByText(OLIVER_EN)).toBeVisible();
  await audit(page, "reply: English made");
  await form.getByRole("textbox", { name: "日本語で書く" }).fill("ありがとうございました。");
  await expect(form.getByText(STALE)).toBeVisible();
  await audit(page, "reply: English stale");
  await form.getByRole("button", { name: "英語を直す" }).click();
  await form.getByRole("button", { name: "返信を公開する" }).click();
  await expect(oliver.getByRole("status").filter({ hasText: "返信を公開しました" })).toBeVisible();
  await oliver.getByText("公開した英語").click();
  await audit(page, "reply: published");
  await reviewItem(page, "由紀 さん · 日本").getByRole("button", { name: "報告する" }).click();
  await audit(page, "report dialog");
  await page.getByRole("dialog").getByRole("radio", { name: "不適切な内容" }).check();
  await page.getByRole("dialog").getByRole("button", { name: "NIHO に報告する" }).click();
  await expect(page.getByRole("status").filter({ hasText: "報告しました" })).toBeVisible();
  await audit(page, "reported");
  for (const path of ["/host/reviews?experience=kintsugi", "/host/reviews?providerId=sample-provider-studio", "/host/experiences", "/host/home"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await audit(page, path);
  }
});

test.describe("320px narrow phone", () => {
  test.use({ viewport: { width: 320, height: 640 } });
  test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== "host-mobile-360"));

  test("the reviews, a reply and the report fit", async ({ page }) => {
    const inside = async (locator: Locator, label: string) => {
      await locator.scrollIntoViewIfNeeded();
      await expect(locator, label).toBeInViewport();
      const box = await locator.boundingBox();
      expect(box && box.x >= 0 && box.x + box.width <= 320, label).toBe(true);
    };
    await signIn(page);
    for (const path of ["/host/home", "/host/reviews", "/host/reviews?experience=community-dinner", "/host/reviews?experience=kintsugi", "/host/experiences"]) {
      await page.goto(path);
      await expect(page.locator("main").getByRole("heading").first()).toBeVisible();
      expect(await overflowX(page), path).toBeLessThanOrEqual(0);
    }
    await page.goto("/host/home");
    await inside(todos(page).filter({ hasText: "Oliver さん" }).getByRole("link", { name: "読んで返信する" }), "home: 読んで返信する");
    await page.goto("/host/experiences");
    await inside(page.getByRole("link", { name: "レビュー 4.8 点 · 5 件" }), "experiences: ★ 4.8 · 5 件");

    await page.goto("/host/reviews");
    await inside(page.getByRole("link", { name: "ホームへ戻る" }), "‹ ホーム");
    await inside(page.getByRole("combobox", { name: "体験" }), "体験の select");
    const oliver = reviewItem(page, "Oliver さん · イギリス");
    await oliver.getByRole("button", { name: "返信する", exact: true }).click();
    const form = replyForm(oliver, "Oliver");
    await form.getByRole("textbox", { name: "日本語で書く" }).fill(OLIVER_JA);
    await form.getByRole("button", { name: "英語にする" }).click();
    await expect(form.getByText(OLIVER_EN)).toBeVisible();
    for (const name of ["英語を作り直す", "英語を直す", "やめる", "返信を公開する"]) await inside(form.getByRole("button", { name }), name);
    await inside(oliver.getByRole("button", { name: "報告する" }), "報告する");
    expect(await overflowX(page), "English made").toBeLessThanOrEqual(0);

    await reviewItem(page, "由紀 さん · 日本").getByRole("button", { name: "報告する" }).click();
    const ask = page.getByRole("dialog");
    for (const name of ["個人情報が書かれている", "その他"]) await inside(ask.getByRole("radio", { name }), name);
    await inside(ask.getByRole("button", { name: "NIHO に報告する" }), "NIHO に報告する");
    expect(await overflowX(page), "report dialog").toBeLessThanOrEqual(0);
  });
});
