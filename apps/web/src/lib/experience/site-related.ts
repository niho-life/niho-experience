import "server-only";
import type { CardModel } from "@/lib/card-model";
import { cardsFor, readListedExperiences } from "@/lib/experience-cards";
import { getReviewSummaries } from "@/lib/journey";
import { pickRelatedExperiences } from "@/lib/related-experiences";
import { withReviewLines } from "@/lib/reviews-ui";
import { sitePublicationCard } from "./site-card-model";
import { listSitePublicExperiences } from "./site-publications";

/**
 * Cards for 2–3 other experiences to suggest under an Experience-owned detail page (#146): the same set the list page
 * shows (experiences sold here that have a sale, then the NIHO catalogue minus every slug this site claims), never the
 * current one. A suggestion is optional, so any failure shows none; and when the claimed slugs cannot be read nothing is
 * suggested, because a stopped or draft Experience slug must not reveal a NIHO item of the same slug.
 */
export async function relatedSiteExperienceCards(currentSlug: string, limit = 3): Promise<CardModel[]> {
  try {
    const [catalog, listed] = await Promise.all([listSitePublicExperiences(), readListedExperiences()]);
    const claimed = new Set(catalog.claimedSlugs);
    const legacy = (listed ?? []).filter((summary) => !claimed.has(summary.slug));
    const native = catalog.experiences.filter(({ saleTerms }) => saleTerms !== null && saleTerms.offers.length > 0);
    // List-page order: NIHO first, then this site's own. Native publications carry no themes yet, so ties keep that order.
    const picked = pickRelatedExperiences(currentSlug, [
      ...legacy.map((summary) => ({ ...summary, source: "legacy" as const })),
      ...native.map(({ publication }) => ({ slug: publication.slug, source: "native" as const })),
    ], limit);
    if (!picked.length) return [];

    const legacyCards = await cardsFor(legacy.filter((summary) => picked.some((item) => item.source === "legacy" && item.slug === summary.slug)));
    const nativeCards = native.filter(({ publication }) => picked.some((item) => item.source === "native" && item.slug === publication.slug)).map(sitePublicationCard);
    const nativeWithReviews = nativeCards.length ? withReviewLines(nativeCards, await getReviewSummaries(nativeCards.map((card) => card.slug))) : [];
    const bySlug = new Map([...legacyCards, ...nativeWithReviews].map((card) => [card.slug, card] as const));
    return picked.flatMap((item) => bySlug.get(item.slug) ?? []);
  } catch {
    return [];
  }
}
