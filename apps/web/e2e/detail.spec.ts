import { expect, test } from "@playwright/test";

const dinner = "/experiences/home-cooked-dinner-with-locals";

test("child participation is bounded by age and stays specific to each option", async ({ page }) => {
  await page.goto(dinner);
  await expect(page.getByText("ages 6–12 with an adult", { exact: true })).toBeVisible();
  await page.goto("/experiences/seaside-cycling-and-market-breakfast");
  await expect(page.getByText("Children: see options", { exact: true })).toBeVisible();
  await expect(page.getByText("ages 10+ with an adult", { exact: true })).toHaveCount(0);
});

test("phones get a swipeable gallery and a booking bar that stays within reach", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-360");
  await page.goto(dinner);

  const gallery = page.getByRole("region", { name: /^Photos of/ });
  await expect(gallery).toBeVisible();
  await expect(page.getByText(/^1 \/ \d+$/)).toBeVisible();
  await gallery.evaluate((element) => element.scrollTo({ left: element.clientWidth, behavior: "instant" }));
  await expect(page.getByText(/^2 \/ \d+$/)).toBeVisible();
  await expect(page.getByLabel("All experiences")).toHaveAttribute("href", "/experiences");

  const book = page.getByRole("link", { name: "Check dates", exact: true });
  await expect(book).toBeInViewport();
  await page.getByRole("heading", { name: "Where you'll meet" }).scrollIntoViewIfNeeded();
  await expect(book).toBeInViewport();
  await book.click();
  await expect(page).toHaveURL(/\/book$/);
});

test("desktop shows every photo in a dialog and a next date opens the booking page with it selected", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto(dinner);

  await page.getByRole("button", { name: /^Show all \d+ photos$/ }).click();
  const dialog = page.getByRole("dialog", { name: "All photos" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("img")).toHaveCount(4);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  const next = page.getByRole("complementary").getByRole("link", { name: /^Book / }).first();
  await expect(next).toBeVisible();
  const date = new URL((await next.getAttribute("href")) ?? "", "http://localhost").searchParams.get("date");
  expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  await next.click();
  await expect(page).toHaveURL(/\/book\?date=/);
  await expect(page.locator('input[name="occurrence"]:checked')).toHaveValue(date ?? "");
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeVisible();
});

test("same-time booking dates identify the option and its adult price", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/experiences/seaside-cycling-and-market-breakfast");

  const card = page.getByRole("complementary");
  const standard = card.getByRole("link", { name: /^Book .*Standard bike for ¥7,500 per adult$/ }).first();
  const eBike = card.getByRole("link", { name: /^Book .*E-bike for ¥9,800 per adult$/ }).first();
  await expect(standard).toBeVisible();
  await expect(eBike).toBeVisible();
  const standardOffer = new URL((await standard.getAttribute("href")) ?? "", "http://localhost").searchParams.get("offer");
  const eBikeOffer = new URL((await eBike.getAttribute("href")) ?? "", "http://localhost").searchParams.get("offer");
  expect(standardOffer).toBe("offer_cycling_standard");
  expect(eBikeOffer).toBe("offer_cycling_ebike");
});

test("the booking card states the terms before the booking page", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/experiences/indigo-dyeing-with-an-artisan");
  const card = page.getByRole("complementary");
  await expect(card).toContainText("Free cancellation until 48 h before");
  await expect(card).toContainText("Your hosts confirm each request — you're only charged if they accept");
  await expect(card).toContainText("No account needed");
  // Party size and totals belong to the booking page.
  await expect(card.getByRole("spinbutton")).toHaveCount(0);
  await expect(page.getByText("The meeting point is shared after your booking is confirmed.", { exact: true })).toBeVisible();
});

test("public meeting overview is visible without exposing the private meeting point", async ({ page }) => {
  await page.goto("/experiences/indigo-dyeing-with-an-artisan");
  const meeting = page.getByRole("heading", { name: "Where you'll meet", exact: true }).locator("..");
  await expect(meeting.getByText("A small indigo studio in Kamakura.", { exact: true })).toBeVisible();
  await expect(meeting.getByText("The meeting point is shared after your booking is confirmed.", { exact: true })).toBeVisible();
  await expect(meeting.getByRole("link", { name: "Open in Maps" })).toHaveCount(0);
});

