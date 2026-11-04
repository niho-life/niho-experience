import type { JourneyReviews } from "@niho-experience/api-client";
import type { Guide } from "@/content/guides/types";
import type { ExperienceDetailForSite } from "./experience-types";
import type { SitePublicExperience } from "./experience/site-publications";
import { shareableGuideImage } from "./guides";
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
 * Reviews are submitted public reviews from guests who booked (docs/growth/seo-content-policy.md).
 */
export function reviewsForJsonLd(reviews: JourneyReviews | null): { count: number; average: number; items: Extract<JourneyReviews, { status: "ok" }>["items"] } | null {
  const display = reviewDisplay(reviews);
  return display.kind === "rated" && reviews?.status === "ok" ? { count: display.count, average: display.average, items: reviews.items } : null;
}

/** Review fields shared by both legacy-shaped and native public experience nodes. */
function reviewJsonLdFacts(reviews: ReturnType<typeof reviewsForJsonLd>): JsonLd {
  return reviews
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
    : {};
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
    ...reviewJsonLdFacts(reviews),
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

/** Product and TouristTrip for the native publication renderer, using only fields visible on that page. */
export function sitePublicationJsonLd(item: SitePublicExperience, siteUrl: string, bookingsEnabled: boolean, reviews: ReturnType<typeof reviewsForJsonLd>): { touristTrip: JsonLd; product: JsonLd } {
  const { publication, saleTerms } = item;
  const origin = siteUrl.replace(/\/$/, "");
  const url = `${origin}/experiences/${publication.slug}`;
  const images = publication.photos.flatMap((photo) => {
    const candidate = photo.src.startsWith("/") ? `${origin}${photo.src}` : photo.src;
    const safe = safeHttpsUrl(candidate);
    return safe ? [safe] : [];
  });
  const offers = saleTerms?.offers ?? [];
  const facts: JsonLd = {
    name: publication.publicTitle,
    description: publication.content.lead,
    url,
    ...(images.length ? { image: images } : {}),
    ...reviewJsonLdFacts(reviews),
    ...(bookingsEnabled && offers.length
      ? {
          offers: {
            "@type": "Offer",
            url,
            price: Math.min(...offers.map((offer) => offer.pricing.adultPriceYen)),
            priceCurrency: "JPY",
            seller: { "@type": "Organization", name: saleTerms?.sellerDisplayName ?? publication.sellerDisplayName },
          },
        }
      : {}),
  };
  const provider = { "@type": "Organization", name: publication.sellerDisplayName };
  return {
    touristTrip: { "@context": "https://schema.org", "@type": "TouristTrip", ...facts, inLanguage: "en", provider },
    product: { "@context": "https://schema.org", "@type": "Product", ...facts, brand: provider },
  };
}

/**
 * The site and its operator, for the home page. No logo until approved artwork exists.
 * `listingName` is the name used on listings, so search and AI answers can match them to this site (#152).
 */
export function siteJsonLd(siteUrl: string, siteName: string, listingName: string): JsonLd {
  const organization = `${siteUrl}/#organization`;
  return {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "Organization", "@id": organization, name: siteName, alternateName: listingName, url: `${siteUrl}/` },
      { "@type": "WebSite", "@id": `${siteUrl}/#website`, name: siteName, url: `${siteUrl}/`, inLanguage: "en", publisher: { "@id": organization } },
    ],
  };
}

/**
 * A guide as an `Article`, saying only what the page shows: the title, description, author (name and role), the published and
 * updated dates and the URL. The publisher is the site's `Organization` (the same `@id`, name and URL as the home page's).
 * The hero is included only when its rights cover sharing (`hero.licensed`). Unlike experiences, the sample guides of the
 * mock preview carry it too: the article says nothing beyond the page, and preview pages are `noindex`.
 */
export function guideArticleJsonLd(guide: Guide, siteUrl: string, siteName: string): JsonLd {
  const url = `${siteUrl}/guides/${guide.slug}`;
  const image = shareableGuideImage(guide, siteUrl);
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: guide.title,
    description: guide.description,
    url,
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    inLanguage: "en",
    author: { "@type": "Person", name: guide.author.name, ...(guide.author.role ? { jobTitle: guide.author.role } : {}) },
    datePublished: guide.publishedAt,
    dateModified: guide.updatedAt,
    publisher: { "@type": "Organization", "@id": `${siteUrl}/#organization`, name: siteName, url: `${siteUrl}/` },
    ...(image ? { image: [image] } : {}),
  };
}

/** Escapes script-breaking characters before embedding JSON in HTML. */
export const serializeJsonLd = (data: JsonLd) => JSON.stringify(data).replace(/</g, "\\u003c");
