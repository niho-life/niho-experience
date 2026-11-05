import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const SESSION = "/host/bookings/session?date=2026-10-24&start=18%3A00&experience=community-dinner&offer=offer-dinner";
const BOOKING = "00000000-0000-4000-8000-00000000b101";
async function signIn(page: Page) {
  await page.goto("/host/auth/mock-login");
  await page.waitForURL(/\/host\/home/);
}

test("ordinary preview home, booking group and session show the same Experience guests", async ({ page }) => {
  await signIn(page);
  const upcoming = page.getByRole("region", { name: "これからの開催" });
  await upcoming.locator(`a[href="${SESSION}"]`).click();
  await expect(page).toHaveURL(new RegExp("/host/bookings/session\\?date=2026-10-24"));
  await expect(page.getByRole("region", { name: "参加者", exact: true })).toContainText("Hannah Kim");
  await expect(page.getByRole("region", { name: "この回", exact: true })).toContainText("参加 2 名");
  await expect(page.getByRole("button", { name: "この回を中止する" })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Hannah Kim さんの出欠" })).toHaveCount(0);
  await page.getByRole("link", { name: "予約へ戻る", exact: true }).first().click();
  await expect(page).toHaveURL(/\/host\/bookings$/);
  await page.goto(`/host/bookings?booking=${BOOKING}`);
  await expect(page.getByRole("region", { name: "Hannah Kim", exact: true })).toContainText("10月24日");
});

test("session contact opens the matching native booking conversation without a write", async ({ page }) => {
  await signIn(page);
  const sent: string[] = [];
  page.on("request", (request) => { if (request.method() !== "GET") sent.push(request.url()); });
  await page.goto(SESSION);
  await page.getByRole("button", { name: "参加者に連絡する" }).click();
  const dialog = page.getByRole("dialog");
  const contact = dialog.getByRole("link", { name: "メッセージを開く" });
  await expect(contact).toHaveAttribute("href", `/host/messages?booking=${BOOKING}`);
  await contact.click();
  await expect(page.getByRole("heading", { name: "Hannah Kim さんとの連絡" })).toBeVisible();
  expect(sent).toEqual([]);
});

test("a different provider or session never exposes the preview's guests", async ({ page }) => {
  await signIn(page);
  expect((await page.goto(`${SESSION}&providerId=sample-provider-studio`))?.status()).toBe(404);
  expect((await page.goto(SESSION.replace("2026-10-24", "2026-10-23")))?.status()).toBe(404);
});

test("the native session is accessible and fits a phone", async ({ page }) => {
  await signIn(page);
  await page.goto(SESSION);
  await expect(page.getByRole("region", { name: "参加者", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(result.violations).toEqual([]);
});
