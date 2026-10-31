import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

// 予約 as one list of NIHO's bookings and this site's (#84): the provider operations preview server
// (playwright.provider-operations.config.ts: 320px, 360px and PC) signed in with `?mock=site-bookings`, so this
// site's bookings come from the synthetic set (src/host/mock/site-bookings.ts) and NIHO's from the browser stubs
// below. Synthetic data only; nothing reaches NIHO.

const PROVIDER = "sample-provider-kitchen";
const DINNER = "Kamakura Community Dinner with Locals";
const NIHO_ROOT = `**/host/api/provider-operations/${PROVIDER}/bookings**`;

const item = (id: string, status: string, day: string, channel = "NIHO_PAGE") => ({
  id, pageId: "niho-page-dinner", offerId: "niho-offer-dinner", occurrenceDate: day,
  startAt: `${day}T09:00:00.000Z`, endAt: `${day}T11:00:00.000Z`, headCount: 2, offerName: "Dinner", totalYen: 60000,
  guestName: `合成予約者 ${id}`, pageTitle: DINNER, status, salesChannel: channel,
});
const detailOf = (booking: ReturnType<typeof item>, status: string) => ({
  booking: {
    id: booking.id, pageId: booking.pageId, pageTitle: booking.pageTitle, offerName: booking.offerName, occurrenceDate: booking.occurrenceDate,
    startAt: booking.startAt, endAt: booking.endAt, adultCount: 2, childCount: 0, guestName: booking.guestName, languageSnapshot: "JA",
    note: "合成のメモ", answers: null, status, totalYen: booking.totalYen, salesChannel: booking.salesChannel, hostMessages: [], guestMessages: [],
  },
});
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body), headers: { "cache-control": "private, no-store" } });

const list = (page: Page) => page.getByRole("region", { name: "予約の一覧" });
const row = (page: Page, guest: string) => list(page).getByRole("link", { name: new RegExp(`^${guest}`) });
const chip = (page: Page, label: string) => page.getByRole("list", { name: "予約の絞り込み" }).getByRole("link", { name: label, exact: true });
const nihoDetail = (page: Page) => page.getByRole("region", { name: "予約の詳細" });
const narrow = (page: Page) => (page.viewportSize()?.width ?? 0) < 1024;
const overflowX = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** NIHO's two bookings: a request on 10/24 and a booking from NIHO's experience site channel on 10/29. */
async function stubNiho(page: Page, options: { failList?: () => number | null } = {}) {
  const request = item("niho-request", "PROVISIONAL", "2026-10-24");
  const confirmed = item("niho-confirmed", "CONFIRMED", "2026-10-29", "EXPERIENCE_SITE");
  const statuses = new Map([[request.id, request.status], [confirmed.id, confirmed.status]]);
  const sent: string[] = [];
  await page.route(NIHO_ROOT, async (route) => {
    const call = route.request();
    const path = new URL(call.url()).pathname;
    if (call.method() !== "GET") sent.push(`${call.method()} ${path}`);
    if (path.endsWith("/bookings")) {
      const failed = options.failList?.() ?? null;
      if (failed) return json(route, { error: "synthetic" }, failed);
      return json(route, { bookings: [request, confirmed].map((booking) => ({ ...booking, status: statuses.get(booking.id) })), nextCursor: null });
    }
    if (path.endsWith("/approve")) { statuses.set(request.id, "CONFIRMED"); return json(route, { status: "CONFIRMED" }); }
    const booking = [request, confirmed].find((candidate) => path.endsWith(`/${candidate.id}`));
    return booking ? json(route, detailOf(booking, statuses.get(booking.id)!)) : json(route, { error: "permission_ended" }, 404);
  });
  return sent;
}

async function signIn(page: Page) {
  await page.goto("/host/auth/mock-login?mock=site-bookings");
  await page.waitForURL(/\/host\/home(\?|$)/);
}

