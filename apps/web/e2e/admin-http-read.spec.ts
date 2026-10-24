import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

type FixtureHost = { kind: "SPOT"; id: string; displayName: string } | { kind: "EXPERIENCE_PROVIDER"; id: string; displayName: string; vesselSpotId: string };
type FixtureSupport = typeof onSupport | typeof offSupport | typeof legacySupport | typeof invalidSupport;
interface FixtureBooking { id: string; host: FixtureHost; pageId: string; experienceTitle: string; offerName: string; occurrenceDate: string; startAt: string; endAt: string; headCount: number; totalYen: number; guestName: string; status: "PENDING"; support: FixtureSupport; needsAttention: boolean; createdAt: string }

const onSupport = { kind: "valid" as const, snapshot: { policyVersion: "2026-10-23" as const, enabled: true, baseRateBps: 1000 as const, supportRateBps: 500 as const, totalRateBps: 1500 as const, consentVersion: "2026-10-23" as const, consentedAt: "2026-10-23T01:00:00.000Z", consentedByUserId: "admin-1", agreementRevision: 2 }, normalOperationsAllowed: true };
const offSupport = { kind: "valid" as const, snapshot: { policyVersion: "2026-10-23" as const, enabled: false, baseRateBps: 1000 as const, supportRateBps: 0 as const, totalRateBps: 1000 as const, consentVersion: "2026-10-23" as const, consentedAt: "2026-10-23T01:00:00.000Z", consentedByUserId: "admin-1", agreementRevision: 1 }, normalOperationsAllowed: false };
const legacySupport = { kind: "legacy" as const, snapshot: null, normalOperationsAllowed: false as const };
const invalidSupport = { kind: "invalid" as const, snapshot: null, normalOperationsAllowed: false as const };

const booking = (id: string, guestName: string, host: FixtureHost, support: FixtureSupport, createdAt: string): FixtureBooking => ({
  id, host, pageId: `page-${id}`, experienceTitle: `体験 ${id}`, offerName: "午前", occurrenceDate: "2026-11-03", startAt: "2026-11-03T01:00:00.000Z", endAt: "2026-11-03T03:00:00.000Z", headCount: 2, totalYen: 12000, guestName, status: "PENDING", support, needsAttention: support.kind !== "valid", createdAt,
});

const provider = { kind: "EXPERIENCE_PROVIDER" as const, id: "provider-1", displayName: "サンプル工房", vesselSpotId: "spot-vessel" };
const spot = { kind: "SPOT" as const, id: "spot-1", displayName: "サンプル拠点" };
const allBookings: FixtureBooking[] = [
  booking("provider-on", "Provider Guest", provider, onSupport, "2026-10-23T04:00:00.000Z"),
  booking("spot-off", "Spot Guest", spot, offSupport, "2026-10-23T03:00:00.000Z"),
  booking("legacy-booking", "Legacy Guest", provider, legacySupport, "2026-10-23T02:00:00.000Z"),
  booking("invalid-booking", "Invalid Guest", spot, invalidSupport, "2026-10-23T01:00:00.000Z"),
];

function detail(id: string) {
  const source = id === "deep-spot" ? booking("deep-spot", "Deep Link Guest", spot, offSupport, "2026-10-23T05:00:00.000Z") : allBookings.find((item) => item.id === id);
  if (!source) return null;
  return { booking: { id: source.id, offerId: `offer-${id}`, offerName: source.offerName, occurrenceDate: source.occurrenceDate, startAt: source.startAt, endAt: source.endAt, headCount: source.headCount, adultCount: 2, childCount: 0, guestName: source.guestName, guestEmail: "", languageSnapshot: "future-language", note: null, answers: null, status: source.status, unitPriceYen: 6000, adultPriceYen: 6000, childPriceYen: null, totalYen: source.totalYen, paidAt: null, authorizedAt: "2026-10-23T01:01:00.000Z", approvalDeadlineAt: "2026-10-24T01:00:00.000Z", travelerCancelRequestedAt: null, cancelledAt: null, cancelReason: null, cancelMessage: null, refundedYen: 0, createdAt: source.createdAt, salesChannel: "FUTURE_CHANNEL", hostMessages: [{ id: `message-${id}`, subject: "Application received", createdAt: source.createdAt, sentAt: null, failed: false, deliveryStatus: "QUEUED" }], pageId: source.pageId, page: { title: source.experienceTitle }, host: source.host, support: source.support }, supportAgreement: { agreementRevision: source.support.kind === "valid" ? source.support.snapshot.agreementRevision : null, sharedConsultationMemo: null, matchesBookingSnapshot: source.support.kind === "valid" } };
}

