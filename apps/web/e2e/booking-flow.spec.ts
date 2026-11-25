import { expect, test, type Page } from "@playwright/test";

const dinner = "/experiences/home-cooked-dinner-with-locals";
async function chooseFirstDate(page: Page) {
  await page.locator('input[name="occurrence"]:not([disabled])').first().check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
}
async function enterBookingDetails(page: Page) {
  await page.getByRole("textbox", { name: "Full name" }).fill("Sample Guest");
  await page.getByRole("textbox", { name: "Email" }).fill("guest@example.com");
  await page.getByRole("checkbox", { name: /agree to version/ }).check();
}

test("browse, review adult and child total, and reach browser-only mock checkout", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST") requests.push(request.url()); });
  await page.goto("/");
  await page.getByRole("link", { name: "See the experiences" }).click();
  await expect(page).toHaveURL(/\/experiences$/);
  // The list's guest filter starts open; two adults carry on to the booking page.
  await page.goto("/experiences?guests=2");
  await page.getByRole("link", { name: /Home-cooked dinner/ }).click();
  // Desktop: the sticky booking card. Phones: the bottom bar. Only one is shown at a time.
  await page.getByRole("link", { name: /^Check dates/ }).click();
  await expect(page).toHaveURL(/\/book\?guests=2$/);
  await page.getByRole("spinbutton", { name: /Adults/ }).fill("2");
  await page.getByRole("spinbutton", { name: /Children/ }).fill("1");
  // Availability varies by JST date; choose a slot that fits all three guests.
  await page.getByRole("radio", { name: /(?:[3-9]|[1-9]\d+) places currently available/ }).first().check();
  // The total sits in the bottom bar on both screens.
  await expect(page.getByText("¥16,000 total")).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText("¥16,000 total")).toBeVisible();
  await expect(page.getByText(/Sold by/)).toBeVisible();
  await page.getByRole("textbox", { name: "Full name" }).fill("Sample Guest");
  await page.getByRole("textbox", { name: "Email" }).fill("guest@example.com");
  await page.getByRole("checkbox", { name: /agree to version/ }).check();
  await page.getByRole("button", { name: "Continue to mock payment" }).click();
  await expect(page).toHaveURL(/\/preview\/checkout$/);
  expect(requests).toEqual([]);
  expect(page.url()).not.toContain("guest@example.com");
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});

test("cancelled checkout return offers a clear way back to date selection on mobile and desktop", async ({ page }) => {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`${dinner}?checkout=cancelled`);
    const status = page.getByRole("status").filter({ hasText: "Checkout cancelled" });
    await expect(status).toContainText("Checkout cancelled");
    const chooseDate = status.getByRole("link", { name: "Choose a date" });
    await expect(chooseDate).toHaveAttribute("href", `${dinner}/book`);

    if (viewport.width === 390) {
      const gallery = page.locator('main [aria-roledescription="carousel"]');
      const galleryBox = await gallery.boundingBox();
      const statusBox = await status.boundingBox();
      expect(galleryBox, "mobile gallery has a layout box").not.toBeNull();
      expect(statusBox, "checkout notice has a layout box").not.toBeNull();
      expect(galleryBox!.y).toBeLessThan(statusBox!.y);

      await page.getByRole("button", { name: "Next photo" }).focus();
      await page.keyboard.press("Tab");
      await expect(chooseDate).toBeFocused();
    }
  }

  await page.getByRole("link", { name: "Choose a date" }).click();
  await expect(page).toHaveURL(/\/book$/);
});

test("provisional pilot dates do not claim remaining seats", async ({ page }) => {
  const pilot = process.env.MOCK_CATALOG === "pilot";
  const slug = pilot ? "kamakura-community-dinner" : "home-cooked-dinner-with-locals";
  await page.goto(`/experiences/${slug}/book`);

  if (pilot) {
    await expect(page.getByText(/Sample dates: availability is not confirmed/)).toBeVisible();
    await expect(page.getByText(/\d+ places? currently available/)).toHaveCount(0);
  } else {
    await expect(page.getByText(/\d+ places? currently available/).first()).toBeVisible();
  }
});

