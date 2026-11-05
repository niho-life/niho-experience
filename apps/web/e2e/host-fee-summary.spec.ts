import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("Experience fees use the booking snapshot and do not read a legacy NIHO fee panel", async ({ page }) => {
  const legacyReads: string[] = [];
  await page.route("**/host/api/bookings/*/fee-summary", (route) => { legacyReads.push(route.request().url()); return route.abort(); });
  await page.goto("/host/auth/mock-login");
  await page.waitForURL(/\/host\/home/);
  await page.goto("/host/bookings?booking=00000000-0000-4000-8000-00000000b103");
  const fee = page.getByRole("region", { name: "料金・精算状況" });
  for (const value of ["受付時 サポートON", "15%（決済費用込み）", "¥42,000", "¥6,300", "¥35,700"]) await expect(fee).toContainText(value);
  await expect(fee).not.toContainText("NIHO入出金差額");
  await page.goto("/host/bookings?booking=00000000-0000-4000-8000-00000000b102");
  await expect(fee).toContainText("返金後の受取額");
  await expect(fee).toContainText("¥0");
  expect(legacyReads).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  const axe = await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze();
  expect(axe.violations.filter((item) => item.impact === "serious" || item.impact === "critical")).toEqual([]);
});

test("unknown and other-provider reservations expose no snapshot amounts", async ({ page }) => {
  await page.goto("/host/auth/mock-login");
  await page.waitForURL(/\/host\/home/);
  for (const path of ["/host/bookings?booking=bk-2041", "/host/bookings?providerId=sample-provider-studio&booking=00000000-0000-4000-8000-00000000b103"]) {
    expect((await page.goto(path))?.status()).toBe(404);
    await expect(page.getByRole("region", { name: "料金・精算状況" })).toHaveCount(0);
  }
});
