import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

// 予約 (#90) on synthetic data. Runs against the second server (HOST_CONSOLE_ENABLED=true,
// mock mode; see playwright.config.ts). Nothing is sent: 承認・お断り・取消 change the bookings
// on this screen only, and the screen keeps them while the URL changes. メッセージ leads to the
// booking's thread (host-messages.spec.ts).

const isDesktop = (projectName: string) => projectName === "host-desktop";
const menu = (page: Page) => page.getByRole("navigation", { name: "ホストのメニュー" });
const list = (page: Page) => page.getByRole("region", { name: "予約の一覧" });
/** The bookings' rows (each session's heading is a link of its own, to この回: host-session.spec.ts). */
const rows = (page: Page) => list(page).getByRole("listitem").getByRole("link");
const row = (page: Page, guest: string) => list(page).getByRole("link", { name: new RegExp(`^${guest}`) });
const chips = (page: Page) => page.getByRole("list", { name: "予約の絞り込み" }).getByRole("link");
const chip = (page: Page, label: string) => page.getByRole("list", { name: "予約の絞り込み" }).getByRole("link", { name: label, exact: true });
const detail = (page: Page, guest: string) => page.getByRole("region", { name: guest, exact: true });
const timeline = (booking: Locator) => booking.getByRole("region", { name: "時系列" });
/** A row of 申込内容 or 状態: the value next to its label. */
const value = (booking: Locator, label: string) => booking.locator("dl > div").filter({ has: booking.page().locator("dt", { hasText: new RegExp(`^${label}$`) }) }).locator("dd");
const overflowX = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function signIn(page: Page, query = "") {
  await page.goto(`/host/auth/mock-login${query}`);
  await page.waitForURL(/\/host\/home(\?|$)/);
}

async function audit(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), label).toEqual([]);
}

test("予約 lists the bookings by session, and the chips and the experience narrow it", async ({ page }) => {
  await signIn(page);
  await menu(page).getByRole("link", { name: "予約" }).click();
  await page.waitForURL(/\/host\/bookings$/);
  await expect(page.getByRole("heading", { level: 1, name: "予約" })).toBeVisible();
  await expect(chips(page)).toHaveText(["これから", "承認待ち", "過去", "取消済み"]);
  await expect(chip(page, "これから")).toHaveAttribute("aria-current", "page");

  // One heading per session: day and time, the experience, and the seats its requests and bookings keep.
  await expect(list(page).getByRole("heading", { level: 2 })).toHaveText([
    // Today's tea time is over, but its day is not (#107).
    /^10月21日（水）13:00.*4 \/ 8名$/,
    /^10月22日（木）18:00.*Kamakura Community Dinner with Locals.*4 \/ 8名$/,
    /^10月24日（土）18:00.*1 \/ 8名$/,
    /^10月25日（日）13:00.*0 \/ 8名$/,
    /^10月27日（火）18:00.*3 \/ 8名$/,
    /^10月29日（木）18:00.*3 \/ 8名$/,
  ]);
  for (const text of ["Lucas & Mia Chen", "2名 · ¥60,000 · 体験サイト", "承認待ち"]) await expect(row(page, "Lucas & Mia Chen")).toContainText(text);
  await expect(row(page, "Mateo García")).toContainText("要返金");
  await expect(row(page, "Sofia Rossi")).toContainText("3名 · ¥90,000 · NIHO");

  await chip(page, "承認待ち").click();
  await expect(page).toHaveURL(/\/host\/bookings\?filter=pending$/);
  await expect(chip(page, "承認待ち")).toHaveAttribute("aria-current", "page");
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page)).toContainText(["Lucas & Mia Chen", "Ana Souza"]);

  await chip(page, "過去").click();
  await expect(page).toHaveURL(/\?filter=past$/);
  await expect(rows(page)).toContainText(["Oliver Brown", "Chloé Dubois", "森 健二", "Liam Walker"]);
  await expect(row(page, "Oliver Brown")).toContainText("確定");
  await expect(row(page, "Chloé Dubois")).toContainText("お断り");
  await expect(row(page, "森 健二")).toContainText("期限切れ");

  await chip(page, "取消済み").click();
  await expect(page).toHaveURL(/\?filter=cancelled$/);
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, "Hannah Kim")).toContainText("取消済み");

  // The experience select keeps the filter.
  const experience = page.getByRole("combobox", { name: "体験" });
  await experience.selectOption({ label: "Mend a Broken Bowl with a Kamakura Restorer" });
  await expect(page).toHaveURL(/\?filter=cancelled&experience=kintsugi$/);
  await expect(list(page)).toContainText("該当する予約はありません");
  await expect(chip(page, "これから")).toHaveAttribute("href", "/host/bookings?experience=kintsugi");
  await experience.selectOption({ label: "すべての体験" });
  await expect(page).toHaveURL(/\?filter=cancelled$/);
  await expect(rows(page)).toHaveCount(1);
});

