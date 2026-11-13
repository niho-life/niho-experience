import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * 旅行者のアカウント (Epic #591, #597) in the preview: an English log in page with no NIHO in front, a button for each way in, and
 * the account page after it. This server runs with EXPERIENCE_TRAVELER_ACCOUNTS_ENABLED; the preview walks a synthetic traveler
 * (no provider, no NIHO, no database).
 */

async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

test("the log in page is English, offers Google (not LINE until NIHO's LINE provider moves), one sentence of consent, and names NIHO only in the last small button", async ({ page }) => {
  await page.goto("/account/sign-in");
  await expect(page.getByRole("heading", { level: 1, name: "Log in or sign up" })).toBeVisible();
  const main = page.getByRole("main");
  await expect(main.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  // LINE waits for EXPERIENCE_TRAVELER_LINE_ENABLED (after NIHO's LINE provider moves, 2027-01): this server leaves it off.
  await expect(main.getByRole("button", { name: /LINE/ })).toHaveCount(0);
  await expect(main.getByRole("button", { name: /Apple/ })).toHaveCount(0);
  await expect(main).toContainText("By continuing, you agree to our");
  await expect(main.getByRole("link", { name: "Privacy Notice" })).toHaveAttribute("href", "/privacy");
  await expect(main).toContainText("You can still book as a guest without an account.");
  const text = await main.innerText();
  expect(text.match(/NIHO/g)).toHaveLength(1);
  expect(text).not.toMatch(/connect/i);
  expect(text.indexOf("Log in with a NIHO account")).toBeGreaterThan(text.indexOf("Continue with Google"));
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await noHorizontalScroll(page);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("a way in logs the traveler in, the account page lets them log out, and the pages follow the session", async ({ page }) => {
  await page.goto("/account");
  await page.waitForURL(/\/account\/sign-in$/);
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await page.waitForURL(/\/account$/);
  await expect(page.getByRole("heading", { level: 1, name: "Your account" })).toBeVisible();
  await expect(page.getByRole("main")).toContainText("You’re logged in.");
  expect(await page.getByRole("main").innerText()).not.toMatch(/NIHO|connect/i);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  // A logged-in traveler does not see the log in page again.
  await page.goto("/account/sign-in");
  await page.waitForURL(/\/account$/);
  await page.getByRole("button", { name: "Log out" }).click();
  await page.waitForURL(/\/account\/sign-in$/);
  await page.goto("/account");
  await page.waitForURL(/\/account\/sign-in$/);
});

test("the existing NIHO account's way in is the same preview round trip", async ({ page }) => {
  await page.goto("/account/sign-in");
  await page.getByRole("button", { name: "Log in with a NIHO account" }).click();
  await page.waitForURL(/\/account$/);
});

test("a log in that did not finish says why, in words that name nobody", async ({ page }) => {
  for (const [error, words] of [["denied", "cancelled"], ["unavailable", "couldn't log you in"], ["expired", "took too long"], ["suspended", "can't log in"]] as const) {
    await page.goto(`/account/sign-in?error=${error}`);
    await expect(page.getByRole("main").getByRole("alert")).toContainText(words);
    expect((await page.getByRole("main").innerText()).match(/NIHO/g)).toHaveLength(1);
  }
  await page.goto("/account/sign-in?error=%3Cscript%3E");
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
});

test("the traveler session is not a host's: the console still asks for its own log in, and a cross-site post starts nothing", async ({ page, request }) => {
  await page.goto("/account/sign-in");
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await page.waitForURL(/\/account$/);
  const cookies = await page.context().cookies();
  expect(cookies.map((cookie) => cookie.name)).toContain("__Host-niho_traveler_session");
  expect(cookies.map((cookie) => cookie.name).filter((name) => /host_(account_)?session/.test(name))).toEqual([]);
  const crossSite = await request.post("/account/auth/start", { headers: { origin: "https://evil.example.test", "sec-fetch-site": "cross-site", "content-type": "application/x-www-form-urlencoded" }, data: "method=google", maxRedirects: 0 });
  expect(crossSite.status()).toBe(403);
});
