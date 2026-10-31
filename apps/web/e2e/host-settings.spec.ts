import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

// 設定 › カレンダー and 通知 (#109) on synthetic data. Runs against the second server
// (HOST_CONSOLE_ENABLED=true, mock mode; see playwright.config.ts). The preview connects a synthetic
// Google account and keeps every change on screen only, so nothing is sent and a reload starts from
// the synthetic data again. http mode's panel (the experience DB's Google connection and bookings
// feed) and 通知's 準備中 are checked by the unit tests (HostCalendarPanel.test.ts, calendar-server.test.ts,
// notifications.test.ts).

const isDesktop = (projectName: string) => projectName === "host-desktop";
const calendarPanel = (page: Page) => page.getByRole("region", { name: "カレンダー" });
const notificationPanel = (page: Page) => page.getByRole("region", { name: "通知" });
const overflowX = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const NOTIFICATIONS = ["新しい予約・申込", "承認の期限が近い", "予約の取消", "予約前の質問・予約者からの連絡", "前日の参加者のまとめ", "新しいレビュー", "掲載と審査の結果"];
const STOPPABLE = ["予約前の質問・予約者からの連絡", "前日の参加者のまとめ", "新しいレビュー"];

async function signIn(page: Page, query = "") {
  await page.goto(`/host/auth/mock-login${query}`);
  await page.waitForURL(/\/host\/home(\?|$)/);
}

async function audit(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), label).toEqual([]);
}

/** Everything the page sends but its own page loads: the preview's calendar and notifications send nothing. */
function recordWrites(page: Page): string[] {
  const sent: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") sent.push(`${request.method()} ${request.url()}`);
  });
  return sent;
}

