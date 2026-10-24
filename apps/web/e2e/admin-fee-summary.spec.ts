import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const supportOn = { kind: "valid" as const, snapshot: { policyVersion: "2026-10-23" as const, enabled: true, baseRateBps: 1000 as const, supportRateBps: 500 as const, totalRateBps: 1500 as const, consentVersion: "2026-10-23" as const, consentedAt: "2026-10-23T01:00:00.000Z", consentedByUserId: "admin-1", agreementRevision: 2 }, normalOperationsAllowed: true };
const supportOff = { kind: "valid" as const, snapshot: { ...supportOn.snapshot, enabled: false, supportRateBps: 0 as const, totalRateBps: 1000 as const }, normalOperationsAllowed: false };
const provider = { kind: "EXPERIENCE_PROVIDER" as const, id: "provider-1", displayName: "合成工房", vesselSpotId: "spot-vessel" };
const spot = { kind: "SPOT" as const, id: "spot-1", displayName: "合成拠点" };
const ids = ["provider-on", "spot-off", "legacy", "free", "preparing", "cost-pending", "unknown", "review", "malformed", "wrong", "slow", "expired"] as const;
const list = ids.map((id, index) => ({ id, host: index % 2 ? spot : provider, pageId: `page-${id}`, experienceTitle: `合成体験 ${id}`, offerName: "午前", occurrenceDate: "2026-11-03", startAt: "2026-11-03T01:00:00.000Z", endAt: "2026-11-03T03:00:00.000Z", headCount: 2, totalYen: id === "free" ? 0 : 12_000, guestName: `Guest ${id}`, status: "PENDING", support: id === "spot-off" ? supportOff : supportOn, needsAttention: id === "review", createdAt: `2026-10-23T${String(index).padStart(2, "0")}:00:00.000Z` }));
const detail = (id: string) => { const source = list.find((item) => item.id === id); if (!source) return null; return { booking: { id, offerId: `offer-${id}`, offerName: source.offerName, occurrenceDate: source.occurrenceDate, startAt: source.startAt, endAt: source.endAt, headCount: 2, adultCount: 2, childCount: 0, guestName: source.guestName, guestEmail: "guest@example.invalid", languageSnapshot: "ja", note: null, answers: [], status: "PENDING", unitPriceYen: source.totalYen / 2, adultPriceYen: source.totalYen / 2, childPriceYen: null, totalYen: source.totalYen, paidAt: null, authorizedAt: source.createdAt, approvalDeadlineAt: "2026-10-24T01:00:00.000Z", travelerCancelRequestedAt: null, cancelledAt: null, cancelReason: null, cancelMessage: null, refundedYen: 0, createdAt: source.createdAt, salesChannel: "SYNTHETIC", hostMessages: [], pageId: source.pageId, page: { title: source.experienceTitle }, host: source.host, support: source.support }, supportAgreement: { agreementRevision: 2, sharedConsultationMemo: null, matchesBookingSnapshot: true } }; };
const policy = (enabled: boolean, gross = 12_000) => ({ supportEnabled: enabled, totalRateBps: enabled ? 1500 : 1000, originalGrossYen: gross, originalApplicationFeeYen: gross === 0 ? 0 : enabled ? 1_800 : 1_200, processingFeesIncluded: true, laborPaidDirectlyByHost: true });
const accounting = { successfulRefundedYen: 2_000, pendingRefundedYen: 1_000, targetTotalFeeYen: 1_500, applicationFeeRefundedYen: 300, targetApplicationFeeRefundYen: 300, processingCompensatedYen: 100, targetProcessingCompensationYen: 300, hostRetainedAfterCreditsYen: 8_300, netNihoCashYen: 1_400 };
const summary = (id: string) => {
  const base = { version: "1.0.0", bookingRequestId: id, status: "PROCESSING", feePolicy: policy(true), accounting, needsAttention: false, reason: "PRIVATE_LEDGER_REASON_MUST_NOT_RENDER", evidenceCheckedAt: "2026-10-23T01:00:00.000Z", settledAt: null };
  if (id === "spot-off") return { ...base, status: "SETTLED", feePolicy: policy(false), accounting: { ...accounting, successfulRefundedYen: 12_000, pendingRefundedYen: 0, targetTotalFeeYen: 0, applicationFeeRefundedYen: 1_200, targetApplicationFeeRefundYen: 1_200, processingCompensatedYen: 300, targetProcessingCompensationYen: 300, hostRetainedAfterCreditsYen: 0, netNihoCashYen: -300 }, settledAt: "2026-10-23T02:00:00.000Z" };
  if (id === "legacy") return { ...base, status: "LEGACY_NOT_RECORDED", feePolicy: null, accounting: null, reason: null };
  if (id === "free") return { ...base, status: "SETTLED", feePolicy: policy(true, 0), accounting: { ...accounting, successfulRefundedYen: 0, pendingRefundedYen: 0, targetTotalFeeYen: 0, applicationFeeRefundedYen: 0, targetApplicationFeeRefundYen: 0, processingCompensatedYen: 0, targetProcessingCompensationYen: 0, hostRetainedAfterCreditsYen: 0, netNihoCashYen: 0 } };
  if (id === "preparing") return { ...base, status: "PREPARING", accounting: null };
  if (id === "cost-pending") return { ...base, status: "PROCESSING_COST_PENDING", accounting: { ...accounting, processingCompensatedYen: null, targetProcessingCompensationYen: null } };
  if (id === "unknown") return { ...base, status: "RESULT_UNKNOWN", accounting: { ...accounting, successfulRefundedYen: null, pendingRefundedYen: 0, hostRetainedAfterCreditsYen: -500, netNihoCashYen: -200 } };
  if (id === "review") return { ...base, status: "REVIEW_REQUIRED", needsAttention: true };
  return base;
};

