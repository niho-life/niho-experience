import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

// The console screens (#84 / #88) on synthetic data. Runs against the second server
// (HOST_CONSOLE_ENABLED=true, mock mode; see playwright.config.ts): the mock sign-in
// makes a session for the synthetic NIHO, and nothing here talks to NIHO.

const CONSOLE_PAGES = ["/host/home", "/host/experiences", "/host/experiences/community-dinner", "/host/calendar", "/host/bookings", "/host/messages", "/host/reviews", "/host/sales", "/host/settings", "/host/register"];
const PREVIEW_NOTE = "プレビュー（合成データ）· 体験・予約・売上・口座は架空で、保存されません";

/** The sidebar (PC) and the bottom tabs (phones) share one name; only the one for the width is exposed. */
const menu = (page: Page) => page.getByRole("navigation", { name: "ホストのメニュー" });
const isDesktop = (projectName: string) => projectName === "host-desktop";
const overflowX = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function signIn(page: Page, query = "") {
  await page.goto(`/host/auth/mock-login${query}`);
  await page.waitForURL(/\/host\/home(\?|$)/);
}

test("ホーム shows what to do next, the sessions coming up and the month", async ({ page }, testInfo) => {
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "ホーム" })).toBeVisible();

  const todo = page.getByRole("region", { name: "次にすること" });
  const todos = todo.getByRole("listitem");
  // Each request, the threads waiting for an answer, the reviews, then a draft and a listing under review
  // (host-messages.spec.ts follows the first ones, host-reviews.spec.ts the reviews).
  await expect(todos).toHaveCount(10);
  await expect(todos.nth(0)).toContainText("承認待ち");
  await expect(todos.nth(5)).toContainText("未返信");
  await expect(todos.nth(8)).toContainText("下書き");
  await expect(todos.nth(9)).toContainText("審査待ち");
  await expect(todo.getByRole("link", { name: "編集する" })).toHaveAttribute("href", "/host/experiences/coffee");
  // Listings under review wait for NIHO: no button.
  await expect(todos.nth(9).getByRole("link")).toHaveCount(0);
  await expect(todo.getByRole("link", { name: "メッセージを見る" })).toHaveAttribute("href", "/host/messages");

  // Today's tea time, over with its attendance still to record; tomorrow's dinner; then the sessions after tomorrow.
  // 参加者を見る opens each session's own screen (この回, host-session.spec.ts).
  const today = page.getByRole("region", { name: "今日の開催" });
  await expect(today.getByRole("listitem")).toHaveCount(1);
  for (const text of ["10月21日（水）", "終了 · 出欠が未記録", "13:00 開始 · 2時間", "ナッツなし 1 名", "4 / 8名 · 2件"]) await expect(today).toContainText(text);
  await expect(today.getByRole("link", { name: "参加者を見る" })).toHaveAttribute("href", "/host/bookings/session?date=2026-10-21&start=13%3A00&experience=community-dinner&offer=offer-tea");
  const tomorrow = page.getByRole("region", { name: "明日の開催" });
  await expect(tomorrow.getByRole("listitem")).toHaveCount(1);
  for (const text of ["10月22日（木）", "Kamakura Community Dinner with Locals", "18:00 開始 · 2時間", "ベジタリアン 1 名", "4 / 8名 · 2件"]) await expect(tomorrow).toContainText(text);
  await expect(tomorrow.getByRole("link", { name: "参加者を見る" })).toHaveAttribute("href", "/host/bookings/session?date=2026-10-22&start=18%3A00&experience=community-dinner&offer=offer-dinner");
  const upcoming = page.getByRole("region", { name: "これからの開催" });
  await expect(upcoming.getByRole("listitem")).toHaveCount(3);
  const saturday = upcoming.getByRole("link", { name: /^10月24日（土）.*Kamakura Community Dinner with Locals.*18:00 開始 · 2時間.*1 \/ 8名.*1件/ });
  await expect(saturday).toHaveAttribute("href", "/host/bookings/session?date=2026-10-24&start=18%3A00&experience=community-dinner&offer=offer-dinner");
  await expect(upcoming).not.toContainText("10月22日");
  await expect(upcoming.getByRole("link", { name: "予約を見る" })).toHaveAttribute("href", "/host/bookings");

  const month = page.getByRole("region", { name: "10月" });
  for (const value of ["¥390,000", "−¥60,000", "¥139,500", "8件"]) await expect(month).toContainText(value);
  await expect(month.getByRole("link", { name: "売上を見る" })).toHaveAttribute("href", "/host/sales");

  // PC: これからの開催 and the month side by side (1.6 : 1). Phones: one column.
  const upcomingBox = (await upcoming.boundingBox())!;
  const monthBox = (await month.boundingBox())!;
  if (isDesktop(testInfo.project.name)) {
    expect(monthBox.y).toBeCloseTo(upcomingBox.y, 0);
    expect(upcomingBox.width / monthBox.width).toBeCloseTo(1.6, 1);
  } else {
    expect(monthBox.y).toBeGreaterThan(upcomingBox.y + upcomingBox.height);
  }
  await expect(page.getByRole("note")).toHaveText(PREVIEW_NOTE);
});

