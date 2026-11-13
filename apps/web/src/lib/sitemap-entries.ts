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

/**
 * 日本語サイト独自のページ（#561）：使い方・法人・学校の案内、街の人（#564）、読みもの（#154）、カテゴリーの一覧（#529）。
 * どれも noindex ではない公開ページで、日本語版が公開されているとき（`japanese` がある）だけ載せる。中身が0件の一覧
 * （街の人が0人・記事が0本・体験が0件のカテゴリー）は空のページを検索に出さないために載せない。
 */
export type JapaneseOwnPages = Readonly<{
  people: readonly Readonly<{ slug: string }>[];
  guides: readonly Readonly<{ slug: string; updatedAt: string }>[];
  /** カテゴリーの id のうち、公開中の体験が1件以上あるもの。 */
  categories: readonly string[];
}>;

export const JAPANESE_SERVICE_PATHS = ["/ja/usage", "/ja/business", "/ja/schools"] as const;

export type SitemapSources = Readonly<{
  siteUrl: string;
  /** The English catalog. A Japanese detail is listed only next to its English page here. */
  experiences: readonly Readonly<{ slug: string; updatedAt: string }>[];
  /** Published guides, newest update first, so the list's date is the first guide's. */
  guides: readonly Readonly<{ slug: string; updatedAt: string }>[];
  japanese: JapaneseSitemapRelease | null;
  japaneseOwn?: JapaneseOwnPages;
}>;

/**
 * Entries in a fixed order: English static pages, English details, guides, Japanese static pages,
 * Japanese details. Paired pages carry the same en/ja/x-default set as their page metadata.
 */
export function sitemapEntries({ siteUrl, experiences, guides, japanese, japaneseOwn }: SitemapSources): MetadataRoute.Sitemap {
  const url = (path: string) => `${siteUrl}${path}`;
  const paired = <T extends MetadataRoute.Sitemap[number]>(entry: T, pair: LocalizedPair | null | undefined): T =>
    pair ? { ...entry, alternates: { languages: pairLanguages(url(pair.englishPath), url(pair.japanesePath)) } } : entry;
  const staticPairs = new Map((japanese?.pages ?? []).flatMap((page) => {
    const pair = staticPair(page);
    return pair ? [[pair.englishPath, pair] as const] : [];
  }));
  const experiencePairs = experiences.flatMap((item) => {
    const link = japanese?.experiences.get(item.slug);
    return link && !link.japaneseOnly ? [link] : [];
  });
  // 日本語のみの商品（#59）：英語のページが無いので日本語の URL だけを載せ、hreflang の組は付けない。
  const japaneseOnlyLinks = [...(japanese?.experiences.values() ?? [])].filter((link) => link.japaneseOnly);
  const guideEntries: MetadataRoute.Sitemap = guides.length
    ? [{ url: url("/guides"), lastModified: guides[0]!.updatedAt }, ...guides.map((guide) => ({ url: url(`/guides/${guide.slug}`), lastModified: guide.updatedAt }))]
    : [];
  const listed = new Set((japanese?.pages ?? []).map((page) => page.route.path));
  const own: MetadataRoute.Sitemap = !japanese || !japaneseOwn ? [] : [
    ...JAPANESE_SERVICE_PATHS.filter((path) => !listed.has(path)).map((path) => ({ url: url(path) })),
    ...(japaneseOwn.people.length ? [{ url: url("/ja/people") }, ...japaneseOwn.people.map((person) => ({ url: url(`/ja/people/${person.slug}`) }))] : []),
    ...(japaneseOwn.guides.length ? [{ url: url("/ja/guides"), lastModified: japaneseOwn.guides[0]!.updatedAt }, ...japaneseOwn.guides.map((guide) => ({ url: url(`/ja/guides/${guide.slug}`), lastModified: guide.updatedAt }))] : []),
    ...japaneseOwn.categories.map((id) => ({ url: url(`/ja/experiences?category=${id}`) })),
  ];
  return [
    ...INDEXED_ENGLISH_STATIC_PATHS.map((path) => paired({ url: url(path) }, staticPairs.get(path))),
    ...experiences.map((item) => paired({ url: url(`/experiences/${item.slug}`), lastModified: item.updatedAt }, japanese?.experiences.get(item.slug))),
    ...guideEntries,
    ...(japanese?.pages ?? []).filter(isIndexableJapanesePage).map((page) => paired({ url: url(page.route.path) }, staticPair(page))),
    ...experiencePairs.map((link) => paired({ url: url(link.japanesePath) }, link)),
    ...japaneseOnlyLinks.map((link) => ({ url: url(link.japanesePath) })),
    ...own,
  ];
}