test("PC shows a booking on the right of the list; phones open it as a screen of its own", async ({ page }, testInfo) => {
  await signIn(page);
  await page.goto("/host/bookings");
  const lucas = detail(page, "Lucas & Mia Chen");
  if (isDesktop(testInfo.project.name)) {
    // The first booking of the list (today's tea time), beside it in a 400px column, until another one is chosen.
    const first = detail(page, "Aiko Tanaka");
    await expect(first).toBeVisible();
    await expect(lucas).toHaveCount(0);
    const listBox = (await list(page).boundingBox())!;
    const detailBox = (await first.boundingBox())!;
    expect(detailBox.x).toBeGreaterThan(listBox.x + listBox.width);
    expect(Math.round(detailBox.width)).toBe(400);
    await row(page, "Emma Larsson").click();
    await expect(page).toHaveURL(/\/host\/bookings\?booking=bk-2038$/);
    await expect(detail(page, "Emma Larsson")).toBeVisible();
    await expect(row(page, "Emma Larsson")).toHaveAttribute("aria-current", "true");
    await expect(list(page)).toBeVisible();
    await expect(menu(page).getByRole("link", { name: "予約" })).toHaveAttribute("aria-current", "page");
  } else {
    await expect(lucas).toBeHidden();
    await row(page, "Lucas & Mia Chen").click();
    await expect(page).toHaveURL(/\/host\/bookings\?booking=bk-2041$/);
    await expect(lucas).toBeVisible();
    await expect(lucas.getByRole("heading", { level: 2, name: "Lucas & Mia Chen" })).toBeFocused();
    await expect(list(page)).toBeHidden();
    // "‹ 予約" instead of the brand header, and no bottom tabs.
    await expect(menu(page)).toHaveCount(0);
    await expect(page.getByRole("banner")).toHaveCount(0);
    const back = page.getByRole("link", { name: "予約へ戻る" });
    await expect(back).toHaveText("予約");
    await back.click();
    await expect(page).toHaveURL(/\/host\/bookings$/);
    await expect(list(page)).toBeVisible();
    await expect(menu(page)).toHaveCount(1);
    await expect(row(page, "Lucas & Mia Chen")).toBeFocused();
    // The browser's back button returns to the booking as well.
    await page.goBack();
    await expect(page).toHaveURL(/\?booking=bk-2041$/);
    await expect(lucas).toBeVisible();
  }

  // Opened from its address, a booking shows on its own; one that is not this provider's does not exist.
  await page.goto("/host/bookings?booking=bk-2033");
  await expect(detail(page, "Mateo García")).toBeVisible();
  expect((await page.goto("/host/bookings?booking=no-such-booking"))?.status()).toBe(404);
  expect((await page.goto("/host/bookings?providerId=sample-provider-studio&booking=bk-2041"))?.status()).toBe(404);
});

