import type { MetadataRoute } from "next";
import { listExperiencesForSite } from "@/lib/api";
import { config } from "@/lib/config";
import { getGuides } from "@/lib/guides/server";
import type { Guide } from "@/lib/guides/types";
import { getJapaneseIndexablePaths } from "@/lib/localized-content";

export const dynamic = "force-dynamic";

/** Published guides only (drafts are read in the mock preview alone, which has no sitemap). */
async function publishedGuides(): Promise<Guide[]> {
  try {
    return (await getGuides()).guides.filter((guide) => !guide.draft);
  } catch (error) {
    console.error("[sitemap] guides unavailable", error instanceof Error ? error.message : error);
    return [];
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  if (!config.indexingAllowed || config.apiMode === "mock") return [];
  const [result, guides] = await Promise.all([listExperiencesForSite("kamakura"), publishedGuides()]);
  const items = result.ok ? result.data.experiences : [];
  let japanese: MetadataRoute.Sitemap = [];
  try { japanese = (await getJapaneseIndexablePaths()).map((path) => ({ url: `${config.siteUrl}${path}` })); } catch { /* no approved JA release */ }
  const guideEntries: MetadataRoute.Sitemap = guides.length
    ? [{ url: `${config.siteUrl}/guides`, lastModified: guides.map((guide) => guide.updated).sort().at(-1) }, ...guides.map((guide) => ({ url: `${config.siteUrl}/guides/${guide.slug}`, lastModified: guide.updated }))]
    : [];
  return [{ url: `${config.siteUrl}/` }, { url: `${config.siteUrl}/experiences` }, { url: `${config.siteUrl}/host` }, ...items.map((item) => ({ url: `${config.siteUrl}/experiences/${item.slug}`, lastModified: item.updatedAt })), ...guideEntries, ...japanese];
}
