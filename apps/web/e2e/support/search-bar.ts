import { expect, type Locator, type Page } from "@playwright/test";

/*
 * The search bar (#698) has two shapes: a pill with the keyword, day and guests segments (sm and wider) and, below sm, one button
 * that opens a bottom sheet. These helpers drive whichever one the project's viewport shows, so a spec reads the same on both.
 */

export const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 640;

export const bar = (page: Page) => page.getByRole("search", { name: "Find an experience" });

/** Opens the phone sheet; on a wide screen there is nothing to open (the pill is always there). */
export async function openSheet(page: Page): Promise<Locator | null> {
  if (!isPhone(page)) return null;
  const sheet = page.getByRole("dialog", { name: "Find an experience" });
  if (!(await sheet.isVisible())) await bar(page).getByRole("button", { name: /Find an experience/ }).click();
  await expect(sheet).toBeVisible();
  return sheet;
}

export async function closeSheet(page: Page) {
  if (!isPhone(page)) return;
  const sheet = page.getByRole("dialog", { name: "Find an experience" });
  if (await sheet.isVisible()) await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toBeHidden();
}

/** The place the calendar is in: the phone sheet, or the day popover of the pill (opened if it is not). */
export async function openCalendar(page: Page): Promise<Locator> {
  const sheet = await openSheet(page);
  if (sheet) return sheet;
  const popover = page.getByRole("dialog", { name: "Choose a day (Japan time)" });
  if (!(await popover.isVisible())) await bar(page).getByRole("button", { name: /^When/ }).click();
  await expect(popover).toBeVisible();
  return popover;
}

/** Days with something on, once availability has been read. */
export const markedDays = (calendar: Locator) => calendar.locator('button[aria-pressed][aria-label$="something on"]');

/** Chooses the first day with something on (not `skip` first ones) and returns its label, e.g. "Sat 5 Dec". */
export async function chooseFirstMarkedDay(page: Page, skip = 0): Promise<string> {
  const calendar = await openCalendar(page);
  const day = markedDays(calendar).nth(skip);
  await expect(day).toBeVisible();
  const label = ((await day.getAttribute("aria-label")) ?? "").split(", ")[0] ?? "";
  await day.click();
  await closeSheet(page);
  return label;
}

/** Sets the party (2 or more) with the stepper's ＋: from "Any" the first press makes 2. */
export async function chooseGuests(page: Page, guests: number) {
  const sheet = await openSheet(page);
  const scope = sheet ?? page.getByRole("dialog", { name: "How many guests?" });
  if (!sheet && !(await scope.isVisible())) await bar(page).getByRole("button", { name: /^Guests/ }).click();
  await expect(scope).toBeVisible();
  const more = scope.getByRole("button", { name: "More guests" });
  for (let press = 0; press < guests - 1; press += 1) await more.click();
  await closeSheet(page);
  if (!sheet) await page.keyboard.press("Escape");
}

/** Types a keyword in whichever field is on screen and submits it with Enter. */
export async function searchKeyword(page: Page, text: string) {
  const sheet = await openSheet(page);
  const field = (sheet ?? bar(page)).getByRole("searchbox");
  await field.fill(text);
  await field.press("Enter");
}

/** Presses 「Search」: the pill's button, or the sheet's footer button on a phone (top mode). */
export async function submitSearch(page: Page) {
  const sheet = await openSheet(page);
  await (sheet ?? bar(page)).getByRole("button", { name: "Search", exact: true }).click();
}
