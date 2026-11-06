import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JourneyReviews, Occurrence } from "@niho-experience/api-client";
import type { SitePublicExperience } from "@/lib/experience/site-publications";
import { SAMPLE_TERMS } from "@/lib/testing/guest-booking-fixtures";

const state = vi.hoisted(() => ({
  reviews: null as JourneyReviews | null,
  nextDates: [] as unknown[],
  guides: { guides: [] as unknown[], draftSlugs: [] as string[] },
  related: [] as unknown[],
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: {
  siteUrl: "https://experience.example.test",
  nihoWebOrigin: "https://niho.example.test",
  indexingAllowed: true,
  bookingsEnabled: true,
  guestBookingEnabled: true,
} }));
vi.mock("@/lib/journey", () => ({ getLiveReviews: vi.fn(async () => state.reviews) }));
vi.mock("@/lib/guest-booking-source", () => ({ siteNextDates: vi.fn(async () => state.nextDates) }));
vi.mock("@/lib/guide-registry", () => ({ guidesAboutExperience: vi.fn(async () => state.guides) }));
vi.mock("@/lib/experience/site-related", () => ({ relatedSiteExperienceCards: vi.fn(async () => state.related) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/Analytics", () => ({ TrackView: () => null }));
vi.mock("@/components/DetailGallery", () => ({ DesktopGallery: () => null, MobileGallery: () => null }));
vi.mock("@/components/Photo", () => ({ Photo: () => null }));

import { getLiveReviews } from "@/lib/journey";
import { siteNextDates } from "@/lib/guest-booking-source";
import { guidesAboutExperience } from "@/lib/guide-registry";
import { relatedSiteExperienceCards } from "@/lib/experience/site-related";
import { sitePublicationCard } from "@/lib/experience/site-card-model";
import { config } from "@/lib/config";
import { SitePublicationPage } from "./SitePublicationPage";

const saleTerms = {
  title: SAMPLE_TERMS.title,
  currency: SAMPLE_TERMS.currency,
  sellerDisplayName: SAMPLE_TERMS.sellerDisplayName,
  offers: SAMPLE_TERMS.offers,
  conditionsVersion: SAMPLE_TERMS.conditionsVersion,
};
const item = {
  sellerDisclosure: { method: "EXTERNAL", sellerKind: "BUSINESS", sellerDisplayName: "Synthetic Host", externalUrl: "https://seller.example.test/legal" },
  publication: {
    slug: "native-review-page",
    publicTitle: "Native review page",
    content: {
      lead: "A synthetic native experience.", description: "Only public manuscript appears here.", facts: { language: "English" },
      highlights: [], included: ["Materials"], notIncluded: [], knowBeforeYouGo: [], notSuitableFor: [], timeline: [], faq: [],
    },
    currency: "JPY", unitAmount: 4_000, sellerDisplayName: "Synthetic Host", meetingOverview: null,
    meetingPointDisclosure: "AFTER_BOOKING", meetingPoint: null, photos: [], providerPhoto: null, businessLogo: null,
    japanese: null, publishedAtUtc: "2026-11-05T00:00:00.000Z",
  },
  saleTerms,
  hostBio: null,
} as SitePublicExperience;

const review = (index: number) => ({
  id: `review-${index}`,
  rating: (index === 0 ? 5 : 4) as 4 | 5,
  body: index === 0 ? "A public review with </script><script>alert(1)</script>." : `Public review ${index + 1}.`,
  tags: ["Great host"], displayName: `Guest ${index + 1}`, originLabel: "United Kingdom",
  publishedAt: `2026-11-0${index + 1}T01:02:03.000Z`, fromBooking: true as const,
  reply: index === 0 ? { hostName: "Synthetic Host", body: "Thank you for joining us." } : null,
});

function ok(count: number): JourneyReviews {
  const items = Array.from({ length: Math.min(count, 3) }, (_, index) => review(index));
  const average = count === 0 ? null : 4.7;
  return { status: "ok", summary: { count, average, tags: count ? [{ label: "Great host", count }] : [] }, items };
}

async function render(reviews: JourneyReviews | null, page: SitePublicExperience = item): Promise<string> {
  state.reviews = reviews;
  return renderToStaticMarkup(await SitePublicationPage({ item: page }));
}

function jsonLd(html: string): Record<string, unknown>[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([^<]*)<\/script>/g)].map((match) => JSON.parse(match[1]!));
}

describe("native publication reviews", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    [null, false, null],
    [{ status: "unavailable" } as JourneyReviews, true, "Reviews can&#x27;t be loaded right now"],
    [ok(0), true, "New"],
    [ok(1), true, "1 review"],
    [ok(2), true, "2 reviews"],
  ])("renders null, unavailable and fewer-than-three states without rating markup", async (reviews, section, text) => {
    const html = await render(reviews);
    expect(html.includes('id="reviews"')).toBe(section);
    if (text) expect(html).toContain(text);
    expect(html).not.toContain("★");
    if (reviews?.status === "ok" && reviews.summary.count > 0) expect(html).toContain("A public review");
    for (const node of jsonLd(html)) {
      expect(node).not.toHaveProperty("aggregateRating");
      expect(node).not.toHaveProperty("review");
    }
    expect(getLiveReviews).toHaveBeenCalledOnce();
    expect(getLiveReviews).toHaveBeenCalledWith(item.publication.slug);
  });

  it("shows 3+ reviews and one English reply, with the same safe rating facts in both JSON-LD nodes", async () => {
    const html = await render(ok(3));
    expect(html).toContain("★ 4.7 · 3 reviews");
    expect(html).toContain("Reply from Synthetic Host");
    expect(html).toContain("Thank you for joining us.");
    expect(html).toContain("https://seller.example.test/legal");
    expect(html).not.toContain("</script><script>alert(1)</script>");

    const nodes = jsonLd(html);
    expect(nodes.map((node) => node["@type"])).toEqual(["TouristTrip", "Product"]);
    for (const node of nodes) {
      expect(node.aggregateRating).toMatchObject({ ratingValue: 4.7, reviewCount: 3 });
      expect(node.review).toHaveLength(3);
      expect(JSON.stringify(node.review)).toContain("</script><script>alert(1)</script>");
      expect(JSON.stringify(node)).not.toMatch(/providerId|productId|bookingId|noteToHost|bodyJa/);
    }
  });
});

