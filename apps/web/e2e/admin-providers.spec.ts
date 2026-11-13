import { expect, test, type Page, type Route } from "@playwright/test";

/*
 * 提供者 (#542 S2): /admin/products and /admin/products/<providerId> with ADMIN_PRODUCT_WORKSPACES_PREVIEW_ENABLED
 * (mock mode). The page keeps no synthetic data; every API call of the browser is stubbed here, so nothing is saved.
 */

const CONSENT = "provider-consent-sample-1";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const KITCHEN = "provider-sample-kitchen";
const WORKSHOP = "provider-sample-workshop";
const UNNAMED = "provider-sample-unnamed";
const NEW_ID = "provider-sample-new";

type Kind = "PERSON" | "BUSINESS" | null;
interface Provider { providerId: string; publicDisplayName: string | null; providerKind: Kind; profileVersion: number | null; sellerProviderDisplayName: string | null; sellerDisplayName: string | null }
interface Asset { id: string; placement: "PROVIDER_PHOTO" | "BUSINESS_LOGO"; altText: string; altTextJa: string; publicCredit: string | null; previewUrl: string }

interface Backend {
  providers: Provider[];
  assets: Record<string, Asset[]>;
  mediaVersion: number;
  posts: Record<string, unknown>[];
  puts: Record<string, unknown>[];
  uploads: { headers: Record<string, string>; contentType: string | undefined }[];
  deletes: { url: string; headers: Record<string, string> }[];
}

const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", headers: { "cache-control": "private, no-store" }, body: JSON.stringify(body) });

async function installStubs(page: Page): Promise<Backend> {
  const backend: Backend = {
    providers: [
      { providerId: KITCHEN, publicDisplayName: "サンプルの台所", providerKind: "BUSINESS", profileVersion: 2, sellerProviderDisplayName: "サンプルの台所", sellerDisplayName: "サンプル販売者" },
      { providerId: WORKSHOP, publicDisplayName: "サンプル工房", providerKind: "PERSON", profileVersion: 1, sellerProviderDisplayName: null, sellerDisplayName: null },
      { providerId: UNNAMED, publicDisplayName: null, providerKind: null, profileVersion: null, sellerProviderDisplayName: "サンプルの店", sellerDisplayName: "サンプル販売者B" },
    ],
    assets: {}, mediaVersion: 1, posts: [], puts: [], uploads: [], deletes: [],
  };
  const bodyOf = (providerId: string) => {
    const provider = backend.providers.find((item) => item.providerId === providerId)!;
    return {
      provider,
      profile: provider.publicDisplayName ? { providerId, publicDisplayName: provider.publicDisplayName, providerKind: provider.providerKind, consentVersion: CONSENT, consentedAtUtc: "2026-11-01T00:00:00.000Z", version: provider.profileVersion } : null,
      providerMedia: { version: backend.mediaVersion, assets: backend.assets[providerId] ?? [] },
      consentVersion: CONSENT,
      managedSalesAvailable: false,
    };
  };
  await page.route("**/admin/api/product-workspaces**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const parts = url.pathname.split("/").filter(Boolean); // admin, api, product-workspaces, <id>, <leaf>, <asset>
    const providerId = parts[3] ? decodeURIComponent(parts[3]) : null;
    const leaf = parts[4];
    if (!providerId) {
      if (method === "GET") return json(route, 200, { providers: backend.providers, consentVersion: CONSENT });
      const body = request.postDataJSON() as Record<string, unknown>;
      backend.posts.push(body);
      backend.providers.push({ providerId: NEW_ID, publicDisplayName: String(body.publicDisplayName), providerKind: (body.providerKind as Kind), profileVersion: 1, sellerProviderDisplayName: null, sellerDisplayName: null });
      return json(route, 200, { profile: { providerId: NEW_ID } });
    }
    if (leaf === "profile") {
      if (method === "GET") return json(route, 200, bodyOf(providerId));
      const body = request.postDataJSON() as { expectedVersion: number | null; profile: { publicDisplayName: string; providerKind: Kind } };
      backend.puts.push(body as unknown as Record<string, unknown>);
      const provider = backend.providers.find((item) => item.providerId === providerId)!;
      provider.publicDisplayName = body.profile.publicDisplayName;
      provider.providerKind = body.profile.providerKind;
      provider.profileVersion = (provider.profileVersion ?? 0) + 1;
      return json(route, 200, bodyOf(providerId));
    }
    if (leaf === "provider-media") {
      if (method === "GET") return route.fulfill({ status: 200, contentType: "image/png", body: PNG });
      if (method === "POST") {
        const headers = request.headers();
        backend.uploads.push({ headers, contentType: headers["content-type"] });
        backend.mediaVersion += 1;
        const decode = (value: string) => Buffer.from(value, "base64url").toString("utf8");
        backend.assets[providerId] = [{ id: "asset-sample-1", placement: headers["x-experience-media-placement"] as Asset["placement"], altText: decode(headers["x-experience-photo-alt-text-utf8-base64url"] ?? ""), altTextJa: decode(headers["x-experience-photo-alt-text-ja-utf8-base64url"] ?? ""), publicCredit: null, previewUrl: `/admin/api/product-workspaces/${providerId}/provider-media/asset-sample-1` }];
        return json(route, 200, bodyOf(providerId));
      }
      if (method === "DELETE") {
        backend.deletes.push({ url: url.pathname, headers: request.headers() });
        backend.mediaVersion += 1;
        backend.assets[providerId] = [];
        return json(route, 200, bodyOf(providerId));
      }
    }
    if (leaf === "provider-media") return json(route, 404, { error: "not_found" });
    if (leaf === "products" && method === "GET") return json(route, 200, { products: [], publicationConsentVersion: "publication-consent-sample-1", managedSalesAvailable: false });
    return json(route, 404, { error: "not_found" });
  });
  return backend;
}

