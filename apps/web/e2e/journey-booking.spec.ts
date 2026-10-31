import { expect, test, type Page } from "@playwright/test";

// Epic #103 (niho-experience#105): conditions to accept, an optional mobile number, the free-cancellation deadline and the
// page after payment. Mock data only: the real API has none of this until NIHO's contract exists.
const indigo = "/experiences/indigo-dyeing-with-an-artisan";
const dinner = "/experiences/home-cooked-dinner-with-locals";
const cycling = "/experiences/seaside-cycling-and-market-breakfast";

async function chooseFirstDate(page: Page) {
  await page.locator('input[name="occurrence"]:not([disabled])').first().check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
}

// A date days ahead, so the free-cancellation deadline (24 or 48 hours before the start) is still in the future whatever day the test runs.
async function chooseLaterDate(page: Page) {
  const dates = page.locator('input[name="occurrence"]:not([disabled])');
  await dates.nth(Math.min(3, (await dates.count()) - 1)).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
}

async function fillIndigoDetails(page: Page) {
  await page.getByRole("textbox", { name: "Full name" }).fill("Emma Clarke");
  await page.getByRole("textbox", { name: "Email" }).fill("emma@example.com");
  await page.locator("#question-q_colour").selectOption("o_deep");
  await page.getByRole("checkbox", { name: /agree to version/ }).check();
}

test("conditions need an OK, the mobile number is optional, and the free-cancellation deadline is a date and time", async ({ page }) => {
  await page.goto(`${indigo}/book`);
  await chooseLaterDate(page);

  await expect(page.getByRole("heading", { name: /Before you book/ })).toBeVisible();
  await expect(page.getByText("Questions from Aiko (sample)", { exact: true })).toBeVisible();
  const conditions = page.getByRole("checkbox", { name: /Everyone in my group is OK with/ });
  await expect(conditions).not.toBeChecked();
  for (const point of ["Ages 10 and up · Children must join with an adult", "Standing for a long time (Working with your hands · about 2 hours, with short breaks)", "Steps up to the studio"]) {
    await expect(page.getByText(point, { exact: true })).toBeVisible();
  }
  // The deadline is a weekday, a date and a time, and says it is Japan time.
  await expect(page.getByText(/^Until [A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}, \d{1,2}:\d{2} (AM|PM) Japan time$/)).toBeVisible();

  await fillIndigoDetails(page);
  await page.getByRole("button", { name: "Request to book" }).click();
  // Without the OK the form does not go on, and the checkbox says why.
  await expect(page).toHaveURL(/\/book$/);
  expect(await conditions.evaluate((element: HTMLInputElement) => element.validity.valueMissing)).toBe(true);

  await conditions.check();
  const phone = page.getByRole("textbox", { name: /^Mobile number/ });
  await phone.fill("call me");
  await page.getByRole("button", { name: "Request to book" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("Please check your mobile number, or leave it empty.");
  await expect(phone).toBeFocused();
  await expect(phone).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("textbox", { name: "Full name" })).toHaveValue("Emma Clarke");

  await phone.fill("+44 7700 900123");
  await page.getByRole("button", { name: "Request to book" }).click();
  await expect(page).toHaveURL(/\/preview\/checkout$/);
  // Nothing the traveler typed is in the URL or in browser storage.
  expect(page.url()).not.toMatch(/emma|7700/);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});

test("the mobile number is optional: leaving it empty books like before", async ({ page }) => {
  await page.goto(`${dinner}/book`);
  await chooseFirstDate(page);
  await expect(page.getByRole("heading", { name: /Before you book/ })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: /^Mobile number/ })).toBeVisible();
  await page.getByRole("textbox", { name: "Full name" }).fill("Sample Guest");
  await page.getByRole("textbox", { name: "Email" }).fill("guest@example.com");
  await page.getByRole("checkbox", { name: /agree to version/ }).check();
  await page.getByRole("button", { name: "Continue to mock payment" }).click();
  await expect(page).toHaveURL(/\/preview\/checkout$/);
});

test("steps are numbered 3, 4, 5 with conditions and 3, 4 without", async ({ page }) => {
  await page.goto(`${indigo}/book`);
  await chooseFirstDate(page);
  await expect(page.locator("h2").filter({ hasText: /^step \d/ })).toHaveText(["step 3Before you book", "step 4Your details", "step 5Check and send"]);
  await page.goto(`${dinner}/book`);
  await chooseFirstDate(page);
  await expect(page.locator("h2").filter({ hasText: /^step \d/ })).toHaveText(["step 3Your details", "step 4Check and pay"]);
});

test("a non-refundable option shows no free-cancellation deadline, a refundable one does", async ({ page }) => {
  await page.goto(`${cycling}/book?guests=2`);
  // Two guests: choose a date that has the places.
  await page.getByRole("radio", { name: /(?:[2-9]|[1-9]\d+) places currently available/ }).first().check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText("Non-refundable").first()).toBeVisible();
  await expect(page.getByText("Free cancellation", { exact: true })).toHaveCount(0);
  await page.goto(`${dinner}/book`);
  await chooseLaterDate(page);
  await expect(page.getByText("Free cancellation", { exact: true })).toBeVisible();
  await expect(page.getByText(/^Until /)).toBeVisible();
});

test("the free-cancellation deadline turns to \"Not available\" when it passes while the form is open", async ({ page }) => {
  await page.clock.install();
  await page.goto(`${indigo}/book`);
  await chooseLaterDate(page);
  await expect(page.getByText(/^Until [A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}, \d{1,2}:\d{2} (AM|PM) Japan time$/)).toBeVisible();
  // Forty days later every date offered is past its deadline (48 hours before the start). One jump is limited to 2^31 ms, so two.
  await page.clock.fastForward(20 * 24 * 60 * 60 * 1000);
  await page.clock.fastForward(20 * 24 * 60 * 60 * 1000);
  await expect(page.getByText("Not available for this date")).toBeVisible();
  await expect(page.getByText(/^Until /)).toHaveCount(0);
});