describe("native publication next dates and booking deadline (#146)", () => {
  // The real config is read-only; this test's mock is not.
  const flags = config as { bookingsEnabled: boolean; guestBookingEnabled: boolean };
  const next: Occurrence = {
    offerId: "offer-a", date: "2026-11-20", startAt: "2026-11-20T01:00:00.000Z", endAt: "2026-11-20T02:30:00.000Z",
    bookingClosesAt: "2026-11-19T09:00:00.000Z", seatsLeft: 4, bookable: true, reason: null,
  };
  const page = async (locale: "en" | "ja" = "en", withItem: SitePublicExperience = item) => {
    state.reviews = null;
    return renderToStaticMarkup(await SitePublicationPage({ item: withItem, locale }));
  };
  beforeEach(() => {
    vi.clearAllMocks();
    state.nextDates = [next];
    flags.bookingsEnabled = true;
    flags.guestBookingEnabled = true;
  });

  it("puts the next dates and when the next one closes under the facts, linked to the booking page", async () => {
    const html = await page();
    expect(siteNextDates).toHaveBeenCalledWith("native-review-page");
    expect(html).toContain("data-next-date-band");
    expect(html).toContain("Next date");
    expect(html).toContain("Book by");
    expect(html).toContain("6:00 PM JST");
    // The band comes after the facts header and before the first section.
    expect(html.indexOf("data-next-date-band")).toBeGreaterThan(html.indexOf("<h1"));
    expect(html.indexOf("data-next-date-band")).toBeLessThan(html.indexOf("What you’ll do"));
    expect(html).toContain('href="/experiences/native-review-page/book"');
    expect(html).not.toContain('href="#book"');
  });

  it("is shown without a deadline when the source says none", async () => {
    state.nextDates = [{ ...next, bookingClosesAt: next.startAt }];
    const html = await page();
    expect(html).toContain("Next date");
    expect(html).not.toContain("Book by");
  });

  it("shows no band where nothing can be booked: bookings off, no offers, or no dates", async () => {
    flags.bookingsEnabled = false;
    expect(await page()).not.toContain("data-next-date-band");
    expect(siteNextDates).not.toHaveBeenCalled();
    flags.bookingsEnabled = true;
    flags.guestBookingEnabled = false;
    expect(await page()).not.toContain("data-next-date-band");
    flags.guestBookingEnabled = true;
    expect(await page("en", { ...item, saleTerms: null } as SitePublicExperience)).not.toContain("data-next-date-band");
    state.nextDates = [];
    expect(await page()).not.toContain("data-next-date-band");
  });
});

