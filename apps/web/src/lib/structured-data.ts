import type { JourneyReviews } from "@niho-experience/api-client";
import type { ExperienceDetailForSite } from "./experience-types";
import { reviewDisplay } from "./reviews-ui";
import { safeHttpsUrl } from "./safe-url";

type JsonLd = Record<string, unknown>;

export function breadcrumbJsonLd(siteUrl: string, items: { name: string; path: string }[]): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: `${siteUrl}${item.path}`,
    })),
  };
}

/**
 * What the structured data may say about reviews: only what the page shows. The rating and the review list appear on the page
 * from three reviews, so that is when they are marked up (one or two reviews are shown without stars: nothing to mark up).
 * Reviews are NIHO's checked reviews from guests who booked (docs/growth/seo-content-policy.md).
 */
export function reviewsForJsonLd(reviews: JourneyReviews | null): { count: number; average: number; items: Extract<JourneyReviews, { status: "ok" }>["items"] } | null {
  const display = reviewDisplay(reviews);
  return display.kind === "rated" && reviews?.status === "ok" ? { count: display.count, average: display.average, items: reviews.items } : null;
}

/** Public details can be described in production. Preview fixtures are never emitted as real structured data. */
export function experienceJsonLd(e: ExperienceDetailForSite, siteUrl: string, preview = false, bookingsEnabled = true, reviews: ReturnType<typeof reviewsForJsonLd> = null): JsonLd | null {
  if (preview) return null;
  const url = safeHttpsUrl(e.canonicalUrl) ?? `${siteUrl}/experiences/${e.slug}`;
  const images = [e.cover, ...e.photos]
    .filter((image): image is NonNullable<typeof image> => image !== null)
    .map((image) => safeHttpsUrl(image.url))
    .filter((image): image is string => image !== null);
  const lowestAdultPrice = Math.min(...e.offers.map((offer) => offer.pricing.adultPriceYen));

  return {
    "@context": "https://schema.org",
    "@type": "TouristTrip",
    name: e.title,
    description: e.lead,
    url,
    ...(images.length ? { image: images } : {}),
    inLanguage: e.contentLanguage.toLowerCase(),
    provider: { "@type": "Organization", name: e.provider.name },
    ...(reviews
      ? {
          aggregateRating: { "@type": "AggregateRating", ratingValue: Math.round(reviews.average * 10) / 10, reviewCount: reviews.count, bestRating: 5, worstRating: 1 },
          review: reviews.items.map((item) => ({
            "@type": "Review",
            reviewRating: { "@type": "Rating", ratingValue: item.rating, bestRating: 5, worstRating: 1 },
            author: { "@type": "Person", name: item.displayName },
            datePublished: item.publishedAt.slice(0, 10),
            reviewBody: item.body,
          })),
        }
      : {}),
    ...(bookingsEnabled && e.booking.checkoutAvailable && e.offers.length
      ? {
          offers: {
            "@type": "Offer",
            url,
            price: lowestAdultPrice,
            priceCurrency: "JPY",
            seller: { "@type": "Organization", name: e.seller.displayName },
          },
        }
      : {}),
  };
}

/** Escapes script-breaking characters before embedding JSON in HTML. */
export const serializeJsonLd = (data: JsonLd) => JSON.stringify(data).replace(/</g, "\\u003c");
