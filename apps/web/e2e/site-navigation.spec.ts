import { expect, test } from "@playwright/test";

// The English header, its phone menu and the About / Help pages (#672). The menu trigger is an accessible button on its
// native <summary>, with an expanded state. The mock preview registers the sample guides, so Journal is shown.

test.describe("desktop header", () => {
  test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== "desktop"));

  test("shows the traveler tabs and a host entrance", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.getByRole("link")).toHaveText(["Experiences", "Journal", "About", "Help", "For hosts"]);
    await expect(nav.getByRole("link", { name: "For hosts" })).toHaveAttribute("href", "/host");
    await expect(page.getByRole("banner").getByRole("button", { name: "Menu" })).toBeHidden();
  });

  test("About opens from the header with its heading", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "About" }).click();
    await expect(page).toHaveURL(/\/about$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("It starts in the town’s living room");
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "About" })).toHaveAttribute("aria-current", "page");
  });
});

test.describe("phone menu", () => {
  test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== "mobile-360"));

  test("opens with every destination, and navigating closes it", async ({ page }) => {
    await page.goto("/");
    const button = page.getByRole("banner").getByRole("button", { name: "Menu" });
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link")).toHaveText(["Experiences"]);
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await button.click();
    await expect(button).toHaveAttribute("aria-expanded", "true");
    const menu = page.getByRole("navigation", { name: "Menu" });
    await expect(menu.getByRole("heading")).toHaveText(["Explore", "Plan your visit", "For hosts"]);
    for (const name of ["All experiences", "Kamakura Journal", "About", "Booking help", "Manage your booking", "Host an experience", "Log in"]) {
      await expect(menu.getByRole("link", { name, exact: true })).toBeVisible();
    }
    await expect(menu.getByRole("link", { name: "Log in", exact: true })).toHaveAttribute("href", "/host/auth/login");
    await menu.getByRole("link", { name: "About" }).click();
    await expect(page).toHaveURL(/\/about$/);
    await expect(page.getByRole("navigation", { name: "Menu" })).toBeHidden();
    await expect(button).toHaveAttribute("aria-expanded", "false");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("Escape closes the menu and returns focus to its button", async ({ page }) => {
    await page.goto("/");
    const button = page.getByRole("banner").getByRole("button", { name: "Menu" });
    await button.click();
    await expect(page.getByRole("navigation", { name: "Menu" })).toBeVisible();
    await expect(button).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("navigation", { name: "Menu" })).toBeHidden();
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await expect(button).toBeFocused();
  });
});

test("Help shows the common questions and one opens", async ({ page }) => {
  await page.goto("/help");
  await expect(page.getByRole("heading", { name: "Common questions" })).toBeVisible();
  const lookup = page.locator("#find-booking");
  await expect(lookup.getByRole("heading")).toContainText("booking");
  const question = page.getByText("Do I need an account?");
  await question.click();
  await expect(page.getByText("No. You book as a guest with your name and email address.")).toBeVisible();
});