describe("native publication FAQ", () => {
  const withFaq = (faq: SitePublicExperience["publication"]["content"]["faq"]): SitePublicExperience => ({
    ...item, publication: { ...item.publication, content: { ...item.publication.content, faq } },
  });

  it("renders no FAQ section, heading or filler when the host wrote none", async () => {
    const html = await render(null);
    expect(html).not.toContain('id="faq"');
    expect(html).not.toContain("Questions before you book");
    expect(html).not.toContain("<details");
  });

  it("renders the host FAQ in order in the server HTML: one h2, one h3 per question inside native details, and no FAQPage JSON-LD", async () => {
    const html = await render(null, withFaq([
      { question: "Can I bring my child?", answer: "Yes, from age 6.\nAn adult must join." },
      { question: "Is it held in rain?", answer: "Yes, indoors." },
    ]));
    expect(html).toContain('id="faq"');
    expect(html.match(/<h2[^>]*>Questions before you book<\/h2>/g)).toHaveLength(1);
    expect(html.match(/<details/g)).toHaveLength(2);
    expect(html).toMatch(/<summary[^>]*><h3[^>]*><span>Can I bring my child\?<\/span>/);
    expect(html.indexOf("Can I bring my child?")).toBeLessThan(html.indexOf("Is it held in rain?"));
    expect(html).toContain("Yes, from age 6.\nAn adult must join.");
    for (const node of jsonLd(html)) expect(JSON.stringify(node)).not.toContain("FAQPage");
  });
});

describe("native publication host bio (#146)", () => {
  const japanese = { title: "合成の体験", lead: "日本語の紹介", description: "日本語の説明", language: "日本語", highlights: [], included: [], notIncluded: [], knowBeforeYouGo: [], notSuitableFor: [], timeline: [], faq: [] };
  const withBio = (hostBio: SitePublicExperience["hostBio"]): SitePublicExperience => ({
    ...item, hostBio, publication: { ...item.publication, japanese } as SitePublicExperience["publication"],
  });
  const renderJa = async (page: SitePublicExperience) => {
    state.reviews = null;
    return renderToStaticMarkup(await SitePublicationPage({ item: page, locale: "ja" }));
  };

  it("shows the confirmed English bio as plain text with the host name, before reviews", async () => {
    const html = await render(ok(2), withBio({ ja: "鎌倉で茶道を教えています。", en: "I teach tea ceremony.\n\n<b>Synthetic</b> host." }));
    expect(html).toContain('<section id="host" aria-labelledby="host-heading"');
    expect(html).toMatch(/<h2 id="host-heading"[^>]*>About your host<\/h2>/);
    expect(html).toContain("Synthetic Host");
    expect(html).toContain("I teach tea ceremony.\n\n&lt;b&gt;Synthetic&lt;/b&gt; host.");
    expect(html).not.toContain("鎌倉で茶道を教えています。");
    expect(html.indexOf('id="host"')).toBeLessThan(html.indexOf('id="reviews"'));
  });

  it("shows no English section while the English is missing or unconfirmed, and no section without a bio", async () => {
    for (const page of [withBio({ ja: "鎌倉で茶道を教えています。", en: null }), withBio(null)]) {
      const html = await render(null, page);
      expect(html).not.toContain('id="host"');
      expect(html).not.toContain("About your host");
    }
  });

  it("shows the Japanese bio on the Japanese page, and nothing there without one", async () => {
    const html = await renderJa(withBio({ ja: "鎌倉で茶道を教えています。\n合成データです。", en: null }));
    expect(html).toMatch(/<h2 id="host-heading"[^>]*>ホストについて<\/h2>/);
    expect(html).toContain("鎌倉で茶道を教えています。\n合成データです。");
    expect(html).not.toContain("About your host");
    expect(await renderJa(withBio(null))).not.toContain('id="host"');
  });
});

