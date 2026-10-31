import { describe, expect, it } from "vitest";
import { buildFixtureExperiences } from "@niho-experience/api-client/mock";
import { resolveConfig } from "./resolve-config";
import { breadcrumbJsonLd, experienceJsonLd, experienceProductJsonLd, serializeJsonLd, siteJsonLd } from "./structured-data";
import nextConfig, { HTML_LIMITED_BOTS } from "../../next.config";

const SITE = "https://experience.example.com";
const experiences = buildFixtureExperiences({ imageBaseUrl: "https://images.example.com" });
const dinner = { ...experiences[0]!, canonicalUrl: `${SITE}/experiences/home-cooked-dinner-with-locals` };

describe("runtime config", () => {
  it("indexes only when explicitly allowed with the real API", () => {
    expect(resolveConfig({}).indexingAllowed).toBe(false);
    expect(resolveConfig({ SITE_INDEXING: "allow" }).indexingAllowed).toBe(false);
    expect(resolveConfig({ SITE_INDEXING: "allow", EXPERIENCE_API_MODE: "http" }).indexingAllowed).toBe(true);
    expect(resolveConfig({ SITE_INDEXING: "yes", EXPERIENCE_API_MODE: "http" }).indexingAllowed).toBe(false);
  });
  it("shows the pilot catalog only when asked, and never lets it be indexed", () => {
    expect(resolveConfig({}).mockCatalog).toBe("synthetic");
    expect(resolveConfig({ MOCK_CATALOG: "pilot" }).mockCatalog).toBe("pilot");
    expect(resolveConfig({ MOCK_CATALOG: "other" }).mockCatalog).toBe("synthetic");
    expect(resolveConfig({ MOCK_CATALOG: "pilot", SITE_INDEXING: "allow" }).indexingAllowed).toBe(false);
  });
  it("keeps bookings on unless explicitly switched off", () => {
    expect(resolveConfig({}).bookingsEnabled).toBe(true);
    expect(resolveConfig({ BOOKINGS_ENABLED: "false" }).bookingsEnabled).toBe(false);
  });
  it("normalises the site URL and gives the public API a safe default", () => {
    expect(resolveConfig({ SITE_URL: "https://a.example/" }).siteUrl).toBe("https://a.example");
    expect(resolveConfig({}).nihoWebOrigin).toBe("https://niho.life");
    expect(resolveConfig({ NEXT_PUBLIC_NIHO_WEB_ORIGIN: "https://app-stg.niho.life" }).nihoWebOrigin).toBe("https://app-stg.niho.life");
  });
});

describe("Japanese private page headers", () => {
  it("keeps booking input and return routes private, no-store, and non-indexable", async () => {
    const headers = await nextConfig.headers!();
    for (const source of ["/ja/experiences/:slug/book", "/ja/booking/:path*"]) {
      const rule = headers.find((candidate) => candidate.source === source);
      expect(rule?.headers).toEqual(expect.arrayContaining([
        { key: "Cache-Control", value: "private, no-store, max-age=0" },
        { key: "X-Robots-Tag", value: "noindex, nofollow" },
      ]));
    }
  });
});

describe("guest booking page headers (#285 slice 6)", () => {
  it("keeps Find your booking, the link page and every booking private, no-store, and non-indexable", async () => {
    const headers = await nextConfig.headers!();
    for (const source of ["/bookings", "/bookings/:path+"]) {
      const rule = headers.find((candidate) => candidate.source === source);
      expect(rule?.headers).toEqual(expect.arrayContaining([
        { key: "Cache-Control", value: "private, no-store, max-age=0" },
        { key: "X-Robots-Tag", value: "noindex, nofollow" },
      ]));
    }
  });
});

describe("structured data", () => {
  it("omits experience data in preview", () => {
    expect(experienceJsonLd(dinner, SITE, true)).toBeNull();
  });

  it("describes public detail facts without inventing availability or ratings", () => {
    const data = experienceJsonLd(dinner, SITE)!;
    const expectedPrice = Math.min(...dinner.offers.map((offer) => offer.pricing.adultPriceYen));
    expect(data).toMatchObject({
      "@type": "TouristTrip",
      name: dinner.title,
      url: dinner.canonicalUrl,
      image: [dinner.cover!.url, ...dinner.photos.map((image) => image.url)],
      inLanguage: "en",
      provider: { name: dinner.provider.name },
      offers: { price: expectedPrice, priceCurrency: "JPY", seller: { name: dinner.seller.displayName } },
    });
    const text = JSON.stringify(data);
    expect(text).not.toMatch(/aggregateRating|review|availability/i);
  });

  it("omits an offer when checkout is paused", () => {
    const paused = experiences.find((experience) => !experience.booking.checkoutAvailable)!;
    expect(experienceJsonLd(paused, SITE)?.offers).toBeUndefined();
    expect(experienceJsonLd(dinner, SITE, false, false)?.offers).toBeUndefined();
  });

  it("builds breadcrumbs and escapes script breakouts", () => {
    const crumbs = breadcrumbJsonLd(SITE, [{ name: "Experiences</script>", path: "/experiences" }]);
    expect(crumbs.itemListElement).toEqual([{ "@type": "ListItem", position: 1, name: "Experiences</script>", item: `${SITE}/experiences` }]);
    expect(serializeJsonLd(crumbs)).not.toContain("</script>");
  });
});

