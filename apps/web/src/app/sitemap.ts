import type { MetadataRoute } from "next";
import { listExperiencesForSite } from "@/lib/api";
import { config } from "@/lib/config";
import { indexableGuides } from "@/lib/guide-registry";
import { getPreparedJapaneseStaticRelease } from "@/lib/localized-content";
import { sitemapEntries, type JapaneseSitemapRelease } from "@/lib/sitemap-entries";

export const dynamic = "force-dynamic";
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  if (!config.indexingAllowed || config.apiMode === "mock") return [];
  const result = await listExperiencesForSite("kamakura");
  let japanese: JapaneseSitemapRelease | null = null;
  try { japanese = await getPreparedJapaneseStaticRelease(); } catch { /* no approved JA release */ }
  // Guides only while some are published (ADR 0002), never drafts.
  const guides = await indexableGuides();
  return sitemapEntries({ siteUrl: config.siteUrl, experiences: result.ok ? result.data.experiences : [], guides, japanese });
}
