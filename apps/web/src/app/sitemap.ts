import type { MetadataRoute } from "next";
import { listExperiencesForSite } from "@/lib/api";
import { config } from "@/lib/config";
import { indexableGuides } from "@/lib/guide-registry";
import { getJapaneseIndexablePaths } from "@/lib/localized-content";

export const dynamic = "force-dynamic";
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  if (!config.indexingAllowed || config.apiMode === "mock") return [];
  const result = await listExperiencesForSite("kamakura");
  const items = result.ok ? result.data.experiences : [];
  let japanese: MetadataRoute.Sitemap = [];
  try { japanese = (await getJapaneseIndexablePaths()).map((path) => ({ url: `${config.siteUrl}${path}` })); } catch { /* no approved JA release */ }
  // Guides only while some are published (ADR 0002), never drafts. Newest update first, so the list's date is the first guide's.
  const guides = await indexableGuides();
  const guideEntries: MetadataRoute.Sitemap = guides.length
    ? [{ url: `${config.siteUrl}/guides`, lastModified: guides[0]!.updatedAt }, ...guides.map((guide) => ({ url: `${config.siteUrl}/guides/${guide.slug}`, lastModified: guide.updatedAt }))]
    : [];
  return [{ url: `${config.siteUrl}/` }, { url: `${config.siteUrl}/experiences` }, { url: `${config.siteUrl}/host` }, ...items.map((item) => ({ url: `${config.siteUrl}/experiences/${item.slug}`, lastModified: item.updatedAt })), ...guideEntries, ...japanese];
}
