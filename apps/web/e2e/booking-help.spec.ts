import { expect, test } from "@playwright/test";

test("the footer leads to English booking help without asking for a guest account", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Footer" }).getByRole("link", { name: "Booking help" }).click();
  await expect(page.getByRole("heading", { name: "Booking help", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Find your booking" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Changes and cancellations" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Email NIHO", exact: true })).toHaveAttribute("href", "mailto:info@niho.life?subject=NIHO%20Travel");
  await expect(page.getByRole("textbox")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("booking return and service failure have a help route without claiming payment success or failure", async ({ page }) => {
  await page.goto("/booking/return");
  await page.getByRole("main").getByRole("link", { name: "Didn't get the email?" }).click();
  await expect(page).toHaveURL(/\/help$/);
  await page.goto("/experiences?mock=error");
  const error = page.getByRole("main").getByRole("alert");
  await expect(error).toContainText("If you already paid");
  await expect(error).not.toContainText("Nothing has been booked or charged");
  await error.getByRole("link", { name: "Booking help" }).click();
  await expect(page).toHaveURL(/\/help$/);
});