test("the booking form with conditions fits a 320px phone", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-360");
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(`${indigo}/book`);
  await chooseFirstDate(page);
  await page.getByRole("checkbox", { name: /Everyone in my group is OK with/ }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  const button = page.getByRole("button", { name: "Request to book" });
  const box = await button.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 320).toBe(true);
});

test.describe("/booking/return", () => {
  test("never claims that a booking or payment is complete, and offers the way to find the email", async ({ page }) => {
    await page.goto("/booking/return");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Check your email");
    await expect(page.locator("main")).not.toContainText(/you're booked|booking confirmed|payment (was )?(successful|received|complete)|you have booked/i);
    await expect(page.getByRole("heading", { name: "What happens next" })).toBeVisible();
    await expect(page.locator("ol > li")).toHaveCount(4);
    await page.getByRole("link", { name: "Didn't get the email?" }).click();
    await expect(page).toHaveURL(/\/help$/);
  });

  test("an instant booking and one that needs approval get their own headings", async ({ page }) => {
    await page.goto("/booking/return?type=instant");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Check your email for your booking");
    await expect(page.locator("main")).toContainText("Your confirmation comes by email once your payment goes through.");
    await page.goto("/booking/return?type=approval");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("The host will review your request");
    await expect(page.locator("main")).toContainText("You are charged only if they accept");
    await expect(page.locator("main")).not.toContainText(/you're booked|booking confirmed|payment (was )?(successful|received|complete)/i);
  });

  test("only the two known kinds change the wording: anything else is the neutral page", async ({ page }) => {
    for (const query of ["type=paid", "type=", "type=approval&type=instant", "type=%3Cb%3Ex%3C%2Fb%3E", "title=Free%20money"]) {
      await page.goto(`/booking/return?${query}`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Check your email");
      await expect(page.locator("main")).not.toContainText("Free money");
    }
  });

  test("the preview's payment page leads to each version of it", async ({ page }) => {
    await page.goto("/preview/checkout");
    await page.getByRole("link", { name: "A request the host approves" }).click();
    await expect(page).toHaveURL(/\/booking\/return\?type=approval$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("The host will review your request");
    await page.goBack();
    await page.getByRole("link", { name: "A booking confirmed by payment" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Check your email for your booking");
  });

  test("fits a 320px phone", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-360");
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto("/booking/return?type=approval");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });
});

test("the host changed the points after the page loaded: the form says so, reloads them and asks for the OK again", async ({ page }) => {
  await page.goto(`${indigo}/book?mock=checkout-conditions-outdated`);
  await chooseLaterDate(page);
  await fillIndigoDetails(page);
  await page.getByRole("checkbox", { name: /Everyone in my group is OK with/ }).check();
  await page.getByRole("button", { name: "Request to book" }).click();

  await expect(page.locator("main").getByRole("alert").filter({ hasText: "Review the latest details" })).toBeVisible();
  await expect(page.locator("#booking-problem")).toContainText("The points under “Before you book” changed. Reload the experience to review them.");
  await expect(page).toHaveURL(/\/book\?mock=checkout-conditions-outdated$/);
  // Nothing can be sent until the points are read again.
  await expect(page.getByRole("button", { name: "Request to book" })).toBeDisabled();

  await page.getByRole("button", { name: "Reload the experience" }).click();
  // The new point is shown, the OK is asked for again, and what the traveler typed stays on the page.
  await expect(page.getByText("Ages 10 and up · Children must join with an adult · Updated by the host", { exact: true })).toBeVisible();
  const conditions = page.getByRole("checkbox", { name: /Everyone in my group is OK with/ });
  await expect(conditions).not.toBeChecked();
  await expect(page.getByRole("textbox", { name: "Full name" })).toHaveValue("Emma Clarke");
  await expect(page.getByRole("textbox", { name: "Email" })).toHaveValue("emma@example.com");
  await expect(page.locator("#question-q_colour")).toHaveValue("o_deep");
  await expect(page.locator("#booking-problem")).toHaveCount(0);

  await conditions.check();
  await page.getByRole("checkbox", { name: /agree to version/ }).check();
  await page.getByRole("button", { name: "Request to book" }).click();
  await expect(page).toHaveURL(/\/preview\/checkout$/);
});

test("the host added points that need an OK after the page loaded: the form reloads them before booking", async ({ page }) => {
  await page.goto(`${dinner}/book?mock=checkout-conditions-added`);
  await chooseFirstDate(page);
  await expect(page.getByRole("heading", { name: /Before you book/ })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Full name" }).fill("Sample Guest");
  await page.getByRole("textbox", { name: "Email" }).fill("guest@example.com");
  await page.getByRole("checkbox", { name: /agree to version/ }).check();
  await page.getByRole("button", { name: "Continue to mock payment" }).click();

  await expect(page.locator("#booking-problem")).toContainText("This experience has points to confirm before you book. Reload the experience to review them.");
  await page.getByRole("button", { name: "Reload the experience" }).click();

  await expect(page.getByRole("heading", { name: /Before you book/ })).toBeVisible();
  await expect(page.getByText("Ages 6 and up", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Full name" })).toHaveValue("Sample Guest");
  await page.getByRole("checkbox", { name: /Everyone in my group is OK with/ }).check();
  await page.getByRole("checkbox", { name: /agree to version/ }).check();
  await page.getByRole("button", { name: "Continue to mock payment" }).click();
  await expect(page).toHaveURL(/\/preview\/checkout$/);
});