test("required booking answer and consent are shown before checkout", async ({ page }) => {
  await page.goto("/experiences/indigo-dyeing-with-an-artisan/book");
  await chooseFirstDate(page);
  await expect(page.getByRole("heading", { name: /Your details/ })).toBeVisible();
  await expect(page.getByLabel(/Which shade would you like to dye/)).toBeVisible();
  await expect(page.getByText(/version 2026-10-01/)).toBeVisible();
  await page.getByRole("textbox", { name: "Full name" }).fill("Sample Guest");
  await page.getByRole("textbox", { name: "Email" }).fill("guest@example.com");
  await page.getByRole("checkbox", { name: /agree to version/ }).check();
  // This experience also has conditions to accept (Epic #103); the point here is the unanswered question.
  await page.getByRole("checkbox", { name: /Everyone in my group is OK with/ }).check();
  await page.getByRole("button", { name: "Request to book" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("required question");
  await expect(page.getByLabel(/Which shade would you like to dye/)).toBeFocused();
  await expect(page.getByLabel(/Which shade would you like to dye/)).toHaveAttribute("aria-describedby", "booking-problem");
  await expect(page.getByLabel(/Which shade would you like to dye/)).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("textbox", { name: "Full name" })).toHaveValue("Sample Guest");
  expect(await page.evaluate(() => (window as Window & { __nihoEvents?: { event: string }[] }).__nihoEvents?.filter((event) => event.event === "checkout_start").length ?? 0)).toBe(0);
});

test("a whitespace-only name returns focus to the name without losing contact details", async ({ page }) => {
  await page.goto(`${dinner}/book`);
  await chooseFirstDate(page);
  await page.getByRole("textbox", { name: "Full name" }).fill("   ");
  await page.getByRole("textbox", { name: "Email" }).fill("guest@example.com");
  await page.getByRole("checkbox", { name: /agree to version/ }).check();
  await page.getByRole("button", { name: "Continue to mock payment" }).click();
  await expect(page.getByRole("textbox", { name: "Full name" })).toBeFocused();
  await expect(page.getByRole("textbox", { name: "Full name" })).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("main").getByRole("alert")).toContainText("Please enter your full name.");
  await expect(page.getByRole("textbox", { name: "Email" })).toHaveValue("guest@example.com");
});

test("booking page is private", async ({ request }) => {
  const res = await request.get(`${dinner}/book`);
  expect(res.headers()["cache-control"]).toContain("no-store");
  expect(res.headers()["x-robots-tag"]).toContain("noindex");
});

test("consent API errors mark the field, then a reload error focuses its own message", async ({ page }) => {
  await page.goto(`${dinner}/book?mock=checkout-consent-outdated`);
  await chooseFirstDate(page);
  await enterBookingDetails(page);
  await page.getByRole("button", { name: "Continue to mock payment" }).click();
  const consent = page.getByRole("checkbox", { name: /agree to version/ });
  await expect(consent).toBeFocused();
  await expect(consent).toHaveAttribute("aria-invalid", "true");
  await expect(consent).toHaveAttribute("aria-describedby", "booking-problem");
  await page.getByRole("button", { name: "Reload the experience" }).click();
  await expect(page.locator("#booking-problem")).toBeFocused();
  await expect(page.locator("#booking-problem")).toContainText("not available yet");
  await expect(consent).not.toHaveAttribute("aria-invalid", "true");
  await expect(consent).not.toHaveAttribute("aria-describedby", "booking-problem");
  await expect(page.getByRole("textbox", { name: "Full name" })).toHaveValue("Sample Guest");
});

test("a newly full date can be checked again without trapping the guest", async ({ page }) => {
  await page.goto(`${dinner}/book?mock=checkout-full`);
  await chooseFirstDate(page);
  await page.getByRole("textbox", { name: "Full name" }).fill("Sample Guest");
  await page.getByRole("textbox", { name: "Email" }).fill("guest@example.com");
  await page.getByRole("checkbox", { name: /agree to version/ }).check();
  await page.getByRole("button", { name: "Continue to mock payment" }).click();
  await expect(page.locator("main").getByRole("alert").last()).toContainText("filled up");
  await page.getByRole("button", { name: "Check dates again" }).click();
  await page.locator('input[name="occurrence"]:not([disabled])').first().check();
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeVisible();
});