test("console links carry ?providerId=, and each provider has its own data", async ({ page }) => {
  await signIn(page, "?providerId=sample-provider-studio");
  const todo = page.getByRole("region", { name: "次にすること" });
  await expect(todo.getByRole("listitem")).toHaveCount(1);
  await expect(todo.getByRole("link", { name: "編集する" })).toHaveAttribute("href", "/host/experiences/calligraphy?providerId=sample-provider-studio");
  await expect(todo.getByRole("link", { name: "メッセージを見る" })).toHaveAttribute("href", "/host/messages?providerId=sample-provider-studio");
  await expect(page.getByRole("region", { name: "明日の開催" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "これからの開催" })).toContainText("これからの開催はまだありません。");
  for (const [label, path] of [["ホーム", "/host/home"], ["体験", "/host/experiences"], ["カレンダー", "/host/calendar"], ["設定", "/host/settings"]]) {
    await expect(menu(page).getByRole("link", { name: label }), label).toHaveAttribute("href", `${path}?providerId=sample-provider-studio`);
  }
  await expect(menu(page).getByRole("link", { name: "予約" })).toHaveCount(0);
  await expect(menu(page).getByRole("link", { name: "売上" })).toHaveCount(0);
  await menu(page).getByRole("link", { name: "設定" }).click();
  await page.waitForURL("**/host/settings?providerId=sample-provider-studio");
  const provider = page.getByRole("region", { name: "提供者情報" });
  await expect(provider.getByRole("textbox", { name: "掲載名" })).toHaveValue("サンプル工房");
  await expect(provider.getByRole("radio", { name: "店舗・事業者" })).toBeChecked();
  await expect(provider).toContainText("未申請");
  // The payout account is the owner's to read; the studio's host is an editor.
  await expect(page.getByRole("region", { name: "売上受取口座" })).toHaveCount(0);
});

