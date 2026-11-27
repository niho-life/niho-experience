import { expect, test } from "@playwright/test";
import { searchKeyword } from "./support/search-bar";

// デフォルトのmockサイト検証とは別の、公開文書APIを持つ合成サーバーで実行する。
test.beforeEach(async ({ request }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("published-"));
  await request.get("http://127.0.0.1:3251/__test/reset");
});
test("公開本文・スタイル・業務ブロックをSSRし、一覧の検索を維持する", async ({ page, request }, testInfo) => {
  for (const [path, id] of [["/", "home"], ["/experiences", "experiences"], ["/experiences/home-cooked-dinner-with-locals", "experience-detail"], ["/experiences/home-cooked-dinner-with-locals/book", "booking"], ["/host", "host"]]) {
    const html = await (await request.get(path!)).text();
    expect(html).toContain(`Published ${id} text`);
    expect(html).toContain("data-nw-scope");
    await page.goto(path!);
    const heading = page.getByRole("heading", { name: `Published ${id} text`, exact: true });
    await expect(heading).toBeVisible();
    await expect(heading).toHaveCSS("color", "rgb(18, 52, 86)");
    await expect(heading).toHaveCSS("font-size", testInfo.project.name.endsWith("desktop") ? "48px" : "40px");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.locator("main")).toHaveCount(1);
  }
  await page.goto("/experiences");
  await searchKeyword(page, "pottery");
  await expect(page.getByRole("heading", { name: "Evening pottery session", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Home-cooked dinner with locals in a shared living room" })).toHaveCount(0);
});
test("公開版の更新とロールバックを次のSSRへ反映し、古い本文を残さない", async ({ request }) => {
  const renderHome = async () => {
    const response = await request.get("/");
    expect(response.ok()).toBe(true);
    return response.text();
  };
  const setVersion = async (version: "updated" | "rollback") => {
    const response = await request.get(`http://127.0.0.1:3251/__test/version?page=home&version=${version}`);
    expect(response.ok()).toBe(true);
  };

  expect(await renderHome()).toContain("Published home text");

  await setVersion("updated");
  const updatedHtml = await renderHome();
  expect(updatedHtml).toContain("Updated published home text");
  expect(updatedHtml).not.toContain("Published home text");

  await setVersion("rollback");
  const rolledBackHtml = await renderHome();
  expect(rolledBackHtml).toContain("Published home text");
  expect(rolledBackHtml).not.toContain("Updated published home text");
});
test("未公開・エラー・不正文書は現行ページへ戻り、業務リンクは固定する", async ({ page, request }) => {
  for (const mode of ["missing", "error", "invalid"]) {
    await request.get(`http://127.0.0.1:3251/__test/mode?page=home&mode=${mode}`);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Meet the people who make Kamakura home" })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("private diagnostic");
  }
  await page.goto("/experiences/home-cooked-dinner-with-locals");
  await expect(page.getByRole("link", { name: /Check dates/ }).first()).toHaveAttribute("href", "/experiences/home-cooked-dinner-with-locals/book");
  await expect(page.locator("main")).toContainText("¥6,500");
  await page.goto("/experiences/home-cooked-dinner-with-locals/book");
  await expect(page.locator("main")).toContainText("Choose a date");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await page.goto("/host");
  await expect(page.getByRole("link", { name: /Tell us.*interested/ })).toHaveAttribute("href", "https://niho.example/contact");
});