test("承認 asks first, then confirms the request and keeps it so", async ({ page }, testInfo) => {
  await signIn(page);
  await page.goto("/host/bookings?booking=bk-2041");
  const booking = detail(page, "Lucas & Mia Chen");
  await expect(booking).toContainText("10月22日（木）18:00–20:00 · Dinner");
  await expect(booking).toContainText("承認期限 今日 22:00");
  for (const [label, text] of [
    ["体験", "Kamakura Community Dinner with Locals"],
    ["商品", "Dinner"],
    ["人数", "2名（大人 2）"],
    ["金額", "¥60,000"],
    ["内訳", "大人 ¥30,000 × 2"],
    ["言語", "英語"],
    ["申込経路", "体験サイト"],
    ["申込メモ", "It is our anniversary that evening!"],
    ["集合案内", "v2 · 承認後に送付"],
    ["予約", "承認待ち"],
    ["与信", "10月20日（火）14:02"],
    ["承認期限", "10月21日（水）22:00"],
  ]) {
    await expect(value(booking, label!), label).toHaveText(text!);
  }
  await expect(value(booking, "回答")).toContainText("Any dietary preferences we should know about?");
  await expect(value(booking, "回答")).toContainText("One of us is vegetarian.");
  // NIHO keeps the guest's address: the host writes through the thread.
  await expect(value(booking, "連絡先")).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText("@");

  // やめる and Esc go back without changing anything.
  const ask = page.getByRole("dialog", { name: "申込を承認しますか？" });
  const approve = booking.getByRole("button", { name: "承認する" });
  await approve.click();
  await expect(ask).toBeVisible();
  for (const text of ["Lucas & Mia Chen", "10月22日（木）18:00–20:00 · Dinner", "¥60,000"]) await expect(ask).toContainText(text);
  await expect(ask.getByRole("button", { name: "やめる" })).toBeFocused();
  await ask.getByRole("button", { name: "やめる" }).click();
  await expect(ask).toHaveCount(0);
  await approve.click();
  await page.keyboard.press("Escape");
  await expect(ask).toHaveCount(0);
  await expect(value(booking, "予約")).toHaveText("承認待ち");

  await approve.click();
  await ask.getByRole("button", { name: "決済して承認" }).click();
  await expect(ask).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "申込を承認しました。予約が確定しました" })).toBeVisible();
  await expect(booking.getByRole("heading", { level: 2, name: "Lucas & Mia Chen" })).toBeFocused();
  await expect(value(booking, "予約")).toHaveText("確定");
  // The preview dates what the host does at its own fixed moment (15:30), after the request.
  await expect(value(booking, "支払い")).toHaveText("10月21日（水）15:30");
  await expect(value(booking, "集合案内")).toHaveText("v2 · 10月21日に送付");
  await expect(value(booking, "承認期限")).toHaveCount(0);
  await expect(timeline(booking).getByRole("listitem")).toHaveText(["10/20 14:02申込（体験サイト）", "10/20 14:02与信", "10/21 15:30承認 · 確定", "10/21 15:30支払い"]);
  await expect(approve).toHaveCount(0);
  await expect(booking.getByRole("button", { name: "取り消して返金する" })).toBeVisible();

  // The change stays while moving around the screen.
  if (!isDesktop(testInfo.project.name)) await page.getByRole("link", { name: "予約へ戻る" }).click();
  await expect(row(page, "Lucas & Mia Chen")).toContainText("確定");
  await row(page, "Emma Larsson").click();
  await expect(detail(page, "Emma Larsson")).toBeVisible();
  if (!isDesktop(testInfo.project.name)) await page.getByRole("link", { name: "予約へ戻る" }).click();
  await row(page, "Lucas & Mia Chen").click();
  await expect(value(booking, "予約")).toHaveText("確定");
});

test("お断り asks first, then declines the other request", async ({ page }, testInfo) => {
  await signIn(page);
  await page.goto("/host/bookings?filter=pending&booking=bk-2044");
  const booking = detail(page, "Ana Souza");
  await expect(value(booking, "人数")).toHaveText("3名（大人 2・子ども 1）");
  await expect(value(booking, "内訳")).toHaveText("大人 ¥30,000 × 2 ＋ 子ども ¥12,000 × 1");
  await expect(value(booking, "金額")).toHaveText("¥72,000");
  await expect(booking).toContainText("承認期限 10月23日（金）12:00");

  await booking.getByRole("button", { name: "お断りする" }).click();
  const ask = page.getByRole("dialog", { name: "申込をお断りしますか？" });
  await expect(ask).toContainText("¥72,000");
  await ask.getByRole("button", { name: "申込を断る" }).click();
  await expect(ask).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "申込をお断りしました" })).toBeVisible();
  await expect(booking.getByRole("heading", { level: 2, name: "Ana Souza" })).toBeFocused();
  await expect(value(booking, "予約")).toHaveText("お断り");
  await expect(value(booking, "集合案内")).toHaveCount(0);
  await expect(timeline(booking)).toContainText("お断り · 与信を取り消し");
  // An ended request has nothing left to do: no actions and no message to start.
  await expect(booking.getByRole("button")).toHaveCount(0);
  await expect(booking.getByRole("region", { name: "メッセージ" })).toHaveCount(0);
  if (isDesktop(testInfo.project.name)) {
    // It no longer waits for an answer.
    await expect(rows(page)).toHaveCount(1);
    await chip(page, "過去").click();
    await expect(row(page, "Ana Souza")).toContainText("お断り");
  }
});

