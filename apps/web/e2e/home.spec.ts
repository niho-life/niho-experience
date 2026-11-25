import { expect, test } from "@playwright/test";

// The English home (#646): the hero is a photo and one button, not a search form.
test("the hero leads to the experiences, with no search form", async ({ page }) => {
  await page.goto("/");
  const hero = page.getByRole("region", { name: "Welcome" });
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(hero.getByRole("search")).toHaveCount(0);
  await expect(page.getByRole("search", { name: "Find experiences" })).toHaveCount(0);
  const action = hero.getByRole("link", { name: "See the experiences" });
  await expect(action).toHaveAttribute("href", "/experiences");
  await action.click();
  await expect(page).toHaveURL(/\/experiences$/);
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
