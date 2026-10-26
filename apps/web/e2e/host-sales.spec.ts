import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

// 売上 (#91) on synthetic data, and the payout account, the provider's review and the
// registration through NIHO's host API (#88/#91). Runs against the second server
// (HOST_CONSOLE_ENABLED=true, mock mode; see playwright.config.ts): the server actions call the
// host contract's mock. That mock keeps a change only within the request that made it
// (docs/api-contract.md §9.1), so no test sees another's changes and they can run in parallel;
// a change shows on screen as NIHO answered it, and the next page load starts from the synthetic
// data again.

const isDesktop = (projectName: string) => projectName === "host-desktop";
const menu = (page: Page) => page.getByRole("navigation", { name: "ホストのメニュー" });
const monthNav = (page: Page) => page.getByRole("navigation", { name: "表示する月" });
const summary = (page: Page, month: string) => page.getByRole("region", { name: `${month}の集計` });
const lines = (page: Page, month: string) => page.getByRole("region", { name: `${month}の明細` });
const providerPanel = (page: Page) => page.getByRole("region", { name: "提供者情報" });
const payoutPanel = (page: Page) => page.getByRole("region", { name: "売上受取口座" });
const overflowX = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
/** A number of the month: the value next to its label. */
const figure = (panel: Locator, label: string) => panel.locator("dl > div").filter({ has: panel.page().locator("dt", { hasText: new RegExp(`^${label}$`) }) }).locator("dd");
const DANGER = "rgb(168, 50, 30)";
const PREVIEW_STRIPE = "プレビューでは Stripe の画面を開かず、入力を終えたものとして口座の状態を読み直しました。";

async function signIn(page: Page, query = "") {
  await page.goto(`/host/auth/mock-login${query}`);
  await page.waitForURL(/\/host\/home(\?|$)/);
}

async function audit(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), label).toEqual([]);
}

test("売上 shows the month's numbers and lines, and moves a month at a time", async ({ page }, testInfo) => {
  await signIn(page);
  await menu(page).getByRole("link", { name: "売上" }).click();
  await page.waitForURL(/\/host\/sales$/);
  await expect(page.getByRole("heading", { level: 1, name: "売上" })).toBeVisible();
  await expect(monthNav(page)).toContainText("2026年10月");
  // The kitchen's payout account is ready: no note above the numbers.
  await expect(page.getByRole("heading", { name: "受取口座の設定が済んでいません" })).toHaveCount(0);

  const october = summary(page, "2026年10月");
  const numbers = [["売上", "¥390,000"], ["手数料", "−¥19,500"], ["返金", "−¥60,000"], ["入金予定", "¥139,500"], ["入金済み", "¥171,000"]];
  for (const [label, value] of numbers) await expect(figure(october, label!), label).toHaveText(value!);
  const stripe = october.getByRole("link", { name: /Stripe で入金の明細を見る/ });
  await expect(stripe).toHaveAttribute("href", "https://connect.stripe.com/express_login");
  await expect(stripe).toHaveAttribute("target", "_blank");

  const rows = lines(page, "2026年10月").getByRole("listitem");
  await expect(rows).toHaveCount(11);
  for (const text of ["10/20", "口座入金", "Stripe · 10月10日〜16日分", "¥54,000", "送金中"]) await expect(rows.nth(0)).toContainText(text);
  // The bookings 予約 lists have their payments here.
  for (const text of ["Kamakura Community Dinner · Sofia Rossi", "NIHO · Dinner 3名", "¥90,000", "計上済み"]) await expect(rows.filter({ hasText: "Sofia Rossi" })).toContainText(text);
  await expect(rows.filter({ hasText: "Mateo García" })).toContainText("体験サイト · tea time 2名");
  // Only a refund is red, with a minus. A payout (口座入金) is money the host receives: unsigned, in ink.
  const refund = rows.filter({ hasText: "返金 · Hannah Kim" });
  await expect(refund).toContainText("体験サイト · 取消");
  await expect(refund.getByText("−¥60,000")).toHaveCSS("color", DANGER);
  const payout = rows.filter({ hasText: "10月1日〜9日分" });
  await expect(payout).toContainText("入金済み");
  await expect(payout.getByText("¥171,000", { exact: true })).not.toHaveCSS("color", DANGER);
  await expect(payout).not.toContainText("−");
  await expect(rows.filter({ hasText: "Sofia Rossi" }).getByText("¥90,000")).not.toHaveCSS("color", DANGER);
  // PC: the state is a pill on the right. Phones: it follows 補足.
  const pending = rows.nth(0);
  const pill = pending.getByText("送金中", { exact: true });
  const inline = pending.getByText("· 送金中", { exact: true });
  if (isDesktop(testInfo.project.name)) {
    await expect(pill).toBeVisible();
    await expect(inline).toBeHidden();
  } else {
    await expect(inline).toBeVisible();
    await expect(pill).toBeHidden();
  }

  await monthNav(page).getByRole("link", { name: "前の月" }).click();
  await expect(page).toHaveURL(/\/host\/sales\?month=2026-09$/);
  await expect(monthNav(page)).toContainText("2026年9月");
  await expect(figure(summary(page, "2026年9月"), "売上")).toHaveText("¥225,000");
  await expect(figure(summary(page, "2026年9月"), "入金予定")).toHaveText("¥0");
  await expect(lines(page, "2026年9月").getByRole("listitem")).toHaveCount(6);
  // The first month of the period: no way further back.
  await expect(monthNav(page).getByRole("link", { name: "前の月" })).toHaveCount(0);

  await monthNav(page).getByRole("link", { name: "次の月" }).click();
  await expect(page).toHaveURL(/\?month=2026-10$/);
  await monthNav(page).getByRole("link", { name: "次の月" }).click();
  await expect(page).toHaveURL(/\?month=2026-11$/);
  await expect(monthNav(page)).toContainText("2026年11月");
  await expect(lines(page, "2026年11月")).toContainText("この月の売上はまだありません");
  for (const label of ["売上", "手数料", "返金", "入金予定", "入金済み"]) await expect(figure(summary(page, "2026年11月"), label), label).toHaveText("¥0");
  await expect(monthNav(page).getByRole("link", { name: "次の月" })).toHaveCount(0);

  // A month outside the period opens the current one.
  await page.goto("/host/sales?month=2027-01");
  await expect(monthNav(page)).toContainText("2026年10月");
});