test("the menu is a sidebar on PC and six bottom tabs on phones", async ({ page }, testInfo) => {
  await signIn(page);
  const nav = menu(page);
  await expect(nav).toHaveCount(1);
  await expect(nav.getByRole("link")).toHaveText(isDesktop(testInfo.project.name)
    ? ["ホーム", "体験", "カレンダー", "予約", "売上", "設定"]
    : ["ホーム", "体験", "予定", "予約", "売上", "設定"]);
  await expect(nav.getByRole("link", { name: "ホーム" })).toHaveAttribute("aria-current", "page");
  const viewport = page.viewportSize()!;
  const navBox = (await nav.boundingBox())!;
  const banner = page.getByRole("banner");
  const bannerBox = (await banner.boundingBox())!;

  if (isDesktop(testInfo.project.name)) {
    // A 232px column the height of the window, with the ways out and the account at its foot.
    expect(bannerBox).toEqual({ x: 0, y: 0, width: 232, height: viewport.height });
    expect(navBox.x + navBox.width).toBeLessThanOrEqual(232);
    await expect(banner.getByRole("link", { name: "NIHO Experience" })).toHaveAttribute("href", "/host/home");
    await expect(banner.getByRole("link", { name: "体験サイトを見る" })).toHaveAttribute("href", "/experiences");
    await expect(banner.getByRole("link", { name: "NIHO アプリ" })).toHaveAttribute("href", "https://niho.life");
    // Articles are written on editor.niho.life (#254).
    await expect(banner.getByRole("link", { name: "記事を書く" })).toHaveAttribute("href", "https://editor.example");
    await expect(banner).toContainText("サンプル ホスト");
    await expect(banner.getByRole("button", { name: "ログアウト" })).toBeVisible();
    // The page sits beside the sidebar, at most 1040px wide.
    const title = (await page.getByRole("heading", { level: 1 }).boundingBox())!;
    expect(title.x).toBeGreaterThanOrEqual(232);
    expect((await page.locator("main > div").first().boundingBox())!.width).toBeLessThanOrEqual(1040);
  } else {
    // A 52px row (and its hairline) with the brand and the account, and the tabs on the bottom edge (12px labels).
    expect(bannerBox).toMatchObject({ x: 0, y: 0, width: viewport.width, height: 53 });
    expect(Math.round(navBox.y + navBox.height)).toBe(viewport.height);
    for (const label of ["ホーム", "体験", "カレンダー", "予約", "売上", "設定"]) {
      expect(await nav.getByRole("link", { name: label }).evaluate((link) => getComputedStyle(link).fontSize), label).toBe("12px");
    }
    await nav.getByRole("link", { name: "売上" }).click();
    await page.waitForURL(/\/host\/sales$/);
    await expect(page.getByRole("heading", { level: 1, name: "売上" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "売上" })).toHaveAttribute("aria-current", "page");
    // The account menu carries the same ways out, editor.niho.life among them (#254).
    await page.locator("summary", { hasText: "のアカウント" }).click();
    await expect(page.getByRole("link", { name: "記事を書く" })).toHaveAttribute("href", "https://editor.example");
  }
});

test("体験: the list, one experience, and back", async ({ page }, testInfo) => {
  await signIn(page);
  await menu(page).getByRole("link", { name: "体験" }).click();
  await page.waitForURL(/\/host\/experiences$/);
  await expect(page.getByRole("heading", { level: 1, name: "体験" })).toBeVisible();
  await expect(menu(page).getByRole("link", { name: "体験" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "新しい体験" })).toBeVisible();

  // Each row opens its editor (its title's link covers the row); the dinner's reviews have a link of their own (host-reviews.spec.ts).
  const rows = page.getByRole("region", { name: "体験の一覧" }).getByRole("listitem");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Kamakura Community Dinner with Locals");
  await expect(rows.nth(0)).toContainText("火・木・土 18:00 · 2時間 · 定員8 · ¥30,000〜");
  await expect(rows.nth(0)).toContainText("掲載中");
  await expect(rows.nth(1)).toContainText("Mend a Broken Bowl with a Kamakura Restorer");
  await expect(rows.nth(1)).toContainText("審査待ち");
  await expect(rows.nth(2)).toContainText("表紙写真・料金が未入力");
  await expect(rows.nth(2)).toContainText("下書き");
  // The cover photo is 96×72 on PC and 64×48 on phones; without one, a plain thumbnail.
  const thumb = (await rows.nth(0).locator("img").boundingBox())!;
  expect([thumb.width, thumb.height]).toEqual(isDesktop(testInfo.project.name) ? [96, 72] : [64, 48]);
  await expect(rows.nth(1).locator("img")).toHaveCount(0);

  await rows.nth(2).click();
  await page.waitForURL(/\/host\/experiences\/coffee$/);
  await expect(page.getByRole("heading", { level: 1, name: "Roast Your Own Coffee in a Kamakura Living Room" })).toBeVisible();
  await expect(page.locator("main").getByText("下書き", { exact: true })).toBeVisible();
  if (isDesktop(testInfo.project.name)) {
    await expect(menu(page).getByRole("link", { name: "体験" })).toHaveAttribute("aria-current", "page");
  } else {
    // Phones: a "‹ 体験" header instead of the brand header, and no bottom tabs.
    await expect(menu(page)).toHaveCount(0);
    await expect(page.getByRole("banner")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "体験へ戻る" })).toHaveText("体験");
  }
  await page.getByRole("link", { name: "体験へ戻る" }).click();
  await page.waitForURL(/\/host\/experiences$/);
  await expect(page.getByRole("heading", { level: 1, name: "体験" })).toBeVisible();

  const missing = await page.goto("/host/experiences/no-such-experience");
  expect(missing?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "ページが見つかりません" })).toBeVisible();
});