test("NIHO's bookings and this site's are one list, told apart by their channel, with one experience to choose", async ({ page }) => {
  await stubNiho(page);
  await signIn(page);
  await page.goto("/host/bookings");
  await expect(page.getByText("NIHO の予約と、このサイトで受けた予約です。申込経路で見分けられます")).toBeVisible();
  await expect(row(page, "合成予約者 niho-request")).toContainText("2名 · ¥60,000 · NIHO");
  await expect(row(page, "合成予約者 niho-request")).toContainText("承認待ち");
  await expect(row(page, "合成予約者 niho-confirmed")).toContainText("NIHO（体験サイト）");
  await expect(row(page, "Hannah Kim")).toContainText("2名 · ¥60,000 · 体験サイト");
  // NIHO's page and this site's product of one experience are one choice.
  await expect(page.getByRole("combobox", { name: "体験" }).getByRole("option")).toHaveText(["すべての体験", DINNER]);
  // Both on 10/24 18:00, each under its own heading: this site's opens この回 (kept on ?source=site), NIHO's names it only.
  const headings = list(page).getByRole("heading", { level: 2 });
  await expect(headings.filter({ hasText: "10月24日（土）18:00" })).toHaveCount(2);
  await expect(headings.getByRole("link").first()).toHaveAttribute("href", /^\/host\/bookings\/session\?source=site&date=2026-10-24&start=18%3A00&experience=community-dinner/);
  await expect(headings.filter({ hasText: "10月24日（土）18:00" }).getByRole("link")).toHaveCount(1);

  await chip(page, "承認待ち").click();
  await expect(list(page).getByRole("listitem").getByRole("link")).toHaveCount(1);
  await expect(row(page, "合成予約者 niho-request")).toBeVisible();
  await page.getByRole("combobox", { name: "体験" }).selectOption(DINNER);
  await expect(row(page, "合成予約者 niho-request")).toBeVisible();
  await expect(page).toHaveURL(/filter=pending&experience=/);
  expect(await overflowX(page)).toBeLessThanOrEqual(0);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
});

test("each booking offers what its own source allows: NIHO's request is approved through NIHO, this site's shows its fees", async ({ page }) => {
  const sent = await stubNiho(page);
  await signIn(page);
  await page.goto("/host/bookings?filter=pending");
  await row(page, "合成予約者 niho-request").click();
  const niho = nihoDetail(page);
  await expect(niho.getByRole("heading", { level: 2, name: "合成予約者 niho-request" })).toBeVisible();
  await expect(niho).toContainText("NIHO で受けた予約です。承認・お断り・予約者への連絡は NIHO を通じて行います。");
  // NIHO's booking: no refund here, and its fees are NIHO's (not this site's 料金・精算状況).
  await expect(niho.getByRole("button", { name: /取り消して/ })).toHaveCount(0);
  await expect(niho.getByRole("region", { name: "料金・精算状況" })).toHaveCount(0);
  await niho.getByRole("button", { name: "承認する" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "決済して承認" }).click();
  await expect(niho.getByRole("status").filter({ hasText: "予約を承認しました" })).toBeVisible();
  await expect(niho.getByText("確定", { exact: true })).toBeVisible();
  expect(sent).toEqual([`POST /host/api/provider-operations/${PROVIDER}/bookings/niho-request/approve`]);
  // NIHO's list is read again: the request is a booking now.
  await page.goto("/host/bookings");
  await expect(row(page, "合成予約者 niho-request")).toContainText("確定");

  // This site's booking: its fees from the experience DB, and no 承認 (it is confirmed when paid).
  await page.goto("/host/bookings?booking=00000000-0000-4000-8000-00000000b101");
  const hannah = page.getByRole("region", { name: "Hannah Kim", exact: true });
  await expect(hannah.getByRole("region", { name: "料金・精算状況" })).toContainText("¥54,000");
  await expect(hannah.getByRole("button", { name: "承認する" })).toHaveCount(0);
  expect(await overflowX(page)).toBeLessThanOrEqual(0);
});

