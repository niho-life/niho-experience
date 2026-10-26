import { expect, test } from "@playwright/test";

// Guides (#145): server-rendered HTML as crawlers see it. The mock preview registers the synthetic sample guides only.
test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== "desktop"));

const article = "/guides/sample-first-evening-in-kamakura";
const title = "A first evening in Kamakura with local hosts (sample guide)";
const dinner = "/experiences/home-cooked-dinner-with-locals";

const CRAWLERS = {
  Googlebot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/126.0.0.0 Safari/537.36",
  GPTBot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot",
};

for (const [crawler, userAgent] of Object.entries(CRAWLERS)) {
  test(`${crawler} gets the sample guide's metadata in <head> and its article in the first HTML`, async ({ request }) => {
    const response = await request.get(article, { headers: { "user-agent": userAgent } });
    expect(response.status()).toBe(200);
    const html = await response.text();
    const headEnd = html.indexOf("</head>");
    expect(headEnd).toBeGreaterThan(-1);
    const head = html.slice(0, headEnd);
    expect(head).toContain(`<title>${title} | NIHO Experience</title>`);
    expect(head).toContain('<meta name="description" content="A sample guide for previews: how an evening with local hosts works');
    expect(head).toContain(`<link rel="canonical" href="http://localhost:3000${article}"`);
    expect(head).toMatch(/<meta name="robots" content="noindex, nofollow"/);
    expect(head).toContain('hrefLang="x-default"');

    const body = html.slice(headEnd);
    expect(body).toMatch(new RegExp(`<h1[^>]*>${title.replace(/[()]/g, "\\$&")}</h1>`));
    expect(body).toContain("Mika Sato (sample)");
    expect(body).toContain("Sample editor, NIHO Experience (invented for previews)");
    // React may separate adjacent text with an empty comment; crawlers read it as one line of text.
    expect(body).toMatch(/Updated(?:<!-- -->)? <time dateTime="2026-10-24">24 Oct 2026<\/time>/i);
    expect(body).toMatch(/Published(?:<!-- -->)? <time dateTime="2026-10-20">20 Oct 2026<\/time>/i);
    expect(html).toContain('"@type":"Article"');
    expect(html).toContain('"headline":"A first evening in Kamakura with local hosts (sample guide)"');
    expect(html).toContain('"dateModified":"2026-10-24"');
    expect(html).toContain('"author":{"@type":"Person","name":"Mika Sato (sample)"');
    expect(html).toContain('"@type":"BreadcrumbList"');
  });
}

test("the article shows its body, FAQ and the experiences to book, and links to them without JavaScript", async ({ request }) => {
  const html = await (await request.get(article)).text();
  expect(html).toMatch(/<h2[^>]*>How an evening works<\/h2>/);
  expect(html).toMatch(/<h3[^>]*>What to bring<\/h3>/);
  expect(html).toMatch(/<h2[^>]*>Frequently asked questions<\/h2>/);
  expect(html).toMatch(/<h3[^>]*>Do I need to speak Japanese\?<\/h3>/);
  expect(html).toMatch(/<h2[^>]*>Book an experience from this guide<\/h2>/);
  expect(html).toContain(`href="${dinner}"`);
  expect(html).toContain('href="/experiences/evening-pottery-session"');
  // Related guide, and the hero shown on the page but never shared (not licensed).
  expect(html).toContain('href="/guides/sample-rainy-day-in-kamakura"');
  expect(html).toContain('src="/placeholders/dinner.svg"');
  expect(html).not.toContain('<meta property="og:image"');
  expect(html).not.toContain('"image"');
  expect(html).toContain('<meta property="og:type" content="article"');
  expect(html).toContain(`<link rel="alternate" hrefLang="en" href="http://localhost:3000${article}"`);
  expect(html).not.toContain('hrefLang="ja"');
});

test("the experience page links back to the guides about it", async ({ request }) => {
  const html = await (await request.get(dinner)).text();
  expect(html).toMatch(/<h2[^>]*>Guides for your visit<\/h2>/);
  expect(html).toContain(`href="${article}"`);
  // No guide mentions the cycling breakfast: no guides block there.
  const cycling = await (await request.get("/experiences/seaside-cycling-and-market-breakfast")).text();
  expect(cycling).not.toContain("Guides for your visit");
});

test("the guides list has its own title, description and canonical, and links every guide", async ({ request }) => {
  const html = await (await request.get("/guides?utm_source=sample")).text();
  expect(html).toContain("<title>Kamakura Guides | NIHO Experience</title>");
  expect(html).toContain('<meta name="description" content="Guides from NIHO Experience for planning your time in Kamakura with the people who live here."');
  expect(html).toContain('<link rel="canonical" href="http://localhost:3000/guides"');
  expect(html).toMatch(/<h1[^>]*>Guides to Kamakura<\/h1>/);
  expect(html).toContain(`href="${article}"`);
  expect(html).toContain('href="/guides/sample-rainy-day-in-kamakura"');
  expect(html).toMatch(/Updated(?:<!-- -->)? <time dateTime="2026-10-24">/i);
});

test("the footer links to the guides while some exist, and unknown guides are not found", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByRole("contentinfo").getByRole("link", { name: "Guides", exact: true })).toHaveAttribute("href", "/guides");
  expect((await request.get("/guides/no-such-guide")).status()).toBe(404);
});

test("the article keeps heading levels in order and has one h1", async ({ page }) => {
  await page.goto(article);
  const levels = await page.locator("main h1, main h2, main h3, main h4").evaluateAll((nodes) => nodes.map((node) => Number(node.tagName.slice(1))));
  expect(levels[0]).toBe(1);
  expect(levels.filter((level) => level === 1)).toHaveLength(1);
  levels.slice(1).forEach((level, index) => expect(level, `heading ${index + 2} skips a level`).toBeLessThanOrEqual(levels[index]! + 1));
});
