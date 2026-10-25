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

type JsonLdLocale = "en" | "ja";

/**
 * What both nodes below say about one experience, from the values the page shows:
 * only public photos, the lowest adult price while bookable, and the reviews the page lists.
 * No `availability`: the SSR response has no seats left, and a missing seat count must not read as "in stock".
 */
function experienceFacts(e: ExperienceDetailForSite, siteUrl: string, bookingsEnabled: boolean, reviews: ReturnType<typeof reviewsForJsonLd>, locale: JsonLdLocale): JsonLd {
  const url = locale === "ja" ? `${siteUrl}/ja/experiences/${e.slug}` : (safeHttpsUrl(e.canonicalUrl) ?? `${siteUrl}/experiences/${e.slug}`);
  const images = [e.cover, ...e.photos]
    .filter((image): image is NonNullable<typeof image> => image !== null)
    .map((image) => safeHttpsUrl(image.url))
    .filter((image): image is string => image !== null);
  const lowestAdultPrice = Math.min(...e.offers.map((offer) => offer.pricing.adultPriceYen));

  return {
    name: e.title,
    description: e.lead,
    url,
    ...(images.length ? { image: images } : {}),
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

/** Public details can be described in production. Preview fixtures are never emitted as real structured data. */
export function experienceJsonLd(e: ExperienceDetailForSite, siteUrl: string, preview = false, bookingsEnabled = true, reviews: ReturnType<typeof reviewsForJsonLd> = null, locale: JsonLdLocale = "en"): JsonLd | null {
  if (preview) return null;
  const { name, description, url, image, aggregateRating, review, offers } = experienceFacts(e, siteUrl, bookingsEnabled, reviews, locale);
  return {
    "@context": "https://schema.org",
    "@type": "TouristTrip",
    name,
    description,
    url,
    ...(image ? { image } : {}),
    inLanguage: locale === "ja" ? "ja" : e.contentLanguage.toLowerCase(),
    provider: { "@type": "Organization", name: e.provider.name },
    ...(aggregateRating ? { aggregateRating, review } : {}),
    ...(offers ? { offers } : {}),
  };
}

/**
 * The same experience as a `Product`, the type Google's rich results (stars, price) read; `TouristTrip` is not one of them.
 * Carries the same facts as {@link experienceJsonLd}, so it never says more than the page and the TouristTrip node do.
 */
export function experienceProductJsonLd(e: ExperienceDetailForSite, siteUrl: string, preview = false, bookingsEnabled = true, reviews: ReturnType<typeof reviewsForJsonLd> = null, locale: JsonLdLocale = "en"): JsonLd | null {
  if (preview) return null;
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    ...experienceFacts(e, siteUrl, bookingsEnabled, reviews, locale),
    brand: { "@type": "Organization", name: e.provider.name },
  };
}

/** The site and its operator, for the home page. No logo until approved artwork exists. */
export function siteJsonLd(siteUrl: string, siteName: string): JsonLd {
  const organization = `${siteUrl}/#organization`;
  return {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "Organization", "@id": organization, name: siteName, url: `${siteUrl}/` },
      { "@type": "WebSite", "@id": `${siteUrl}/#website`, name: siteName, url: `${siteUrl}/`, inLanguage: "en", publisher: { "@id": organization } },
    ],
  };
}

/** Escapes script-breaking characters before embedding JSON in HTML. */
export const serializeJsonLd = (data: JsonLd) => JSON.stringify(data).replace(/</g, "\\u003c");
