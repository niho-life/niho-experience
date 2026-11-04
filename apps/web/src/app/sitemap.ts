import type { MetadataRoute } from "next";
import { listExperiencesForSite } from "@/lib/api";
import { config } from "@/lib/config";
import { indexableGuides } from "@/lib/guide-registry";
import { getJapaneseCopy, getPreparedJapaneseStaticRelease } from "@/lib/localized-content";
import { sitemapEntries, type JapaneseSitemapRelease } from "@/lib/sitemap-entries";
import { listSitePublicExperiences } from "@/lib/experience/site-publications";

export const dynamic = "force-dynamic";
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  if (!config.indexingAllowed || config.apiMode === "mock") return [];
  const [result, sitePublications] = await Promise.all([listExperiencesForSite("kamakura"), listSitePublicExperiences()]);
  let japanese: JapaneseSitemapRelease | null = null;
  try { japanese = await getPreparedJapaneseStaticRelease(); } catch { /* no approved JA release */ }
  // Guides only while some are published (ADR 0002), never drafts.
  const guides = await indexableGuides();
  const localSlugs = new Set(sitePublications.claimedSlugs);
  const legacyExperiences = result.ok ? result.data.experiences.filter((experience) => !localSlugs.has(experience.slug)) : [];
  const localExperiences = sitePublications.experiences.flatMap(({ publication, saleTerms }) => saleTerms?.offers.length ? [{ slug: publication.slug, updatedAt: publication.publishedAtUtc }] : []);
  const experiences = [...legacyExperiences, ...localExperiences];
  const base = sitemapEntries({
    siteUrl: config.siteUrl,
    experiences,
    guides,
    japanese: config.experiencePublicationsEnabled && japanese ? { ...japanese, experiences: new Map() } : japanese,
  });
  if (!config.experiencePublicationsEnabled || !config.japaneseSiteEnabled) return base;

  try {
    await getJapaneseCopy();
    const publications = sitePublications.experiences.filter((item) => item.publication.japanese !== null);
    const pairs = new Map(publications.map((item) => {
      const english = `${config.siteUrl}/experiences/${encodeURIComponent(item.publication.slug)}`;
      const japaneseUrl = `${config.siteUrl}/ja/experiences/${encodeURIComponent(item.publication.slug)}`;
      return [english, { english, japanese: japaneseUrl, lastModified: item.publication.publishedAtUtc }] as const;
    }));
    const entries = base.map((entry) => {
      const pair = pairs.get(entry.url);
      if (!pair) return entry;
      return { ...entry, alternates: { languages: { en: pair.english, ja: pair.japanese, "x-default": pair.english } } };
    });
    const existing = new Set(entries.map((entry) => entry.url));
    for (const pair of pairs.values()) {
      if (existing.has(pair.japanese)) continue;
      entries.push({
        url: pair.japanese,
        lastModified: pair.lastModified,
        alternates: { languages: { en: pair.english, ja: pair.japanese, "x-default": pair.english } },
      });
    }
    return entries;
  } catch { return base; }
}
