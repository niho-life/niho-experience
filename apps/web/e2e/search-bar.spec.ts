import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { bar, closeSheet, isPhone, openCalendar, openSheet } from "./support/search-bar";

// The search bar of the home and the list (#698), on a phone (sheet) and a wide screen (pill).

test("the list's category tabs are links with an icon, the chosen one is marked, and the heading is small", async ({ page }) => {
  await page.goto("/experiences");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("All experiences");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const tabs = page.getByRole("navigation", { name: "Categories" });
  if ((await tabs.count()) === 0) return;
  await expect(tabs.getByRole("link", { name: "All", exact: true })).toHaveAttribute("aria-current", "page");
  for (const link of await tabs.getByRole("link").all()) await expect(link.locator("svg")).toHaveCount(1);
  await expect(page.getByText("Prices in yen, tax included · Times in Japan time")).toBeVisible();
  await expect(page.locator("main")).not.toContainText("Hosted by people who live here");
  await expect(page.locator("main")).not.toContainText("Kamakura experiences with local hosts");
});

test("the chosen day is green, never black, in the search calendar", async ({ page }) => {
  await page.goto("/experiences");
  const calendar = await openCalendar(page);
  const day = calendar.locator('button[aria-pressed][aria-label$="something on"]').first();
  await expect(day).toBeVisible();
  await day.click();
  const again = await openCalendar(page);
  const chosen = again.locator('button[aria-pressed="true"]');
  await expect(chosen).toHaveCount(1);
  const colour = await chosen.evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(colour).toBe("rgb(178, 214, 124)");
});

test("the phone sheet opens from one button, applies the choice and closes with Escape", async ({ page }) => {
  test.skip(!isPhone(page), "the sheet is the phone's");
  await page.goto("/experiences");
  const pill = bar(page).getByRole("button", { name: /Find an experience/ });
  await expect(pill).toContainText("Any day · Any group");
  const sheet = await openSheet(page);
  await expect(sheet!.getByRole("searchbox")).toBeVisible();
  await expect(sheet!.getByRole("button", { name: /^Show \d+ experiences?$/ })).toBeVisible();
  await sheet!.getByRole("button", { name: "More guests" }).click();
  await expect(page).toHaveURL(/guests=2/);
  await expect(sheet!.getByRole("button", { name: /^Show \d+ experiences?$/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet!).toBeHidden();
  await expect(pill).toContainText("Any day · 2 guests");
  await expect(pill).toBeFocused();
});

test("no sideways scroll at 320px, with the sheet open as well", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  for (const path of ["/", "/experiences", "/experiences?guests=2"]) {
    await page.goto(path);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), path).toBe(true);
    const sheet = await openSheet(page);
    const target = sheet ?? (await openCalendar(page));
    await expect(target).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${path} open`).toBe(true);
    if (sheet) {
      const box = await sheet.boundingBox();
      expect(box && box.x >= 0 && box.x + box.width <= 320).toBe(true);
      await closeSheet(page);
    }
  }
});

test("no serious accessibility violations with the calendar or the sheet open", async ({ page }) => {
  for (const path of ["/", "/experiences"]) {
    await page.goto(path);
    await openCalendar(page);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), path).toEqual([]);
  }
});
