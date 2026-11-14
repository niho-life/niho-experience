import type { MetadataRoute } from "next";
import { config } from "@/lib/config";
import { indexableGuides } from "@/lib/guide-registry";
import { getPreparedJapaneseStaticRelease } from "@/lib/localized-content";
import { jaCategoryCounts } from "@/lib/ja-catalog";
import { loadJaCards } from "@/lib/ja-catalog-server";
import { loadJapaneseGuides } from "@/lib/ja-guides";
import { loadPeoplePages } from "@/lib/ja-people";
import { sitemapEntries, type JapaneseOwnPages, type JapaneseSitemapRelease } from "@/lib/sitemap-entries";
import { listSitePublicExperiences } from "@/lib/experience/site-publications";

export const dynamic = "force-dynamic";
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  if (!config.indexingAllowed || config.apiMode === "mock") return [];
  const sitePublications = await listSitePublicExperiences();
  let japanese: JapaneseSitemapRelease | null = null;
  try { japanese = await getPreparedJapaneseStaticRelease(); } catch { /* no approved JA release */ }
  // Guides only while some are published (ADR 0002), never drafts.
  const guides = await indexableGuides();
  const experiences = sitePublications.experiences.flatMap(({ publication, saleTerms }) => saleTerms?.offers.length ? [{ slug: publication.slug, updatedAt: publication.publishedAtUtc }] : []);
  // 日本語サイト独自のページ（#561）。日本語版が公開されているときだけ読み、どれか読めなければそのまとまりは載せない。
  let japaneseOwn: JapaneseOwnPages | undefined;
  if (japanese) {
    const [people, jaGuides, cards] = await Promise.all([
      loadPeoplePages().catch(() => []),
      loadJapaneseGuides().catch(() => []),
      loadJaCards().catch(() => []),
    ]);
    japaneseOwn = {
      people,
      guides: jaGuides.map((guide) => ({ slug: guide.slug, updatedAt: guide.updatedAt })),
      categories: [...jaCategoryCounts(cards).keys()],
    };
  }
  return sitemapEntries({
    siteUrl: config.siteUrl,
    experiences,
    guides,
    japanese,
    ...(japaneseOwn ? { japaneseOwn } : {}),
  });
}
