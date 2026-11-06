import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JourneyReviews, Occurrence } from "@niho-experience/api-client";
import type { SitePublicExperience } from "@/lib/experience/site-publications";
import { SAMPLE_TERMS } from "@/lib/testing/guest-booking-fixtures";

const state = vi.hoisted(() => ({ reviews: null as JourneyReviews | null, nextDates: [] as unknown[] }));
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
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/Analytics", () => ({ TrackView: () => null }));
vi.mock("@/components/DetailGallery", () => ({ DesktopGallery: () => null, MobileGallery: () => null }));
vi.mock("@/components/Photo", () => ({ Photo: () => null }));

import { getLiveReviews } from "@/lib/journey";
import { siteNextDates } from "@/lib/guest-booking-source";
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
      highlights: [], included: ["Materials"], notIncluded: [], knowBeforeYouGo: [], notSuitableFor: [], timeline: [],
    },
    currency: "JPY", unitAmount: 4_000, sellerDisplayName: "Synthetic Host", meetingOverview: null,
    meetingPointDisclosure: "AFTER_BOOKING", meetingPoint: null, photos: [], providerPhoto: null, businessLogo: null,
    japanese: null, publishedAtUtc: "2026-11-05T00:00:00.000Z",
  },
  saleTerms,
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

async function render(reviews: JourneyReviews | null): Promise<string> {
  state.reviews = reviews;
  return renderToStaticMarkup(await SitePublicationPage({ item }));
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
