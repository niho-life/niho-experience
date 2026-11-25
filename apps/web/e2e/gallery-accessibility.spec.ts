import { expect, test } from "@playwright/test";

const dinner = "/experiences/home-cooked-dinner-with-locals";

test("photo navigation is operable by buttons and keyboard, with a spoken position", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(dinner);
  const gallery = page.getByRole("region", { name: /^Photos of/ });
  const position = page.getByRole("status").filter({ hasText: /photo \d+ of \d+/i });
  await expect(position).toContainText(/photo 1 of 4/i);
  await expect(page.getByRole("button", { name: "Previous photo" })).toBeDisabled();
  await page.getByRole("button", { name: "Next photo" }).click();
  await expect(position).toContainText(/photo 2 of 4/i);
  await gallery.focus();
  await page.keyboard.press("End");
  await expect(position).toContainText(/photo 4 of 4/i);
  await expect(page.getByRole("button", { name: "Next photo" })).toBeDisabled();
  await page.keyboard.press("ArrowLeft");
  await expect(position).toContainText(/photo 3 of 4/i);
  await page.keyboard.press("Home");
  await expect(position).toContainText(/photo 1 of 4/i);
  await expect(gallery).toBeFocused();
});

test("a gallery photo opens the all-photos dialog on phones and desktop", async ({ page }, testInfo) => {
  test.skip(!["mobile-360", "desktop"].includes(testInfo.project.name));
  await page.goto(dinner);
  await page.getByRole("button", { name: /^All photos:/ }).first().click();
  const dialog = page.getByRole("dialog", { name: "All photos" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("img")).toHaveCount(4);
});

test("single-photo and empty galleries do not announce unavailable navigation help", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });

  for (const scenario of ["gallery-single-photo", "gallery-no-photos"]) {
    await page.goto(`${dinner}?mock=${scenario}`);
    const gallery = page.getByRole("region", { name: /^Photos of/ });
    await expect(gallery).not.toHaveAttribute("aria-describedby");
    await expect(page.getByText("Use the left and right arrow keys to browse photos.")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Previous photo" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Next photo" })).toHaveCount(0);

    if (scenario === "gallery-single-photo") {
      await expect(gallery.getByRole("img")).toHaveCount(1);
    } else {
      await expect(gallery.getByRole("img", { name: /Photos of .* are not available/ })).toBeVisible();
    }
  }
});

test("a failed photo keeps its description and does not disable navigation", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.route("**/broken-photo-for-test.jpg", (route) => route.abort());
  await page.goto(dinner);
  const gallery = page.getByRole("region", { name: /^Photos of/ });
  // Synthetic photos are data URLs, so replace one source to exercise a real image-load error.
  await gallery.getByRole("img").first().evaluate((image) => { (image as HTMLImageElement).src = "/broken-photo-for-test.jpg"; });
  await expect(gallery.getByText("Photo unavailable").first()).toBeVisible();
  await expect(gallery.getByRole("img").first()).toHaveAccessibleName(/.+/);
  await page.getByRole("button", { name: "Next photo" }).click();
  await expect(page.getByRole("status").filter({ hasText: /photo 2 of 4/i })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("the full gallery returns keyboard focus after closing", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(dinner);
  const open = page.getByRole("button", { name: "Show all 4 photos" });
  await open.click();
  const dialog = page.getByRole("dialog", { name: "All photos" });
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
});
