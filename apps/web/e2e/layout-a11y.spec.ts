import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const PAGES = [
  "/",
  "/experiences",
  "/experiences/home-cooked-dinner-with-locals",
  "/experiences/indigo-dyeing-with-an-artisan",
  "/host",
  "/booking/return",
  "/preview/states",
  "/guides",
  "/guides/sample-first-evening-in-kamakura",
];

test.describe("320px narrow phone", () => {
  test.use({ viewport: { width: 320, height: 640 } });
  // The viewport is fixed here, so one project is enough.
  test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== "mobile-360"));
  for (const path of PAGES) {
    test(`no horizontal scroll on ${path}`, async ({ page }) => {
      await page.goto(path);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }

  test("booking form fits and its main button is reachable", async ({ page }) => {
    await page.goto("/experiences/home-cooked-dinner-with-locals/book");
    await page.locator('input[name="occurrence"]:not([disabled])').first().check();
    await page.getByRole("button", { name: "Continue" }).click();
    const button = page.getByRole("button", { name: "Continue to mock payment" });
    await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 320).toBe(true);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

for (const path of [...PAGES, "/experiences/home-cooked-dinner-with-locals/book"]) {
  test(`no serious accessibility violations on ${path}`, async ({ page }) => {
    if (path.endsWith("/book")) {
      await page.goto("/experiences/home-cooked-dinner-with-locals/book");
      await page.locator('input[name="occurrence"]:not([disabled])').first().check();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("button", { name: "Continue to mock payment" }).waitFor();
    } else {
      await page.goto(path);
    }
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });
}

test("keyboard users can skip to content and see focus", async ({ page }) => {
  await page.goto("/experiences");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
});

test("list, detail and booking actions fit the project viewport", async ({ page }, testInfo) => {
  for (const path of ["/experiences", "/experiences/home-cooked-dinner-with-locals", "/experiences/home-cooked-dinner-with-locals/book"]) {
    await page.goto(path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${testInfo.project.name}: ${path}`).toBeLessThanOrEqual(0);
  }
});
