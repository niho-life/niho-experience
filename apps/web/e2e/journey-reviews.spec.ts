import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Epic #103 (niho-experience#104): reviews on the detail page and the cards. Mock data only: the real API has no reviews yet.
// indigo = 12 reviews, pottery = 2, cycling = 1, dinner = none (all synthetic, names end in "(sample)").
const indigo = "/experiences/indigo-dyeing-with-an-artisan";
const pottery = "/experiences/evening-pottery-session";
const cycling = "/experiences/seaside-cycling-and-market-breakfast";
const dinner = "/experiences/home-cooked-dinner-with-locals";
const reviewsSection = (page: Page) => page.locator("section#reviews");
const titleLine = (page: Page) => page.locator("h1 + p");

test("twelve reviews: the rating under the title leads to the reviews, which show the average, what guests liked and the newest three", async ({ page }) => {
  await page.goto(indigo);
  const link = titleLine(page).getByRole("link");
  await expect(link).toHaveText("★ 4.9 · 12 reviews");
  await expect(link).toHaveAccessibleName("Rated 4.9 out of 5 from 12 reviews. Go to the reviews");
  await link.click();
  await expect(page).toHaveURL(/#reviews$/);
  const section = reviewsSection(page);
  await expect(section.getByRole("heading", { name: "Reviews", exact: true })).toBeInViewport();
  await expect(section.getByText("12 reviews from guests who booked")).toBeVisible();
  await expect(section.getByText("4.9", { exact: true })).toBeVisible();
  await expect(section.getByRole("list", { name: "What guests liked" }).getByRole("listitem").first()).toHaveText("Beautiful results · 5");
  await expect(section.locator("article")).toHaveCount(3);
  await expect(section.locator("article").first()).toContainText("Emma (sample)");
  await expect(section.locator("article").first()).toContainText("United Kingdom · October 2026");
  await expect(section.locator("article").first()).toContainText("Booked on NIHO");
  await expect(section.locator("article").first()).toContainText("Rated 5 out of 5");
  await expect(section.locator("article").first()).toContainText("Reply from Aiko (sample)");
  // The section comes after Good to know and before the cancellation terms.
  const order = await page.locator("main h2").allTextContents();
  expect(order.indexOf("Good to know")).toBeLessThan(order.indexOf("Reviews"));
  expect(order.indexOf("Reviews")).toBeLessThan(order.indexOf("Cancellation"));
});

test("Show all opens every review in a dialog that closes with Escape and returns focus", async ({ page }) => {
  await page.goto(indigo);
  const open = page.getByRole("button", { name: "Show all 12 reviews" });
  await open.click();
  const dialog = page.getByRole("dialog", { name: "All reviews" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("article")).toHaveCount(12);
  await expect(dialog.locator("article").last()).toContainText("Ben (sample)");
  const results = await new AxeBuilder({ page }).include("dialog[open]").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
});

test("one or two reviews show the count and the words, without an average or stars", async ({ page }) => {
  for (const [path, label, count] of [[pottery, "2 reviews", 2], [cycling, "1 review", 1]] as const) {
    await page.goto(path);
    await expect(titleLine(page).getByRole("link")).toHaveText(label);
    const section = reviewsSection(page);
    await expect(section.getByText(`${label} from guests who booked`)).toBeVisible();
    await expect(section.locator("article")).toHaveCount(count);
    await expect(section.getByText(/Rated \d/)).toHaveCount(0);
    await expect(section.getByRole("list", { name: "What guests liked" })).toHaveCount(0);
    await expect(section.getByRole("button", { name: /^Show all/ })).toHaveCount(0);
    await expect(titleLine(page)).not.toContainText("★");
  }
});

test("no reviews yet shows the New badge and a short line, not a rating", async ({ page }) => {
  await page.goto(dinner);
  await expect(titleLine(page)).toHaveText("New");
  await expect(titleLine(page).getByRole("link")).toHaveCount(0);
  const section = reviewsSection(page);
  await expect(section.getByText("be one of the first")).toBeVisible();
  await expect(section.getByText("Reviews appear here after guests who booked share how it went.")).toBeVisible();
  await expect(section.locator("article")).toHaveCount(0);
});

test("when reviews cannot be read the page says so and keeps working", async ({ page }) => {
  await page.goto(`${indigo}?mock=reviews-error`);
  await expect(reviewsSection(page).getByRole("alert")).toContainText("Reviews can't be loaded right now");
  await expect(reviewsSection(page).getByRole("button", { name: "Try again" })).toBeVisible();
  // Neither a rating nor the New badge: a failed read is not "no reviews".
  await expect(page.locator("h1 + p")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Good to know", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Check dates/ }).first()).toBeAttached();
});

test("when only Show all fails, the dialog offers Try again", async ({ page }) => {
  await page.goto(`${indigo}?mock=reviews-more-error`);
  await page.getByRole("button", { name: "Show all 12 reviews" }).click();
  const dialog = page.getByRole("dialog", { name: "All reviews" });
  await expect(dialog.getByRole("alert")).toContainText("Reviews can't be loaded right now");
  await expect(dialog.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(dialog.locator("article")).toHaveCount(0);
});

test("blocked analytics and tracking requests do not stop reviews", async ({ page }) => {
  await page.route(/umami|analytics|plausible|gtag|google-analytics/i, (route) => route.abort());
  await page.goto(indigo);
  await page.getByRole("button", { name: "Show all 12 reviews" }).click();
  await expect(page.getByRole("dialog", { name: "All reviews" }).locator("article")).toHaveCount(12);
});

test("cards show the rating or the count only for experiences that have reviews", async ({ page }) => {
  await page.goto("/experiences");
  const card = (name: RegExp) => page.locator("article").filter({ has: page.getByRole("heading", { name }) });
  await expect(card(/Indigo dyeing/)).toContainText("★ 4.9 · 12");
  await expect(card(/Indigo dyeing/)).toContainText("Rated 4.9 out of 5 from 12 reviews");
  await expect(card(/Evening pottery/)).toContainText("2 reviews");
  await expect(card(/Evening pottery/)).not.toContainText("★");
  await expect(card(/Seaside cycling/)).toContainText("1 review");
  await expect(card(/Home-cooked dinner/)).not.toContainText(/review|★/);
  await page.goto("/");
  await expect(page.locator("article").filter({ has: page.getByRole("heading", { name: /Indigo dyeing/ }) })).toContainText("★ 4.9 · 12");
});

test("sample reviews are never emitted as structured data", async ({ page }) => {
  await page.goto(indigo);
  const jsonLd = (await page.locator('script[type="application/ld+json"]').allTextContents()).join("\n");
  expect(jsonLd).not.toMatch(/aggregateRating|"Review"/);
});

test("the reviews fit a phone and the page has no serious accessibility violations", async ({ page }) => {
  await page.goto(indigo);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  const results = await new AxeBuilder({ page }).include("section#reviews").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
});

test("the reviews fit a 320px phone", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-360");
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(indigo);
  await page.getByRole("button", { name: "Show all 12 reviews" }).click();
  const dialog = page.getByRole("dialog", { name: "All reviews" });
  const box = await dialog.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 320).toBe(true);
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
