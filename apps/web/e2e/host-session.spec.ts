import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

// この回 (#107): one session's guests and attendance on the day, on synthetic data. Runs against
// the second server (HOST_CONSOLE_ENABLED=true, mock mode; see playwright.config.ts). The
// preview's moment is 10/21 15:30: today's 13:00 tea time is over (attendance can be recorded),
// tomorrow's dinner has not started. 出欠 and 中止 change this screen only (moving to another page
// starts over from the synthetic data), and nothing is sent.

const DINNER = "/host/bookings/session?date=2026-10-22&start=18%3A00&experience=community-dinner&offer=offer-dinner";
const TEA = "/host/bookings/session?date=2026-10-21&start=13%3A00&experience=community-dinner&offer=offer-tea";
const DINNER_URL = /\/host\/bookings\/session\?date=2026-10-22&start=18%3A00&experience=community-dinner&offer=offer-dinner$/;

const isDesktop = (projectName: string) => projectName === "host-desktop";
const menu = (page: Page) => page.getByRole("navigation", { name: "ホストのメニュー" });
const summary = (page: Page) => page.getByRole("region", { name: "この回", exact: true });
const guests = (page: Page) => page.getByRole("region", { name: "参加者", exact: true });
const requests = (page: Page) => page.getByRole("region", { name: "承認待ち", exact: true });
const result = (page: Page) => page.getByRole("region", { name: "中止しました · 新しい予約は受け付けません" });
/** One guest's row, by the name heading it. */
const guest = (section: Locator, name: string) => section.getByRole("listitem").filter({ has: section.page().getByRole("heading", { level: 3, name, exact: true }) });
const attendance = (page: Page, name: string) => page.getByRole("group", { name: `${name} さんの出欠` });
/** A row of この回: the value next to its label. */
const value = (section: Locator, label: string) => section.locator("dl > div").filter({ has: section.page().locator("dt", { hasText: new RegExp(`^${label}$`) }) }).locator("dd");
const overflowX = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function signIn(page: Page, query = "") {
  await page.goto(`/host/auth/mock-login${query}`);
  await page.waitForURL(/\/host\/home(\?|$)/);
}

async function audit(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), label).toEqual([]);
}

/** What leaves the browser besides page loads (a server action would be a POST). */
function recordSent(page: Page): string[] {
  const sent: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") sent.push(`${request.method()} ${request.url()}`);
  });
  return sent;
}