test("a changed price requires a fresh detail and agreement", async ({ page }) => {
  await page.goto(`${dinner}/book?mock=checkout-price-changed`);
  await chooseFirstDate(page);
  const checkSection = page.locator("section").filter({ has: page.getByRole("heading", { name: /Check and pay/ }) });
  const total = checkSection.locator("dl dd").last();
  const beforeRefresh = await total.innerText();
  await page.getByRole("textbox", { name: "Full name" }).fill("Sample Guest");
  await page.getByRole("textbox", { name: "Email" }).fill("guest@example.com");
  await page.getByRole("checkbox", { name: /agree to version/ }).check();
  await page.getByRole("button", { name: "Continue to mock payment" }).click();
  await expect(page.getByRole("button", { name: "Reload the experience" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue to mock payment" })).toBeDisabled();
  await page.getByRole("button", { name: "Reload the experience" }).click();
  await expect(page.getByRole("button", { name: "Reload the experience" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Full name" })).toHaveValue("Sample Guest");
  await expect(total).not.toHaveText(beforeRefresh);
  await expect(page.getByRole("checkbox", { name: /agree to version/ })).not.toBeChecked();
  await page.getByRole("checkbox", { name: /agree to version/ }).check();
  await expect(page.getByRole("button", { name: "Continue to mock payment" })).toBeEnabled();
  await page.getByRole("button", { name: "Continue to mock payment" }).click();
  await expect(page).toHaveURL(/\/preview\/checkout$/);
});

test("a hold limit directs the guest to choose another date", async ({ page }) => {
  await page.goto(`${dinner}/book?mock=checkout-hold-limit`);
  await chooseFirstDate(page);
  await enterBookingDetails(page);
  await page.getByRole("button", { name: "Continue to mock payment" }).click();
  await expect(page.locator("main").getByRole("alert").last()).toContainText("different date");
  await expect(page.getByRole("textbox", { name: "Full name" })).toHaveValue("Sample Guest");

  await page.getByRole("button", { name: /Change date or guest count/ }).click();
  await page.locator('input[name="occurrence"]:not([disabled])').first().check();
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeVisible();
});

test("changed booking questions require a fresh detail before checkout", async ({ page }) => {
  await page.goto(`${dinner}/book?mock=checkout-questions-changed`);
  await chooseFirstDate(page);
  await enterBookingDetails(page);
  await page.getByRole("button", { name: "Continue to mock payment" }).click();
  await expect(page.getByRole("button", { name: "Reload the experience" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue to mock payment" })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "Full name" })).toHaveValue("Sample Guest");
});

test("an unavailable checkout keeps the guest's details available for retry", async ({ page }) => {
  await page.goto(`${dinner}/book?mock=checkout-unavailable`);
  await chooseFirstDate(page);
  await enterBookingDetails(page);
  await page.getByRole("button", { name: "Continue to mock payment" }).click();
  await expect(page.locator("main").getByRole("alert").last()).toContainText("details are still here");
  await expect(page.getByRole("textbox", { name: "Full name" })).toHaveValue("Sample Guest");
  await expect(page.getByRole("textbox", { name: "Email" })).toHaveValue("guest@example.com");
  await expect(page.getByRole("button", { name: "Continue to mock payment" })).toBeEnabled();
});

test("a rate limit gives the retry delay and prevents an early resubmission", async ({ page }) => {
  await page.goto(`${dinner}/book?mock=checkout-rate-limited`);
  await chooseFirstDate(page);
  await enterBookingDetails(page);
  await page.getByRole("button", { name: "Continue to mock payment" }).click();
  await expect(page.locator("main").getByRole("alert").last()).toContainText("120 seconds");
  await expect(page.getByRole("button", { name: "Please wait…" })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "Full name" })).toHaveValue("Sample Guest");
});

test("a failing analytics sink never blocks a preview booking", async ({ page }) => {
  await page.addInitScript(() => {
    console.debug = () => { throw new Error("analytics blocked"); };
  });
  await page.goto(`${dinner}/book`);
  await chooseFirstDate(page);
  await page.getByRole("textbox", { name: "Full name" }).fill("Sample Guest");
  await page.getByRole("textbox", { name: "Email" }).fill("guest@example.com");
  await page.getByRole("checkbox", { name: /agree to version/ }).check();
  await page.getByRole("button", { name: "Continue to mock payment" }).click();
  await expect(page).toHaveURL(/\/preview\/checkout$/);
  const trackedEvents = await page.evaluate(() => (window as Window & { __nihoEvents?: { event: string }[] }).__nihoEvents?.map(({ event }) => event) ?? []);
  expect(trackedEvents).toContain("checkout_start");
});

test("DNT suppresses first-touch attribution without blocking a preview booking", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "doNotTrack", { configurable: true, get: () => "1" });
  });
  await page.goto(`${dinner}?utm_source=niho_site&utm_campaign=pilot_2026q4`);
  await expect.poll(() => page.evaluate(() => sessionStorage.length)).toBe(0);
  await page.getByRole("link", { name: /^Check dates/ }).click();
  await chooseFirstDate(page);
  await page.getByRole("textbox", { name: "Full name" }).fill("Sample Guest");
  await page.getByRole("textbox", { name: "Email" }).fill("guest@example.com");
  await page.getByRole("checkbox", { name: /agree to version/ }).check();
  await page.getByRole("button", { name: "Continue to mock payment" }).click();
  await expect(page).toHaveURL(/\/preview\/checkout$/);
});

test("an unavailable checkout keeps details and lets the guest return to availability", async ({ page }) => {
  await page.goto(`${dinner}/book?mock=checkout-unavailable`);
  await chooseFirstDate(page);
  await page.getByRole("textbox", { name: "Full name" }).fill("Sample Guest");
  await page.getByRole("textbox", { name: "Email" }).fill("guest@example.com");
  await page.getByRole("checkbox", { name: /agree to version/ }).check();
  await page.getByRole("button", { name: "Continue to mock payment" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("couldn't reach checkout");
  await expect(page.getByRole("textbox", { name: "Full name" })).toHaveValue("Sample Guest");
  await expect(page.getByRole("button", { name: "Continue to mock payment" })).toBeEnabled();
  await page.getByRole("button", { name: "Change date or guest count" }).click();
  await page.locator('input[name="occurrence"]:not([disabled])').first().check();
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeVisible();
});