const notices = [
  { id: "notice-1", type: "APPLICATION_RECEIVED", title: "新規申込", body: "合成の通知本文です。", bookingRequestId: "provider-on", occurredAt: "2026-10-23T04:00:00.000Z", readAt: null },
  { id: "notice-2", type: "TRAVELER_CANCEL_REQUESTED", title: "取消申出", body: "旅行者から取消申出があります。", bookingRequestId: "spot-off", occurredAt: "2026-10-23T03:00:00.000Z", readAt: null },
  { id: "notice-3", type: "REFUND_NEEDED", title: "返金確認", body: "返金確認が必要です。", bookingRequestId: "legacy-booking", occurredAt: "2026-10-23T02:00:00.000Z", readAt: null },
];

async function installContractStubs(page: Page) {
  const readAt = new Map<string, string>();
  let notificationFirstPageReads = 0;
  let bookingRetryAttempts = 0;
  await page.route("**/admin/api/bookings**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "POST" && url.pathname === "/admin/api/bookings") {
      const query = route.request().postDataJSON() as Record<string, string>;
      if (query.search === "expire-session") {
        await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "signed_out" }) });
        return;
      }
      if (query.search === "retry-once" && bookingRetryAttempts++ === 0) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) });
        return;
      }
      if (query.search === "slow") await new Promise((resolve) => setTimeout(resolve, 650));
      if (query.cursor === "page-2") await new Promise((resolve) => setTimeout(resolve, 650));
      let rows = query.search === "retry-once" ? [allBookings[0]!] : allBookings;
      const search = query.search === "retry-once" ? undefined : query.search;
      const hostSearch = query.hostSearch;
      const support = query.support;
      if (search) rows = rows.filter((item) => `${item.id} ${item.guestName}`.toLowerCase().includes(search.toLowerCase()));
      if (hostSearch) rows = rows.filter((item) => item.host.displayName.includes(hostSearch));
      if (support) rows = rows.filter((item) => support === "legacy" ? item.support.kind !== "valid" : item.support.kind === "valid" && item.support.snapshot.enabled === (support === "on"));
      const offset = query.cursor === "page-2" ? 2 : 0;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ bookings: rows.slice(offset, offset + 2), nextCursor: offset === 0 && rows.length > 2 ? "page-2" : null }) });
      return;
    }
    const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    const response = detail(id);
    await route.fulfill({ status: response ? 200 : 404, contentType: "application/json", body: JSON.stringify(response ?? { error: "not_found" }) });
  });
  await page.route("**/admin/api/notifications**", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const ids = (request.postDataJSON() as { notificationIds: string[] }).notificationIds;
      if (ids.includes("notice-3")) {
        await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "signed_out" }) });
        return;
      }
      for (const id of ids) if (!readAt.has(id)) readAt.set(id, "2026-10-23T06:00:00.000Z");
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ notifications: ids.map((id) => ({ id, readAt: readAt.get(id) })), unreadCount: notices.filter((item) => !readAt.has(item.id)).length }) });
      return;
    }
    const url = new URL(request.url());
    const unreadOnly = url.searchParams.get("unread") === "true";
    const offset = url.searchParams.get("cursor") === "notice-page-2" ? 2 : 0;
    const source = notices.slice(offset).map((item) => ({ ...item, readAt: readAt.get(item.id) ?? item.readAt })).filter((item) => !unreadOnly || item.readAt === null);
    const body = JSON.stringify({ notifications: source.slice(0, 2), unreadCount: notices.filter((item) => !readAt.has(item.id)).length, nextCursor: offset === 0 && source.length > 2 ? "notice-page-2" : null });
    if (offset === 0) notificationFirstPageReads += 1;
    if (offset > 0 || notificationFirstPageReads === 2) await new Promise((resolve) => setTimeout(resolve, 650));
    await route.fulfill({ status: 200, contentType: "application/json", body });
  });
}

async function signIn(page: Page) {
  await page.goto("/admin");
  await page.getByRole("button", { name: "合成Adminとして開く" }).click();
  await page.waitForURL(/\/admin\/bookings/);
}