test("取消 waits for the refund and the reason, and says how much went back", async ({ page }) => {
  await signIn(page);
  await page.goto("/host/bookings?booking=bk-2038");
  const booking = detail(page, "Emma Larsson");
  const cancel = booking.getByRole("button", { name: "取り消して返金する" });
  const ask = page.getByRole("dialog", { name: "予約を取り消しますか？" });
  const confirm = ask.getByRole("button", { name: /を返金して取り消す$|^予約を取り消す$/ });
  await cancel.click();
  await expect(ask).toContainText("Emma Larssonさんの予約を取り消します。この操作は元に戻せません。");
  await expect(ask.getByRole("radio", { name: /^全額/ })).toBeChecked();
  await expect(ask.getByRole("radio", { name: /^全額/ })).toBeFocused();
  await expect(confirm).toHaveText("¥60,000 を返金して取り消す");
  // Without a reason it cannot be cancelled.
  await expect(confirm).toBeDisabled();
  await expect(ask).toContainText("取消理由を選ぶと取り消せます");
  await ask.getByRole("radio", { name: /^半額/ }).check();
  await expect(confirm).toHaveText("¥30,000 を返金して取り消す");
  await expect(ask).toContainText("今回の返金 ¥30,000 · 返金後の合計 ¥30,000");
  await ask.getByRole("radio", { name: /^返金なし/ }).check();
  await expect(confirm).toHaveText("予約を取り消す");
  await ask.getByRole("radio", { name: /^全額/ }).check();
  await ask.getByRole("radio", { name: "運営者の都合" }).check();
  const message = ask.getByRole("textbox", { name: "旅行者へのメッセージ" });
  await expect(message).toHaveValue(/^We’re very sorry/);
  await expect(confirm).toBeEnabled();
  // Nor without a message.
  await message.fill("");
  await expect(confirm).toBeDisabled();
  await message.fill("We are very sorry: the kitchen is closed that evening.");
  await expect(confirm).toBeEnabled();
  // Esc goes back without cancelling, and the dialog starts over the next time.
  await page.keyboard.press("Escape");
  await expect(ask).toHaveCount(0);
  await expect(value(booking, "予約")).toHaveText("確定");
  await cancel.click();
  await expect(confirm).toBeDisabled();
  await expect(message).toHaveValue(/^We’re very sorry/);

  await ask.getByRole("radio", { name: "運営者の都合" }).check();
  await confirm.click();
  await expect(ask).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "予約を取り消し、¥60,000 を返金しました" })).toBeVisible();
  await expect(booking.getByRole("heading", { level: 2, name: "Emma Larsson" })).toBeFocused();
  for (const [label, text] of [
    ["予約", "取消済み"],
    ["取消理由", "運営者の都合"],
    ["累計返金", "¥60,000"],
  ]) {
    await expect(value(booking, label!), label).toHaveText(text!);
  }
  await expect(value(booking, "取消")).toHaveText("10月21日（水）15:30");
  await expect(value(booking, "取消連絡")).toHaveText(/^We’re very sorry/);
  await expect(timeline(booking)).toContainText("取消 · 返金 ¥60,000");
  await expect(booking).toContainText("10月21日に取消 · ¥60,000 を返金済み");
  await expect(cancel).toHaveCount(0);
});

test("要返金: the traveler's own request is refunded in full", async ({ page }) => {
  await signIn(page);
  await page.goto("/host/bookings?booking=bk-2033");
  const booking = detail(page, "Mateo García");
  await expect(value(booking, "予約")).toHaveText("要返金");
  await expect(value(booking, "取消依頼")).toHaveText("10月20日（火）08:12");
  await expect(value(booking, "累計返金")).toHaveText("¥0");
  await expect(booking).toContainText("旅行者が取消を依頼しています");

  await booking.getByRole("button", { name: "取り消して返金する" }).click();
  const ask = page.getByRole("dialog", { name: "予約を取り消しますか？" });
  // Only the full refund, and the traveler's reason to start with.
  await expect(ask.getByRole("radio", { name: /^(全額|半額|返金なし)/ })).toHaveCount(0);
  await expect(ask).toContainText("全額 ¥30,000 · 旅行者からの取消依頼は全額を返金します");
  await expect(ask.getByRole("radio", { name: "旅行者からの依頼" })).toBeChecked();
  await expect(ask.getByRole("radio", { name: "旅行者からの依頼" })).toBeFocused();
  await expect(ask.getByRole("textbox", { name: "旅行者へのメッセージ" })).toHaveValue(/^As you asked/);
  await ask.getByRole("button", { name: "¥30,000 を返金して取り消す" }).click();
  await expect(ask).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "予約を取り消し、¥30,000 を返金しました" })).toBeVisible();
  await expect(value(booking, "予約")).toHaveText("取消済み");
  await expect(value(booking, "取消理由")).toHaveText("旅行者からの依頼");
  await expect(value(booking, "累計返金")).toHaveText("¥30,000");
  await expect(booking).not.toContainText("旅行者が取消を依頼しています");
});

