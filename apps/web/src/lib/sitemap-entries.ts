import type { MetadataRoute } from "next";
import {
  INDEXED_ENGLISH_STATIC_PATHS,
  isIndexableJapanesePage,
  pairLanguages,
  staticPair,
  type JapaneseExperienceMapping,
  type LocalizedPair,
} from "./localized-mapping";

type JapaneseStaticPage = Parameters<typeof staticPair>[0];

/** The prepared Japanese release, or null when it is off or incomplete: then the sitemap is English and guides only. */
export type JapaneseSitemapRelease = Readonly<{ pages: readonly JapaneseStaticPage[]; experiences: JapaneseExperienceMapping }>;

export type SitemapSources = Readonly<{
  siteUrl: string;
  /** The English catalog. A Japanese detail is listed only next to its English page here. */
  experiences: readonly Readonly<{ slug: string; updatedAt: string }>[];
  /** Published guides, newest update first, so the list's date is the first guide's. */
  guides: readonly Readonly<{ slug: string; updatedAt: string }>[];
  japanese: JapaneseSitemapRelease | null;
}>;

/**
 * Entries in a fixed order: English static pages, English details, guides, Japanese static pages,
 * Japanese details. Paired pages carry the same en/ja/x-default set as their page metadata.
 */
export function sitemapEntries({ siteUrl, experiences, guides, japanese }: SitemapSources): MetadataRoute.Sitemap {
  const url = (path: string) => `${siteUrl}${path}`;
  const paired = <T extends MetadataRoute.Sitemap[number]>(entry: T, pair: LocalizedPair | null | undefined): T =>
    pair ? { ...entry, alternates: { languages: pairLanguages(url(pair.englishPath), url(pair.japanesePath)) } } : entry;
  const staticPairs = new Map((japanese?.pages ?? []).flatMap((page) => {
    const pair = staticPair(page);
    return pair ? [[pair.englishPath, pair] as const] : [];
  }));
  const experiencePairs = experiences.flatMap((item) => {
    const link = japanese?.experiences.get(item.slug);
    return link ? [link] : [];
  });
  const guideEntries: MetadataRoute.Sitemap = guides.length
    ? [{ url: url("/guides"), lastModified: guides[0]!.updatedAt }, ...guides.map((guide) => ({ url: url(`/guides/${guide.slug}`), lastModified: guide.updatedAt }))]
    : [];
  return [
    ...INDEXED_ENGLISH_STATIC_PATHS.map((path) => paired({ url: url(path) }, staticPairs.get(path))),
    ...experiences.map((item) => paired({ url: url(`/experiences/${item.slug}`), lastModified: item.updatedAt }, japanese?.experiences.get(item.slug))),
    ...guideEntries,
    ...(japanese?.pages ?? []).filter(isIndexableJapanesePage).map((page) => paired({ url: url(page.route.path) }, staticPair(page))),
    ...experiencePairs.map((link) => paired({ url: url(link.japanesePath) }, link)),
  ];
}