const overflowX = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.beforeEach(async ({ page }) => { await installContractStubs(page); });

test("shows API booking, deadline and notification instants in Japan time", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("region", { name: "予約一覧" })).toContainText("2026/11/3 10:00 JST");
  await page.getByRole("button", { name: /Provider Guest/ }).click();
  const detail = page.getByRole("article");
  await expect(detail).toContainText("2026/11/3 10:00 JST〜2026/11/3 12:00 JST");
  await expect(detail).toContainText("2026/10/23 10:01 JST");
  await expect(detail).toContainText("2026/10/24 10:00 JST");
  await page.getByRole("link", { name: /^通知/ }).click();
  await expect(page.getByRole("article").filter({ hasText: "新規申込" })).toContainText("2026/10/23 13:00 JST");
});

test("typed read UI uses API pagination, both host kinds, legacy/invalid and deep links", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("region", { name: "予約一覧" })).toContainText("Provider Guest");
  await expect(page.getByRole("region", { name: "予約一覧" })).toContainText("Spot Guest");
  await page.getByRole("button", { name: "次の50件を読み込む" }).click();
  await expect(page.getByRole("region", { name: "予約一覧" })).toContainText("旧予約・条件未記録");
  await expect(page.getByRole("region", { name: "予約一覧" })).toContainText("支援条件を確認できません");
  await page.goto("/admin/bookings?booking=deep-spot");
  await expect(page.getByRole("article")).toContainText("Deep Link Guest");
  await expect(page.getByRole("article")).toContainText("通常拠点");
  await expect(page.getByRole("article")).toContainText("予約対応は準備中です。承認・辞退・取消／返金・連絡の送信は行いません。");
  await expect(page.getByRole("article").getByRole("button")).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/bookings$/);
  await page.goForward();
  await expect(page.getByRole("article")).toContainText("Deep Link Guest");
});

test("query input stays out of browser URL and stale responses cannot replace the latest result", async ({ page }) => {
  await signIn(page);
  const search = page.getByRole("searchbox", { name: "予約ID・予約者を検索" });
  await search.fill("slow");
  await page.waitForTimeout(280);
  await search.fill("Spot Guest");
  await expect(page.getByRole("region", { name: "予約一覧" })).toContainText("Spot Guest");
  await expect(page.getByRole("region", { name: "予約一覧" })).not.toContainText("Provider Guest");
  expect(page.url()).not.toContain("slow");
  expect(page.url()).not.toContain("Spot");
});

test("editing filters while loading a cursor discards the old cursor and keeps the new query pageable", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "次の50件を読み込む" }).click();
  await page.getByRole("searchbox", { name: "ホスト名を検索" }).fill("サンプル");
  await expect(page.getByRole("region", { name: "予約一覧" })).toContainText("Provider Guest");
  await page.waitForTimeout(700);
  await expect(page.getByRole("button", { name: "次の50件を読み込む" })).toBeEnabled();
  await page.getByRole("button", { name: "次の50件を読み込む" }).click();
  await expect(page.getByRole("region", { name: "予約一覧" })).toContainText("Legacy Guest");
});

test("clearing an already empty filter can reload and paginate again", async ({ page }, testInfo) => {
  await signIn(page);
  await expect(page.getByRole("region", { name: "予約一覧" })).toContainText("Provider Guest");
  if (testInfo.project.name === "admin-read-mobile-360") await page.getByRole("button", { name: /詳細条件/ }).click();
  await page.getByRole("button", { name: "条件をクリア" }).click();
  await expect(page.getByRole("button", { name: "次の50件を読み込む" })).toBeEnabled();
  await page.getByRole("button", { name: "次の50件を読み込む" }).click();
  await expect(page.getByRole("region", { name: "予約一覧" })).toContainText("Legacy Guest");
});

