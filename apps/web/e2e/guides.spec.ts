import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// The first web server reads the synthetic drafts in e2e/fixtures/guides (GUIDE_DRAFTS_DIR, mock mode only).
const guide = "/guides/sample-guide";
const title = "Sample Guide: An Invented Evening for Tests";
const dinner = "/experiences/home-cooked-dinner-with-locals";

const overflowX = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("the index lists the guide under its pillar, marked as a draft", async ({ page }) => {
  await page.goto("/guides");
  await expect(page).toHaveTitle("Kamakura Guides: Evenings, Zazen, Crafts and Day Trips | NIHO Experience");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Guides to Kamakura");
  const evenings = page.getByRole("region", { name: "Evenings in Kamakura" });
  await expect(evenings.getByRole("link", { name: title })).toHaveAttribute("href", guide);
  await expect(evenings.getByText("Draft", { exact: true })).toBeVisible();
  await expect(evenings.locator('time[datetime="2026-11-12"]')).toHaveText("12 Nov 2026");
  // Pillars without guides are not shown.
  await expect(page.getByRole("heading", { name: "Hands-on crafts" })).toHaveCount(0);
});

test("the article shows its byline, dates, contents, FAQ and experiences", async ({ page }) => {
  await page.goto(guide);
  await expect(page.getByText("Draft · not published · visible only in this preview")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
  const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(breadcrumb.getByRole("link", { name: "Guides" })).toHaveAttribute("href", "/guides");
  await expect(breadcrumb.getByText(title)).toHaveAttribute("aria-current", "page");

  await expect(page.getByText("By Sample Author, Test writer (synthetic)")).toBeVisible();
  await expect(page.getByText("Published 10 Nov 2026 · Updated 12 Nov 2026")).toBeVisible();
  await expect(page.locator('time[datetime="2026-11-10"]')).toHaveText("10 Nov 2026");
  await expect(page.getByText("Times and prices checked on 8 Nov 2026")).toBeVisible();
  await expect(page.getByText("Photo: Placeholder artwork")).toBeVisible();

  const toc = page.getByRole("navigation", { name: "On this page" });
  await expect(toc.getByRole("link")).toHaveText(["Start before the light goes", "Eat with neighbors", "Check the last trains", "Questions people ask"]);
  await toc.getByRole("link", { name: "Check the last trains" }).click();
  await expect(page).toHaveURL(/#check-the-last-trains$/);
  await expect(page.getByRole("heading", { level: 2, name: "Check the last trains" })).toBeInViewport();

  // Facts still to confirm are highlighted; markup and unsafe links stay text.
  await expect(page.locator("mark").first()).toHaveText("To confirm: nothing here is real");
  await expect(page.getByText("Bring <b>nothing else</b>")).toBeVisible();
  await expect(page.getByText("This link stays plain text.")).toBeVisible();
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);

  const table = page.getByRole("region", { name: "Check the last trains" }).getByRole("table");
  await expect(table.getByRole("columnheader")).toHaveText(["Station", "Last train", "Platform", "Note"]);
  await expect(table.getByRole("rowheader", { name: "Sample Station A" })).toBeVisible();

  const faq = page.getByRole("region", { name: "Questions people ask" });
  await expect(faq.getByRole("heading", { level: 3 })).toHaveText(["Is this guide real?", "Can I book from here?"]);

  // The inline card and the closing section link to the catalog's experiences; a slug the catalog lacks is left out.
  // Links to the dinner: the one in the text and the card after it. The closing section does not repeat a card shown in the body.
  await expect(page.locator(`main a[href="${dinner}"]`)).toHaveCount(2);
  const experiences = page.getByRole("region", { name: "Experiences in this guide" });
  await expect(experiences.locator(":scope > ul > li")).toHaveCount(1);
  await expect(experiences.getByRole("link", { name: "Evening pottery session" })).toHaveAttribute("href", "/experiences/evening-pottery-session");
  // `related` names a guide that does not exist: no "More guides".
  await expect(page.getByRole("heading", { name: "More guides" })).toHaveCount(0);
});

test("the experience page links to the guide under Read before you go", async ({ page }) => {
  await page.goto(dinner);
  const section = page.getByRole("region", { name: "Read before you go" });
  await expect(section.getByRole("link", { name: title })).toHaveAttribute("href", guide);
  // No guide recommends the cycling morning.
  await page.goto("/experiences/seaside-cycling-and-market-breakfast");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Read before you go" })).toHaveCount(0);
});

test("unknown guides are not found", async ({ request }) => {
  expect((await request.get("/guides/no-such-guide")).status()).toBe(404);
});

// Googlebot and the AI crawlers read <head> from the first HTML and never run JavaScript (#139).
const CRAWLERS = {
  Googlebot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/126.0.0.0 Safari/537.36",
  GPTBot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot",
};

for (const [crawler, userAgent] of Object.entries(CRAWLERS)) {
  test(`${crawler} gets the guide's head and Article data without JavaScript`, async ({ request }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop");
    const html = await (await request.get(guide, { headers: { "user-agent": userAgent } })).text();
    const headEnd = html.indexOf("</head>");
    expect(headEnd).toBeGreaterThan(-1);
    const head = html.slice(0, headEnd);
    expect(head).toContain(`<title>${title} | NIHO Experience</title>`);
    expect(head).toContain('<meta name="description" content="Synthetic test content.');
    expect(head).toContain('<link rel="canonical" href="http://localhost:3000/guides/sample-guide"');
    expect(head).toContain('<link rel="alternate" hrefLang="x-default" href="http://localhost:3000/guides/sample-guide"');
    expect(head).not.toContain('hrefLang="ja"');
    expect(head).toContain('<meta property="og:type" content="article"');
    expect(head).toContain('<meta property="article:published_time" content="2026-11-10"');
    expect(head).not.toContain('<meta property="og:image"');
    // A draft is never indexed.
    expect(head).toMatch(/<meta name="robots" content="noindex, nofollow"/);

    // Next renders JSON-LD scripts with the page body (node_modules/next/dist/docs/01-app/02-guides/json-ld.md).
    const article = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map((match) => JSON.parse(match[1]!)).find((data) => data["@type"] === "Article");
    expect(article).toMatchObject({
      headline: title,
      datePublished: "2026-11-10",
      dateModified: "2026-11-12",
      author: { "@type": "Person", name: "Sample Author", jobTitle: "Test writer (synthetic)" },
      publisher: { "@id": "http://localhost:3000/#organization" },
      image: ["http://localhost:3000/placeholders/hero.svg"],
      articleSection: "Evenings in Kamakura",
    });
    expect(html).toContain('"@type":"BreadcrumbList"');
    expect(html).not.toContain('"@type":"FAQPage"');
    // The body is in the first HTML too.
    expect(html).toContain("Is this guide real?");
  });
}

test("the guides index has its canonical and breadcrumb", async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  const html = await (await request.get("/guides")).text();
  expect(html).toContain('<link rel="canonical" href="http://localhost:3000/guides"');
  expect(html).toContain('"@type":"BreadcrumbList"');
  // Preview builds have no sitemap entries, drafts least of all.
  expect(await (await request.get("/sitemap.xml")).text()).not.toContain("/guides");
});

for (const path of ["/guides", guide]) {
  test(`${path} does not scroll sideways at 360px and 320px`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-360");
    await page.goto(path);
    expect(await overflowX(page)).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 320, height: 720 });
    expect(await overflowX(page)).toBeLessThanOrEqual(0);
    if (path === guide) {
      // The wide table scrolls inside its own box instead, and can be reached with the keyboard.
      const region = page.getByRole("region", { name: "Check the last trains" });
      expect(await region.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
      await expect(region).toHaveAttribute("tabindex", "0");
    }
  });

  test(`no serious accessibility violations on ${path}`, async ({ page }) => {
    await page.goto(path);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });
}