test("メッセージ shows the last word of the booking's thread, or starts one", async ({ page }) => {
  await signIn(page);
  await page.goto("/host/bookings?booking=bk-2031");
  const sofia = detail(page, "Sofia Rossi");
  await expect(value(sofia, "集合案内")).toHaveText("v1 · 10月15日に送付");
  const messages = sofia.getByRole("region", { name: "メッセージ" });
  // Sofia answered the host's note by email: her words, in Japanese, and when.
  await expect(messages).toContainText("ありがとうございます！ 電車は 17:40 ごろに着きます。");
  await expect(messages).toContainText("10/21 11:05");
  await expect(messages.getByRole("link", { name: "やりとりを開く" })).toHaveAttribute("href", "/host/messages?thread=th-3004");
  await expect(messages.getByRole("textbox")).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText("@");

  // A booking without a thread yet starts one.
  await page.goto("/host/bookings?booking=bk-2035");
  const noah = detail(page, "Noah Williams").getByRole("region", { name: "メッセージ" });
  await expect(noah).toContainText("まだやりとりはありません。");
  await expect(noah.getByRole("link", { name: "メッセージを送る" })).toHaveAttribute("href", "/host/messages?booking=bk-2035");
});

test("ホーム's request opens its booking with 詳しく見る", async ({ page }) => {
  await signIn(page);
  const lucas = page.getByRole("region", { name: "次にすること" }).getByRole("listitem").filter({ hasText: "Lucas & Mia Chen さん" });
  const open = lucas.getByRole("link", { name: "詳しく見る" });
  await expect(open).toHaveAttribute("href", "/host/bookings?booking=bk-2041");
  await open.click();
  await expect(page).toHaveURL(/\/host\/bookings\?booking=bk-2041$/);
  await expect(detail(page, "Lucas & Mia Chen")).toBeVisible();
  await expect(value(detail(page, "Lucas & Mia Chen"), "予約")).toHaveText("承認待ち");
});

test("the screen's links keep ?providerId=, and a provider without bookings says so", async ({ page }) => {
  await signIn(page, "?providerId=sample-provider-kitchen");
  await page.goto("/host/bookings?providerId=sample-provider-kitchen");
  await expect(row(page, "Lucas & Mia Chen")).toHaveAttribute("href", "/host/bookings?providerId=sample-provider-kitchen&booking=bk-2041");
  await row(page, "Sofia Rossi").click();
  await expect(detail(page, "Sofia Rossi").getByRole("link", { name: "やりとりを開く" })).toHaveAttribute("href", "/host/messages?providerId=sample-provider-kitchen&thread=th-3004");
  if (!(await list(page).isVisible())) await page.getByRole("link", { name: "予約へ戻る" }).click();
  await expect(chip(page, "承認待ち")).toHaveAttribute("href", "/host/bookings?providerId=sample-provider-kitchen&filter=pending");
  await chip(page, "過去").click();
  await expect(page).toHaveURL(/\/host\/bookings\?providerId=sample-provider-kitchen&filter=past$/);
  await expect(menu(page).getByRole("link", { name: "予約" })).toHaveAttribute("href", "/host/bookings?providerId=sample-provider-kitchen");

  expect((await page.goto("/host/bookings?providerId=sample-provider-studio"))?.status()).toBe(404);
});