test("a 401 clears already displayed booking data before rechecking the admin session", async ({ page }) => {
  await signIn(page);
  const list = page.getByRole("region", { name: "予約一覧" });
  await expect(list).toContainText("Provider Guest");
  await page.getByRole("searchbox", { name: "予約ID・予約者を検索" }).fill("expire-session");
  await expect(page.getByRole("alert").filter({ hasText: "もう一度サインイン" })).toBeVisible();
  await expect(list).toHaveCount(0);
  await expect(page.getByText("Provider Guest", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Spot Guest", { exact: true })).toHaveCount(0);
});

test("an initial query failure can retry the unchanged body while keeping prior data", async ({ page }) => {
  await signIn(page);
  const list = page.getByRole("region", { name: "予約一覧" });
  await expect(list).toContainText("Spot Guest");
  await page.getByRole("searchbox", { name: "予約ID・予約者を検索" }).fill("retry-once");
  const alert = page.getByRole("alert").filter({ hasText: "表示中の結果は更新していません" });
  await expect(alert).toContainText("表示中の結果は更新していません");
  await expect(list).toContainText("Spot Guest");
  await alert.getByRole("button", { name: "もう一度試す" }).click();
  await expect(list).toContainText("Provider Guest");
  await expect(list).not.toContainText("Spot Guest");
});

test("notification pages expose global unread count and update only after whole-page success", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: /通知/ }).click();
  await expect(page.getByRole("button", { name: "未読 3件" })).toBeVisible();
  await expect(page.getByText("読み込みページ 1 · 2件")).toBeVisible();
  await page.getByRole("button", { name: "次の50件を読み込む" }).click();
  await page.getByRole("button", { name: "手動で更新" }).click();
  await page.getByRole("button", { name: "このページの未読2件を既読にする" }).click();
  await expect(page.getByRole("button", { name: "未読 1件" })).toBeVisible();
  await page.waitForTimeout(700);
  await expect(page.getByRole("button", { name: "未読 1件" })).toBeVisible();
  await expect(page.getByText("既読", { exact: true })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "次の50件を読み込む" })).toBeEnabled();
  await page.getByRole("button", { name: "次の50件を読み込む" }).click();
  await expect(page.getByText("読み込みページ 2 · 1件")).toBeVisible();
});

test("marking unread notifications removes them and preserves the next keyset page", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: /通知/ }).click();
  await page.getByRole("button", { name: "未読 3件" }).click();
  const list = page.getByRole("region", { name: "通知一覧" });
  const first = list.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "新規申込", exact: true }) });
  await first.getByRole("button", { name: "既読にする", exact: true }).click();
  await expect(first).toHaveCount(0);
  await expect(page.getByRole("button", { name: "未読 2件" })).toBeVisible();
  await page.getByRole("button", { name: "このページの未読1件を既読にする" }).click();
  await expect(list.getByRole("listitem")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "未読 1件" })).toBeVisible();
  await page.getByRole("button", { name: "次の50件を読み込む" }).click();
  await expect(list.getByRole("heading", { name: "返金確認", exact: true })).toBeVisible();
  await expect(list.getByText("既読", { exact: true })).toHaveCount(0);
});

test("a notification write 401 clears notifications and the global unread count", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: /通知/ }).click();
  await expect(page.getByRole("button", { name: "未読 3件" })).toBeVisible();
  await page.getByRole("button", { name: "次の50件を読み込む" }).click();
  const notificationList = page.getByRole("region", { name: "通知一覧" });
  const refundNotice = notificationList.getByRole("listitem").filter({ hasText: "返金確認" });
  await expect(refundNotice).toBeVisible();
  await refundNotice.getByRole("button", { name: "既読にする" }).click();
  await expect(page.getByRole("region", { name: "通知一覧" }).getByRole("alert")).toContainText("もう一度サインイン");
  await expect(page.getByRole("button", { name: "未読 件数不明" })).toBeVisible();
  await expect(notificationList.getByRole("listitem")).toHaveCount(0);
});

test.describe("typed read accessibility", () => {
  test("320px and keyboard/axe stay usable", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "admin-read-mobile-360");
    await page.setViewportSize({ width: 320, height: 640 });
    await signIn(page);
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "本文へ移動" })).toBeFocused();
    await expect(page.getByRole("region", { name: "予約一覧" })).toBeVisible();
    expect(await overflowX(page)).toBeLessThanOrEqual(0);
    await page.getByRole("button", { name: /Provider Guest/ }).click();
    await expect(page.getByRole("button", { name: "予約支援へ戻る" })).toBeVisible();
    expect(await overflowX(page)).toBeLessThanOrEqual(0);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze();
    expect(results.violations.filter((item) => item.impact === "serious" || item.impact === "critical")).toEqual([]);
  });
});
