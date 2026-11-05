import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

// The ordinary preview uses the same synthetic Experience reservations as explicit ?mock=site-bookings.
const list = (page: Page) => page.getByRole("region", { name: "予約の一覧" });
const row = (page: Page, guest: string) => list(page).getByRole("link", { name: new RegExp(`^${guest}`) });
const chip = (page: Page, label: string) => page.getByRole("list", { name: "予約の絞り込み" }).getByRole("link", { name: label, exact: true });
const detail = (page: Page, guest: string) => page.getByRole("region", { name: guest, exact: true });
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

test("ordinary sign-in shows Experience bookings and filters without reading a legacy booking BFF", async ({ page }) => {
  const legacy: string[] = [];
  await page.route("**/host/api/provider-operations/**/bookings**", (route) => { legacy.push(route.request().url()); return route.abort(); });
  await signIn(page);
  await page.getByRole("navigation", { name: "ホストのメニュー" }).getByRole("link", { name: "予約" }).click();
  for (const name of ["Hannah Kim", "Noah Park", "Léa Dubois"]) await expect(row(page, name)).toBeVisible();
  await expect(row(page, "Priya Nair")).toHaveCount(0);
  await chip(page, "取消済み").click();
  for (const name of ["Kenji Sato", "Maya Cohen", "Oscar Lind"]) await expect(row(page, name)).toBeVisible();
  await expect(row(page, "Hannah Kim")).toHaveCount(0);
  expect(legacy).toEqual([]);
});

test("desktop and phone open the same native detail and retain the provider on its message link", async ({ page }, testInfo) => {
  await signIn(page, "?providerId=sample-provider-kitchen");
  await page.goto("/host/bookings?providerId=sample-provider-kitchen");
  if (testInfo.project.name === "host-desktop") await expect(detail(page, "Hannah Kim")).toBeVisible();
  else await expect(detail(page, "Hannah Kim")).not.toBeVisible();
  await row(page, "Noah Park").click();
  const booking = detail(page, "Noah Park");
  await expect(booking).toBeVisible();
  await expect(page).toHaveURL(/booking=00000000-0000-4000-8000-00000000b103/);
  await expect(booking.getByRole("button", { name: /承認する|お断り|取り消して/ })).toHaveCount(0);
  await expect(booking.getByRole("link", { name: "メッセージを開く" })).toHaveAttribute("href", "/host/messages?providerId=sample-provider-kitchen&booking=00000000-0000-4000-8000-00000000b103");
  await booking.getByRole("link", { name: "メッセージを開く" }).click();
  await expect(page.getByRole("heading", { name: "Noah Park さんとの連絡" })).toBeVisible();
});

test("another provider and unknown booking stay isolated", async ({ page }) => {
  await signIn(page);
  expect((await page.goto("/host/bookings?booking=another-booking"))?.status()).toBe(404);
  expect((await page.goto("/host/bookings?providerId=sample-provider-studio"))?.status()).toBe(404);
  await expect(detail(page, "Hannah Kim")).toHaveCount(0);
  expect((await page.goto("/host/bookings?providerId=sample-provider-studio&booking=00000000-0000-4000-8000-00000000b101"))?.status()).toBe(404);
});

test("native list and detail stay accessible and fit a narrow phone", async ({ page }) => {
  await signIn(page);
  for (const path of ["/host/bookings", "/host/bookings?filter=cancelled", "/host/bookings?booking=00000000-0000-4000-8000-00000000b101"]) {
    await page.goto(path);
    await expect(page.getByRole("heading").first()).toBeVisible();
    expect(await overflowX(page)).toBeLessThanOrEqual(0);
    await audit(page, path);
  }
});

test("通訳を始める shows the guest's QR, the host's own way in, who has joined, and ends in a dialog (#181)", async ({ page }, testInfo) => {
  await signIn(page);
  await page.goto("/host/bookings?booking=00000000-0000-4000-8000-00000000b102");
  await expect(detail(page, "Kenji Sato").getByRole("button", { name: "通訳を始める" })).toHaveCount(0);
  await page.goto("/host/bookings?booking=00000000-0000-4000-8000-00000000b101");
  const booking = detail(page, "Hannah Kim");
  const start = booking.getByRole("button", { name: "通訳を始める" });
  await expect(start).toBeVisible();
  await expect(booking.getByRole("button", { name: /取り消して/ })).toHaveCount(0);
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
