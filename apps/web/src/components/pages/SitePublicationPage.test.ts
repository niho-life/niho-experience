import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JourneyReviews } from "@niho-experience/api-client";
import type { SitePublicExperience } from "@/lib/experience/site-publications";
import { SAMPLE_TERMS } from "@/lib/testing/guest-booking-fixtures";

const state = vi.hoisted(() => ({ reviews: null as JourneyReviews | null }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: {
  siteUrl: "https://experience.example.test",
  nihoWebOrigin: "https://niho.example.test",
  indexingAllowed: true,
  bookingsEnabled: true,
  guestBookingEnabled: true,
} }));
vi.mock("@/lib/journey", () => ({ getLiveReviews: vi.fn(async () => state.reviews) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/Analytics", () => ({ TrackView: () => null }));
vi.mock("@/components/DetailGallery", () => ({ DesktopGallery: () => null, MobileGallery: () => null }));
vi.mock("@/components/Photo", () => ({ Photo: () => null }));

import { getLiveReviews } from "@/lib/journey";
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
