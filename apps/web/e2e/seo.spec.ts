import { expect, test } from "@playwright/test";

// Server-rendered HTML as a crawler sees it, without running JavaScript.
test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== "desktop"));

const dinner = "/experiences/home-cooked-dinner-with-locals";

test("public pages share their canonical URL without carrying queries or unapproved images", async ({ request }) => {
  for (const path of ["/", "/experiences", "/host"]) {
    const html = await (await request.get(`${path}?utm_source=sample&token=private`)).text();
    // Next serializes an origin's root URL without the trailing slash.
    const canonical = `http://localhost:3000${path === "/" ? "" : path}`;
    expect(html).toContain(`<link rel="canonical" href="${canonical}"`);
    expect(html).toContain(`<meta property="og:url" content="${canonical}"`);
    expect(html).toContain('<meta property="og:locale" content="en_US"');
    expect(html).toContain('<meta name="twitter:card" content="summary"');
    expect(html).not.toContain('<meta property="og:image"');
    expect(html).not.toContain('<meta name="twitter:image"');
    // English only until a Japanese page is released: itself and x-default.
    expect(html).toContain(`<link rel="alternate" hrefLang="en" href="${canonical}"`);
    expect(html).toContain(`<link rel="alternate" hrefLang="x-default" href="${canonical}"`);
    expect(html).not.toContain('hrefLang="ja"');
  }
});

// Googlebot and the AI crawlers read <head> from the first HTML and never run JavaScript (#139).
const CRAWLERS = {
  Googlebot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/126.0.0.0 Safari/537.36",
  GPTBot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot",
  "OAI-SearchBot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot",
  ClaudeBot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
  PerplexityBot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
  Bingbot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/126.0.0.0 Safari/537.36",
};

for (const [crawler, userAgent] of Object.entries(CRAWLERS)) {
  test(`${crawler} gets title, description, canonical, robots and hreflang inside <head>`, async ({ request }) => {
    for (const path of ["/", "/experiences", "/experiences?theme=craft", dinner, "/host"]) {
      const html = await (await request.get(path, { headers: { "user-agent": userAgent } })).text();
      const headEnd = html.indexOf("</head>");
      expect(headEnd, `${path}: no </head>`).toBeGreaterThan(-1);
      const head = html.slice(0, headEnd);
      for (const [name, tag] of [
        ["title", "<title>"],
        ["description", '<meta name="description"'],
        ["canonical", '<link rel="canonical"'],
        ["robots", '<meta name="robots"'],
        ["hreflang", 'hrefLang="x-default"'],
      ] as const) expect(head, `${path}: ${name} is not in <head>`).toContain(tag);
    }
  });
}

test("the home page names the organization and the website for crawlers", async ({ request }) => {
  const html = await (await request.get("/")).text();
  expect(html).toContain('"@type":"Organization"');
  expect(html).toContain('"alternateName":"NIHO Experience, Kamakura"');
  expect(html).toContain('"@type":"WebSite"');
  expect(html).not.toContain('"logo"');
});

test("the experience page carries hreflang for itself and x-default", async ({ request }) => {
  const html = await (await request.get(dinner)).text();
  const canonical = "https://experiences.niho.example/experiences/home-cooked-dinner-with-locals";
  expect(html).toContain(`<link rel="alternate" hrefLang="en" href="${canonical}"`);
  expect(html).toContain(`<link rel="alternate" hrefLang="x-default" href="${canonical}"`);
  expect(html).not.toContain('hrefLang="ja"');
});