test("設定 has nine panels, and 保存 checks the fields and keeps what NIHO has no API for on screen", async ({ page }, testInfo) => {
  await signIn(page);
  await menu(page).getByRole("link", { name: "設定" }).click();
  await page.waitForURL(/\/host\/settings$/);
  await expect(page.getByRole("heading", { level: 1, name: "設定" })).toBeVisible();
  await expect(page.locator("main").getByRole("heading", { level: 2 })).toHaveText(["提供者情報", "売上受取口座", "カレンダー", "既定の集合案内", "通知", "運営チーム", "NIHOサポート", "この端末", "アカウント"]);

  const provider = page.getByRole("region", { name: "提供者情報" });
  await expect(provider).toContainText("審査済み");
  await expect(provider.getByRole("textbox", { name: "掲載名" })).toHaveValue("サンプルの台所");
  await expect(provider.getByRole("radio", { name: "個人" })).toBeChecked();
  // The provider's own values come from the host contract's mock (@niho-experience/api-client/host/mock).
  await expect(provider.getByRole("textbox", { name: "紹介" })).toHaveValue("家庭料理を一緒に作る体験の、合成データの提供者です（sample）。");
  await expect(provider.getByRole("textbox", { name: "特商法表示 URL" })).toHaveValue("https://example.com/sample-kitchen/legal");
  const payout = page.getByRole("region", { name: "売上受取口座" });
  await expect(payout).toContainText("準備済み");
  await expect(payout).toContainText("サンプルの台所の口座");
  await expect(payout.getByRole("link", { name: /Stripe で確認/ })).toBeVisible();
  // カレンダー and 通知 (#109): host-settings.spec.ts.
  await expect(page.getByRole("region", { name: "カレンダー" })).toContainText("接続中");
  await expect(page.getByRole("region", { name: "通知" })).toContainText("kitchen@example.com");
  const meeting = page.getByRole("region", { name: "既定の集合案内" });
  await expect(meeting.getByRole("textbox", { name: "公開する大まかな場所" })).toHaveValue("Near Kamakura Station, 5-minute walk");
  const mapUrl = meeting.getByRole("textbox", { name: "地図 URL" });
  await expect(mapUrl).toHaveValue("https://maps.example.com/sample-kitchen");
  await expect(meeting.getByRole("textbox", { name: "住所" })).not.toHaveValue("");
  await expect(meeting.getByRole("textbox", { name: "入口・当日の案内" })).not.toHaveValue("");
  await expect(meeting).toContainText("予約が確定した方にだけ届きます");
  const account = page.getByRole("region", { name: "アカウント" });
  await expect(account).toContainText("サンプル ホスト");
  await expect(account.getByRole("link", { name: "NIHO アプリ" })).toHaveAttribute("href", "https://niho.life");
  await expect(account.getByRole("button", { name: "ログアウト" })).toBeVisible();

  const sent: string[] = [];
  page.on("request", (request) => sent.push(`${request.method()} ${request.url()} ${request.postData() ?? ""}`));
  const save = page.getByRole("button", { name: "保存", exact: true });
  const saved = page.getByRole("status").filter({ hasText: "保存しました" });
  // The kind comes from the registration: shown, not changed here.
  await expect(provider.getByRole("radio", { name: "店舗・事業者" })).toBeDisabled();
  // The meeting fields sit outside the <form> (カレンダー's dialogs are forms of their own) and still join its checks.
  await mapUrl.fill("not-a-url");
  await save.click();
  await expect(saved).toHaveCount(0);
  await mapUrl.fill("https://maps.example.com/kitchen-desk");
  await save.click();
  await expect(saved).toBeVisible();
  await expect(page).toHaveURL(/\/host\/settings$/);
  // The preview keeps 集合案内 on screen: nothing is sent (提供者情報 is, see host-sales.spec.ts).
  expect(sent.filter((line) => line.includes("kitchen-desk") || !line.startsWith("GET "))).toEqual([]);

  // PC: a leaf pill floating at the bottom right. Phones: a full-width 48px band above the tabs.
  const viewport = page.viewportSize()!;
  const saveBox = (await save.boundingBox())!;
  if (isDesktop(testInfo.project.name)) {
    expect(saveBox.height).toBe(44);
    expect(saveBox.x + saveBox.width).toBeGreaterThan(viewport.width - 80);
  } else {
    expect(saveBox.height).toBe(48);
    expect(saveBox.width).toBe(viewport.width - 32);
    const tabs = (await menu(page).boundingBox())!;
    expect(saveBox.y + saveBox.height).toBeLessThanOrEqual(tabs.y);
  }
  await page.mouse.wheel(0, -10_000);
  await expect(save).toBeInViewport();
});