test("the studio connects Google Calendar from ホーム's card, sets it up and disconnects it", async ({ page }) => {
  await signIn(page, "?providerId=sample-provider-studio");
  const card = page.getByRole("region", { name: "Google カレンダーをつなぐ" });
  await expect(card).toContainText("予定がある時間は予約を受け付けません");
  // Under 次にすること and the day's sessions, above これからの開催.
  const cardBox = (await card.boundingBox())!;
  expect(cardBox.y).toBeGreaterThan((await page.getByRole("region", { name: "次にすること" }).boundingBox())!.y);
  expect((await page.getByRole("region", { name: "これからの開催" }).boundingBox())!.y).toBeGreaterThan(cardBox.y + cardBox.height);
  // Nothing closes it: it stays until the calendar is connected.
  await expect(card.getByRole("button")).toHaveCount(0);
  const connectLink = card.getByRole("link", { name: "つなぐ" });
  await expect(connectLink).toHaveAttribute("href", "/host/settings?providerId=sample-provider-studio#settings-calendar");
  await connectLink.click();
  await page.waitForURL("**/host/settings?providerId=sample-provider-studio#settings-calendar");

  const calendar = calendarPanel(page);
  const status = calendar.getByRole("status");
  await expect(calendar).toBeInViewport();
  await expect(calendar).toContainText("未接続");
  await expect(calendar).toContainText("つなぐと、予定がある時間は予約を受け付けません");
  await expect(calendar.getByRole("switch")).toHaveCount(0);
  await expect(calendar).not.toContainText("準備中");

  const sent = recordWrites(page);
  await calendar.getByRole("button", { name: "Google カレンダーをつなぐ" }).click();
  await expect(status).toHaveText("Google カレンダーをつなぎました（host@example.com）");
  await expect(calendar).toContainText("接続中");
  await expect(calendar.getByRole("group", { name: "Google カレンダー" })).toContainText("host@example.com");
  const block = calendar.getByRole("switch", { name: "予定がある時間は予約を受け付けない" });
  await expect(block).toBeChecked();
  // The connect button is gone: focus moves to the first new setting.
  await expect(block).toBeFocused();
  await expect(block).toHaveAccessibleDescription("選んだカレンダーの予定と重なる回は、体験サイトで満席と同じ扱いになります（理由は予約者に出しません）");

  // The calendars that close sessions: named, Google's choice to start with (its holidays are not read).
  const busy = calendar.getByRole("list", { name: "空きを見るカレンダー" }).getByRole("checkbox");
  await expect(busy).toHaveCount(3);
  await expect(calendar.getByRole("checkbox", { name: "個人の予定" })).toBeChecked();
  await expect(calendar.getByRole("checkbox", { name: "日本の祝日" })).not.toBeChecked();
  const classes = calendar.getByRole("checkbox", { name: "教室の予定" });
  await classes.check();
  await expect(status).toHaveText("「教室の予定」の予定がある時間は予約を受け付けません");
  await block.click();
  await expect(block).not.toBeChecked();
  await expect(status).toHaveText("予定がある時間も予約を受け付けます");
  await expect(classes).toBeDisabled();
  await block.click();
  await expect(classes).toBeEnabled();
  await expect(classes).toBeChecked();

  // Bookings go to a calendar the account can write to (not Google's holidays).
  const write = calendar.getByRole("switch", { name: "確定した予約をカレンダーに書き込む" });
  const target = calendar.getByRole("combobox", { name: "書き込み先" });
  await expect(write).toBeChecked();
  await expect(write).toHaveAccessibleDescription("人数と食べものの希望を予定のメモに入れます。予約者の連絡先は入れません");
  await expect(target.getByRole("option")).toHaveText(["個人の予定", "教室の予定"]);
  await expect(target).toHaveValue("sample-host-main");
  await target.selectOption({ label: "教室の予定" });
  await expect(status).toHaveText("確定した予約を「教室の予定」に書き込みます");
  await write.click();
  await expect(status).toHaveText("予約をカレンダーに書き込みません");
  await expect(target).toBeDisabled();

  // 接続を切る asks first; やめる changes nothing.
  const disconnect = calendar.getByRole("button", { name: "接続を切る" });
  const dialog = page.getByRole("dialog", { name: "Google カレンダーの接続を切りますか？" });
  await disconnect.click();
  await expect(dialog).toContainText("切っても予約は消えません。書き込んだ予定は残ります。予定がある時間の判定は止まります。");
  await expect(dialog.getByRole("button", { name: "やめる" })).toBeFocused();
  await dialog.getByRole("button", { name: "やめる" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(calendar).toContainText("接続中");
  await disconnect.click();
  await dialog.getByRole("button", { name: "接続を切る" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(status).toHaveText("Google カレンダーの接続を切りました。予約はそのままです");
  await expect(calendar).toContainText("未接続");
  await expect(calendar.getByRole("switch")).toHaveCount(0);
  await expect(calendar.getByRole("button", { name: "Google カレンダーをつなぐ" })).toBeFocused();
  expect(sent).toEqual([]);
  expect(await overflowX(page)).toBeLessThanOrEqual(0);
});

test("a calendar whose access was taken away in Google says so on ホーム and in 設定, until it is connected again", async ({ page }) => {
  await signIn(page, "?mock=calendar-revoked");
  const card = page.getByRole("region", { name: "Google カレンダーの接続が切れました" });
  await expect(card).toContainText("もう一度つなぐまで、予定の確認と書き込みを止めています");
  // Below today's and tomorrow's sessions, above これからの開催.
  const cardBox = (await card.boundingBox())!;
  const tomorrow = (await page.getByRole("region", { name: "明日の開催" }).boundingBox())!;
  expect(cardBox.y).toBeGreaterThan(tomorrow.y + tomorrow.height);
  expect((await page.getByRole("region", { name: "これからの開催" }).boundingBox())!.y).toBeGreaterThan(cardBox.y + cardBox.height);
  expect(await overflowX(page)).toBeLessThanOrEqual(0);

  await card.getByRole("link", { name: "もう一度つなぐ" }).click();
  await page.waitForURL(/\/host\/settings#settings-calendar$/);
  const calendar = calendarPanel(page);
  await expect(calendar).toContainText("接続が切れました");
  await expect(calendar).toContainText("Google カレンダーの権限が取り消されたため、予定の確認と書き込みを止めています");
  await expect(calendar.getByRole("switch")).toHaveCount(0);
  await expect(calendar.getByRole("button", { name: "接続を切る" })).toHaveCount(0);
  await calendar.getByRole("button", { name: "もう一度つなぐ" }).click();
  await expect(calendar.getByRole("status")).toHaveText("Google カレンダーにもう一度つなぎました（kitchen@example.com）");
  await expect(calendar).toContainText("接続中");
  // Its own calendars and choices come back.
  await expect(calendar.getByRole("checkbox", { name: "家族の予定" })).toBeChecked();
  await expect(calendar.getByRole("combobox", { name: "書き込み先" })).toHaveValue("sample-kitchen-main");

  // Connected (the usual preview): no card on ホーム.
  await signIn(page);
  await expect(page.getByRole("heading", { level: 2, name: "次にすること" })).toBeVisible();
  await expect(page.getByRole("region", { name: /Google カレンダー/ })).toHaveCount(0);
});

test("ほかのカレンダーで見る: the feed's address is copied, and a new one replaces it after asking", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page);
  await page.goto("/host/settings");
  const calendar = calendarPanel(page);
  const status = calendar.getByRole("status");
  await expect(calendar.getByRole("group", { name: "ほかのカレンダーで見る" })).toContainText("Apple・Outlook などに予約の一覧を表示します");
  const url = calendar.getByRole("textbox", { name: "予約の一覧の URL" });
  await expect(url).not.toBeEditable();
  const before = await url.inputValue();
  expect(before).toMatch(/^https:\/\/calendar\.example\.com\/sample-kitchen\/[0-9a-z]{20,}\/bookings\.ics$/);
  // A click selects the whole address.
  await url.click();
  expect(await url.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([0, before.length]);

  await calendar.getByRole("button", { name: "URL をコピー" }).click();
  await expect(status).toHaveText("URL をコピーしました");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(before);

  const sent = recordWrites(page);
  const renew = calendar.getByRole("button", { name: "URL を作り直す" });
  const dialog = page.getByRole("dialog", { name: "URL を作り直しますか？" });
  await renew.click();
  await expect(dialog).toContainText("今の URL は使えなくなります。登録したカレンダーで、新しい URL を登録し直してください。");
  await dialog.getByRole("button", { name: "やめる" }).click();
  await expect(url).toHaveValue(before);
  await renew.click();
  await dialog.getByRole("button", { name: "URL を作り直す" }).click();
  await expect(status).toHaveText("URL を作り直しました。登録したカレンダーで、新しい URL を登録し直してください");
  await expect(url).not.toHaveValue(before);
  expect(await url.inputValue()).toMatch(/^https:\/\/calendar\.example\.com\/sample-kitchen\/[0-9a-f]{32}\/bookings\.ics$/);
  await calendar.getByRole("button", { name: "URL をコピー" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await url.inputValue());
  expect(sent).toEqual([]);
});

test("the bookings feed's address answers nothing in the preview, privately", async ({ request }) => {
  // http mode serves it from the experience DB (EXPERIENCE_HOST_CALENDAR_FEED_ENABLED); the preview has no feed.
  const response = await request.get(`/host/calendar/feed/${"A".repeat(43)}/bookings.ics`);
  expect(response.status()).toBe(404);
  expect(await response.text()).toBe("");
  const headers = response.headers();
  expect(headers["cache-control"]).toContain("no-store");
  expect(headers["x-robots-tag"]).toBe("noindex, nofollow, noarchive");
  expect(headers["referrer-policy"]).toBe("no-referrer");
});

test("通知: NIHO's seven notifications in its order; the three the owner may stop are kept by 保存", async ({ page }) => {
  await signIn(page);
  await page.goto("/host/settings");
  const panel = notificationPanel(page);
  // Where the mail goes, read-only: changing it is not here yet.
  const to = panel.getByRole("group", { name: "宛先" });
  await expect(to).toContainText("kitchen@example.com");
  await expect(to).toContainText("NIHO からの通知はこのメールに届きます");
  await expect(to).toContainText("宛先の変更は準備中です");
  await expect(panel.getByRole("textbox")).toHaveCount(0);
  await expect(panel.getByRole("button")).toHaveCount(0);

  const switches = panel.getByRole("switch");
  await expect(switches).toHaveCount(7);
  for (const [index, name] of NOTIFICATIONS.entries()) await expect(switches.nth(index)).toHaveAccessibleName(name);
  await expect(panel.getByRole("switch", { name: "前日の参加者のまとめ" })).toHaveAccessibleDescription("毎日 18:00 · 翌日に確定の予約があるときだけ");
  for (const name of NOTIFICATIONS) {
    const control = panel.getByRole("switch", { name });
    await expect(control, name).toBeChecked();
    if (STOPPABLE.includes(name)) {
      await expect(control, name).toBeEnabled();
    } else {
      // On, locked, and said so (also to screen readers).
      await expect(control, name).toBeDisabled();
      await expect(control, name).toHaveAccessibleDescription(/止められません$/);
    }
  }
  // The switch sits to the right of its words.
  const review = panel.getByRole("switch", { name: "新しいレビュー" });
  const label = (await panel.getByText("新しいレビュー", { exact: true }).boundingBox())!;
  expect((await review.boundingBox())!.x).toBeGreaterThan(label.x + label.width);

  const sent = recordWrites(page);
  await review.click();
  await expect(review).not.toBeChecked();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "保存しました" })).toBeVisible();
  await expect(review).not.toBeChecked();
  // The preview keeps it on screen only: nothing is sent, and a reload starts from the synthetic settings.
  expect(sent).toEqual([]);
  await page.reload();
  await expect(notificationPanel(page).getByRole("switch", { name: "新しいレビュー" })).toBeChecked();
});

test("an editor reads that the notification settings are the owner's", async ({ page }) => {
  await signIn(page, "?providerId=sample-provider-studio");
  await page.goto("/host/settings?providerId=sample-provider-studio");
  const panel = notificationPanel(page);
  await expect(panel).toContainText("通知の設定はオーナーが変えられます");
  await expect(panel.getByRole("switch")).toHaveCount(0);
  await expect(panel).not.toContainText("studio@example.com");
});

test("カレンダー, 通知 and ホーム's card have no WCAG 2.2 AA violations", async ({ page }) => {
  await signIn(page);
  await page.goto("/host/settings");
  await expect(calendarPanel(page)).toContainText("接続中");
  await audit(page, "/host/settings (connected)");
  await calendarPanel(page).getByRole("button", { name: "接続を切る" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await audit(page, "/host/settings (disconnect dialog)");
  await page.keyboard.press("Escape");
  await calendarPanel(page).getByRole("button", { name: "URL を作り直す" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await audit(page, "/host/settings (new address dialog)");

  await signIn(page, "?providerId=sample-provider-studio");
  await audit(page, "/host/home (calendar card)");
  await page.goto("/host/settings?providerId=sample-provider-studio");
  await expect(calendarPanel(page)).toContainText("未接続");
  await audit(page, "/host/settings (not connected, editor)");

  await signIn(page, "?mock=calendar-revoked");
  await audit(page, "/host/home (calendar revoked)");
  await page.goto("/host/settings");
  await expect(calendarPanel(page)).toContainText("接続が切れました");
  await audit(page, "/host/settings (revoked)");
});

test("PC and phones: the panels' fields stay readable and nothing scrolls sideways", async ({ page }, testInfo) => {
  await signIn(page);
  await page.goto("/host/settings");
  expect(await overflowX(page)).toBeLessThanOrEqual(0);
  const calendar = calendarPanel(page);
  const url = calendar.getByRole("textbox", { name: "予約の一覧の URL" });
  const select = calendar.getByRole("combobox", { name: "書き込み先" });
  if (isDesktop(testInfo.project.name)) {
    // PC: "label 168px + field" rows; the address at most 520px wide, the fields 14px.
    const labelBox = (await calendar.getByText("ほかのカレンダーで見る", { exact: true }).boundingBox())!;
    const urlBox = (await url.boundingBox())!;
    expect(urlBox.x).toBeGreaterThan(labelBox.x + 168);
    expect(urlBox.width).toBeLessThanOrEqual(520);
    expect(await url.evaluate((input) => getComputedStyle(input).fontSize)).toBe("14px");
  } else {
    // Phones: stacked, and 16px fields (iOS does not zoom in).
    expect(await url.evaluate((input) => getComputedStyle(input).fontSize)).toBe("16px");
    expect(await select.evaluate((input) => getComputedStyle(input).fontSize)).toBe("16px");
  }
});

test.describe("320px narrow phone", () => {
  test.use({ viewport: { width: 320, height: 640 } });
  test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== "host-mobile-360"));

  test("カレンダー, 通知 and ホーム's card fit, with their controls inside the screen", async ({ page }) => {
    const inside = async (locator: Locator, label: string) => {
      await locator.scrollIntoViewIfNeeded();
      await expect(locator, label).toBeInViewport();
      const box = await locator.boundingBox();
      expect(box && box.x >= 0 && box.x + box.width <= 320, label).toBe(true);
    };
    await signIn(page);
    await page.goto("/host/settings");
    expect(await overflowX(page), "settings (connected)").toBeLessThanOrEqual(0);
    const calendar = calendarPanel(page);
    await inside(calendar.getByRole("button", { name: "接続を切る" }), "接続を切る");
    await inside(calendar.getByRole("switch", { name: "予定がある時間は予約を受け付けない" }), "busy switch");
    await inside(calendar.getByRole("checkbox", { name: "日本の祝日" }), "a calendar");
    await inside(calendar.getByRole("combobox", { name: "書き込み先" }), "書き込み先");
    await inside(calendar.getByRole("textbox", { name: "予約の一覧の URL" }), "the address");
    await inside(calendar.getByRole("button", { name: "URL をコピー" }), "URL をコピー");
    await inside(calendar.getByRole("button", { name: "URL を作り直す" }), "URL を作り直す");
    for (const name of NOTIFICATIONS) await inside(notificationPanel(page).getByRole("switch", { name }), name);
    await calendar.getByRole("button", { name: "URL を作り直す" }).click();
    await inside(page.getByRole("dialog").getByRole("button", { name: "URL を作り直す" }), "dialog: URL を作り直す");
    expect(await overflowX(page), "dialog open").toBeLessThanOrEqual(0);

    await signIn(page, "?providerId=sample-provider-studio");
    expect(await overflowX(page), "home with the card").toBeLessThanOrEqual(0);
    await inside(page.getByRole("region", { name: "Google カレンダーをつなぐ" }).getByRole("link", { name: "つなぐ" }), "home: つなぐ");
    await page.goto("/host/settings?providerId=sample-provider-studio");
    expect(await overflowX(page), "settings (not connected)").toBeLessThanOrEqual(0);
    await inside(calendarPanel(page).getByRole("button", { name: "Google カレンダーをつなぐ" }), "Google カレンダーをつなぐ");

    await signIn(page, "?mock=calendar-revoked");
    expect(await overflowX(page), "home (revoked)").toBeLessThanOrEqual(0);
    await inside(page.getByRole("link", { name: "もう一度つなぐ" }), "home: もう一度つなぐ");
    await page.goto("/host/settings");
    expect(await overflowX(page), "settings (revoked)").toBeLessThanOrEqual(0);
    await inside(calendarPanel(page).getByRole("button", { name: "もう一度つなぐ" }), "もう一度つなぐ");
  });
});
