import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const policy = { supportEnabled: true, totalRateBps: 1500, originalGrossYen: 60_000, originalApplicationFeeYen: 9_000, processingFeesIncluded: true, laborPaidDirectlyByHost: true };
const accounting = { successfulRefundedYen: 0, pendingRefundedYen: 0, targetTotalFeeYen: 9_000, applicationFeeRefundedYen: 0, targetApplicationFeeRefundYen: 0, processingCompensatedYen: 0, targetProcessingCompensationYen: 0, hostRetainedAfterCreditsYen: 51_000, netNihoCashYen: null };
const fee = (id: string, successfulRefundedYen = 0) => ({ feeSummary: { version: "1.0.0", bookingRequestId: id, status: "SETTLED", feePolicy: policy, accounting: { ...accounting, successfulRefundedYen, ...(successfulRefundedYen === 3_000 ? { targetTotalFeeYen: 8_550, applicationFeeRefundedYen: 450, targetApplicationFeeRefundYen: 450, hostRetainedAfterCreditsYen: 48_450, netNihoCashYen: null } : {}) }, needsAttention: false, reason: null, evidenceCheckedAt: "2026-10-23T01:00:00.000Z", settledAt: "2026-10-23T02:00:00.000Z" } });
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "cache-control": "private, no-store" }, body: JSON.stringify(body) });

async function signIn(page: Page) { await page.goto("/host"); await page.getByRole("link", { name: "NIHO でログイン" }).click(); await page.waitForURL(/\/host\/home/); }

test("host reads the same API amounts independently from support history and never sees NIHO cash", async ({ page }, testInfo) => {
  let reads = 0;
  await page.route("**/host/api/bookings/*/fee-summary", async (route) => { const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2) ?? ""); reads += 1; return json(route, fee(id, reads === 1 ? 0 : 3_000)); });
  await signIn(page); await page.goto("/host/bookings?booking=bk-2041");
  const panel = page.getByRole("region", { name: "料金・精算状況" }); await expect(panel).toContainText("受付時 サポートON"); await expect(panel).toContainText("15%（決済費用込み）"); await expect(panel).toContainText("顧客への返金（完了）¥0"); await expect(panel).toContainText("NIHO利用料の累計返還目標¥0"); await expect(panel).toContainText("決済費用の累計補填目標¥0"); await expect(panel).toContainText("ホスト残額¥51,000"); await expect(panel).not.toContainText("NIHO入出金差額");
  await expect(page.getByRole("heading", { name: "NIHOサポート", exact: true })).toBeVisible();
  const refreshButton = panel.getByRole("button", { name: "最新の記録を再取得" }); await refreshButton.focus(); await page.keyboard.press("Enter"); await expect(panel).toContainText("顧客への返金（完了）¥3,000"); await expect(refreshButton).toBeFocused(); await expect(panel).toContainText("ホスト残額¥48,450"); expect(reads).toBe(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  if (testInfo.project.name === "fee-summary-mobile-360") { await page.setViewportSize({ width: 320, height: 720 }); expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0); }
  const axe = await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze(); expect(axe.violations.filter((item) => item.impact === "serious" || item.impact === "critical")).toEqual([]);
});

test("not-found and network failures stay distinct and retry is explicit", async ({ page }) => {
  let networkAttempt = 0;
  await page.route("**/host/api/bookings/*/fee-summary", async (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2) ?? "");
    if (id === "bk-2038") return json(route, { error: "not_found" }, 404);
    if (id === "bk-2035" && networkAttempt++ === 0) return route.abort("connectionfailed");
    return json(route, fee(id));
  });
  await signIn(page); await page.goto("/host/bookings?booking=bk-2038"); let panel = page.getByRole("region", { name: "料金・精算状況" }); await expect(panel).toContainText("料金記録は見つかりませんでした"); await expect(panel.getByRole("button", { name: "もう一度確認" })).toBeVisible();
  await page.goto("/host/bookings?booking=bk-2035"); panel = page.getByRole("region", { name: "料金・精算状況" }); await expect(panel.getByRole("alert")).toContainText("通信できず"); await panel.getByRole("button", { name: "もう一度試す" }).click(); await expect(panel).toContainText("精算確認済み");
});

test("403 clears amounts and reports lost access without a mock success fallback", async ({ page }) => {
  await page.route("**/host/api/bookings/*/fee-summary", async (route) => { const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2) ?? ""); return id === "bk-2020" ? json(route, { error: "forbidden" }, 403) : json(route, fee(id)); });
  await signIn(page); await page.goto("/host/bookings?booking=bk-2041"); await expect(page.getByRole("region", { name: "料金・精算状況" })).toContainText("¥60,000");
  await page.goto("/host/bookings?booking=bk-2020"); const panel = page.getByRole("region", { name: "料金・精算状況" }); await expect(panel.getByRole("alert")).toContainText("表示していた金額を消去しました"); await expect(panel).not.toContainText("¥60,000");
});