test("experience facts and links are in the initial HTML", async ({ request }) => {
  const html = await (await request.get(dinner)).text();
  for (const fact of [
    "<h1",
    "Home-cooked dinner with locals in a shared living room",
    "Komorebi Living (sample)",
    "2 hr 30 min",
    "English &amp; Japanese",
    "¥6,500",
    "Sold by",
    'href="/experiences"',
  ]) {
    expect(html, fact).toContain(fact);
  }
  expect(html).toContain('<link rel="canonical" href="https://experiences.niho.example/experiences/home-cooked-dinner-with-locals"');
  expect(html).toContain('"@type":"BreadcrumbList"');
  // Mock preview data is never described as a live TouristTrip or Product.
  expect(html).not.toContain('"@type":"TouristTrip"');
  expect(html).not.toContain('"@type":"Product"');
  expect(html).not.toContain('<meta property="og:image"');
});

test("list links reach every experience without JavaScript", async ({ request }) => {
  const html = await (await request.get("/experiences")).text();
  for (const slug of [
    "home-cooked-dinner-with-locals",
    "indigo-dyeing-with-an-artisan",
    "seaside-cycling-and-market-breakfast",
    "evening-pottery-session",
  ]) {
    expect(html).toContain(`href="/experiences/${slug}"`);
  }
  expect(html).toContain('<link rel="canonical" href="http://localhost:3000/experiences"');
  expect(html).toContain("<title>Kamakura Experiences with Local Hosts | NIHO Experience</title>");
  expect(html).toContain("Small-group experiences in Kamakura hosted by people who live here.");
});

test("the list keeps heading levels in order: h1, then h2, then the cards' h3", async ({ page }) => {
  await page.goto("/experiences");
  // The loading skeleton has no headings: wait for the streamed page before reading them.
  await expect(page.locator("main h1")).toBeVisible();
  const levels = await page.locator("main h1, main h2, main h3, main h4").evaluateAll((nodes) => nodes.map((node) => Number(node.tagName.slice(1))));
  expect(levels[0]).toBe(1);
  expect(levels.filter((level) => level === 1)).toHaveLength(1);
  levels.slice(1).forEach((level, index) => expect(level, `heading ${index + 2} skips a level`).toBeLessThanOrEqual(levels[index]! + 1));
});

test("legacy filter query URLs point to the main list and stay out of the index", async ({ request }) => {
  const html = await (await request.get("/experiences?theme=craft")).text();
  expect(html).toContain('<link rel="canonical" href="http://localhost:3000/experiences"');
  expect(html).toMatch(/<meta name="robots" content="noindex, (?:follow|nofollow)"/);
});

test("search result URLs are canonicalized and stay out of the index", async ({ request }) => {
  const html = await (await request.get("/experiences?q=pottery")).text();
  expect(html).toContain('<link rel="canonical" href="http://localhost:3000/experiences"');
  expect(html).toMatch(/<meta name="robots" content="noindex, (?:follow|nofollow)"/);
});

test("date and party-size filter URLs are canonicalized and stay out of the index", async ({ request }) => {
  for (const path of ["/experiences?date=2026-10-24", "/experiences?guests=2"]) {
    const html = await (await request.get(path)).text();
    expect(html, path).toContain('<link rel="canonical" href="http://localhost:3000/experiences"');
    expect(html, path).toMatch(/<meta name="robots" content="noindex, follow"/);
  }
});

test("preview builds are never indexable", async ({ request }) => {
  for (const path of ["/", "/host", dinner]) {
    const html = await (await request.get(path)).text();
    expect(html, path).toMatch(/<meta name="robots" content="noindex, nofollow"/);
  }
  expect(await (await request.get("/sitemap.xml")).text()).not.toContain("<loc>");
});

test("a preview keeps every crawler out and offers no IndexNow key (#141)", async ({ request }) => {
  const robots = await request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  const text = await robots.text();
  expect(text).toMatch(/User-Agent: \*\s+Disallow: \/\s*$/);
  // The named search and AI crawler groups exist only when indexing is allowed (lib/robots-policy.test.ts).
  expect(text).not.toContain("OAI-SearchBot");
  expect(text).not.toContain("Sitemap:");
  expect((await request.get("/indexnow-key.txt")).status()).toBe(404);
});