test("ホーム's month card has 入金予定, as 売上 counts it", async ({ page }) => {
  await signIn(page);
  const month = page.getByRole("region", { name: "10月" });
  await expect(month.locator("dt")).toHaveText(["売上", "返金", "入金予定", "確定した予約"]);
  await expect(month.locator("dd")).toHaveText(["¥390,000", "−¥60,000", "¥139,500", "8件"]);
});

test("an editor cannot open sales or the payout account", async ({ page }) => {
  await signIn(page, "?providerId=sample-provider-studio");
  await expect(menu(page).getByRole("link", { name: "売上" })).toHaveCount(0);
  expect((await page.goto("/host/sales?providerId=sample-provider-studio"))?.status()).toBe(404);

  await page.goto("/host/home?providerId=sample-provider-studio");
  await menu(page).getByRole("link", { name: "設定" }).click();
  await page.waitForURL("**/host/settings?providerId=sample-provider-studio");
  const provider = providerPanel(page);
  await expect(provider).toContainText("未申請");
  await expect(provider.getByRole("textbox", { name: "特商法表示 URL" })).toBeDisabled();
  await expect(provider).toContainText("特商法表示 URL はオーナーが変えられます。");
  await expect(provider.getByRole("button", { name: "審査を申請" })).toHaveCount(0);
  await expect(provider).toContainText("審査の申請はオーナーが行います。");
  await expect(payoutPanel(page)).toHaveCount(0);
});