async function signIn(page: Page): Promise<Backend> {
  const backend = await installStubs(page);
  await page.goto("/admin");
  await page.getByRole("button", { name: "合成Adminとして開く" }).click();
  await page.waitForURL(/\/admin\/bookings/);
  return backend;
}

const list = (page: Page) => page.getByRole("region", { name: "提供者の一覧" });
const rowOf = (page: Page, text: string) => list(page).getByRole("link").filter({ hasText: text });

test("the list: a row per provider, a pill only for an exception, each a link", async ({ page }) => {
  await signIn(page);
  await page.goto("/admin/products");
  await expect(page.getByRole("heading", { level: 1, name: "提供者" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "管理メニュー" }).getByRole("link", { name: "提供者", exact: true })).toHaveAttribute("aria-current", "page");
  const kitchen = rowOf(page, "サンプルの台所");
  await expect(kitchen).toHaveAttribute("href", `/admin/products/${KITCHEN}`);
  await expect(kitchen).toContainText("サンプル販売者");
  await expect(kitchen.getByText("公開名なし")).toHaveCount(0);
  await expect(kitchen.getByText("販売者なし")).toHaveCount(0);
  await expect(rowOf(page, "サンプル工房")).toContainText("販売者なし");
  const unnamed = rowOf(page, "サンプルの店");
  await expect(unnamed).toContainText("公開名なし");
  await expect(unnamed).toHaveAttribute("href", `/admin/products/${UNNAMED}`);
  // Nothing of the old per-row buttons or the explanatory paragraph.
  await expect(page.getByText("提供者情報・下書き")).toHaveCount(0);
  await expect(page.getByText("Experience 正本")).toHaveCount(0);
});

test("registering: a dialog, the consent, then the provider's own page", async ({ page }) => {
  const backend = await signIn(page);
  await page.goto("/admin/products");
  await page.getByRole("button", { name: "登録" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "提供者を登録" })).toBeVisible();
  const submit = dialog.getByRole("button", { name: "登録", exact: true });
  const name = dialog.getByRole("textbox", { name: "旅行者へ公開する提供者名" });
  await expect(name).toBeFocused();
  await expect(name).toHaveAttribute("placeholder", "公開名");
  await name.fill("サンプル新店");
  // Without the consent it cannot be pressed.
  await expect(submit).toBeDisabled();
  await dialog.getByRole("radiogroup", { name: "提供者の種別" }).getByText("個人").click();
  await dialog.getByRole("checkbox", { name: "事務局が、提供者からこの公開名でExperienceサイトへ掲載する承諾を得ていることを確認しました。" }).check();
  await expect(submit).toBeEnabled();
  await submit.click();
  await page.waitForURL(new RegExp(`/admin/products/${NEW_ID}$`));
  expect(backend.posts).toEqual([{ publicDisplayName: "サンプル新店", providerKind: "PERSON", consentVersion: CONSENT, consentConfirmed: true }]);
  await expect(page.getByRole("heading", { level: 1, name: "サンプル新店" })).toBeVisible();
});

