import { expect, test } from "@playwright/test";

// editor.niho.life as the guide source (#252 #253, provisional contract), against the synthetic fixture
// (src/lib/editor-publication/fixtures/editor-publications.json). playwright.guide-editor.config.ts starts the servers.

const GOOGLEBOT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/126.0.0.0 Safari/537.36";
const LIVE = [
  { slug: "sample-evening-walk", title: "A slow evening walk (sample guide)" },
  { slug: "sample-rainy-afternoon", title: "What to do on a rainy afternoon (sample guide)" },
  { slug: "sample-market-morning", title: "A market morning by bicycle (sample guide)" },
];
// Each is in the editor's list, and none may show on /guides or in the sitemap.
const LEFT_OUT = ["sample-direct-link-only", "sample-just-unpublished", "sample-for-another-site", "sample-http-cover", "sample-script-link", "sample-in-japanese"];
const PREVIEW_TOKEN = "synthetic-preview-token-0001";

/** Raw responses are the same on every viewport: read them once. */
const desktopOnly = () => test.skip(test.info().project.name !== "guide-editor-desktop", "server responses are checked on desktop only");

test("/guides lists the live publications only, and the footer sends writers to the editor", async ({ page }) => {
  await page.goto("/guides");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const main = page.getByRole("main");
  for (const { slug, title } of LIVE) await expect(main.getByRole("link", { name: title }).first()).toHaveAttribute("href", `/guides/${slug}`);
  for (const slug of LEFT_OUT) await expect(main.locator(`a[href="/guides/${slug}"]`)).toHaveCount(0);

  const footer = page.getByRole("contentinfo");
  await expect(footer.getByRole("link", { name: "Guides" })).toHaveAttribute("href", "/guides");
  await expect(footer.getByRole("link", { name: "For writers" })).toHaveAttribute("href", "https://editor.example");
});

test("a guide's first HTML carries its body, canonical and Article JSON-LD, and is indexable", async ({ request, baseURL }) => {
  desktopOnly();
  const response = await request.get("/guides/sample-evening-walk", { headers: { "user-agent": GOOGLEBOT } });
  expect(response.status()).toBe(200);
  const html = await response.text();
  const headEnd = html.indexOf("</head>");
  const head = html.slice(0, headEnd);
  expect(head).toContain("<title>A slow evening walk (sample guide) | NIHO Experience</title>");
  expect(head).toContain(`<link rel="canonical" href="${baseURL}/guides/sample-evening-walk"`);
  expect(head).not.toContain("noindex");
  expect(head).toContain('<meta property="og:image" content="https://assets.editor.example/photos/cover-1.jpg"');
  const body = html.slice(headEnd).replaceAll("<!-- -->", "");
  expect(body).toMatch(/<h1[^>]*>A slow evening walk \(sample guide\)<\/h1>/);
  expect(body).toContain("Start before sunset");
  expect(html).toContain('"@type":"Article"');
  expect(html).not.toContain("synthetic-fixture-token");
});

test("an unlisted guide opens by its direct URL with noindex, and the sitemap has the live ones only", async ({ request, baseURL }) => {
  desktopOnly();
  const unlisted = await request.get("/guides/sample-direct-link-only", { headers: { "user-agent": GOOGLEBOT } });
  expect(unlisted.status()).toBe(200);
  expect(await unlisted.text()).toMatch(/<meta name="robots" content="noindex/);

  const sitemap = await (await request.get("/sitemap.xml")).text();
  for (const { slug } of LIVE) expect(sitemap).toContain(`<loc>${baseURL}/guides/${slug}</loc>`);
  for (const slug of LEFT_OUT) expect(sitemap).not.toContain(`/guides/${slug}<`);
});

test("an unpublished or unknown guide goes back to /guides, and a malformed slug is not found", async ({ request }) => {
  desktopOnly();
  for (const slug of ["sample-just-unpublished", "sample-never-published"]) {
    const response = await request.get(`/guides/${slug}`, { maxRedirects: 0 });
    // Temporary: a guide published again comes back at the same URL.
    expect(response.status(), slug).toBe(307);
    expect(new URL(response.headers().location!, "http://x").pathname, slug).toBe("/guides");
  }
  expect((await request.get("/guides/Bad_Slug", { maxRedirects: 0 })).status()).toBe(404);
});

test("the preview renders a draft privately, and is not found without a live token", async ({ request }) => {
  desktopOnly();
  const response = await request.get(`/guides/preview?token=${PREVIEW_TOKEN}`, { headers: { "user-agent": GOOGLEBOT } });
  expect(response.status()).toBe(200);
  expect(response.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  expect(response.headers()["referrer-policy"]).toBe("no-referrer");
  const html = await response.text();
  expect(html).toMatch(/<meta name="robots" content="noindex, nofollow[",]/);
  expect(html.replaceAll("<!-- -->", "")).toContain("An unfinished draft (sample)");
  // No link, image, meta or canonical carries the token. Next's router payload in <script> repeats the requested URL
  // (the address bar's own value), so only the markup outside scripts is checked.
  expect(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")).not.toContain(PREVIEW_TOKEN);
  expect(html).not.toContain('"@type":"Article"');
  expect(html).not.toContain('rel="canonical"');

  // Expired, for another destination, or missing.
  for (const path of ["/guides/preview?token=synthetic-preview-token-gone", "/guides/preview?token=synthetic-preview-token-0003", "/guides/preview"]) {
    expect((await request.get(path)).status(), path).toBe(404);
  }
  expect(await (await request.get("/sitemap.xml")).text()).not.toContain("/guides/preview");
});

test("the publication conditions are declared for the editor to read", async ({ request, baseURL }) => {
  desktopOnly();
  const response = await request.get("/api/public/guides/publication-requirements");
  expect(response.status()).toBe(200);
  expect(response.headers()["x-robots-tag"]).toBe("noindex");
  const body = (await response.json()) as { conditions: { id: string; lookup?: string }[] };
  expect(body.conditions.map((condition) => condition.id)).toEqual(expect.arrayContaining(["language-en", "cover", "lead", "category", "no-confirm-marker", "related-experiences-listed"]));
  expect(body.conditions.find((condition) => condition.id === "related-experiences-listed")?.lookup).toBe(`${baseURL}/experiences/{slug}`);
});