const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", headers: { "cache-control": "private, no-store" }, body: JSON.stringify(body) });

async function install(page: Page) {
  await page.route("**/admin/api/bookings**", async (route) => {
    const request = route.request(); const url = new URL(request.url());
    const fee = url.pathname.match(/^\/admin\/api\/bookings\/([^/]+)\/fee-summary$/);
    if (fee) {
      const id = decodeURIComponent(fee[1]!);
      if (id === "slow") { await new Promise((resolve) => setTimeout(resolve, 800)); return json(route, 200, { feeSummary: summary(id) }); }
      if (id === "expired") return json(route, 401, { error: "signed_out" });
      if (id === "malformed") return json(route, 200, { feeSummary: { ...summary(id), privateLedger: true } });
      if (id === "wrong") return json(route, 200, { feeSummary: summary("other-booking") });
      return json(route, 200, { feeSummary: summary(id) });
    }
    if (request.method() === "POST" && url.pathname === "/admin/api/bookings") return json(route, 200, { bookings: list, nextCursor: null });
    const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? ""); const found = detail(id); return json(route, found ? 200 : 404, found ?? { error: "not_found" });
  });
}

async function signIn(page: Page) { await page.goto("/admin"); await page.getByRole("button", { name: "合成Adminとして開く" }).click(); await page.waitForURL(/\/admin\/bookings/); }
async function open(page: Page, id: string) { await page.goto(`/admin/bookings?booking=${encodeURIComponent(id)}`); await expect(page.getByRole("heading", { name: `Guest ${id}` })).toBeVisible(); return page.getByRole("region", { name: "料金・精算状況" }); }

test.beforeEach(async ({ page }) => { await install(page); await signIn(page); });