describe("native publication context under the title and below the sections (#146)", () => {
  const guide = (slug: string, pillar: "hosts" | "planning") => ({
    slug, title: `Guide ${slug}`, description: `About ${slug}.`, pillar, author: { name: "Synthetic Editor" },
    publishedAt: "2026-10-01", updatedAt: "2026-10-02", relatedExperienceSlugs: ["native-review-page"], relatedGuideSlugs: [], faq: [], body: "Body.",
  });
  const withOverview = (meetingOverview: string | null): SitePublicExperience => ({ ...item, publication: { ...item.publication, meetingOverview } });
  const japanese: NonNullable<SitePublicExperience["publication"]["japanese"]> = {
    title: "日本語の題名", lead: "導入", description: "説明", language: "日本語", highlights: [], included: ["材料"], notIncluded: [],
    knowBeforeYouGo: [], notSuitableFor: [], timeline: [], faq: [],
  };
  const page = async (locale: "en" | "ja" = "en", withItem: SitePublicExperience = item) => {
    state.reviews = null;
    return renderToStaticMarkup(await SitePublicationPage({ item: withItem, locale }));
  };
  beforeEach(() => {
    vi.clearAllMocks();
    state.nextDates = [];
    state.guides = { guides: [], draftSlugs: [] };
    state.related = [];
  });

  it("says where it is under the title, and adds the station walk only when the meeting overview names one", async () => {
    const html = await page();
    expect(html).toContain("Kamakura · 1 hour from Tokyo<");
    expect(html.indexOf("Kamakura · 1 hour from Tokyo")).toBeGreaterThan(html.indexOf("<h1"));
    expect(html.indexOf("Kamakura · 1 hour from Tokyo")).toBeLessThan(html.indexOf("Offered by"));
    expect(await page("en", withOverview("Meet at the gate. It is a 2-minute walk from Kamakura Station."))).toContain("Kamakura · 1 hour from Tokyo · 2-minute walk from Kamakura Station");
    expect(await page("en", withOverview("Meet near the nearest station."))).toContain("Kamakura · 1 hour from Tokyo<");
  });

  it("says it in Japanese too, without carrying an English station into the Japanese page", async () => {
    const ja = { ...withOverview("It is a 2-minute walk from Kamakura Station."), publication: { ...item.publication, meetingOverview: "It is a 2-minute walk from Kamakura Station.", japanese } } as SitePublicExperience;
    const html = await page("ja", ja);
    expect(html).toContain("鎌倉・東京から1時間<");
    expect(html).not.toContain("Kamakura Station");
  });

  it("links the host story and shows the related guides under a heading that names the place, English only", async () => {
    state.guides = { guides: [guide("meet-the-host", "hosts"), guide("rainy-day", "planning")], draftSlugs: [] };
    const html = await page();
    expect(guidesAboutExperience).toHaveBeenCalledWith("native-review-page");
    expect(html).toMatch(/<h2[^>]*>Plan your (morning|evening|day) in Kamakura<\/h2>/);
    expect(html).toContain("Guide meet-the-host");
    expect(html).toContain("Guide rainy-day");
    expect(html).toContain('href="/guides/meet-the-host"');
    expect(html).toContain("Read the host story");
    // The related guides come after the FAQ position and before the price card; the story link is up with the host line.
    expect(html.indexOf("Read the host story")).toBeLessThan(html.indexOf("What you’ll do"));
    expect(html.indexOf("Plan your")).toBeGreaterThan(html.indexOf("What’s included"));

    const ja = await page("ja", { ...item, publication: { ...item.publication, japanese } } as SitePublicExperience);
    expect(ja).not.toContain("Read the host story");
    expect(ja).not.toContain("Guide meet-the-host");
    expect(guidesAboutExperience).toHaveBeenCalledTimes(1);
  });

  it("links no host story without a hosts guide, or when it is only a draft; the other guides still show", async () => {
    state.guides = { guides: [guide("rainy-day", "planning")], draftSlugs: [] };
    const html = await page();
    expect(html).not.toContain("Read the host story");
    expect(html).toContain("Guide rainy-day");
    state.guides = { guides: [guide("meet-the-host", "hosts")], draftSlugs: ["meet-the-host"] };
    expect(await page()).not.toContain("Read the host story");
  });

  it("shows no guides section at all when none relate, and a failing lookup does not break the page", async () => {
    expect(await page()).not.toContain("detail-guides-heading");
    vi.mocked(guidesAboutExperience).mockRejectedValueOnce(new Error("catalogue unavailable"));
    const html = await page();
    expect(html).toContain("Native review page");
    expect(html).not.toContain("detail-guides-heading");
  });

  it("suggests other experiences after the page content, English only, and nothing when there are none", async () => {
    const other = { ...item, publication: { ...item.publication, slug: "another-experience", publicTitle: "Another experience" } } as SitePublicExperience;
    state.related = [sitePublicationCard(other)];
    const html = await page();
    expect(relatedSiteExperienceCards).toHaveBeenCalledWith("native-review-page");
    expect(html).toMatch(/<h2[^>]*>More experiences in Kamakura<\/h2>/);
    expect(html).toContain('href="/experiences/another-experience"');
    // Full width, after the price card rather than inside the two-column body.
    expect(html.indexOf("More experiences in Kamakura")).toBeGreaterThan(html.indexOf("</aside>"));

    const ja = await page("ja", { ...item, publication: { ...item.publication, japanese } } as SitePublicExperience);
    expect(ja).not.toContain("More experiences in Kamakura");
    expect(relatedSiteExperienceCards).toHaveBeenCalledTimes(1);

    state.related = [];
    expect(await page()).not.toContain("More experiences in Kamakura");
  });
});