test("bookings screens have no WCAG 2.2 AA violations", async ({ page }) => {
  await signIn(page);
  for (const path of ["/host/bookings", "/host/bookings?filter=past", "/host/bookings?booking=bk-2041", "/host/bookings?booking=bk-2033", "/host/bookings?booking=bk-2031", "/host/bookings?booking=bk-2012"]) {
    await page.goto(path);
    await expect(page.locator("main").getByRole("heading", { level: 2 }).first()).toBeVisible();
    await audit(page, path);
  }
  await page.goto("/host/bookings?booking=bk-2041");
  const lucas = detail(page, "Lucas & Mia Chen");
  await lucas.getByRole("button", { name: "承認する" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await audit(page, "approve dialog");
  await page.getByRole("dialog").getByRole("button", { name: "決済して承認" }).click();
  await expect(page.getByRole("status").filter({ hasText: "申込を承認しました" })).toBeVisible();
  await audit(page, "approved");
  await page.goto("/host/bookings?booking=bk-2044");
  await detail(page, "Ana Souza").getByRole("button", { name: "お断りする" }).click();
  await audit(page, "decline dialog");
  await page.goto("/host/bookings?booking=bk-2038");
  await detail(page, "Emma Larsson").getByRole("button", { name: "取り消して返金する" }).click();
  await audit(page, "cancel dialog");
});

test.describe("320px narrow phone", () => {
  test.use({ viewport: { width: 320, height: 640 } });
  test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== "host-mobile-360"));

  test("the list, a booking and the dialogs fit", async ({ page }) => {
    const inside = async (locator: Locator, label: string) => {
      await locator.scrollIntoViewIfNeeded();
      await expect(locator, label).toBeInViewport();
      const box = await locator.boundingBox();
      expect(box && box.x >= 0 && box.x + box.width <= 320, label).toBe(true);
    };
    await signIn(page);
    for (const path of ["/host/bookings", "/host/bookings?filter=past", "/host/bookings?booking=bk-2044", "/host/bookings?booking=bk-2012", "/host/bookings?booking=bk-2031"]) {
      await page.goto(path);
      await expect(page.locator("main").getByRole("heading", { level: 2 }).first()).toBeVisible();
      expect(await overflowX(page), path).toBeLessThanOrEqual(0);
    }
    await page.goto("/host/bookings");
    await inside(page.getByRole("combobox", { name: "体験" }), "experience select");
    for (const label of ["これから", "承認待ち", "過去", "取消済み"]) await inside(chip(page, label), `chip ${label}`);

    await page.goto("/host/bookings?booking=bk-2044");
    const ana = detail(page, "Ana Souza");
    await inside(page.getByRole("link", { name: "予約へ戻る" }), "‹ 予約");
    await inside(ana.getByRole("button", { name: "承認する" }), "承認する");
    await inside(ana.getByRole("button", { name: "お断りする" }), "お断りする");
    await inside(ana.getByRole("link", { name: "メッセージを送る" }), "メッセージを送る");
    await ana.getByRole("button", { name: "お断りする" }).click();
    await inside(page.getByRole("dialog").getByRole("button", { name: "申込を断る" }), "申込を断る");
    expect(await overflowX(page), "decline dialog").toBeLessThanOrEqual(0);
    await page.keyboard.press("Escape");

    await page.goto("/host/bookings?booking=bk-2038");
    await detail(page, "Emma Larsson").getByRole("button", { name: "取り消して返金する" }).click();
    const ask = page.getByRole("dialog");
    for (const label of ["全額", "半額", "返金なし"]) await inside(ask.getByRole("radio", { name: new RegExp(`^${label}`) }), label);
    await ask.getByRole("radio", { name: "その他" }).check();
    await inside(ask.getByRole("button", { name: "¥60,000 を返金して取り消す" }), "取消の確定");
    await inside(ask.getByRole("button", { name: "やめる" }), "やめる");
    expect(await overflowX(page), "cancel dialog").toBeLessThanOrEqual(0);
    await page.keyboard.press("Escape");

    // 通訳 (#181): the QR, the host's own way in, 参加状況 and 終了 fit as well.
    const emma = detail(page, "Emma Larsson");
    await inside(emma.getByRole("button", { name: "通訳を始める" }), "通訳を始める");
    await emma.getByRole("button", { name: "通訳を始める" }).click();
    const room = emma.getByRole("region", { name: "対面通訳" });
    await inside(room.getByRole("img", { name: "ゲスト用の招待 QR コード" }), "guest QR");
    await inside(room.getByRole("button", { name: "自分の iPhone で開く" }), "自分の iPhone で開く");
    await inside(room.getByRole("button", { name: "通訳を終了" }), "通訳を終了");
    expect(await overflowX(page), "translate room").toBeLessThanOrEqual(0);
    await page.screenshot({ path: test.info().outputPath("translate-320.png"), fullPage: true });
    await room.getByRole("button", { name: "通訳を終了" }).click();
    await inside(page.getByRole("dialog").getByRole("button", { name: "通訳を終了する" }), "通訳を終了する");
    expect(await overflowX(page), "end dialog").toBeLessThanOrEqual(0);
  });
});