test("an account without a provider is led to registration, and registering opens the console", async ({ page }) => {
  await signIn(page, "?mock=empty");
  await expect(page.getByRole("heading", { level: 1, name: "ホーム" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "体験を掲載する場合は提供者登録へ" })).toBeVisible();
  await expect(menu(page)).toHaveCount(0);
  await page.goto("/host/settings");
  await expect(page.getByRole("heading", { name: "体験を掲載する場合は提供者登録へ" })).toBeVisible();

  await page.getByRole("link", { name: "提供者として登録" }).click();
  await page.waitForURL(/\/host\/register$/);
  await expect(page.getByRole("heading", { level: 1, name: "提供者の登録" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "個人" })).toBeChecked();
  await page.getByRole("radio", { name: "店舗・事業者" }).check();
  await page.getByRole("textbox", { name: "掲載名" }).fill("合成スタジオ");
  await page.getByRole("textbox", { name: "紹介" }).fill("合成の紹介文");
  await page.getByRole("button", { name: "登録する" }).click();
  // The consent is required before anything happens.
  await expect(page).toHaveURL(/\/host\/register$/);

  const sent: string[] = [];
  page.on("request", (request) => sent.push(decodeURIComponent(request.url())));
  await page.getByRole("checkbox", { name: /提供者規約に同意します/ }).check();
  await page.getByRole("button", { name: "登録する" }).click();
  // Registered through NIHO's provider API (the contract mock); the preview then opens a provider in the state a new one starts in.
  await page.waitForURL(/\/host\/home$/);
  await expect(page.getByRole("heading", { name: "次にすること" })).toBeVisible();
  await expect(menu(page)).toHaveCount(1);
  // What was typed goes to NIHO in a request body, never in a URL.
  expect(sent.filter((url) => url.includes("合成スタジオ") || url.includes("合成の紹介文"))).toEqual([]);
});