describe("Product structured data", () => {
  it("is omitted in preview and carries the same public facts as the TouristTrip", () => {
    expect(experienceProductJsonLd(dinner, SITE, true)).toBeNull();
    const product = experienceProductJsonLd(dinner, SITE)!;
    const trip = experienceJsonLd(dinner, SITE)!;
    const expectedPrice = Math.min(...dinner.offers.map((offer) => offer.pricing.adultPriceYen));
    expect(product).toMatchObject({
      "@type": "Product",
      name: dinner.title,
      description: dinner.lead,
      url: dinner.canonicalUrl,
      image: [dinner.cover!.url, ...dinner.photos.map((image) => image.url)],
      brand: { "@type": "Organization", name: dinner.provider.name },
      offers: { "@type": "Offer", price: expectedPrice, priceCurrency: "JPY", seller: { name: dinner.seller.displayName } },
    });
    expect(product.image).toEqual(trip.image);
    expect(product.offers).toEqual(trip.offers);
  });

  it("never says anything about seats, ratings or reviews the page does not show", () => {
    const text = JSON.stringify(experienceProductJsonLd(dinner, SITE));
    expect(text).not.toMatch(/availability|inventory|remaining|aggregateRating|review/i);
  });

  it("leaves out images that are not public https URLs and the offer while bookings are off", () => {
    const withUnsafe = { ...dinner, photos: [...dinner.photos, { ...dinner.photos[0]!, url: "http://images.example.com/insecure.jpg" }] };
    const product = experienceProductJsonLd(withUnsafe, SITE)!;
    expect(product.image).toEqual([dinner.cover!.url, ...dinner.photos.map((image) => image.url)]);
    expect(experienceProductJsonLd(dinner, SITE, false, false)?.offers).toBeUndefined();
    const paused = experiences.find((experience) => !experience.booking.checkoutAvailable)!;
    expect(experienceProductJsonLd(paused, SITE)?.offers).toBeUndefined();
  });

  it("describes the Japanese page under its own URL and language", () => {
    const trip = experienceJsonLd(dinner, SITE, false, true, null, "ja")!;
    const product = experienceProductJsonLd(dinner, SITE, false, true, null, "ja")!;
    expect(trip).toMatchObject({ "@type": "TouristTrip", url: `${SITE}/ja/experiences/${dinner.slug}`, inLanguage: "ja" });
    expect(product).toMatchObject({ "@type": "Product", url: `${SITE}/ja/experiences/${dinner.slug}` });
    expect(product.offers).toMatchObject({ url: `${SITE}/ja/experiences/${dinner.slug}` });
  });
});

describe("site structured data", () => {
  it("names the organization, with its listing name, and the website without a logo", () => {
    const data = siteJsonLd(SITE, "NIHO Experience", "NIHO Experience, Kamakura");
    expect(data["@graph"]).toEqual([
      { "@type": "Organization", "@id": `${SITE}/#organization`, name: "NIHO Experience", alternateName: "NIHO Experience, Kamakura", url: `${SITE}/` },
      { "@type": "WebSite", "@id": `${SITE}/#website`, name: "NIHO Experience", url: `${SITE}/`, inLanguage: "en", publisher: { "@id": `${SITE}/#organization` } },
    ]);
    expect(JSON.stringify(data)).not.toMatch(/logo/i);
  });
});

describe("crawlers that get metadata in the first bytes", () => {
  it("covers search engines, AI crawlers and link-preview bots, and leaves browsers to stream", () => {
    for (const agent of [
      "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot",
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot",
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
      "Claude-SearchBot", "Claude-User", "anthropic-ai",
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
      "Perplexity-User",
      // Next's own default list stays covered.
      "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)", "Twitterbot/1.0", "Slackbot-LinkExpanding 1.0", "facebookexternalhit/1.1",
      "Mozilla/5.0 (compatible; Google-InspectionTool/1.0)", "Mediapartners-Google", "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (Applebot/0.1)",
    ]) expect(HTML_LIMITED_BOTS.test(agent), agent).toBe(true);
    for (const agent of [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
    ]) expect(HTML_LIMITED_BOTS.test(agent), agent).toBe(false);
  });

  it("is what the Next config hands to the server", () => {
    expect(nextConfig.htmlLimitedBots).toBe(HTML_LIMITED_BOTS);
  });
});
