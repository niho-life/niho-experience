import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

// OTA の予約の画面 (#194 PR B) as the preview's `?mock=ota-bookings` sign-in shows them: the bookings made on reservation
// sites (src/host/mock/ota-bookings.ts) beside the preview's own on 予約, ホーム's 次にすること and この回. Read only: their
// site keeps cancelling, refunding and writing to the guest, and nothing is sent. 360px and PC by the host projects,
// 320px below.

const GYG = "0b7f3c1e-5a2d-4e8f-9c61-2d4b8a7e1f01";
const JALAN = "0b7f3c1e-5a2d-4e8f-9c61-2d4b8a7e1f03";
const list = (page: Page) => page.getByRole("region", { name: "予約の一覧" });
const row = (page: Page, guest: string) => list(page).getByRole("link", { name: new RegExp(`^${guest}`) });
const chip = (page: Page, label: string) => page.getByRole("list", { name: "予約の絞り込み" }).getByRole("link", { name: label, exact: true });
const detail = (page: Page, guest: string) => page.getByRole("region", { name: guest, exact: true });
const value = (booking: Locator, label: string) => booking.locator("dl > div").filter({ has: booking.page().locator("dt", { hasText: new RegExp(`^${label}$`) }) }).locator("dd");
const overflowX = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function signIn(page: Page) {
  await page.goto("/host/auth/mock-login?mock=ota-bookings");
  await page.waitForURL(/\/host\/home(\?|$)/);
}

async function audit(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), label).toEqual([]);
}

/** What leaves the browser besides page loads (a server action is a POST). */
function recordSent(page: Page): string[] {
  const sent: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") sent.push(`${request.method()} ${request.url()}`);
  });
  return sent;
}

test("予約: OTA bookings join the list with their site's badge, and open read only with the guest's contact", async ({ page }) => {
  await signIn(page);
  const sent = recordSent(page);
  await page.goto("/host/bookings");
  await expect(page.getByText("予約サイト（Airbnb・GetYourGuide など）で受けた予約も並べています")).toBeVisible();
  // On the preview's own session, beside its guests; no amount for them.
  await expect(row(page, "Sample Traveler")).toContainText("GetYourGuide");
  await expect(row(page, "Sample Traveler")).toContainText("3名 · GetYourGuide");
  await expect(row(page, "Sample Traveler")).not.toContainText("¥");
  await expect(row(page, "見本 花子")).toContainText("確定待ち");
  await expect(row(page, "Sample Solo")).toContainText("確認中");
  await chip(page, "取消済み").click();
  await expect(row(page, "Sample Couple")).toContainText("Airbnb");
  await expect(row(page, "Sample Couple")).toContainText("取消済み");

  await chip(page, "これから").click();
  await row(page, "Sample Traveler").click();
  const booking = detail(page, "Sample Traveler");
  await expect(booking).toContainText("取消・返金・予約者とのやりとりは GetYourGuide で行ってください。この画面からは変えられません。");
  const request = booking.getByRole("region", { name: "申込内容" });
  await expect(value(request, "人数")).toHaveText("3名（大人 2・子ども 1）");
  await expect(value(request, "予約番号")).toHaveText("GYG-SAMPLE-1042");
  const guest = booking.getByRole("region", { name: "予約者" });
  await expect(guest.getByRole("link", { name: "traveler@example.com" })).toHaveAttribute("href", "mailto:traveler@example.com");
  await expect(guest.getByRole("link", { name: "+44 20 0000 0000" })).toHaveAttribute("href", /^tel:/);
  await expect(guest).toContainText("One vegetarian, please.");
  // Nothing to do here: no approval, cancellation, refund or message.
  await expect(booking.getByRole("button")).toHaveCount(0);
  await expect(booking.getByRole("link", { name: /メッセージ|取り消/ })).toHaveCount(0);
  await audit(page, "予約 with an OTA booking open");
  expect(sent).toEqual([]);
});

