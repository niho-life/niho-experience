import { expect, test } from "@playwright/test";

// editor.niho.life as the guide source (#252 #253, contract v1), against the synthetic fixture
// (src/lib/editor-publication/fixtures/editor-publications.json). playwright.guide-editor.config.ts starts the servers,
// with small list pages so that the site follows nextCursor across several of them.

const GOOGLEBOT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/126.0.0.0 Safari/537.36";
const LIVE = [
  { slug: "sample-evening-walk", title: "A slow evening walk (sample guide)" },
  { slug: "sample-rainy-afternoon", title: "What to do on a rainy afternoon (sample guide)" },
  { slug: "sample-market-morning", title: "A market morning by bicycle (sample guide)" },
];
// Each is in the editor's list, and none may show on /guides or in the sitemap.
const LEFT_OUT = [
  "sample-direct-link-only", "sample-just-unpublished", "sample-moved-to-another-face", "sample-for-another-site", "sample-http-cover",
  "sample-script-link", "sample-in-japanese", "sample-without-category", "sample-without-lead",
];
const PREVIEW_TOKEN = "pv_synthetic-preview-not-a-secret-draft-000001";
const COVER_URL = "https://assets.editor.example/photos/cover-1.jpg";

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

test("a guide's first HTML carries its body, canonical and Article JSON-LD, and is indexable, without sharing its cover", async ({ request, baseURL }) => {
  desktopOnly();
  const response = await request.get("/guides/sample-evening-walk", { headers: { "user-agent": GOOGLEBOT } });
  expect(response.status()).toBe(200);
  const html = await response.text();
  const headEnd = html.indexOf("</head>");
  const head = html.slice(0, headEnd);
  expect(head).toContain("<title>A slow evening walk (sample guide) | NIHO Experience</title>");
  expect(head).toContain(`<link rel="canonical" href="${baseURL}/guides/sample-evening-walk"`);
  expect(head).not.toContain("noindex");
  // Contract v1 declares no sharing rights for a photo: the cover is on the page, never on a social card.
  expect(head).not.toContain(`content="${COVER_URL}"`);
  const body = html.slice(headEnd).replaceAll("<!-- -->", "");
  expect(body).toMatch(/<h1[^>]*>A slow evening walk \(sample guide\)<\/h1>/);
  expect(body).toContain("Start before sunset");
  expect(body).toContain(`src="${COVER_URL}"`);
  // The author is shown by name only, and *** reads as bold italic.
  expect(body).toMatch(/<b[^>]*>Sample Writer<\/b> · Published/);
  expect(body).toMatch(/<strong[^>]*><em>light<\/em><\/strong>/);
  const article = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
    .map((match) => JSON.parse(match[1]!) as Record<string, unknown>)
    .find((data) => data["@type"] === "Article");
  expect(article).toMatchObject({ headline: "A slow evening walk (sample guide)", author: { "@type": "Person", name: "Sample Writer" } });
  expect(article).not.toHaveProperty("image");
  expect(article?.author).not.toHaveProperty("jobTitle");
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
  for (const slug of ["sample-just-unpublished", "sample-moved-to-another-face", "sample-never-published"]) {
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

  // Expired, unknown, for another destination, malformed, or missing.
  for (const path of [
    "/guides/preview?token=pv_synthetic-preview-not-a-secret-expired-0001",
    "/guides/preview?token=pv_synthetic-preview-not-a-secret-unknown-0001",
    "/guides/preview?token=pv_synthetic-preview-not-a-secret-draft-000003",
    "/guides/preview?token=synthetic-preview-token-0001",
    "/guides/preview",
  ]) {
    expect((await request.get(path)).status(), path).toBe(404);
  }
  expect(await (await request.get("/sitemap.xml")).text()).not.toContain("/guides/preview");
});

test("the publication conditions are declared for the editor to read", async ({ request, baseURL }) => {
  desktopOnly();
  const response = await request.get("/api/public/guides/publication-requirements");
  expect(response.status()).toBe(200);
  expect(response.headers()["x-robots-tag"]).toBe("noindex");
  const body = (await response.json()) as { schemaVersion: number; id: string; host: string; path: string; requires: { id: string; kind: string }[] };
  expect(body).toMatchObject({ schemaVersion: 1, id: "exp", host: new URL(baseURL!).host, path: "guides" });
  expect(body.requires.map((condition) => condition.kind)).toEqual(["lang", "cover", "lead", "category", "headings", "noConfirm", "relatedLive"]);
});