// #146: the FAQ, the host's introduction and other experiences, all in the first HTML (mock data only).
test("the FAQ is an h2 with one h3 per question in the initial HTML, and only where an experience has one", async ({ request }) => {
  const html = await (await request.get(dinner)).text();
  const section = html.slice(html.indexOf('id="faq"'));
  expect(html).toMatch(/<section id="faq"[^>]*><h2[^>]*>Questions before you book<\/h2>/);
  const questions = [...section.slice(0, section.indexOf("</section>")).matchAll(/<summary[^>]*><h3[^>]*><span>([^<]+)<\/span>/g)].map((match) => match[1]);
  expect(questions.length).toBeGreaterThanOrEqual(10);
  expect(questions).toContain("What should I wear?");
  expect(questions).toContain("How do I pay?");
  expect(html).toContain("Free cancellation until 24 hours before the start. After that, the booking cannot be refunded.");
  expect(section).toMatch(/<details[^>]*><summary[^>]*><h3/);
  // The FAQ comes before the cancellation terms.
  expect(html.indexOf('id="faq"')).toBeLessThan(html.lastIndexOf(">Cancellation</h2>"));
  const indigo = await (await request.get("/experiences/indigo-dyeing-with-an-artisan")).text();
  expect(indigo).not.toContain('id="faq"');
});

test("the host's own introduction shows as text in the host section, and nothing when there is none", async ({ request }) => {
  const html = await (await request.get(dinner)).text();
  const host = html.slice(html.indexOf(">Your host</h2>"), html.indexOf(">What&#x27;s included</h2>"));
  expect(host).toContain("Yui (sample) cooks for the regulars of a neighbourhood living room");
  const cycling = await (await request.get("/experiences/seaside-cycling-and-market-breakfast")).text();
  expect(cycling).not.toContain("An invented host for previews.");
});

test("other experiences are linked from the detail page, same themes first, never the page itself", async ({ request }) => {
  const html = await (await request.get(dinner)).text();
  const start = html.indexOf('id="related-experiences-heading"');
  expect(start).toBeGreaterThan(-1);
  const related = html.slice(start, html.indexOf("</section>", start));
  expect(related).toContain(">More experiences in Kamakura</h2>");
  const links = [...related.matchAll(/href="\/experiences\/([a-z0-9-]+)"/g)].map((match) => match[1]);
  // Dinner is FOOD and LOCAL_LIFE: the cycling breakfast (FOOD) comes first.
  expect([...new Set(links)]).toEqual(["seaside-cycling-and-market-breakfast", "indigo-dyeing-with-an-artisan", "evening-pottery-session"]);
});

test("two crawler UAs get the location, FAQ and next-date band in the initial HTML", async ({ request }) => {
  for (const userAgent of ["Googlebot/2.1 (+http://www.google.com/bot.html)", "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)"]) {
    const html = (await (await request.get(dinner, { headers: { "user-agent": userAgent } })).text()).replaceAll("<!-- -->", "");
    expect(html).toContain("Kamakura · 1 hour from Tokyo");
    expect(html).toContain("data-next-date-band");
    expect(html).toMatch(/Next date<\/span><time[^>]*>(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} [A-Z][a-z]{2} · .* JST<\/time>/);
    expect(html).toContain('id="faq"');
    expect(html.indexOf("data-next-date-band")).toBeLessThan(html.indexOf('aria-label="Photos of'));
    expect(html.indexOf('id="faq"')).toBeLessThan(html.indexOf("Stories behind this experience"));
    expect(html.indexOf("Stories behind this experience")).toBeLessThan(html.lastIndexOf(">Cancellation</h2>"));
    expect(html).not.toMatch(/Book by|seats? left/i);
  }

  // No bookable occurrence means no band at all.
  const unavailable = await (await request.get("/experiences/evening-pottery-session")).text();
  expect(unavailable).not.toContain("data-next-date-band");
});
