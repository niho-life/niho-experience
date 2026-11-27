import { expect, test } from "@playwright/test";
import { bar, chooseFirstMarkedDay, isPhone } from "./support/search-bar";

const dinner = "/experiences/home-cooked-dinner-with-locals";

test("search conditions survive the search bar, detail, booking and the way back", async ({ page }) => {
  await page.goto("/experiences?q=dinner&theme=FOOD&guests=1");
  // A day with something on for this search and party, chosen in the search bar's calendar (#698).
  await chooseFirstMarkedDay(page);
  await expect(page).toHaveURL(/[?&]date=\d{4}-\d{2}-\d{2}/);
  const date = new URL(page.url()).searchParams.get("date")!;
  await expect(page).toHaveURL(/[?&]q=dinner/);
  await expect(page).toHaveURL(/[?&]theme=FOOD/);
  await expect(page).toHaveURL(/[?&]guests=1/);
  await expect(bar(page)).toContainText("1 guest");
  await page.getByRole("link", { name: /home-cooked dinner/i }).click();
  expect(new URL(page.url()).searchParams.get("date")).toBe(date);
  expect(new URL(page.url()).searchParams.get("guests")).toBe("1");
  await page.getByRole("link", { name: /^Check dates/ }).click();
  await expect(page.getByRole("spinbutton", { name: "Adults", exact: true })).toHaveValue("1");
  await expect(page.locator(`input[name="occurrence"][value="${date}"]`)).toBeChecked();
  await page.goBack();
  await page.locator('a[aria-label="All experiences"]:visible, nav[aria-label="Breadcrumb"] a:visible').click();
  // The keyword field is the pill's on a wide screen; on a phone it is in the sheet, so read the address there.
  if (isPhone(page)) expect(new URL(page.url()).searchParams.get("q")).toBe("dinner");
  else await expect(bar(page).getByRole("searchbox")).toHaveValue("dinner");
  await expect(page.getByLabel("Theme")).toHaveValue("FOOD");
  await expect(bar(page)).toContainText("1 guest");
  expect(new URL(page.url()).searchParams.get("date")).toBe(date);
});

test("changing the party keeps selection and contact details in memory, with renewed agreement", async ({ page }) => {
  await page.goto(`${dinner}/book?guests=2`);
  const slot = page.getByRole("radio", { name: /(?:[4-9]|[1-9]\d+) places currently available/ }).first();
  await slot.check();
  const date = await slot.inputValue();
  await page.getByRole("spinbutton", { name: "Children", exact: true }).fill("1");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("textbox", { name: "Full name" }).fill("Sample Guest");
  await page.getByRole("textbox", { name: "Email", exact: true }).fill("guest@example.com");
  await page.getByRole("textbox", { name: /Anything else/ }).fill("Sample note");
  await page.getByRole("checkbox", { name: /agree to version/ }).check();
  await page.getByRole("button", { name: "Change date or guest count" }).click();
  await expect(page.getByRole("spinbutton", { name: "Adults", exact: true })).toHaveValue("2");
  await expect(page.getByRole("spinbutton", { name: "Children", exact: true })).toHaveValue("1");
  await expect(page.locator(`input[name="occurrence"][value="${date}"]`)).toBeChecked();
  await page.getByRole("spinbutton", { name: "Adults", exact: true }).fill("3");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Full name" })).toHaveValue("Sample Guest");
  await expect(page.getByRole("textbox", { name: "Email", exact: true })).toHaveValue("guest@example.com");
  await expect(page.getByRole("textbox", { name: /Anything else/ })).toHaveValue("Sample note");
  await expect(page.getByRole("checkbox", { name: /agree to version/ })).not.toBeChecked();
  expect(page.url()).not.toContain("guest@example.com");
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  await page.reload();
  await page.getByRole("radio", { name: /(?:[4-9]|[1-9]\d+) places currently available/ }).first().check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Full name" })).toHaveValue("");
});

test("answers to the same question set survive date reselection", async ({ page }) => {
  await page.goto("/experiences/indigo-dyeing-with-an-artisan/book");
  await page.locator('input[name="occurrence"]:not([disabled])').first().check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByLabel(/Which shade would you like to dye/).selectOption("o_deep");
  await page.getByRole("button", { name: "Change date or guest count" }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByLabel(/Which shade would you like to dye/)).toHaveValue("o_deep");
});