test("通訳を始める shows the guest's QR, the host's own way in, who has joined, and ends in a dialog (#181)", async ({ page }, testInfo) => {
  await signIn(page);
  // A request still waiting for approval (Lucas) and a Japanese guest (Aiko) have no 通訳.
  await page.goto("/host/bookings?booking=bk-2041");
  await expect(detail(page, "Lucas & Mia Chen").getByRole("button", { name: "承認する" })).toBeVisible();
  await expect(detail(page, "Lucas & Mia Chen").getByRole("button", { name: "通訳を始める" })).toHaveCount(0);
  await page.goto("/host/bookings?booking=bk-2006");
  await expect(detail(page, "Aiko Tanaka")).toBeVisible();
  await expect(detail(page, "Aiko Tanaka").getByRole("button", { name: "通訳を始める" })).toHaveCount(0);

  // Emma: confirmed, English, tomorrow.
  await page.goto("/host/bookings?booking=bk-2038");
  const booking = detail(page, "Emma Larsson");
  const start = booking.getByRole("button", { name: "通訳を始める" });
  await expect(start).toBeVisible();
  await expect(booking.getByRole("button", { name: "取り消して返金する" })).toBeVisible();
  await start.click();

  const room = booking.getByRole("region", { name: "対面通訳" });
  await expect(room).toBeVisible();
  await expect(room.getByRole("heading", { level: 3, name: "対面通訳" })).toBeFocused();
  await expect(room.getByRole("img", { name: "ゲスト用の招待 QR コード" })).toBeVisible();
  await expect(room).toContainText("相手に読み取ってもらってください");
  await expect(room).toContainText(/QR は \d{2}:\d{2} まで使えます/);
  // The invite code is only inside the QR's URL, never in the page's text.
  await expect(page.locator("main")).not.toContainText("/i/");
  await expect(page.locator("main")).not.toContainText("mock-guest-");
  await expect(start).toHaveCount(0);
  expect(await overflowX(page)).toBe(0);

  // ③ The synthetic host joins first, then the guest.
  const who = room.getByRole("definition");
  await expect(who).toHaveText(["未参加", "未参加"]);
  await expect(who.nth(0)).toHaveText("接続中", { timeout: 15_000 });
  await expect(room.getByText("通訳中")).toBeVisible();
  await expect(who.nth(1)).toHaveText("接続中", { timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath("translate-live.png"), fullPage: true });

  // ② Not on an iPhone here: 自分の iPhone で開く switches to the host's own QR.
  const own = room.getByRole("button", { name: "自分の iPhone で開く" });
  await own.click();
  await expect(room.getByRole("img", { name: "自分用の招待 QR コード" })).toBeVisible();
  await expect(room).toContainText("自分の iPhone で読み取ってください");
  await room.getByRole("button", { name: "ゲスト用 QR に戻す" }).click();
  await expect(room.getByRole("img", { name: "ゲスト用の招待 QR コード" })).toBeVisible();
  await audit(page, "translate room");

  // ④ 終了 asks first; やめる changes nothing.
  await room.getByRole("button", { name: "通訳を終了" }).click();
  const ask = page.getByRole("dialog", { name: "通訳を終了しますか？" });
  await expect(ask).toBeVisible();
  await expect(ask.getByRole("button", { name: "やめる" })).toBeFocused();
  await ask.getByRole("button", { name: "やめる" }).click();
  await expect(ask).toHaveCount(0);
  await expect(room).toBeVisible();
  await room.getByRole("button", { name: "通訳を終了" }).click();
  await ask.getByRole("button", { name: "通訳を終了する" }).click();
  await expect(ask).toHaveCount(0);
  await expect(booking.getByRole("status").filter({ hasText: "通訳を終了しました" })).toBeVisible();
  await expect(room).toHaveCount(0);
  await expect(start).toBeVisible();
  expect(await overflowX(page)).toBe(0);
});

test("通訳の参加状況で権限が失効したら招待 QR を消してポーリングを止める (#181)", async ({ page }) => {
  await signIn(page);
  await page.goto("/host/bookings?booking=bk-2038");
  const booking = detail(page, "Emma Larsson");
  let statusReads = 0;
  await page.route((url) => /^\/host\/api\/translate\/providers\/[^/]+\/bookings\/[^/]+\/rooms\/[^/]+$/.test(url.pathname), async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    statusReads += 1;
    await route.fulfill({ status: 403, contentType: "application/json", body: '{"error":"permission_ended"}' });
  });

  await booking.getByRole("button", { name: "通訳を始める" }).click();
  await expect(booking.getByRole("alert")).toContainText("権限を確認してください");
  await expect(booking.getByRole("region", { name: "対面通訳" })).toHaveCount(0);
  await expect(booking.getByRole("img", { name: /招待 QR コード/ })).toHaveCount(0);
  await expect(booking.getByRole("button", { name: "通訳を始める" })).toHaveCount(0);
  expect(statusReads).toBe(1);
  await page.waitForTimeout(3500); // The next 3-second poll must not happen after access was revoked.
  expect(statusReads).toBe(1);
});