test("console screens have no WCAG 2.2 AA violations", async ({ page }) => {
  const audit = async (label: string) => {
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), label).toEqual([]);
  };
  await signIn(page);
  for (const path of CONSOLE_PAGES) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await audit(path);
  }
  await page.goto("/host/settings");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "保存しました" })).toBeVisible();
  await audit("/host/settings (saved)");
  // The provider switch (PC) or the account menu (phones), open.
  await page.locator("summary:visible").first().click();
  await audit("menu open");
  await signIn(page, "?mock=empty");
  await audit("/host/home (no provider)");
});

test("console screens carry no analytics and stay private", async ({ page }) => {
  await signIn(page);
  for (const path of CONSOLE_PAGES) {
    // A page load, not page.request: the session cookie is Secure, which only the browser sends to http://127.0.0.1.
    const response = (await page.goto(path))!;
    expect(new URL(response.url()).pathname, path).toBe(path);
    expect(response.status(), path).toBe(200);
    expect(response.headers()["cache-control"], path).toContain("no-store");
    expect(response.headers()["x-robots-tag"], path).toContain("noindex");
    const html = await response.text();
    expect(html, path).toContain('<html lang="ja"');
    expect(html.toLowerCase(), path).not.toContain("umami");
    expect(html, path).not.toContain("__nihoEvents");
  }
  await page.goto("/host/settings");
  await expect(page.locator('script[src*="umami"]')).toHaveCount(0);
  expect(await page.evaluate(() => "__nihoEvents" in window)).toBe(false);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});

test.describe("320px narrow phone", () => {
  test.use({ viewport: { width: 320, height: 640 } });
  test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== "host-mobile-360"));

  test("every console screen fits and keeps its main actions", async ({ page }) => {
    const inside = async (locator: Locator, label: string) => {
      await locator.scrollIntoViewIfNeeded();
      await expect(locator, label).toBeInViewport();
      const box = await locator.boundingBox();
      expect(box && box.x >= 0 && box.x + box.width <= 320, label).toBe(true);
    };
    await signIn(page);
    for (const path of CONSOLE_PAGES) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await overflowX(page), path).toBeLessThanOrEqual(0);
    }
    await page.goto("/host/home");
    for (const name of ["ホーム", "体験", "カレンダー", "予約", "売上", "設定"]) await inside(menu(page).getByRole("link", { name }), `tab ${name}`);
    await inside(page.getByRole("button", { name: "承認する" }).first(), "home: 承認する");
    await inside(page.getByRole("link", { name: "詳しく見る" }).first(), "home: 詳しく見る");
    await inside(page.getByRole("link", { name: "返信する" }).first(), "home: 返信する");
    for (const day of ["今日の開催", "明日の開催"]) await inside(page.getByRole("region", { name: day }).getByRole("link", { name: "参加者を見る" }), `home: ${day} 参加者を見る`);
    await inside(page.getByRole("link", { name: "編集する" }), "home: 編集する");
    await page.locator("summary", { hasText: "のアカウント" }).click();
    await inside(page.getByRole("link", { name: /サンプル工房/ }), "account menu: provider");
    expect(await overflowX(page), "account menu open").toBeLessThanOrEqual(0);
    await page.goto("/host/experiences");
    await inside(page.getByRole("button", { name: "新しい体験" }), "experiences: 新しい体験");
    await page.goto("/host/experiences/community-dinner");
    await inside(page.getByRole("link", { name: "体験へ戻る" }), "sub page: ‹ 体験");
    await page.goto("/host/settings");
    const save = page.getByRole("button", { name: "保存", exact: true });
    await expect(save).toBeInViewport();
    await inside(save, "settings: 保存");
    await inside(page.getByRole("region", { name: "アカウント" }).getByRole("button", { name: "ログアウト" }), "settings: ログアウト");
    await page.goto("/host/register");
    await inside(page.getByRole("button", { name: "登録する" }), "register: 登録する");
  });
});
