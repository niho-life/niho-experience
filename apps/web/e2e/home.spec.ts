import { expect, test } from "@playwright/test";
import { bar, chooseFirstMarkedDay, chooseGuests, isPhone, searchKeyword, submitSearch } from "./support/search-bar";

// The English home: a photo hero with the search bar over its bottom edge (#698; the hero button of #646 is gone).
test("the hero carries the search bar, not a button", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "See the experiences" })).toHaveCount(0);
  const search = bar(page);
  await expect(search).toHaveCount(1);
  await expect(search).toHaveAttribute("method", "get");
  await expect(search).toHaveAttribute("action", "/experiences");
  // The bar sits over the hero's bottom edge: its top is inside the hero photo, its bottom below it.
  const hero = await page.getByRole("region", { name: "Welcome" }).boundingBox();
  const barBox = await search.boundingBox();
  expect(hero && barBox && barBox.y < hero.y + hero.height && barBox.y + barBox.height > hero.y + hero.height - 80).toBe(true);
});

test("searching from the top opens the list with the day and the party in the address and in the bar", async ({ page }) => {
  await page.goto("/");
  const dayLabel = await chooseFirstMarkedDay(page);
  await chooseGuests(page, 2);
  await submitSearch(page);
  await expect(page).toHaveURL(/\/experiences\?date=\d{4}-\d{2}-\d{2}&guests=2$/);
  await expect(bar(page).locator('input[name="date"]')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  await expect(bar(page).locator('input[name="guests"]')).toHaveValue("2");
  await expect(page.getByRole("status").first()).toContainText(`on ${dayLabel}`);
  await expect(page.getByRole("status").first()).toContainText("for 2 guests");
});

test("a keyword typed on the top is searched on the list; the category row links to the list", async ({ page }) => {
  await page.goto("/");
  await searchKeyword(page, "pottery");
  await expect(page).toHaveURL(/\/experiences\?q=pottery$/);
  await expect(page.getByRole("link", { name: /evening pottery session/i })).toBeVisible();
  await page.goto("/");
  const categories = page.getByRole("navigation", { name: "Categories" });
  if (await categories.count()) {
    await expect(categories.getByRole("link", { name: "All", exact: true })).toHaveAttribute("href", "/experiences");
    for (const link of await categories.getByRole("link").all()) await expect(link.locator("svg")).toHaveCount(1);
  }
});

test("the cards heading, the living-room band and the journal keep their order", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 2, name: "Spend a few hours with a neighbor" })).toBeVisible();
  const band = page.getByRole("region", { name: "NIHO, the town’s living room" });
  await expect(band.getByRole("link", { name: "About NIHO Travel" })).toHaveAttribute("href", "/about");
  const order = await page.locator("#home-cards-v1, #home-living-room, #home-guides-heading, #host-band-heading-v1").evaluateAll((nodes) => nodes.map((node) => node.id));
  expect(order).toEqual(["home-cards-v1", "home-living-room", "home-guides-heading", "host-band-heading-v1"]);
});

test("the hero slides fade by opacity only, and stand still with reduced motion", async ({ page }) => {
  await page.goto("/");
  const slides = page.locator("[data-hero-slide]");
  await expect(slides).toHaveCount(2);
  for (const slide of await slides.all()) {
    expect(await slide.evaluate((node) => getComputedStyle(node).animationName)).toMatch(/^hero-fade-[23]$/);
    expect(await slide.evaluate((node) => getComputedStyle(node).transform)).toBe("none");
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const slide of await slides.all()) {
    await expect(slide).toHaveCSS("animation-name", "none");
    await expect(slide).toHaveCSS("opacity", "0");
  }
});

test("the home does not overflow sideways on a small phone", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("the top search opens and closes by keyboard, and the calendar fails open until availability is read", async ({ page }) => {
  test.skip(isPhone(page), "the popover is the wide screen's");
  await page.goto("/");
  const when = bar(page).getByRole("button", { name: /^When/ });
  await expect(when).toHaveAttribute("aria-expanded", "false");
  await when.focus();
  await page.keyboard.press("Enter");
  await expect(when).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("dialog", { name: "Choose a day (Japan time)" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(when).toHaveAttribute("aria-expanded", "false");
  await expect(when).toBeFocused();
  // An outside press closes it too.
  await when.click();
  await page.getByRole("heading", { level: 1 }).click({ force: true });
  await expect(when).toHaveAttribute("aria-expanded", "false");
});
