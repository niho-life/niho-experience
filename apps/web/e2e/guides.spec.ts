import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator } from "@playwright/test";

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

    // React inserts empty comments between adjacent server-rendered text nodes.
    const body = html.slice(headEnd).replaceAll("<!-- -->", "");
    expect(body).toMatch(new RegExp(`<h1[^>]*>${title.replace(/[()]/g, "\\$&")}</h1>`));
    expect(body).toContain("Mika Sato (sample)");
    expect(body).toContain("Sample editor, NIHO Experience (invented for previews)");
    // React may separate adjacent text with an empty comment; crawlers read it as one line of text.
    expect(body).toMatch(/Updated <time dateTime="2026-10-24">24 Oct 2026<\/time>/i);
    expect(body).toContain("5 min read");
    expect(body).toMatch(/Published <time dateTime="2026-10-20">20 Oct 2026<\/time>/i);
    expect(html).toContain('"@type":"Article"');
    expect(html).toContain('"headline":"A first evening in Kamakura with local hosts (sample guide)"');
    expect(html).toContain('"dateModified":"2026-10-24"');
    expect(html).toContain('"author":{"@type":"Person","name":"Mika Sato (sample)"');
    expect(html).toContain('"@type":"BreadcrumbList"');
  });
}

test("the article shows its body, FAQ and the experiences to book, and links to them without JavaScript", async ({ request }) => {
  const html = (await (await request.get(article)).text()).replaceAll("<!-- -->", "");
  expect(html).toMatch(/<h2[^>]*id="how-an-evening-works"[^>]*><span[^>]*>1\. <\/span>How an evening works<\/h2>/);
  expect(html).toMatch(/<h3[^>]*>What to bring<\/h3>/);
  expect(html).toMatch(/<h2[^>]*>Questions people ask<\/h2>/);
  expect(html).toMatch(/<summary[^>]*>[\s\S]*Do I need to speak Japanese\?/);
  expect(html).toMatch(/<h3[^>]*>[\s\S]*Do I need to speak Japanese\?/);
  expect(html).toContain("In this guide");
  expect(html).toContain(`href="#how-an-evening-works"`);
  expect(html).toContain(`aria-label="Experience: Home-cooked dinner with locals in a shared living room"`);
  expect(html).toContain("More experiences from this guide");
  expect(html).toContain('aria-label="Experience: Evening pottery session"');
  expect(html).toContain(`href="${dinner}"`);
  expect(html).toContain('href="/experiences/evening-pottery-session"');
  expect(html).toContain("Keep planning");
  expect(html).toContain("About the author.");
  // Related guide, and the hero shown on the page but never shared (not licensed).
  expect(html).toContain('href="/guides/sample-rainy-day-in-kamakura"');
  expect(html).toContain('src="/placeholders/dinner.svg"');
  expect(html).not.toContain('<meta property="og:image"');
  // No `image` in the Article structured data (the hero's `<link rel="preload" as="image">` is not a share image).
  expect(html).not.toMatch(/"image"\s*:/);
  expect(html).toContain('<meta property="og:type" content="article"');
  expect(html).toContain(`<link rel="alternate" hrefLang="en" href="http://localhost:3000${article}"`);
  expect(html).not.toContain('hrefLang="ja"');
});

test("the experience page links back to the guides about it", async ({ request }) => {
  const html = await (await request.get(dinner)).text();
  expect(html).toMatch(/<h2[^>]*>Plan your evening in Kamakura<\/h2>/);
  expect(html).toContain(`href="${article}"`);
  // A second synthetic guide points at the cycling breakfast too.
  const cycling = await (await request.get("/experiences/seaside-cycling-and-market-breakfast")).text();
  expect(cycling).toContain("Plan your morning in Kamakura");
  expect(cycling).toContain('href="/guides/sample-kamakura-day-plan"');
});

test("the guides list has its own title, description and canonical, and links every guide", async ({ request }) => {
  const html = await (await request.get("/guides?utm_source=sample")).text();
  expect(html).toContain("<title>Kamakura, from people who live here | NIHO Experience</title>");
  expect(html).toContain('<meta name="description" content="Short, first-hand guides by our hosts.');
  expect(html).toContain('<link rel="canonical" href="http://localhost:3000/guides"');
  expect(html).toMatch(/<h1[^>]*>Kamakura, from people who live here<\/h1>/);
  expect(html).toContain(`href="${article}"`);
  expect(html).toContain('href="/guides/sample-rainy-day-in-kamakura"');
  expect(html).toContain('href="/guides/sample-kamakura-day-plan"');
  expect(html).toMatch(/Checked(?:<!-- -->)? <time dateTime="2026-10-24">/i);
  expect(html).toMatch(/<h2[^>]*>Kamakura after 4 PM<\/h2>/);
  expect(html).toMatch(/<h2[^>]*>Mending, calligraphy and coffee<\/h2>/);
});

test("the footer links to the guides while some exist, and unknown guides are not found", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByRole("contentinfo").getByRole("link", { name: "Guides", exact: true })).toHaveAttribute("href", "/guides");
  expect((await request.get("/guides/no-such-guide")).status()).toBe(404);
});

