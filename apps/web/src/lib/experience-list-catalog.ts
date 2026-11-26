import type { SitePublicCatalog, SitePublicExperience } from "./experience/site-publications";
import { withoutNativeSlugs } from "./experience/dedupe-slugs";

export function saleablePublication({ saleTerms }: SitePublicExperience): boolean {
  return (saleTerms?.offers.length ?? 0) > 0;
}

type JapaneseListPublication = SitePublicExperience & {
  publication: { japanese: NonNullable<SitePublicExperience["publication"]["japanese"]> };
  saleTerms: NonNullable<SitePublicExperience["saleTerms"]>;
};

export function japaneseListPublication(item: SitePublicExperience): item is JapaneseListPublication {
  return Boolean(item.publication.japanese) && saleablePublication(item);
}

/** The English list combines enabled native sales with its remaining public summaries. */
export function englishListCatalog<T extends { readonly slug: string }>(summaries: readonly T[], site: SitePublicCatalog) {
  const native = site.experiences.filter(saleablePublication);
  const soldHere = native.map(({ publication }) => publication.slug);
  const catalog = withoutNativeSlugs(summaries, [...site.claimedSlugs, ...soldHere]);
  return { catalog, native, slugs: [...catalog.map(({ slug }) => slug), ...soldHere] };
}
