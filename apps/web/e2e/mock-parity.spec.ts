import { expect, test } from "@playwright/test";

// The owner-approved phone mock (2026-10-20): the booking page's two screens (date and party → details and checkout).
// Its next dates on cards and its round search button were replaced by one card and the search bar (#698).

const dinner = "/experiences/home-cooked-dinner-with-locals";

test("cards are the same on the home page and the list: no next dates, no weekday line, no 2-line lead", async ({ page }) => {
  for (const path of ["/", "/experiences"]) {
    await page.goto(path);
    const card = page.locator("main article").filter({ has: page.getByRole("link", { name: /Home-cooked dinner/ }) });
    await expect(card, path).toBeVisible();
    await expect(card.locator("[data-next-dates]"), path).toHaveCount(0);
    await expect(card, path).not.toContainText(/^Next|Next dates/);
    await expect(card.locator(".line-clamp-2"), path).toHaveCount(0);
    // Never the seats left.
    await expect(card, path).not.toContainText(/places? (currently )?(left|available)/);
  }
});

test("the booking page keeps two screens: date and party first, then details and checkout", async ({ page }) => {
  await page.goto(`${dinner}/book`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Home-cooked dinner with locals in a shared living room");
  await expect(page.getByRole("link", { name: /Back to/ })).toHaveAttribute("href", dinner);

  // Step 1: date cards are radios (invisible but reachable by keyboard).
  await expect(page.getByRole("heading", { name: /step 1\s*Choose a date/ })).toBeVisible();
  const dates = page.getByRole("radiogroup", { name: /Choose a date/ });
  const first = dates.locator('input[name="occurrence"]:not([disabled])').first();
  await first.focus();
  await page.keyboard.press("Space");
  await expect(first).toBeChecked();

  // Step 2: −/+ change the same number inputs that can be typed into.
  await expect(page.getByRole("heading", { name: /step 2\s*Who's coming/ })).toBeVisible();
  const adults = page.getByRole("spinbutton", { name: "Adults" });
  await expect(adults).toHaveValue("1");
  await page.getByRole("button", { name: "More adults" }).click();
  await expect(adults).toHaveValue("2");
  await expect(page.getByText("¥13,000 total")).toBeVisible();
  await page.getByRole("button", { name: "Fewer adults" }).click();
  await expect(adults).toHaveValue("1");

  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: /step 3\s*Your details/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /step 4\s*Check and pay/ })).toBeVisible();
  await expect(page.getByText("¥6,500 total")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Home-cooked dinner with locals in a shared living room");

  await page.getByRole("button", { name: "Change date or guest count" }).click();
  await expect(page.getByRole("heading", { name: /step 1\s*Choose a date/ })).toBeVisible();
});

test("approval-based experiences ask the guest to check and send", async ({ page }) => {
  await page.goto("/experiences/indigo-dyeing-with-an-artisan/book");
  await page.locator('input[name="occurrence"]:not([disabled])').first().check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  // "Before you book" (conditions to accept, Epic #103) is step 3, so the check is step 5.
  await expect(page.getByRole("heading", { name: /step 5\s*Check and send/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Request to book" })).toBeVisible();
});

test("previews say so once, in the footer, and photos carry no sample tags", async ({ page }) => {
  await page.goto("/");
  const note = page.getByRole("contentinfo").getByRole("note");
  await expect(note).toContainText("Preview");
  await expect(note).toContainText("API contract");
  await expect(page.getByText("Sample photo")).toHaveCount(0);
  await page.goto(dinner);
  await expect(page.getByText(/Sample listing|Details to be confirmed/)).toHaveCount(0);
});

test("the header marks Experiences on the list", async ({ page }) => {
  await page.goto("/experiences");
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Experiences" })).toHaveAttribute("aria-current", "page");
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Experiences" })).not.toHaveAttribute("aria-current", "page");
});
