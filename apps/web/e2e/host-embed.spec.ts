import { expect, test, type Page } from "@playwright/test";

// 自分のサイトに貼る (#638, docs/embed.md「ホストの画面」) on synthetic data. Runs against the host server (mock mode,
// HOST_CONSOLE_ENABLED and EXPERIENCE_EMBED_ENABLED; see playwright.config.ts). Nothing is issued or stored.

const DINNER = "/host/experiences/community-dinner";
const SLUG = "kamakura-community-dinner";
const panel = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const overflowX = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function signIn(page: Page) {
  await page.goto("/host/auth/mock-login");
  await page.waitForURL(/\/host\/home(\?|$)/);
}

test("the editor's ページ opens 自分のサイトに貼る, with the widget's code, its URL and the booking button", async ({ page }) => {
  await signIn(page);
  await page.goto(DINNER);
  await expect(page.getByRole("textbox", { name: "題名" })).toBeVisible();
  const entry = panel(page, "ページ").getByRole("link", { name: "自分のサイトに貼る" });
  await expect(entry).toHaveAttribute("href", `${DINNER}/embed`);
  await entry.click();
  await page.waitForURL(new RegExp(`${DINNER}/embed$`));
  await expect(page.getByRole("heading", { level: 1, name: "自分のサイトに貼る" })).toBeVisible();
  await expect(page.getByText(/STUDIO・WordPress・Wix などで作ったサイトに、「.+」の予約を表示できます。/)).toBeVisible();

  // The preview is the real widget of this site, with booking turned off.
  const preview = panel(page, "プレビュー").locator("iframe");
  await expect(preview).toHaveAttribute("src", `/embed/experiences/${SLUG}/book?preview=1`);
  await expect(preview).toHaveAttribute("title", "予約ウィジェットのプレビュー");
  await expect(panel(page, "プレビュー")).toContainText("実際の表示です。プレビューでは予約できません。");

  const code = panel(page, "コード");
  const snippet = code.locator("pre");
  await expect(page.getByRole("button", { name: /予約ウィジェット/ })).toHaveAttribute("aria-pressed", "true");
  await expect(snippet).toContainText(`<iframe src="`);
  await expect(snippet).toContainText(`/embed/experiences/${SLUG}/book"`);
  await expect(snippet).toContainText("document.currentScript.previousElementSibling");
  await expect(snippet).toContainText(`niho-experience-embed-resize`);
  await expect(code).toContainText("高さは中身に合わせて自動で変わります。");

  await code.getByRole("button", { name: "URL だけ" }).click();
  await expect(code.getByRole("button", { name: "URL だけ" })).toHaveAttribute("aria-pressed", "true");
  await expect(snippet).toHaveText(new RegExp(`^https?://[^\\s]+/embed/experiences/${SLUG}/book$`));
  await expect(code).toContainText("URL だけを受け付ける埋め込み枠に使います。");

  await page.getByRole("button", { name: /予約ボタン/ }).click();
  await expect(page.getByRole("button", { name: /予約ボタン/ })).toHaveAttribute("aria-pressed", "true");
  await expect(snippet).toContainText(`/experiences/${SLUG}?utm_source=provider&amp;utm_medium=referral" target="_blank"`);
  await expect(snippet).toContainText(">Book now</a>");
  await expect(code.getByRole("button", { name: "URL だけ" })).toHaveCount(0);
  await expect(panel(page, "プレビュー").locator("iframe")).toHaveCount(0);
  await expect(panel(page, "プレビュー")).toContainText("Book now");

  for (const service of ["STUDIO", "WordPress", "Wix"]) await expect(panel(page, "貼り方").getByText(service, { exact: true })).toBeVisible();
  await expect(page.getByText("公開ページと同じく、コードと URL は誰でも見られるものです。")).toBeVisible();
});

test("自分のサイトに貼る does not scroll sideways at 360px", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await signIn(page);
  await page.goto(`${DINNER}/embed`);
  await expect(panel(page, "コード").locator("pre")).toContainText("document.currentScript.previousElementSibling");
  expect(await overflowX(page)).toBeLessThanOrEqual(0);
  await page.getByRole("button", { name: /予約ボタン/ }).click();
  expect(await overflowX(page)).toBeLessThanOrEqual(0);
});
