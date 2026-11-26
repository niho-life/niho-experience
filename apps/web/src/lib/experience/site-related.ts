import "server-only";
import type { CardModel } from "@/lib/card-model";
import { cardsFor, readListedExperiences } from "@/lib/experience-cards";
import { loadCategoryBySlug } from "@/lib/experience-categories-server";
import { getReviewSummaries } from "@/lib/journey";
import { getJapaneseCopy } from "@/lib/localized-content";
import { pickRelatedExperiences } from "@/lib/related-experiences";
import { withReviewLines } from "@/lib/reviews-ui";
import { withoutNativeSlugs } from "./dedupe-slugs";
import { sitePublicationCard } from "./site-card-model";
import { listSitePublicExperiences } from "./site-publications";

/**
 * Cards for 2–3 other experiences to suggest under an Experience-owned detail page (#146, #658), never the current one. The ones in
 * the same category come first, then the rest in the list page's order. English: the same set the list page shows (experiences
 * sold here that have a sale, then the NIHO catalogue minus every slug this site claims and every slug sold here). Japanese: the
 * experiences sold here that have Japanese text. A suggestion is optional, so any failure shows none; and when the claimed slugs
 * cannot be read nothing is suggested, because a stopped or draft Experience slug must not reveal a NIHO item of the same slug.
 */
export async function relatedSiteExperienceCards(currentSlug: string, locale: "en" | "ja" = "en", limit = 3): Promise<CardModel[]> {
  try {
    const ja = locale === "ja";
    const [catalog, listed, bySlug] = await Promise.all([
      listSitePublicExperiences(ja ? "ja" : undefined),
      ja ? Promise.resolve(null) : readListedExperiences(),
      loadCategoryBySlug(),
    ]);
    const native = catalog.experiences.filter(({ publication, saleTerms }) => saleTerms !== null && saleTerms.offers.length > 0 && (!ja || publication.japanese));
    // A slug sold here is never also read from the NIHO side (#643): the native card stays.
    const legacy = withoutNativeSlugs(listed ?? [], [...catalog.claimedSlugs, ...native.map(({ publication }) => publication.slug)]);
    // List-page order: NIHO first, then this site's own. Native publications carry no themes yet, so ties keep that order.
    const candidates = [
      ...legacy.map((summary) => ({ ...summary, source: "legacy" as const })),
      ...native.map(({ publication }) => ({ slug: publication.slug, source: "native" as const })),
    ];
    const ordered = pickRelatedExperiences(currentSlug, candidates, candidates.length);
    const mine = bySlug?.get(currentSlug) ?? null;
    const sameCategory = (slug: string) => (mine !== null && bySlug?.get(slug) === mine ? 0 : 1);
    const picked = ordered.map((item, index) => ({ item, index })).sort((a, b) => sameCategory(a.item.slug) - sameCategory(b.item.slug) || a.index - b.index).slice(0, Math.max(0, limit)).map((entry) => entry.item);
    if (!picked.length) return [];

    const legacyCards = await cardsFor(legacy.filter((summary) => picked.some((item) => item.source === "legacy" && item.slug === summary.slug)));
    const chosen = native.filter(({ publication }) => picked.some((item) => item.source === "native" && item.slug === publication.slug));
    let nativeCards: CardModel[];
    if (ja) {
      const { copy } = await getJapaneseCopy();
      nativeCards = chosen.flatMap((entry) => sitePublicationCard(entry, "ja", { copy }) ?? []);
    } else {
      nativeCards = chosen.map((entry) => sitePublicationCard(entry));
    }
    const nativeWithReviews = nativeCards.length ? withReviewLines(nativeCards, await getReviewSummaries(nativeCards.map((card) => card.slug)), locale) : [];
    const bySlugCards = new Map([...legacyCards, ...nativeWithReviews].map((card) => [card.slug, card] as const));
    return picked.flatMap((item) => bySlugCards.get(item.slug) ?? []);
  } catch {
    return [];
  }
}