test("shows API amounts without recalculation for ON/OFF, legacy, free, pending, unknown, review and null vs zero", async ({ page }, testInfo) => {
  let panel = await open(page, "provider-on"); await expect(page.getByRole("article")).toContainText("外部提供者"); await expect(panel).toContainText("受付時 サポートON"); await expect(panel).toContainText("15%（決済費用込み）"); await expect(panel).toContainText("顧客への返金（処理中）¥1,000"); await expect(panel).toContainText("ホスト残額¥8,300"); await expect(panel).toContainText("NIHO入出金差額¥1,400"); await expect(panel).not.toContainText("PRIVATE_LEDGER_REASON");
  panel = await open(page, "spot-off"); await expect(page.getByRole("article")).toContainText("通常拠点"); await expect(panel).toContainText("受付時 サポートOFF"); await expect(panel).toContainText("10%（決済費用込み）"); await expect(panel).toContainText("ホスト残額¥0"); await expect(panel).toContainText("決済費用の補填（完了）¥300"); await expect(panel).toContainText("NIHO入出金差額−¥300");
  panel = await open(page, "legacy"); await expect(panel).toContainText("料金記録なし"); await expect(panel).toContainText("料金の記録がなく、受付条件や精算額を画面から確定できません"); await expect(panel).toContainText("受付時の料金条件は未確認");
  panel = await open(page, "free"); await expect(panel).toContainText("受付時の合計¥0"); await expect(panel).toContainText("精算確認済み");
  panel = await open(page, "preparing"); await expect(panel).toContainText("精算準備中"); await expect(panel).toContainText("返金・精算の金額は未確認");
  panel = await open(page, "cost-pending"); await expect(panel).toContainText("決済費用を確認中"); await expect(panel).toContainText("決済費用の補填（完了）未確認");
  panel = await open(page, "unknown"); await expect(panel).toContainText("処理結果を確認中"); await expect(panel).toContainText("顧客への返金（完了）未確認"); await expect(panel).toContainText("顧客への返金（処理中）¥0"); await expect(panel).toContainText("ホスト残額−¥500"); await expect(panel).toContainText("NIHO入出金差額−¥200"); await expect(panel).toContainText("収益や利益を表す項目ではありません");
  panel = await open(page, "review"); await expect(panel).toContainText("要確認"); await expect(panel).toContainText("NIHO事務局による記録照合が必要です");
  panel = await open(page, "provider-on"); await expect(panel).toContainText("NIHO利用料の累計返還目標¥300"); await expect(panel).toContainText("決済費用の累計補填目標¥300"); await expect(panel).not.toContainText("返還予定"); await expect(panel).not.toContainText("補填予定");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  if (testInfo.project.name === "fee-summary-mobile-360") { await page.setViewportSize({ width: 320, height: 720 }); expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0); }
  const axe = await new AxeBuilder({ page }).include("article").withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze(); expect(axe.violations.filter((item) => item.impact === "serious" || item.impact === "critical")).toEqual([]);
});

test("malformed and wrong-booking responses clear amounts and offer explicit retry", async ({ page }) => {
  for (const id of ["malformed", "wrong"]) { const panel = await open(page, id); await expect(panel.getByRole("alert")).toContainText("応答を確認できませんでした"); await expect(panel.getByRole("button", { name: "もう一度試す" })).toBeVisible(); await expect(panel).not.toContainText("¥12,000"); }
});

test("a slow previous booking response cannot replace the selected booking", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "fee-summary-desktop", "desktop list keeps both booking selectors visible");
  await page.goto("/admin/bookings?booking=slow"); await expect(page.getByRole("heading", { name: "Guest slow" })).toBeVisible();
  await page.getByRole("button", { name: /Guest spot-off/ }).click(); const panel = page.getByRole("region", { name: "料金・精算状況" }); await expect(panel).toContainText("受付時 サポートOFF"); await page.waitForTimeout(900); await expect(panel).toContainText("受付時 サポートOFF"); await expect(panel).not.toContainText("受付時 サポートON");
});

test("401 removes all displayed fee data and expires the Admin view", async ({ page }) => {
  const panel = await open(page, "provider-on"); await expect(panel).toContainText("受付時の合計¥12,000");
  await page.goto("/admin/bookings?booking=expired"); await expect(page.getByRole("heading", { name: "管理者接続の有効期限が切れました" })).toBeVisible(); await expect(page.getByText("¥12,000", { exact: true })).toHaveCount(0);
});
