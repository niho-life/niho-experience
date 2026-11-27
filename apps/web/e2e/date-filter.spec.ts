import { expect, test } from "@playwright/test";
import { bar, chooseFirstMarkedDay, markedDays, openCalendar, closeSheet } from "./support/search-bar";

test("date loading can be retried in place without losing the party size", async ({ page }) => {
  await page.goto("/experiences?guests=2&mock=availability-retry");
  await expect(page.getByText("Dates couldn't be checked. Showing experiences for your group.")).toBeVisible();
  await expect(page.locator("main article")).toHaveCount(4);
  // Failing open: the calendar lets every day be chosen and marks none.
  const failedCalendar = await openCalendar(page);
  await expect(failedCalendar.locator("button[aria-pressed]:enabled").first()).toBeVisible();
  await expect(markedDays(failedCalendar)).toHaveCount(0);
  await closeSheet(page);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Retry dates" }).click();
  const calendar = await openCalendar(page);
  await expect(markedDays(calendar).first()).toBeVisible();
  await closeSheet(page);
  await expect(bar(page).locator('input[name="guests"]')).toHaveValue("2");
  await expect(page).toHaveURL(/guests=2/);
});

test("choosing a day in the calendar shows the experiences with a session then, and keeps the URL in sync", async ({ page }) => {
  await page.goto("/experiences");
  const status = page.getByRole("status").first();
  await expect(status).toContainText("4 experiences");

  const dayLabel = await chooseFirstMarkedDay(page);
  await expect(page).toHaveURL(/[?&]date=\d{4}-\d{2}-\d{2}/);
  await expect(status).toContainText(`on ${dayLabel}`);
  const count = await page.locator("main article").count();
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThanOrEqual(4);
  // Each remaining card names its session on that day (never the seats left) in the green start-time pill.
  await expect(page.locator("main article").first()).toContainText(dayLabel);
  await expect(page.locator("main")).not.toContainText(/places? (currently )?(left|available)/);
  // The bar shows the chosen day; the cards have no "next dates" and no 2-line lead.
  await expect(bar(page).locator('input[name="date"]')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  await expect(page.locator("[data-next-dates]")).toHaveCount(0);

  const calendar = await openCalendar(page);
  await expect(calendar.getByRole("button", { name: new RegExp(`^${dayLabel}`), pressed: true })).toBeVisible();
  await calendar.getByRole("button", { name: "Any day" }).click();
  await closeSheet(page);
  await expect(page).not.toHaveURL(/date=/);
  await expect(status).toContainText("4 experiences");
});

test("the calendar marks only days with something on, never disables a marked day, and ?date= preselects", async ({ page }) => {
  await page.goto("/experiences");
  const calendar = await openCalendar(page);
  const marked = markedDays(calendar);
  await expect(marked.first()).toBeVisible();
  // A day without a mark cannot be pressed; a marked day always can. No per-day counts.
  await expect(calendar.locator('button[aria-pressed]:enabled:not([aria-label$="something on"])')).toHaveCount(0);
  await expect(calendar.locator('button[aria-pressed][aria-label$="something on"]:disabled')).toHaveCount(0);
  await expect(calendar.getByText("Something on")).toBeVisible();
  await expect(calendar.getByText("Nothing on")).toBeVisible();
  const label = ((await marked.first().getAttribute("aria-label")) ?? "").split(", ")[0] ?? "";
  await marked.first().click();
  await expect(page).toHaveURL(/[?&]date=(\d{4}-\d{2}-\d{2})/);
  const date = new URL(page.url()).searchParams.get("date")!;

  await page.goto(`/experiences?date=${date}`);
  const again = await openCalendar(page);
  await expect(again.getByRole("button", { pressed: true })).toHaveAccessibleName(new RegExp(`^${label}`));
});

test("a date in the URL up to 60 days ahead fills the bar", async ({ page }) => {
  const far = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  await page.goto(`/experiences?date=${far(55)}`);
  await expect(bar(page).locator('input[name="date"]')).toHaveValue(far(55));
});

test("an explicit one guest filter excludes experiences that require two guests", async ({ page }) => {
  await page.goto("/experiences?guests=1");
  await expect(bar(page).locator('input[name="guests"]')).toHaveValue("1");
  await expect(page.getByRole("link", { name: /seaside cycling and a fish market breakfast/i })).toHaveCount(0);
});

test("a party larger than every option's limit gets a clear way back", async ({ page }) => {
  await page.goto("/experiences?guests=8");
  await expect(page.getByRole("heading", { name: "No experiences for 8 guests" })).toBeVisible();
  await page.getByRole("button", { name: "Show all experiences" }).click();
  await expect(page.getByRole("status").first()).toContainText("4 experiences");
  await expect(page).not.toHaveURL(/guests=/);
  await expect(bar(page).locator('input[name="guests"]')).toHaveCount(0);
});