test("the provider's page: saving the public information needs the consent again", async ({ page }) => {
  const backend = await signIn(page);
  await page.goto(`/admin/products/${KITCHEN}`);
  await expect(page.getByRole("heading", { level: 1, name: "サンプルの台所" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "公開情報" })).toBeVisible();
  const consent = page.getByRole("checkbox", { name: "事務局が、この公開名と種別で掲載する提供者の承諾を確認しました。" });
  const save = page.getByRole("button", { name: "保存", exact: true });
  await expect(save).toBeDisabled();
  await consent.check();
  await expect(save).toBeEnabled();
  // Changing the name takes the consent back.
  await page.getByRole("textbox", { name: "旅行者へ公開する提供者名" }).fill("サンプルの台所 本店");
  await expect(consent).not.toBeChecked();
  await expect(save).toBeDisabled();
  await consent.check();
  await save.click();
  await expect(page.getByRole("status").filter({ hasText: "公開用の提供者情報と承諾確認を保存しました。" })).toBeVisible();
  expect(backend.puts).toEqual([{ expectedVersion: 2, profile: { publicDisplayName: "サンプルの台所 本店", providerKind: "BUSINESS", consentVersion: CONSENT, publicDisplayNameEn: null, consentConfirmed: true } }]);
  await expect(consent).not.toBeChecked();
  await expect(page.getByRole("heading", { level: 1, name: "サンプルの台所 本店" })).toBeVisible();
});

test("photos: a dialog to register, and 公開を撤回", async ({ page }) => {
  const backend = await signIn(page);
  await page.goto(`/admin/products/${KITCHEN}`);
  await expect(page.getByText("公開写真は未登録です。")).toBeVisible();
  await page.getByRole("button", { name: "写真", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "写真を登録" })).toBeVisible();
  const submit = dialog.getByRole("button", { name: "登録", exact: true });
  await dialog.getByRole("radiogroup", { name: "用途" }).getByText("事業者ロゴ").click();
  await dialog.locator('input[type="file"]').setInputFiles({ name: "sample.png", mimeType: "image/png", buffer: PNG });
  await dialog.getByLabel("画像の説明（英語）").fill("Sample logo");
  await dialog.getByLabel("画像の説明（日本語）").fill("サンプルのロゴ");
  await expect(submit).toBeDisabled();
  await dialog.getByRole("checkbox", { name: "事務局が、権利者と写っている方から、この画像を選択した用途でExperienceサイトへ公開する明示的な許諾を得ていることを確認しました。" }).check();
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByRole("status").filter({ hasText: "事業者ロゴを差し替えました。" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(backend.uploads).toHaveLength(1);
  const headers = backend.uploads[0]!.headers;
  expect(headers["content-type"]).toBe("image/png");
  expect(headers["x-experience-photo-rights-confirmed"]).toBe("true");
  expect(headers["x-experience-provider-profile-consent-version"]).toBe(CONSENT);
  expect(headers["x-experience-provider-media-version"]).toBe("1");
  expect(headers["x-experience-media-placement"]).toBe("BUSINESS_LOGO");
  await expect(page.getByText("事業者ロゴ", { exact: true })).toBeVisible();
  await expect(page.getByText("サンプルのロゴ")).toBeVisible();

  await page.getByRole("button", { name: "公開を撤回" }).click();
  await expect(page.getByRole("status").filter({ hasText: "公開写真を撤回しました。公開画面と画像配信から外れます。" })).toBeVisible();
  expect(backend.deletes).toHaveLength(1);
  expect(backend.deletes[0]!.url).toBe(`/admin/api/product-workspaces/${KITCHEN}/provider-media/asset-sample-1`);
  expect(backend.deletes[0]!.headers["x-experience-provider-media-version"]).toBe("2");
  await expect(page.getByText("公開写真は未登録です。")).toBeVisible();
});

test("a provider without a seller shows 販売者なし instead of the experiences", async ({ page }) => {
  await signIn(page);
  await page.goto(`/admin/products/${WORKSHOP}`);
  await expect(page.getByRole("heading", { level: 1, name: "サンプル工房" })).toBeVisible();
  const experiences = page.getByRole("region", { name: "体験" });
  await expect(experiences).toContainText("販売者なし");
  // A provider with no public name yet cannot take a photo.
  await page.goto(`/admin/products/${UNNAMED}`);
  await expect(page.getByRole("button", { name: "写真", exact: true })).toBeDisabled();
});

test("on a phone the provider's page has a 提供者 band and no tabs; nothing scrolls sideways", async ({ page }, testInfo) => {
  await signIn(page);
  await page.goto("/admin/products");
  const overflowList = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflowList).toBeLessThanOrEqual(0);
  await page.goto(`/admin/products/${KITCHEN}`);
  await expect(page.getByRole("heading", { level: 1, name: "サンプルの台所" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const menu = page.getByRole("navigation", { name: "管理メニュー" });
  if (testInfo.project.name.includes("mobile")) {
    await expect(menu).toHaveCount(0);
    const back = page.getByRole("link", { name: "提供者へ戻る" });
    await expect(back).toHaveAttribute("href", "/admin/products");
    await back.click();
    await page.waitForURL(/\/admin\/products$/);
    await expect(menu.getByRole("link", { name: "提供者", exact: true })).toBeVisible();
  } else {
    await expect(menu.getByRole("link", { name: "提供者", exact: true })).toHaveAttribute("aria-current", "page");
  }
});