test("a NIHO booking named in the address opens from NIHO, and one NIHO does not have is not found", async ({ page }) => {
  await stubNiho(page);
  await signIn(page);
  await page.goto("/host/bookings?booking=niho-confirmed");
  await expect(nihoDetail(page).getByRole("heading", { level: 2, name: "合成予約者 niho-confirmed" })).toBeVisible();
  await expect(nihoDetail(page)).toContainText("NIHO（体験サイト）");
  await page.goto("/host/bookings?booking=niho-missing");
  await expect(nihoDetail(page).getByRole("alert")).toContainText("この予約は見つかりません");
  if (narrow(page)) await expect(page.getByRole("link", { name: "予約へ戻る" })).toBeVisible();
});

test("a message to NIHO's booking shown first keeps it on screen when the window narrows, still locked until checked", async ({ page }) => {
  test.skip(narrow(page), "The first booking shows beside the list from lg only");
  await stubNiho(page);
  let posts = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  // Registered last, so it runs first: NIHO's answer to the message waits, then cannot be confirmed (503).
  await page.route(`**/host/api/provider-operations/${PROVIDER}/bookings/niho-request/message`, async (route) => {
    posts += 1;
    await gate;
    await json(route, { error: "synthetic" }, 503);
  });
  await signIn(page);
  await page.goto("/host/bookings?filter=pending");
  const niho = nihoDetail(page);
  const heading = niho.getByRole("heading", { level: 2, name: "合成予約者 niho-request" });
  // From lg, the first booking shows beside the list without being chosen.
  await expect(heading).toBeVisible();
  await expect(page).not.toHaveURL(/booking=/);
  await niho.getByLabel("件名").fill("合成の件名");
  await niho.getByLabel("本文").fill("合成の本文");
  await niho.getByRole("button", { name: "送信内容を確認" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "この内容で送る" }).click();
  // The window narrows below lg while NIHO has the message: the booking stays (it is the chosen one now).
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(heading).toBeVisible();
  await expect(niho.getByRole("button", { name: "確認中…", exact: true })).toBeDisabled();
  await expect(page).toHaveURL(/booking=niho-request/);
  release();
  await expect(niho.getByText("直前の操作結果を確認してください")).toBeVisible();
  await expect(niho.getByRole("button", { name: "送信内容を確認" })).toBeDisabled();
  await expect(niho.getByLabel("本文")).toHaveValue("合成の本文");
  // Wide again: the page still keeps the host on this booking until the result is checked.
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(niho.getByText("直前の操作結果を確認してください")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "体験" })).toBeDisabled();
  await expect(niho.getByRole("button", { name: "送信内容を確認" })).toBeDisabled();
  expect(posts).toBe(1);
});

test("NIHO's list loading, failing and refused: this site's bookings stay, with why and a way to try again", async ({ page }) => {
  let answer: number | null = 503;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await stubNiho(page, { failList: () => answer });
  // Registered last, so it runs first: NIHO's first answer waits until the screen has been seen loading.
  await page.route(NIHO_ROOT, async (route) => {
    await gate;
    await route.fallback();
  });
  await signIn(page);
  await page.goto("/host/bookings");
  await expect(page.getByRole("status").filter({ hasText: "NIHO の予約を読み込み中…" })).toBeVisible();
  await expect(row(page, "Hannah Kim")).toBeVisible();
  release();
  const alert = page.getByRole("alert").filter({ hasText: "NIHO の予約を読み込めませんでした。このサイトで受けた予約だけを表示しています。" });
  await expect(alert).toBeVisible();
  await expect(row(page, "Hannah Kim")).toBeVisible();
  answer = null;
  await alert.getByRole("button", { name: "もう一度読み込む" }).click();
  await expect(row(page, "合成予約者 niho-request")).toBeVisible();
  await expect(alert).toHaveCount(0);

  answer = 403;
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "この提供者の予約を見る権限がありません" })).toBeVisible();
  await expect(row(page, "Hannah Kim")).toBeVisible();
  await expect(row(page, "合成予約者 niho-request")).toHaveCount(0);
  expect(await overflowX(page)).toBeLessThanOrEqual(0);
});
