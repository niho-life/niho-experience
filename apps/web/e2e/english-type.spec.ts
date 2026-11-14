import { expect, test } from "@playwright/test";

// 日本語の画面を NIHO Sans にしても (#615)、英語のサイトの書体は変えない（見出し Fraunces・本文 Nunito）。
test("the English site keeps Fraunces headings and Nunito text, and never uses NIHO Sans", async ({ page }) => {
  for (const path of ["/", "/experiences"]) {
    await page.goto(path);
    const heading = page.getByRole("heading", { level: 1 }).first();
    await expect(heading).toBeVisible();
    expect(await heading.evaluate((element) => getComputedStyle(element).fontFamily), path).toMatch(/^"Fraunces Variable"/);
    expect(await page.locator("body").evaluate((element) => getComputedStyle(element).fontFamily), path).toMatch(/^"Nunito Variable", "Hiragino Sans"/);
    const families = await page.evaluate(() => [...new Set([...document.querySelectorAll("body *")].map((element) => getComputedStyle(element).fontFamily))]);
    expect(families.filter((family) => family.includes("NIHO")), path).toEqual([]);
  }
});
