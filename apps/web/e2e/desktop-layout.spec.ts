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

test("home finder is one pill over the hero", async ({ page }) => {
  await page.goto("/");
  const finder = page.getByRole("search", { name: "Find experiences" });
  await expect(finder).toHaveCSS("position", "absolute");
  const date = await box(finder.locator("label").filter({ has: page.locator('select[name="date"]') }));
  const guests = await box(finder.locator("label").filter({ has: page.locator('select[name="guests"]') }));
  const submit = await box(finder.getByRole("button", { name: "Find experiences" }));
  expect(Math.abs(guests.y - date.y)).toBeLessThanOrEqual(8);
  expect(Math.abs(submit.y - date.y)).toBeLessThanOrEqual(8);
  expect(guests.x).toBeGreaterThan(date.x + date.width - 1);
  expect(submit.x).toBeGreaterThan(guests.x + guests.width - 1);
});

test("list puts the guests pill and the day chips on one row", async ({ page }) => {
  await page.goto("/experiences?guests=2");
  const pill = await box(page.locator("label").filter({ has: page.locator("select", { has: page.locator("option", { hasText: "Any group size" }) }) }));
  const chip = await box(page.getByRole("group", { name: "Date (Japan time)" }).getByRole("button").first());
  expect(Math.abs(pill.y + pill.height / 2 - (chip.y + chip.height / 2))).toBeLessThanOrEqual(8);
  expect(chip.x).toBeGreaterThan(pill.x + pill.width);
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

test("host steps sit in one row", async ({ page }) => {
  await page.goto("/host");
  const steps = page.locator('section[aria-labelledby="host-steps-v1"] ol > li');
  await expect(steps).toHaveCount(4);
  await expect(steps.last()).toBeVisible();
  const tops = await steps.evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
});
