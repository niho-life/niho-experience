import { expect, test, type Locator, type Page } from "@playwright/test";

// Desktop (PC) layout from the responsive mock v3. Phones keep their own layout and are covered elsewhere.
test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== "desktop"));

const dinner = "/experiences/home-cooked-dinner-with-locals";

async function box(locator: Locator) {
  // Pages stream in behind a loading skeleton; measure once the element is shown.
  await expect(locator).toBeVisible();
  const value = await locator.boundingBox();
  expect(value, "element has a layout box").not.toBeNull();
  return value!;
}

/** The total/action bar is the right column's in-flow card that sticks below the header, not the phone's bottom bar. */
async function expectAsideBar(page: Page, action: Locator) {
  const bar = page.locator("[data-sticky-bar]").filter({ has: action });
  const barBox = await box(bar);
  expect(barBox.x).toBeGreaterThan(640);
  await expect(bar).toHaveCSS("position", "sticky");
  await expect(bar).toHaveCSS("top", "88px");
  await expect(bar).toHaveCSS("bottom", "auto");
  const viewport = page.viewportSize()!;
  expect(barBox.y + barBox.height).toBeLessThan(viewport.height - 8);
  const actionBox = await box(action);
  // Total and date on top, the action full width below.
  expect(actionBox.y).toBeGreaterThan(barBox.y + 40);
  expect(actionBox.width).toBeGreaterThan(barBox.width - 60);
}

test("list search is one pill: keyword, day, guests and the Search button on one row", async ({ page }) => {
  await page.goto("/experiences?guests=2");
  const search = page.getByRole("search", { name: "Find an experience" });
  const keyword = await box(search.getByRole("searchbox"));
  const when = await box(search.getByRole("button", { name: /^When/ }));
  const guests = await box(search.getByRole("button", { name: /^Guests/ }));
  const go = await box(search.getByRole("button", { name: "Search", exact: true }));
  const centres = [keyword, when, guests, go].map((item) => item.y + item.height / 2);
  expect(Math.max(...centres) - Math.min(...centres)).toBeLessThanOrEqual(8);
  expect(when.x).toBeGreaterThan(keyword.x + keyword.width - 4);
  expect(guests.x).toBeGreaterThan(when.x + when.width - 4);
  expect(go.x).toBeGreaterThan(guests.x + guests.width - 4);
  // Sticky under the 64px header, with the category tabs and a small heading below it.
  await expect(search.locator("xpath=ancestor::div[contains(@class,'sticky')][1]")).toHaveCSS("top", "64px");
  const barBox = await box(search);
  const tabs = page.getByRole("navigation", { name: "Categories" });
  // The mock catalog has no categories; where there are, the tabs sit under the bar and above the small heading.
  if (await tabs.count()) expect((await box(tabs.first())).y).toBeGreaterThan(barBox.y + barBox.height);
  expect((await box(page.getByRole("heading", { level: 1 }))).y).toBeGreaterThan(barBox.y + barBox.height);
});

test("detail shows the title before the photo mosaic", async ({ page }) => {
  await page.goto(dinner);
  const title = await box(page.getByRole("heading", { level: 1 }));
  const mosaic = page.getByRole("group", { name: "Experience photos" });
  expect(title.y).toBeLessThan((await box(mosaic)).y);
  await expect(mosaic.getByRole("button", { name: /^Show all \d+ photos$/ })).toBeVisible();
});

test("booking puts the steps on the left and the summary and sticky total card on the right", async ({ page }) => {
  await page.goto(`${dinner}/book`);
  const summary = await box(page.getByRole("heading", { level: 1 }));
  const step1 = await box(page.getByRole("heading", { name: /Choose a date/ }));
  expect(summary.x - step1.x).toBeGreaterThan(300);
  await expectAsideBar(page, page.getByRole("button", { name: "Continue", exact: true }));

  await page.locator('input[name="occurrence"]:not([disabled])').first().check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const step3 = await box(page.getByRole("heading", { name: /Your details/ }));
  expect((await box(page.getByRole("heading", { level: 1 }))).x - step3.x).toBeGreaterThan(300);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expectAsideBar(page, page.getByRole("button", { name: "Continue to mock payment" }));
});

test("host plans sit in one row", async ({ page }) => {
  await page.goto("/host");
  const plans = page.locator('section[aria-labelledby="host-plans-heading"] article');
  await expect(plans).toHaveCount(3);
  await expect(plans.last()).toBeVisible();
  const tops = await plans.evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
});