test("a new provider: registered through NIHO, led from 売上 to its payout account, shares a spot's account and asks for the review", async ({ page }) => {
  await signIn(page, "?mock=empty");
  await page.getByRole("link", { name: "提供者として登録" }).click();
  await page.waitForURL(/\/host\/register$/);
  await page.getByRole("radio", { name: "店舗・事業者" }).check();
  await page.getByRole("textbox", { name: "掲載名" }).fill("合成スタジオ");
  await page.getByRole("checkbox", { name: /提供者規約に同意します/ }).check();
  // NIHO (the contract mock) refuses a seller page with a user name in it: the form says so and keeps what was typed.
  const sellerUrl = page.getByRole("textbox", { name: "特商法表示 URL" });
  await sellerUrl.fill("https://user:secret@example.com/legal");
  await page.getByRole("button", { name: "登録する" }).click();
  await expect(page.locator("main").getByRole("alert")).toHaveText("入力を確かめてください。");
  await expect(page).toHaveURL(/\/host\/register$/);
  await expect(page.getByRole("textbox", { name: "掲載名" })).toHaveValue("合成スタジオ");

  await sellerUrl.fill("https://example.com/legal");
  await page.getByRole("button", { name: "登録する" }).click();
  // The preview forgets the new provider after the request: the synthetic host comes back with
  // a provider in the state a new one starts in (未申請, no payout account).
  await page.waitForURL(/\/host\/home$/);
  await expect(page.getByRole("heading", { level: 1, name: "ホーム" })).toBeVisible();
  await expect(menu(page)).toHaveCount(1);

  await menu(page).getByRole("link", { name: "設定" }).click();
  await page.waitForURL(/\/host\/settings$/);
  const provider = providerPanel(page);
  const payout = payoutPanel(page);
  await expect(provider).toContainText("未申請");
  await expect(payout).toContainText("未接続");
  await expect(payout).toContainText("売上を受け取る口座を接続してください。");
  const submit = provider.getByRole("button", { name: "審査を申請" });
  await expect(submit).toBeDisabled();
  await expect(provider).toContainText("売上受取口座の準備ができると申請できます。");

  await menu(page).getByRole("link", { name: "売上" }).click();
  await page.waitForURL(/\/host\/sales$/);
  const notice = page.getByRole("region", { name: "受取口座の設定が済んでいません" });
  await expect(notice).toContainText("売上を受け取る口座を接続してください。");
  await expect(lines(page, "2026年10月")).toContainText("この月の売上はまだありません");
  await notice.getByRole("link", { name: "口座を設定" }).click();
  await page.waitForURL(/\/host\/settings#settings-payout$/);
  await expect(payout).toBeInViewport();

  const share = payout.getByRole("button", { name: "共有する" });
  await payout.getByRole("combobox", { name: "既存の口座を使う" }).selectOption({ label: "サンプルの拠点" });
  await expect(share).toBeDisabled();
  await payout.getByRole("checkbox", { name: /拠点の販売者口座を、体験の売上の受取に使うことに同意します/ }).check();
  await share.click();
  await expect(payout.getByRole("status")).toHaveText("サンプルの拠点の口座を共有しました。");
  await expect(payout).toContainText("準備済み");
  await expect(payout).toContainText("サンプルの拠点の口座を共有中");
  await expect(payout.getByRole("link", { name: /Stripe で確認/ })).toBeVisible();

  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(provider.getByRole("status")).toHaveText("審査を申請しました。");
  await expect(provider).toContainText("審査待ち");
  await expect(provider).toContainText("NIHO が確認しています。");
});

test("提供者情報: 保存 sends the change to NIHO, asking first for a reviewed provider", async ({ page }) => {
  await signIn(page);
  await page.goto("/host/settings");
  const provider = providerPanel(page);
  const bio = provider.getByRole("textbox", { name: "紹介" });
  const save = page.getByRole("button", { name: "保存", exact: true });
  await expect(provider).toContainText("審査済み");
  await expect(provider.getByRole("radio", { name: "個人" })).toBeChecked();
  await expect(provider.getByRole("radio", { name: "個人" })).toBeDisabled();
  // 販売者表示: the provider's own site; NIHO's page for providers without one is not ready yet.
  await expect(provider.getByRole("radio", { name: "自分のサイトに表示する" })).toBeChecked();
  await expect(provider.getByRole("radio", { name: /NIHO のページに表示する（自前サイトがない事業者）/ })).toBeDisabled();
  await expect(provider.getByRole("group", { name: "販売者表示" })).toContainText("準備中");

  await bio.fill("  合成の新しい紹介  ");
  await save.click();
  const dialog = page.getByRole("dialog", { name: "提供者情報を保存しますか？" });
  await expect(dialog).toContainText("掲載中の体験は止まります");
  await expect(dialog.getByRole("button", { name: "やめる" })).toBeFocused();
  await dialog.getByRole("button", { name: "やめる" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(provider).toContainText("審査済み");
  await expect(page.getByRole("status").filter({ hasText: "保存しました" })).toHaveCount(0);

  await save.click();
  await dialog.getByRole("button", { name: "保存して再審査を受ける" }).click();
  await expect(page.getByRole("status").filter({ hasText: "保存しました" })).toBeVisible();
  // What NIHO kept: the words without the spaces around them, and the provider back in review.
  await expect(bio).toHaveValue("合成の新しい紹介");
  await expect(provider).toContainText("審査待ち");
  await expect(provider).toContainText("NIHO が確認しています。");

  // The preview does not keep it (the contract mock keeps a change for one request only): a
  // reload shows the synthetic provider again. In http mode NIHO keeps it.
  await page.reload();
  await expect(providerPanel(page)).toContainText("審査済み");
  await expect(providerPanel(page).getByRole("textbox", { name: "紹介" })).toHaveValue("家庭料理を一緒に作る体験の、合成データの提供者です（sample）。");
});

test("the payout account: Stripe's page in the preview, and the way back from Stripe", async ({ page }) => {
  await signIn(page, "?mock=payments-pending");
  await page.goto("/host/settings");
  const payout = payoutPanel(page);
  await payout.getByRole("button", { name: "Stripe で口座を接続" }).click();
  await expect(payout.getByRole("status")).toHaveText(PREVIEW_STRIPE);
  await expect(payout).toContainText("準備済み");
  await expect(payout).toContainText("サンプルの庭の口座");

  // Back from Stripe without an account (?connect=return): NIHO says there is none yet.
  await page.goto("/host/settings?connect=return");
  await expect(payoutPanel(page).getByRole("alert")).toHaveText("口座がまだ接続されていません。「Stripe で口座を接続」から進めてください。");
  // The query is gone, so a reload does not ask again.
  await expect(page).toHaveURL(/\/host\/settings$/);

  // The kitchen's account is connected: back from Stripe reads it again. /host passes the way back on to 設定.
  await signIn(page);
  await page.goto("/host?providerId=sample-provider-kitchen&connect=return");
  await page.waitForURL("**/host/settings?providerId=sample-provider-kitchen");
  await expect(payoutPanel(page).getByRole("status")).toHaveText("口座の状態を Stripe から読み直しました。");
  await expect(payoutPanel(page)).toContainText("準備済み");
  await expect(payoutPanel(page)).toBeInViewport();
});

test("sales, payout and registration screens have no WCAG 2.2 AA violations", async ({ page }) => {
  await signIn(page);
  await page.goto("/host/sales");
  await expect(page.getByRole("heading", { level: 1, name: "売上" })).toBeVisible();
  await audit(page, "/host/sales");
  await page.goto("/host/sales?month=2026-11");
  await audit(page, "/host/sales (empty month)");
  await page.goto("/host/settings");
  await providerPanel(page).getByRole("textbox", { name: "紹介" }).fill("合成の紹介");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await audit(page, "/host/settings (confirm)");

  await signIn(page, "?mock=payments-pending");
  await page.goto("/host/sales");
  await expect(page.getByRole("heading", { name: "受取口座の設定が済んでいません" })).toBeVisible();
  await audit(page, "/host/sales (payout not ready)");
  await page.goto("/host/settings");
  await expect(payoutPanel(page).getByRole("combobox", { name: "既存の口座を使う" })).toBeVisible();
  await audit(page, "/host/settings (payout not connected)");
  await page.goto("/host/settings?connect=return");
  await expect(payoutPanel(page).getByRole("alert")).toBeVisible();
  await audit(page, "/host/settings (payout error)");

  await signIn(page, "?mock=empty");
  await page.goto("/host/register");
  await page.getByRole("textbox", { name: "掲載名" }).fill("合成スタジオ");
  await page.getByRole("textbox", { name: "特商法表示 URL" }).fill("https://user:secret@example.com/legal");
  await page.getByRole("checkbox", { name: /提供者規約に同意します/ }).check();
  await page.getByRole("button", { name: "登録する" }).click();
  await expect(page.locator("main").getByRole("alert")).toBeVisible();
  await audit(page, "/host/register (refused)");
});

test.describe("320px narrow phone", () => {
  test.use({ viewport: { width: 320, height: 640 } });
  test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== "host-mobile-360"));

  test("sales and the payout account fit and keep their actions", async ({ page }) => {
    const inside = async (locator: Locator, label: string) => {
      await locator.scrollIntoViewIfNeeded();
      await expect(locator, label).toBeInViewport();
      const box = await locator.boundingBox();
      expect(box && box.x >= 0 && box.x + box.width <= 320, label).toBe(true);
    };
    await signIn(page);
    await page.goto("/host/sales");
    expect(await overflowX(page), "sales").toBeLessThanOrEqual(0);
    await inside(monthNav(page).getByRole("link", { name: "前の月" }), "sales: 前の月");
    await inside(monthNav(page).getByRole("link", { name: "次の月" }), "sales: 次の月");
    await inside(summary(page, "2026年10月").getByRole("link", { name: /Stripe で入金の明細を見る/ }), "sales: Stripe");
    await inside(lines(page, "2026年10月").getByText("¥171,000", { exact: true }), "sales: an amount");

    await signIn(page, "?mock=payments-pending");
    await page.goto("/host/sales");
    expect(await overflowX(page), "sales with the note").toBeLessThanOrEqual(0);
    await inside(page.getByRole("link", { name: "口座を設定" }), "sales: 口座を設定");
    await page.goto("/host/settings");
    expect(await overflowX(page), "settings").toBeLessThanOrEqual(0);
    const payout = payoutPanel(page);
    await inside(payout.getByRole("button", { name: "Stripe で口座を接続" }), "settings: Stripe で口座を接続");
    await inside(payout.getByRole("combobox", { name: "既存の口座を使う" }), "settings: 既存の口座");
    await inside(payout.getByRole("button", { name: "共有する" }), "settings: 共有する");
    await inside(providerPanel(page).getByRole("button", { name: "審査を申請" }), "settings: 審査を申請");
    // Inputs stay 16px on phones (iOS does not zoom in).
    expect(await payout.getByRole("combobox", { name: "既存の口座を使う" }).evaluate((select) => getComputedStyle(select).fontSize)).toBe("16px");
    expect(await providerPanel(page).getByRole("textbox", { name: "特商法表示 URL" }).evaluate((input) => getComputedStyle(input).fontSize)).toBe("16px");
  });
});
