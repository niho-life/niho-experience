import { expect, test } from "@playwright/test";

test("date loading can be retried in place without losing the party size", async ({ page }) => {
  await page.goto("/experiences?guests=2&mock=availability-retry");
  await expect(page.getByText("Dates couldn't be checked. Showing experiences for your group.")).toBeVisible();
  await expect(page.locator("main article")).toHaveCount(4);
  await page.getByRole("button", { name: "Retry dates" }).click();
  await expect(page.getByRole("group", { name: "Date (Japan time)" }).getByRole("button", { name: /, \d+ experiences?$/ }).first()).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Guests" })).toHaveValue("2");
  await expect(page).toHaveURL(/guests=2/);
});

test("date chips show experiences with available sessions and keep the URL in sync", async ({ page }) => {
  await page.goto("/experiences");
  const status = page.getByRole("status");
  await expect(status).toContainText("4 experiences");

  // Counts appear once each experience's availability has been read in the browser.
  const chips = page.getByRole("group", { name: "Date (Japan time)" });
  const day = chips.getByRole("button", { name: /, \d+ experiences?$/ }).first();
  await expect(day).toBeVisible();
  const [dayLabel = "", countText = ""] = ((await day.getAttribute("aria-label")) ?? "").split(", ");
  const count = Number(countText.split(" ")[0]);
  expect(count).toBeGreaterThan(0);

  await day.click();
  await expect(day).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/[?&]date=\d{4}-\d{2}-\d{2}/);
  await expect(status).toContainText(`on ${dayLabel}`);
  await expect(page.locator("main article")).toHaveCount(count);
  // Each remaining card names its session on that day (never the seats left).
  await expect(page.locator("main article").first()).toContainText(dayLabel);
  await expect(page.locator("main")).not.toContainText(/places? (currently )?(left|available)/);

  await chips.getByRole("button", { name: "Any day" }).click();
  await expect(page).not.toHaveURL(/date=/);
  await expect(status).toContainText("4 experiences");
});

test("the home finder carries the date and party size to the list", async ({ page }) => {
  await page.goto("/");
  const finder = page.getByRole("search", { name: "Find experiences" });
  const when = finder.getByRole("combobox", { name: /When/ });
  const labels = await when.locator("option").allTextContents();
  // The fixture schedule includes Friday dinners; a fixed index can land on a day with no experiences.
  const fridayIndex = labels.findIndex((label, index) => index > 0 && /^Fri\b/.test(label));
  expect(fridayIndex).toBeGreaterThan(0);
  await when.selectOption({ index: fridayIndex });
  await finder.getByRole("combobox", { name: /Guests/ }).selectOption("2");
  await finder.getByRole("button", { name: "Find experiences" }).click();

  await expect(page).toHaveURL(/\/experiences\?date=\d{4}-\d{2}-\d{2}&guests=2$/);
  await expect(page.getByRole("status")).toContainText(`on ${labels[fridayIndex]} for 2 guests`);
  await expect(page.getByRole("combobox", { name: /Guests/ })).toHaveValue("2");
  await expect(page.getByRole("group", { name: "Date (Japan time)" }).getByRole("button", { pressed: true })).toHaveAccessibleName(new RegExp(`^${labels[fridayIndex]}`));
});

test("the home finder starts at two adults and carries them to the list", async ({ page }) => {
  await page.goto("/");
  const finder = page.getByRole("search", { name: "Find experiences" });
  await expect(finder.getByRole("combobox", { name: /Guests/ })).toHaveValue("2");
  await finder.getByRole("button", { name: "Find experiences" }).click();
  await expect(page).toHaveURL("/experiences?guests=2");
  await expect(page.getByRole("combobox", { name: /Guests/ })).toHaveValue("2");
});

test("an explicit one guest filter excludes experiences that require two guests", async ({ page }) => {
  await page.goto("/experiences?guests=1");
  await expect(page.getByRole("combobox", { name: /Guests/ })).toHaveValue("1");
  await expect(page.getByRole("link", { name: /seaside cycling and a fish market breakfast/i })).toHaveCount(0);
});

test("a party larger than every option's limit gets a clear way back", async ({ page }) => {
  await page.goto("/experiences?guests=8");
  await expect(page.getByRole("heading", { name: "No experiences for 8 guests" })).toBeVisible();
  await page.getByRole("button", { name: "Show all experiences" }).click();
  await expect(page.getByRole("status")).toContainText("4 experiences");
  await expect(page).not.toHaveURL(/guests=/);
  await expect(page.getByRole("combobox", { name: /Guests/ })).toHaveValue("");
});
