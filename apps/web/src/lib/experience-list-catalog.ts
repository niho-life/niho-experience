import type { SitePublicCatalog, SitePublicExperience } from "./experience/site-publications";
import { withoutNativeSlugs } from "./experience/dedupe-slugs";

/** An experience a guest can book now: its bookings are open and it has something to book. A page without that is "preparing". */
export function saleablePublication({ publication, saleTerms }: SitePublicExperience): boolean {
  return publication.bookingAvailable === true && (saleTerms?.offers.length ?? 0) > 0;
}

type JapaneseListPublication = SitePublicExperience & {
  publication: { japanese: NonNullable<SitePublicExperience["publication"]["japanese"]> };
};

/**
 * Whether the Japanese list shows an experience (#706): it has Japanese text. Whether bookings are open does not matter: a page
 * whose bookings are not open yet is listed too, marked as preparing and placed after the ones that can be booked.
 */
export function japaneseListPublication(item: SitePublicExperience): item is JapaneseListPublication {
  return Boolean(item.publication.japanese);
}

/** Cards a guest can book come first; the others ("preparing") follow. Each group keeps its order. */
export function bookableFirst<T extends { readonly bookingAvailable?: boolean }>(cards: readonly T[]): T[] {
  return [...cards.filter((card) => card.bookingAvailable !== false), ...cards.filter((card) => card.bookingAvailable === false)];
}

/** The English list combines this site's public pages (bookable or not yet) with its remaining public summaries. */
export function englishListCatalog<T extends { readonly slug: string }>(summaries: readonly T[], site: SitePublicCatalog) {
  const native = site.experiences;
  const soldHere = native.map(({ publication }) => publication.slug);
  const catalog = withoutNativeSlugs(summaries, [...site.claimedSlugs, ...soldHere]);
  return { catalog, native, slugs: [...catalog.map(({ slug }) => slug), ...soldHere] };
}
