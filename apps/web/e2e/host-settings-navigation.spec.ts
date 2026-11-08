import { expect, test } from "@playwright/test";

test("設定の独立した画面から同じ提供者の一覧へ戻れる", async ({ page }) => {
  await page.goto("/host/auth/mock-login");
  await page.waitForURL(/\/host\/home/);
  const providerId = "sample-provider-kitchen";
  for (const path of [
    `/host/profile?providerId=${providerId}`,
    `/host/seller?providerId=${providerId}`,
    `/host/support?hostKind=EXPERIENCE_PROVIDER&hostId=${providerId}`,
  ]) {
    await page.goto(path);
    const back = page.getByRole("link", { name: "設定へ戻る", exact: true });
    await expect(back).toBeVisible();
    await expect(back).toHaveAttribute("href", `/host/settings?providerId=${providerId}`);
    await back.click();
    await expect(page.getByRole("heading", { level: 1, name: "設定", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(["販売者", "運営", "アカウント"]);
  }
});

test("旧設定のブックマークは提供者・追加query・hashを保って項目を開く", async ({ page }) => {
  await page.goto("/host/auth/mock-login");
  await page.waitForURL(/\/host\/home/);
  await page.goto("/host/settings?providerId=sample-provider-kitchen&from=bookmark#settings-notification");
  await page.waitForURL((url) => url.searchParams.get("section") === "notifications");
  const url = new URL(page.url());
  expect(url.searchParams.get("providerId")).toBe("sample-provider-kitchen");
  expect(url.searchParams.get("from")).toBe("bookmark");
  expect(url.hash).toBe("#settings-notification");
  await expect(page.getByRole("heading", { level: 1, name: "通知", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "通知", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "掲載名", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "カレンダー", exact: true })).toHaveCount(0);
});

test("項目別の設定は必要なパネルだけを開き、未保存の入力を守る", async ({ page }) => {
  await page.goto("/host/auth/mock-login");
  await page.waitForURL(/\/host\/home/);
  await page.goto("/host/settings?providerId=sample-provider-kitchen");
  await page.getByRole("link", { name: "提供者情報", exact: true }).click();
  const name = page.getByRole("textbox", { name: "掲載名", exact: true });
  await expect(name).toBeVisible();
  await expect(page.getByRole("region", { name: "通知", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "カレンダー", exact: true })).toHaveCount(0);
  await name.fill("編集中の提供者");
  await page.getByRole("link", { name: "設定へ戻る", exact: true }).click();
  const leave = page.getByRole("dialog", { name: "保存していない変更があります", exact: true });
  await expect(leave).toBeVisible();
  await leave.getByRole("button", { name: "編集を続ける", exact: true }).click();
  await expect(name).toHaveValue("編集中の提供者");
  await page.goBack();
  await expect(leave).toBeVisible();
  await leave.getByRole("button", { name: "編集を続ける", exact: true }).click();
  await expect(name).toHaveValue("編集中の提供者");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "保存しました" })).toBeVisible();
  await page.getByRole("link", { name: "設定へ戻る", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "設定", exact: true })).toBeVisible();
});

test("通知だけを開いた画面でも保存でき、他項目の非表示入力に妨げられない", async ({ page }) => {
  await page.goto("/host/auth/mock-login");
  await page.waitForURL(/\/host\/home/);
  await page.goto("/host/settings?providerId=sample-provider-kitchen&section=notifications");
  await expect(page.getByRole("textbox", { name: "掲載名", exact: true })).toHaveCount(0);
  const review = page.getByRole("switch", { name: "新しいレビュー", exact: true });
  await review.uncheck();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "保存しました" })).toBeVisible();
  await expect(review).not.toBeChecked();
  await page.getByRole("link", { name: "設定へ戻る", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "設定", exact: true })).toBeVisible();
});
