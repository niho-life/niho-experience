import { expect, test } from "@playwright/test";

test("paused experience has no booking entry", async ({ page }) => {
  await page.goto("/experiences/evening-pottery-session");
  // The notice sits in the booking card on desktop and in the bottom bar on phones.
  await expect(page.getByText(/Bookings are paused/).filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: /^Check dates/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /^Book / })).toHaveCount(0);
});
test("empty, unavailable, and unknown catalog states have a way forward", async ({ page }) => {
  await page.goto("/experiences?mock=empty");
  await expect(page.getByRole("heading", { name: "No experiences are listed right now" })).toBeVisible();
  await page.goto("/experiences?mock=error");
  await expect(page.locator("main").getByRole("alert")).toContainText("couldn't load experiences");
  const res = await page.goto("/experiences/does-not-exist");
  expect(res?.status()).toBe(404);
});

test("host page keeps self-sign-up closed until NIHO provides the real registration route", async ({ page }) => {
  await page.goto("/host");

  await expect(page.getByRole("heading", { name: "Share what you love about Kamakura" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Choose how to list each experience" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "From first conversation to your page" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Start with your NIHO account" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Manage your experiences on NIHO" })).toHaveAttribute("href", "https://niho.life/experiences/provider");
});

test("the returning host entry fits a 320px phone", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto("/host");
  const management = page.getByRole("link", { name: "Manage your experiences on NIHO" });
  await management.scrollIntoViewIfNeeded();
  await expect(management).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
