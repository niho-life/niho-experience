import { expect, test } from "@playwright/test";
import { bar, chooseFirstMarkedDay, searchKeyword } from "./support/search-bar";

test("search filters the server-rendered list and browser history restores the URL state", async ({ page }) => {
  await page.goto("/experiences");
  await searchKeyword(page, "POTTERY");

  await expect(page).toHaveURL(/\/experiences\?q=POTTERY$/);
  await expect(page.getByRole("status").first()).toContainText("1 experience");
  await expect(page.getByRole("link", { name: /evening pottery session/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /home-cooked dinner/i })).toHaveCount(0);

  await page.goBack();
  await expect(page).toHaveURL(/\/experiences$/);
  await expect(page.getByRole("status").first()).toContainText("4 experiences");
  await page.goForward();
  await expect(page).toHaveURL(/\/experiences\?q=POTTERY$/);
  await expect(page.getByRole("status").first()).toContainText("1 experience");
});

test("the search bar is a plain GET form to the list, and arriving with a word shows it", async ({ page }) => {
  await page.goto("/experiences");
  const form = bar(page);
  await expect(form).toHaveAttribute("method", "get");
  await expect(form).toHaveAttribute("action", "/experiences");
  await page.goto("/experiences?q=pottery");
  await expect(bar(page).locator('input[name="q"]')).toHaveValue("pottery");
  await expect(page.getByRole("link", { name: /evening pottery session/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /home-cooked dinner/i })).toHaveCount(0);
});

test("an unmatched search explains how to clear it", async ({ page }) => {
  await page.goto("/experiences?q=not-a-real-experience");
  await expect(page.getByRole("heading", { name: "No experiences match your search" })).toBeVisible();
  await page.getByRole("link", { name: "Clear search" }).click();
  await expect(page).toHaveURL(/\/experiences$/);
  await expect(page.getByRole("status").first()).toContainText("4 experiences");
});

test("theme and scheduled-date filters stay in the URL and restore with browser history", async ({ page }) => {
  await page.goto("/experiences");
  await page.getByLabel("Theme").selectOption("FOOD");

  await expect(page).toHaveURL("/experiences?theme=FOOD");
  await expect(page.getByRole("status").first()).toContainText("2 experiences");
  const dayLabel = await chooseFirstMarkedDay(page);
  await expect(page).toHaveURL(/\/experiences\?theme=FOOD&date=\d{4}-\d{2}-\d{2}$/);
  await expect(page.getByRole("status").first()).toContainText(`on ${dayLabel}`);
  await expect(page.getByRole("status").first()).toContainText(/\d experiences?/);

  await page.goBack();
  await expect(page).toHaveURL("/experiences?theme=FOOD");
  await expect(page.getByRole("status").first()).toContainText("2 experiences");
  await page.goForward();
  await expect(page).toHaveURL(/\/experiences\?theme=FOOD&date=\d{4}-\d{2}-\d{2}$/);
});

test("first-touch booking attribution survives client navigation through filters", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "__nihoDocumentMarker", { value: crypto.randomUUID(), configurable: true });
  });
  await page.goto("/experiences?utm_source=niho_site&utm_campaign=pilot_2026q4");
  const documentMarker = await page.evaluate(() => (window as Window & { __nihoDocumentMarker?: string }).__nihoDocumentMarker);

  await page.getByLabel("Theme").selectOption("FOOD");
  await expect(page).toHaveURL(/\/experiences\?theme=FOOD$/);
  await expect(page.getByRole("link", { name: /home-cooked dinner/i })).toBeVisible();
  expect(await page.evaluate(() => (window as Window & { __nihoDocumentMarker?: string }).__nihoDocumentMarker)).toBe(documentMarker);

  await page.getByRole("link", { name: /home-cooked dinner/i }).click();
  await page.getByRole("link", { name: /^Check dates/ }).click();
  await page.locator('input[name="occurrence"]:not([disabled])').first().check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("textbox", { name: "Full name" }).fill("Sample Guest");
  await page.getByRole("textbox", { name: "Email" }).fill("guest@example.com");
  await page.getByRole("checkbox", { name: /agree to version/ }).check();
  await page.getByRole("button", { name: "Continue to mock payment" }).click();
  await expect(page).toHaveURL(/\/preview\/checkout$/);
  expect(await page.evaluate(() => (window as Window & { __nihoDocumentMarker?: string }).__nihoDocumentMarker)).toBe(documentMarker);
  expect(page.url()).not.toContain("utm_");
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});