test("the home and experience list expose three guide cards in their requested positions", async ({ page }) => {
  await page.goto("/");
  const homeGuides = page.getByRole("region", { name: "Guides from people who live here" });
  await expect(homeGuides.getByRole("listitem")).toHaveCount(3);
  const homeOrder = await page.locator("#home-cards-v1, #home-guides-heading-v1, #home-guides-heading, #featured-heading-v1").evaluateAll((nodes) => nodes.map((node) => node.id));
  expect(homeOrder.indexOf("home-guides-heading")).toBeGreaterThan(homeOrder.indexOf("home-cards-v1"));

  await page.goto("/experiences");
  const plan = page.getByRole("region", { name: "Plan your day" });
  await expect(plan.getByRole("listitem")).toHaveCount(3);
});

test("the article keeps heading levels in order and has one h1", async ({ page }) => {
  await page.goto(article);
  const levels = await page.locator("main h1, main h2, main h3, main h4").evaluateAll((nodes) => nodes.map((node) => Number(node.tagName.slice(1))));
  expect(levels[0]).toBe(1);
  expect(levels.filter((level) => level === 1)).toHaveLength(1);
  levels.slice(1).forEach((level, index) => expect(level, `heading ${index + 2} skips a level`).toBeLessThanOrEqual(levels[index]! + 1));
});

// A draft read from GUIDE_DRAFTS_DIR (playwright.config.ts passes e2e/fixtures/guide-drafts to the first server only).
const draft = "/guides/sample-draft";
const draftTitle = "A synthetic draft for preview tests (sample draft)";
const draftItem = (scope: Locator, name: string) => scope.getByRole("listitem").filter({ has: scope.page().getByRole("link", { name, exact: true }) });

test.describe("a guide draft in the mock preview", () => {
  test("the guides list shows the draft with a Draft pill, published guides without one, and no draft problems", async ({ page }) => {
    await page.goto("/guides");
    const main = page.getByRole("main");
    await expect(draftItem(main, draftTitle).getByText("Draft", { exact: true })).toBeVisible();
    await expect(draftItem(main, title).getByText("Draft", { exact: true })).toHaveCount(0);
    await expect(main.getByText(/drafts? (?:is|are) not shown/)).toHaveCount(0);
  });

  test("the draft article is marked as a draft and noindex, and is never in the sitemap", async ({ request }) => {
    const response = await request.get(draft);
    expect(response.status()).toBe(200);
    const html = await response.text();
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).toMatch(/<meta name="robots" content="noindex, nofollow"/);
    expect(html).toContain("Draft · not published · visible only in this preview");
    expect(await (await request.get("/sitemap.xml")).text()).not.toContain("sample-draft");
  });

  test("the draft renders its photo, table, note, facts to confirm and FAQ answers", async ({ page }) => {
    await page.goto(draft);
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { level: 1 })).toHaveText(draftTitle);

    const figure = main.locator("figure").filter({ has: page.locator("figcaption") });
    await expect(figure.getByRole("img", { name: "Illustration of a long dinner table set for guests" })).toHaveAttribute("src", "/placeholders/dinner.svg");
    await expect(figure.locator("figcaption")).toHaveText("An invented caption for the test draft");

    const region = main.getByRole("region", { name: "Compare the two studios" });
    await region.focus();
    await expect(region).toBeFocused();
    const table = region.getByRole("table");
    await expect(table.getByRole("columnheader")).toHaveText(["What", "Indigo studio", "Pottery studio"]);
    await expect(table.getByRole("rowheader")).toHaveText(["Language", "Time", "Good for"]);
    await expect(table.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "Good for" }) }).locator("strong")).toHaveText("Couples");

    const note = main.getByRole("note");
    await expect(note).toContainText("Checked on 26 Oct 2026");
    await expect(note.getByRole("listitem")).toHaveText(["Ask the host before you go", "Bring an apron"]);

    await expect(main.locator("mark")).toHaveText([
      "To confirm: the invented opening hours",
      "To confirm: the invented length",
      "To confirm: an invented price",
    ]);

    const faq = main.getByRole("region", { name: "Questions people ask" });
    // The browser exposes the summary as a single control in the accessibility tree.
    await expect(faq.locator("summary h3")).toHaveText(["Is anything in this draft real?+", "Can children come?+"]);
    await expect(faq.locator("summary")).toHaveText(["Is anything in this draft real?+", "Can children come?+"]);
    await expect(faq.locator("strong")).toHaveText("invented");
    await expect(faq.locator("mark")).toHaveText("To confirm: an invented price");
    await faq.locator("summary").nth(1).click();
    await expect(faq.getByRole("link", { name: "pottery page" })).toHaveAttribute("href", "/experiences/evening-pottery-session");
    await expect(faq).not.toContainText("**");
  });

  test("on a 360px phone the page never scrolls sideways; only the table box does", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto(draft);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const region = page.getByRole("region", { name: "Compare the two studios" });
    expect(await region.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  });

  test("the draft article has no serious accessibility violations", async ({ page }) => {
    await page.goto(draft);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });

  test("the experience page marks the draft among its guides", async ({ page }) => {
    await page.goto("/experiences/indigo-dyeing-with-an-artisan");
    const guides = page.getByRole("region", { name: /^Plan your (morning|day|evening) in / });
    await expect(draftItem(guides, draftTitle).getByText("Draft", { exact: true })).toBeVisible();
    await expect(draftItem(guides, "Indoor crafts for a rainy day in Kamakura (sample guide)").getByText("Draft", { exact: true })).toHaveCount(0);
  });
});
