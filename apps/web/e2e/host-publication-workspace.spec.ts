import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { build } from "vite";

// Exercise the real host component with synthetic responses; no host account or live API.
const ORIGIN = "https://publication.example.test";
let bundle: string;
test.beforeAll(async () => {
  const result = await build({
    configFile: false, envDir: false, logLevel: "error",
    root: fileURLToPath(new URL("..", import.meta.url)),
    resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } },
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    build: {
      lib: { entry: fileURLToPath(new URL("./fixtures/host-publication-client.tsx", import.meta.url)), name: "HostPublicationTest", formats: ["iife"] },
      write: false, minify: false,
    },
  });
  const outputs = Array.isArray(result) ? result : "output" in result ? [result] : [];
  const chunk = outputs.flatMap((output) => output.output).find((output) => output.type === "chunk");
  if (!chunk) throw new Error("Synthetic publication client was not built");
  bundle = chunk.code;
});

test("Japanese and English lists accept typed new lines and survive workspace switches", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(`${ORIGIN}/`, (route) => route.fulfill({ contentType: "text/html", body: '<!doctype html><meta charset="utf-8"><div id="root"></div>' }));
  await page.route(`${ORIGIN}/synthetic/products/synthetic-product`, (route) => route.fulfill({ json: { product: {
    id: "synthetic-product", version: "1", status: "DRAFT", publicationNeedsUpdate: false,
    publicationBlockers: [], sellerDisplayName: "Synthetic seller", saleTerms: null, offers: [], media: [],
    draft: { slug: "synthetic-product", publicTitle: "Synthetic product", currency: "JPY", unitAmount: 5000, content: {
      ja: { title: "合成の商品", highlights: ["一つ目"], included: [], notIncluded: [], knowBeforeYouGo: [], notSuitableFor: [], timeline: [] },
      highlights: ["First"], included: [], notIncluded: [], knowBeforeYouGo: [], notSuitableFor: [],
    } },
  } } }));
  await page.route(`${ORIGIN}/host/api/provider-media`, (route) => route.fulfill({ json: { providerMedia: { version: 1, assets: [] } } }));
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(() => Object.defineProperty(globalThis, "process", { value: { env: { NODE_ENV: "development" } } }));
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => window.mountHostPublication());
  for (const [locale, label, first, second] of [["日本語", "見どころ", "一つ目", "二つ目"], ["英語を確認", "Highlights", "First", "Second"]] as const) {
    await page.getByRole("button", { name: locale, exact: true }).click();
    const list = page.getByRole("textbox", { name: label, exact: true });
    await list.fill(first);
    await list.press("End");
    await list.press("Enter");
    await expect(list).toHaveValue(`${first}\n`);
    await list.pressSequentially(second);
    await list.press("Enter");
    await page.getByRole("button", { name: "料金・予約", exact: true }).click();
    await page.getByRole("button", { name: "体験ページ", exact: true }).click();
    await expect(page.getByRole("textbox", { name: label, exact: true })).toHaveValue(`${first}\n${second}`);
  }
  expect(errors).toEqual([]);
});