// This site's bookings (#285, experience DB) as the preview's `?mock=site-bookings` sign-in shows them: the same
// screen as http mode, from synthetic bookings (src/host/mock/site-bookings.ts). Read only: nothing is sent (#84).
test.describe("this site's bookings (?mock=site-bookings)", () => {
  const id = (n: number) => `00000000-0000-4000-8000-00000000b10${n}`;
  const fees = (booking: Locator) => booking.getByRole("region", { name: "料金・精算状況" });
  const expectAmounts = async (booking: Locator, amounts: Record<string, string>) => {
    for (const [label, amount] of Object.entries(amounts)) await expect(value(fees(booking), label), label).toHaveText(amount);
  };
  /** What leaves the browser besides page loads (a server action is a POST). */
  const recordSent = (page: Page) => {
    const sent: string[] = [];
    page.on("request", (request) => {
      if (request.method() !== "GET") sent.push(`${request.method()} ${request.url()}`);
    });
    return sent;
  };

  test("料金・精算状況 shows what the guest paid, NIHO's fee and what the host receives, then what the refunds changed", async ({ page }) => {
    await signIn(page, "?mock=site-bookings");
    const sent = recordSent(page);
    await page.goto("/host/bookings");
    await expect(page.getByText("このサイトで受けた予約です")).toBeVisible();
    await expect(row(page, "Hannah Kim")).toContainText("2名 · ¥60,000 · 体験サイト");
    await expect(row(page, "Léa Dubois")).toContainText("確認待ち");
    await chip(page, "取消済み").click();
    for (const guest of ["Kenji Sato", "Maya Cohen", "Oscar Lind"]) await expect(row(page, guest)).toContainText("取消済み");

    // At booking: 10 % with NIHO support off, payment fees included; the fee is not repeated in 申込内容.
    await page.goto(`/host/bookings?booking=${id(1)}`);
    const hannah = detail(page, "Hannah Kim");
    await expect(fees(hannah)).toContainText("受付時 サポートOFF");
    await expect(fees(hannah)).toContainText("10%（決済費用込み）");
    await expectAmounts(hannah, { 予約者の支払い: "¥60,000", "NIHO の手数料": "¥6,000", 受取額: "¥54,000" });
    await expect(fees(hannah)).toContainText("通訳・お手伝いの人件費は含みません");
    const request = hannah.getByRole("region", { name: "申込内容" });
    await expect(value(request, "取消条件")).toHaveText("48時間前まで無料");
    await expect(request).not.toContainText("手数料");
    // NIHO's own panels know NIHO's bookings only; the preview cancels nothing.
    await expect(hannah).not.toContainText("料金・精算状況は現在確認できません");
    await expect(hannah.getByRole("button", { name: /取り消して/ })).toHaveCount(0);

    // Support on: 15 %, the store's floor of the total (an adult and a child).
    await page.goto(`/host/bookings?booking=${id(3)}`);
    const noah = detail(page, "Noah Park");
    await expect(fees(noah)).toContainText("受付時 サポートON");
    await expect(fees(noah)).toContainText("15%（決済費用込み）");
    await expectAmounts(noah, { 予約者の支払い: "¥42,000", "NIHO の手数料": "¥6,300", 受取額: "¥35,700" });

    // Refunded in full: the whole fee goes back, nothing is left to anyone.
    await page.goto(`/host/bookings?booking=${id(2)}`);
    await expectAmounts(detail(page, "Kenji Sato"), { "予約者への返金（完了）": "¥30,000", "NIHO の手数料の返還": "¥3,000", 返金後の受取額: "¥0" });
    // Half refunded by support: half the fee back, worked out (Stripe may differ by ¥1).
    await page.goto(`/host/bookings?booking=${id(4)}`);
    const maya = detail(page, "Maya Cohen");
    await expectAmounts(maya, { "予約者への返金（完了）": "¥15,000", "NIHO の手数料の返還（概算）": "¥1,500", 返金後の受取額: "¥13,500" });
    await expect(fees(maya)).toContainText("Stripe の計算と ¥1 ずれることがあります");
    await audit(page, "a refunded booking's 料金・精算状況");
    // On its way: shown apart, and nothing is counted back until Stripe finishes.
    await page.goto(`/host/bookings?booking=${id(6)}`);
    const oscar = detail(page, "Oscar Lind");
    await expectAmounts(oscar, { "予約者への返金（処理中）": "¥30,000" });
    await expect(fees(oscar)).toContainText("処理中の返金が終わると、手数料の返還と受取額が変わります。");
    await expect(value(fees(oscar), "返金後の受取額")).toHaveCount(0);
    expect(sent).toEqual([]);
  });

  test.describe("320px narrow phone", () => {
    test.use({ viewport: { width: 320, height: 640 } });
    test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== "host-mobile-360"));

    test("the list and 料金・精算状況 fit", async ({ page }) => {
      await signIn(page, "?mock=site-bookings");
      for (const path of ["/host/bookings", "/host/bookings?filter=cancelled", `/host/bookings?booking=${id(4)}`, `/host/bookings?booking=${id(3)}`]) {
        await page.goto(path);
        await expect(page.locator("main").getByRole("heading", { level: 2 }).first()).toBeVisible();
        expect(await overflowX(page), path).toBeLessThanOrEqual(0);
      }
      const box = await fees(detail(page, "Noah Park")).boundingBox();
      expect(box && box.x >= 0 && box.x + box.width <= 320).toBe(true);
    });
  });
});