test("a session's heading in 予約 opens この回: the times, the guests, the food wishes and the phone", async ({ page }, testInfo) => {
  await signIn(page);
  await page.goto("/host/bookings");
  await page.getByRole("region", { name: "予約の一覧" }).getByRole("link", { name: /^10月22日（木）18:00/ }).click();
  await expect(page).toHaveURL(DINNER_URL);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("10/22（木）Kamakura Community Dinner with Locals");

  const about = summary(page);
  await expect(about).toContainText("開始まであと 26 時間");
  await expect(value(about, "時間")).toHaveText("18:00–20:00 · Dinner");
  // 参加 counts the bookings (確定); the request follows apart.
  await expect(value(about, "人数")).toContainText("参加 2 名 · 定員 8");
  await expect(value(about, "人数")).toContainText("ほかに承認待ち 2 名");
  await expect(value(about, "集合")).toHaveText("Near Kamakura Station, 2-minute walk");
  await expect(value(about, "食べもの")).toHaveText("ベジタリアン 1 名");
  await expect(value(about, "出欠")).toHaveCount(0);

  const emma = guest(guests(page), "Emma Larsson");
  for (const text of ["大人 2", "イギリス · 英語", "支払い済み", "No restrictions."]) await expect(emma).toContainText(text);
  await expect(emma.getByRole("link", { name: "電話 +44 7700 900123" })).toHaveAttribute("href", "tel:+447700900123");
  await expect(emma.getByRole("link", { name: "メッセージ" })).toHaveAttribute("href", "/host/messages?booking=bk-2038");
  // Before the start, attendance cannot be recorded yet: both unpressed and disabled.
  await expect(guests(page)).toContainText("出欠は開始後に付けられます");
  for (const name of ["来た", "来なかった"]) {
    const button = attendance(page, "Emma Larsson").getByRole("button", { name });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute("aria-pressed", "false");
  }

  // The request is apart, and answered in 予約.
  const lucas = guest(requests(page), "Lucas & Mia Chen");
  for (const text of ["大人 2", "カナダ · 英語", "承認期限 今日 22:00", "ベジタリアン", "It is our anniversary that evening!"]) await expect(lucas).toContainText(text);
  await expect(lucas.getByRole("link", { name: "予約の詳細で承認する" })).toHaveAttribute("href", "/host/bookings?booking=bk-2041");
  await expect(lucas.getByRole("group")).toHaveCount(0);
  await expect(lucas.getByRole("link", { name: /^電話/ })).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText("@");
  expect(await overflowX(page)).toBeLessThanOrEqual(0);

  if (isDesktop(testInfo.project.name)) {
    // A screen under 予約: the sidebar keeps 予約 selected, and "‹" leads back to the list.
    await expect(menu(page).getByRole("link", { name: "予約" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("link", { name: "予約へ戻る" })).toHaveAttribute("href", "/host/bookings");
  } else {
    // "‹ 予約" instead of the brand header, and no bottom tabs.
    await expect(menu(page)).toHaveCount(0);
    await expect(page.getByRole("banner")).toHaveCount(0);
    const back = page.getByRole("link", { name: "予約へ戻る" });
    await expect(back).toHaveText("予約");
    await back.click();
    await expect(page).toHaveURL(/\/host\/bookings$/);
    await expect(menu(page)).toHaveCount(1);
  }
});

test("today's session, once started, records who came and lets the host correct it", async ({ page }) => {
  await signIn(page);
  await page.goto(TEA);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("10/21（水）Kamakura Community Dinner with Locals");
  const about = summary(page);
  await expect(about).toContainText("終了しました");
  await expect(value(about, "人数")).toHaveText("参加 4 名 · 定員 8");
  await expect(value(about, "食べもの")).toHaveText("ナッツなし 1 名");
  await expect(value(about, "出欠")).toHaveText("来た 0 件 · 来なかった 0 件 · 未記録 2 件");
  await expect(guests(page)).not.toContainText("開始後に付けられます");
  // Calling off is for sessions that have not started.
  await expect(page.getByRole("button", { name: /この回を中止する/ })).toHaveCount(0);

  const tom = guest(guests(page), "Tom Becker");
  for (const text of ["大人 1・子ども 1", "イギリス · 英語", "ナッツなし", "支払い済み", "My son is 7 and will come with me."]) await expect(tom).toContainText(text);
  await expect(tom.getByRole("link", { name: "電話 +44 7700 900987" })).toHaveAttribute("href", "tel:+447700900987");
  const aiko = guest(guests(page), "Aiko Tanaka");
  await expect(aiko).toContainText("日本 · 日本語");
  await expect(aiko.getByRole("link", { name: /^電話/ })).toHaveCount(0);

  const sent = recordSent(page);
  const came = attendance(page, "Aiko Tanaka").getByRole("button", { name: "来た" });
  await expect(came).toBeEnabled();
  // Big enough to tap on the day.
  expect((await came.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await came.click();
  await expect(came).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("status").filter({ hasText: "Aiko Tanaka さん: 来た" })).toBeVisible();

  await attendance(page, "Tom Becker").getByRole("button", { name: "来なかった" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Tom Becker さん: 来なかった" })).toBeVisible();
  await expect(tom).toContainText("お礼とレビュー依頼は届きません");
  await expect(value(about, "出欠")).toHaveText("来た 1 件 · 来なかった 1 件 · 未記録 0 件");

  // Put right after the end.
  await attendance(page, "Tom Becker").getByRole("button", { name: "来た" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Tom Becker さん: 来た" })).toBeVisible();
  await expect(attendance(page, "Tom Becker").getByRole("button", { name: "来た" })).toHaveAttribute("aria-pressed", "true");
  await expect(attendance(page, "Tom Becker").getByRole("button", { name: "来なかった" })).toHaveAttribute("aria-pressed", "false");
  await expect(tom).not.toContainText("お礼とレビュー依頼は届きません");
  await expect(value(about, "出欠")).toHaveText("来た 2 件 · 来なかった 0 件 · 未記録 0 件");
  expect(sent).toEqual([]);
});

test("参加者に連絡する lists the guests and opens each one's thread: one at a time, never to everyone", async ({ page }) => {
  await signIn(page);
  await page.goto(DINNER);
  const open = page.getByRole("button", { name: "参加者に連絡する" });
  await open.click();
  const contact = page.getByRole("dialog", { name: "参加者に連絡する" });
  await expect(contact).toContainText("連絡は 1 人ずつ送ります");
  await expect(contact.getByRole("textbox")).toHaveCount(0);
  await expect(contact.getByRole("button", { name: "閉じる" })).toBeFocused();
  const people = contact.getByRole("listitem");
  await expect(people).toHaveCount(2);
  await expect(people.nth(0)).toContainText("Emma Larsson");
  await expect(people.nth(0)).toContainText("2名");
  for (const text of ["Lucas & Mia Chen", "承認待ち"]) await expect(people.nth(1)).toContainText(text);
  await page.keyboard.press("Escape");
  await expect(contact).toHaveCount(0);

  await open.click();
  await people.nth(0).getByRole("link", { name: "メッセージを開く" }).click();
  await expect(page).toHaveURL(/\/host\/messages\?booking=bk-2038$/);
  await expect(page.getByRole("region", { name: "Emma Larsson さんとの連絡", exact: true })).toBeVisible();
  // The phone stays on この回.
  await expect(page.locator("main")).not.toContainText("7700");

  // A booking that has a thread opens it.
  await page.goto("/host/bookings/session?date=2026-10-27&start=18%3A00&experience=community-dinner&offer=offer-dinner");
  await expect(guest(guests(page), "Sofia Rossi").getByRole("link", { name: "メッセージ" })).toHaveAttribute("href", "/host/messages?thread=th-3004");
});

test("この回を中止 waits for a reason, cancels each booking and request, and says how each went", async ({ page }) => {
  await signIn(page);
  await page.goto(DINNER);
  const sent = recordSent(page);
  const cancel = page.getByRole("button", { name: "この回を中止する（雨天・急病など）" });
  const ask = page.getByRole("dialog", { name: "この回を中止しますか？" });
  const confirm = ask.getByRole("button", { name: "2 件を取り消して ¥60,000 を返金する" });
  await cancel.click();
  await expect(ask).toContainText("10/22（木）18:00の回を中止します。この操作は元に戻せません。");
  await expect(ask.getByRole("radio", { name: "雨・荒天" })).toBeFocused();
  await expect(ask).toContainText("確定 1 件・承認待ち 1 件を取り消し、¥60,000 を全額返金します。承認待ちはカードの仮押さえを解除します。");
  await expect(ask).toContainText("予約者には取消のメールに理由を添えて送ります（自由文は送れません）。");
  // No free text, and nothing to confirm without a reason.
  await expect(ask.getByRole("textbox")).toHaveCount(0);
  await expect(confirm).toBeDisabled();
  await expect(ask).toContainText("中止の理由を選ぶと中止できます");
  // Esc goes back without changing anything.
  await page.keyboard.press("Escape");
  await expect(ask).toHaveCount(0);
  await expect(result(page)).toHaveCount(0);

  await cancel.click();
  await expect(confirm).toBeDisabled();
  await ask.getByRole("radio", { name: "雨・荒天" }).check();
  await expect(ask).toContainText("メールに添える文: 申し訳ありませんが、天候のため、この回は中止になりました。");
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(ask).toHaveCount(0);

  await expect(result(page).getByRole("heading", { level: 2 })).toBeFocused();
  await expect(page.getByRole("status").filter({ hasText: "この回を中止しました。2 件を取り消し、¥60,000 を返金しました" })).toBeVisible();
  await expect(result(page).getByRole("listitem")).toHaveText(["Lucas & Mia Chen取り消してカードの仮押さえを解除", "Emma Larsson取り消して ¥60,000 を返金"]);
  await expect(result(page).getByRole("button", { name: "失敗した予約をもう一度" })).toHaveCount(0);

  // Each booking stays where it was, cancelled; only 連絡 is left to do.
  await expect(guest(guests(page), "Emma Larsson")).toContainText("取消済み");
  await expect(guest(guests(page), "Emma Larsson")).not.toContainText("支払い済み");
  await expect(guest(requests(page), "Lucas & Mia Chen")).toContainText("取消済み");
  await expect(page.getByRole("group", { name: /さんの出欠$/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "予約の詳細で承認する" })).toHaveCount(0);
  await expect(cancel).toHaveCount(0);
  await expect(page.getByRole("button", { name: "参加者に連絡する" })).toBeVisible();
  await expect(value(summary(page), "人数")).toHaveText("参加 0 名 · 定員 8");
  await expect(summary(page)).toContainText("中止");
  await expect(summary(page)).not.toContainText("開始まで");
  await expect(guests(page)).not.toContainText("開始後に付けられます");
  await expect(value(summary(page), "食べもの")).toHaveText("食べものの希望はありません");
  // Mock mode: nothing left the browser.
  expect(sent).toEqual([]);
});

test("ホーム's 参加者を見る opens the day's session, and the links keep ?providerId=", async ({ page }) => {
  await signIn(page, "?providerId=sample-provider-kitchen");
  await page.getByRole("region", { name: "今日の開催" }).getByRole("link", { name: "参加者を見る" }).click();
  await expect(page).toHaveURL(/\/host\/bookings\/session\?date=2026-10-21&start=13%3A00&experience=community-dinner&offer=offer-tea&providerId=sample-provider-kitchen$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("10/21（水）Kamakura Community Dinner with Locals");
  await expect(page.getByRole("link", { name: "予約へ戻る" })).toHaveAttribute("href", "/host/bookings?providerId=sample-provider-kitchen");
  await expect(guest(guests(page), "Tom Becker").getByRole("link", { name: "メッセージ" })).toHaveAttribute("href", "/host/messages?providerId=sample-provider-kitchen&booking=bk-2003");

  await page.goto("/host/home?providerId=sample-provider-kitchen");
  await page.getByRole("region", { name: "明日の開催" }).getByRole("link", { name: "参加者を見る" }).click();
  await expect(page).toHaveURL(/\/host\/bookings\/session\?date=2026-10-22&start=18%3A00&experience=community-dinner&offer=offer-dinner&providerId=sample-provider-kitchen$/);
  await expect(guest(guests(page), "Emma Larsson")).toBeVisible();

  // 予約's headings carry it too.
  await page.goto("/host/bookings?providerId=sample-provider-kitchen");
  await expect(page.getByRole("region", { name: "予約の一覧" }).getByRole("link", { name: /^10月22日（木）18:00/ })).toHaveAttribute(
    "href",
    "/host/bookings/session?providerId=sample-provider-kitchen&date=2026-10-22&start=18%3A00&experience=community-dinner&offer=offer-dinner",
  );
});

test("the guest's phone is on この回 only, and a session that is not the provider's does not open", async ({ page }) => {
  await signIn(page);
  for (const path of ["/host/home", "/host/bookings", "/host/bookings?booking=bk-2038", "/host/bookings?booking=bk-2003", "/host/messages?booking=bk-2038"]) {
    // Not in what the page shows, nor in what it sends to the browser.
    const response = (await page.goto(path))!;
    expect(await response.text(), path).not.toContain("7700 900");
    await expect(page.locator("main"), path).not.toContainText("7700");
  }
  const response = (await page.goto(DINNER))!;
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.headers()["x-robots-tag"]).toContain("noindex");
  expect(await response.text()).toContain("+44 7700 900123");

  for (const path of [
    // No booking on that day, a malformed address, another provider's.
    "/host/bookings/session?date=2026-10-20&start=18%3A00&experience=community-dinner&offer=offer-dinner",
    "/host/bookings/session?date=2026-10-22",
    "/host/bookings/session?providerId=sample-provider-studio&date=2026-10-22&start=18%3A00&experience=community-dinner&offer=offer-dinner",
  ]) {
    expect((await page.goto(path))?.status(), path).toBe(404);
  }
});

test("この回 has no WCAG 2.2 AA violations", async ({ page }) => {
  await signIn(page);
  await page.goto(DINNER);
  await expect(guests(page)).toBeVisible();
  await audit(page, "before the start");
  await page.getByRole("button", { name: "参加者に連絡する" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await audit(page, "contact dialog");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "この回を中止する（雨天・急病など）" }).click();
  await page.getByRole("dialog").getByRole("radio", { name: "急病・けが" }).check();
  await audit(page, "cancel dialog");
  await page.getByRole("dialog").getByRole("button", { name: /を返金する$/ }).click();
  await expect(result(page)).toBeVisible();
  await audit(page, "called off");

  await page.goto(TEA);
  await attendance(page, "Tom Becker").getByRole("button", { name: "来なかった" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Tom Becker さん: 来なかった" })).toBeVisible();
  await audit(page, "attendance recorded");
});

test.describe("320px narrow phone", () => {
  test.use({ viewport: { width: 320, height: 640 } });
  test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== "host-mobile-360"));

  test("the session, its guests and the dialogs fit", async ({ page }) => {
    const inside = async (locator: Locator, label: string) => {
      await locator.scrollIntoViewIfNeeded();
      await expect(locator, label).toBeInViewport();
      const box = await locator.boundingBox();
      expect(box && box.x >= 0 && box.x + box.width <= 320, label).toBe(true);
    };
    await signIn(page);
    for (const path of [DINNER, TEA]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await overflowX(page), path).toBeLessThanOrEqual(0);
    }
    await inside(page.getByRole("link", { name: "予約へ戻る" }), "‹ 予約");
    for (const name of ["来た", "来なかった"]) await inside(attendance(page, "Tom Becker").getByRole("button", { name }), `Tom ${name}`);
    await inside(guest(guests(page), "Tom Becker").getByRole("link", { name: "メッセージ" }), "Tom メッセージ");
    await inside(guest(guests(page), "Tom Becker").getByRole("link", { name: /^電話/ }), "Tom 電話");

    await page.goto(DINNER);
    await inside(guest(requests(page), "Lucas & Mia Chen").getByRole("link", { name: "予約の詳細で承認する" }), "予約の詳細で承認する");
    await inside(page.getByRole("button", { name: "参加者に連絡する" }), "参加者に連絡する");
    const cancel = page.getByRole("button", { name: "この回を中止する（雨天・急病など）" });
    await inside(cancel, "この回を中止する");
    await page.getByRole("button", { name: "参加者に連絡する" }).click();
    await inside(page.getByRole("dialog").getByRole("link", { name: "メッセージを開く" }).first(), "メッセージを開く");
    await inside(page.getByRole("dialog").getByRole("button", { name: "閉じる" }), "閉じる");
    expect(await overflowX(page), "contact dialog").toBeLessThanOrEqual(0);
    await page.keyboard.press("Escape");
    await cancel.click();
    const ask = page.getByRole("dialog");
    for (const label of ["雨・荒天", "急病・けが", "その他の事情"]) await inside(ask.getByRole("radio", { name: label }), label);
    await ask.getByRole("radio", { name: "その他の事情" }).check();
    await inside(ask.getByRole("button", { name: "2 件を取り消して ¥60,000 を返金する" }), "中止の確定");
    await inside(ask.getByRole("button", { name: "やめる" }), "やめる");
    expect(await overflowX(page), "cancel dialog").toBeLessThanOrEqual(0);
    await ask.getByRole("button", { name: "2 件を取り消して ¥60,000 を返金する" }).click();
    await expect(result(page)).toBeVisible();
    expect(await overflowX(page), "called off").toBeLessThanOrEqual(0);
  });
});