test("the push's link (?ota=) opens the booking, and an erased one says so", async ({ page }) => {
  await signIn(page);
  await page.goto(`/host/bookings?ota=${JALAN}`);
  const booking = detail(page, "見本 花子");
  await expect(booking).toContainText("じゃらん で行ってください");
  await expect(booking).toContainText("予約サイトで確定待ちです。席は押さえています。");
  await expect(booking.getByRole("link", { name: "hanako@example.jp" })).toBeVisible();
  await page.goto("/host/bookings?ota=0b7f3c1e-5a2d-4e8f-9c61-2d4b8a7e1f05");
  await expect(detail(page, "保存期間を過ぎたため表示できません")).toContainText("保存期間を過ぎたため、予約者の情報は表示できません。");
  // One this account cannot read (another provider's, or none): not found, as any other booking.
  await page.goto("/host/bookings?ota=0b7f3c1e-5a2d-4e8f-9c61-2d4b8a7e1f99");
  await expect(page.getByRole("heading", { name: "ページが見つかりません" })).toBeVisible();
});

test("ホーム: new OTA bookings are in 次にすること and lead to their detail", async ({ page }) => {
  await signIn(page);
  const todos = page.getByRole("region", { name: "次にすること" });
  await expect(todos).toContainText("GetYourGuide で新しい予約");
  await expect(todos).toContainText("10/22（木）18:00 · Kamakura Community Dinner with Locals · Sample Traveler 様 · 3名");
  // Cancelled and older bookings are not new.
  await expect(todos).not.toContainText("Sample Couple");
  const open = todos.getByRole("link", { name: "予約を見る" }).first();
  await expect(open).toHaveAttribute("href", new RegExp(`ota=${JALAN}`));
  await open.click();
  await expect(detail(page, "見本 花子")).toBeVisible();
});

test("この回: the session's OTA guests with their site's badge and phone, and no message to them", async ({ page }) => {
  await signIn(page);
  await page.goto("/host/bookings");
  await list(page).getByRole("link", { name: /10月22日（木）18:00/ }).click();
  await expect(page).toHaveURL(/\/host\/bookings\/session\?/);
  await expect(page.getByText(/取消・返金・予約者とのやりとりは、その予約サイトで行ってください/)).toBeVisible();
  const guests = page.getByRole("region", { name: "参加者" });
  const traveler = guests.getByRole("listitem").filter({ hasText: "Sample Traveler" });
  await expect(traveler).toContainText("GetYourGuide");
  await expect(traveler).toContainText("予約番号 GYG-SAMPLE-1042");
  await expect(traveler.getByRole("link", { name: /\+44 20 0000 0000/ })).toHaveAttribute("href", /^tel:/);
  await expect(traveler.getByRole("link", { name: "メッセージ" })).toHaveCount(0);
  await audit(page, "この回 with an OTA guest");
});

test("PC and phones: nothing scrolls sideways", async ({ page }) => {
  await signIn(page);
  for (const path of ["/host/bookings", `/host/bookings?ota=${GYG}`, "/host/home"]) {
    await page.goto(path);
    await expect(page.locator("main").first()).toBeVisible();
    expect(await overflowX(page), path).toBeLessThanOrEqual(0);
  }
});

test.describe("320px narrow phone", () => {
  test.use({ viewport: { width: 320, height: 640 } });
  test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== "host-mobile-360"));

  test("the list, an OTA booking, ホーム and この回 fit", async ({ page }) => {
    await signIn(page);
    for (const path of ["/host/bookings", "/host/bookings?filter=cancelled", `/host/bookings?ota=${GYG}`, `/host/bookings?ota=${JALAN}`, "/host/home"]) {
      await page.goto(path);
      await expect(page.locator("main").first()).toBeVisible();
      expect(await overflowX(page), path).toBeLessThanOrEqual(0);
    }
    await page.goto(`/host/bookings?ota=${GYG}`);
    const email = detail(page, "Sample Traveler").getByRole("link", { name: "traveler@example.com" });
    const box = await email.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 320).toBe(true);
  });
});
