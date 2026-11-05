import type { MetadataRoute } from "next";
import { config } from "@/lib/config";
import { indexableGuides } from "@/lib/guide-registry";
import { getPreparedJapaneseStaticRelease } from "@/lib/localized-content";
import { sitemapEntries, type JapaneseSitemapRelease } from "@/lib/sitemap-entries";
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
  return sitemapEntries({
    siteUrl: config.siteUrl,
    experiences,
    guides,
    japanese,
  });
}
