import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * 「NIHO アカウントでログイン」 (Epic #591, #594) in the preview: the host's entrance is a heading and one button, and a NIHO
 * account nobody registered ends on the not-registered page. This server runs with EXPERIENCE_HOST_NIHO_LOGIN_ENABLED; the
 * preview walks a synthetic NIHO (no network, no account).
 */

async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

test("the entrance is a heading and one button, with no email link and no explanation", async ({ page }) => {
  await page.goto("/host/auth/sign-in");
  await expect(page.getByRole("heading", { level: 1, name: "ホストのログイン" })).toBeVisible();
  const main = page.getByRole("main");
  await expect(main.getByRole("link")).toHaveCount(1);
  await expect(main.getByRole("link", { name: "NIHO アカウントでログイン" })).toHaveAttribute("href", "/host/auth/login");
  await expect(main.getByRole("button")).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveCount(0);
  const text = await main.innerText();
  for (const absent of ["メール", "パスワード", "体験の提供について", "LINE", "Google", "Apple"]) expect(text, absent).not.toContain(absent);
  await noHorizontalScroll(page);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("the one button signs the host in (the preview's NIHO) and lands on ホーム", async ({ page }) => {
  await page.goto("/host/auth/sign-in");
  await page.getByRole("link", { name: "NIHO アカウントでログイン" }).click();
  await page.waitForURL(/\/host\/home/);
  await expect(page.getByRole("link", { name: "NIHO アカウントでログイン" })).toHaveCount(0);
  // A signed-in host does not see the entrance again: it goes on to ホーム.
  await page.goto("/host/auth/sign-in");
  await page.waitForURL(/\/host\/home/);
});

test("the sign-in the host's pages ask for says the same words, and keeps the page it was for", async ({ page }) => {
  await page.goto("/host/home");
  const login = page.getByRole("link", { name: "NIHO アカウントでログイン" });
  await expect(login).toBeVisible();
  await expect(page.getByRole("link", { name: /^(メール|NIHO) でログイン$/ })).toHaveCount(0);
  await page.goto("/host/auth/sign-in?next=%2Fwrite%2Fnew");
  await expect(page.getByRole("link", { name: "NIHO アカウントでログイン" })).toHaveAttribute("href", "/host/auth/login?returnTo=%2Fwrite%2Fnew");
  // Anything that is not an allowlisted page is dropped.
  await page.goto("/host/auth/sign-in?next=https%3A%2F%2Fevil.example.test");
  await expect(page.getByRole("link", { name: "NIHO アカウントでログイン" })).toHaveAttribute("href", "/host/auth/login");
});

test("a NIHO account nobody registered ends on the not-registered page and signs nobody in", async ({ page }) => {
  await page.goto("/host/auth/login?mock=unregistered");
  await page.waitForURL(/\/host\/auth\/error\?reason=unregistered/);
  await expect(page.getByRole("heading", { level: 1, name: "このアカウントは、ホストに登録されていません" })).toBeVisible();
  const main = page.getByRole("main");
  await expect(main).toContainText("別の方法でログインしていませんか？");
  await expect(main).toContainText("ホストの登録に使った NIHO アカウントで、もう一度お試しください");
  await expect(main.getByRole("link", { name: "別の方法でやり直す" })).toHaveAttribute("href", "/host/auth/login");
  await expect(main.getByRole("link", { name: "運営に問い合わせる" })).toHaveAttribute("href", /^mailto:info@niho\.life\?/);
  await noHorizontalScroll(page);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  // Nobody is signed in: the console still asks for the login.
  await page.goto("/host/home");
  await expect(page.getByRole("link", { name: "NIHO アカウントでログイン" })).toBeVisible();
  // Trying another way leads back to NIHO (the preview's), which here is a registered account.
  await page.goto("/host/auth/error?reason=unregistered");
  await page.getByRole("link", { name: "別の方法でやり直す" }).click();
  await page.waitForURL(/\/host\/home/);
});

test("the other login failures keep their own words", async ({ page }) => {
  await page.goto("/host/auth/error?reason=suspended");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("停止されています");
  await expect(page.getByRole("link", { name: "もう一度ログイン" })).toHaveAttribute("href", "/host/auth/login");
  await page.goto("/host/auth/error?reason=unavailable");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("NIHO に接続できませんでした");
  await page.goto("/host/auth/error?reason=expired");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("時間切れ");
});
