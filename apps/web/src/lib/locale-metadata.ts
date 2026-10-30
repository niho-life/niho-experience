import "server-only";
import type { Metadata } from "next";
import type { PageId } from "./page-document-contract";
import { listExperiencesForSite } from "./api";
import { config } from "./config";
import { getJapaneseCatalog, getJapaneseDetail, getPreparedJapaneseStaticRelease } from "./localized-content";
import { isIndexableJapanesePage, mapJapaneseExperiences, pairLanguages, staticPair } from "./localized-mapping";

export async function englishAlternates(sourcePath: string, indexable = true): Promise<Metadata["alternates"]> {
  const canonical = `${config.siteUrl}${sourcePath === "/" ? "/" : sourcePath}`;
  if (!indexable) return { canonical };
  try {
    const release = await getPreparedJapaneseStaticRelease();
    const page = release.pages.find((candidate) => candidate.route.sourcePath === sourcePath);
    const pair = page ? staticPair(page) : null;
    if (!pair) return { canonical, languages: { en: canonical, "x-default": canonical } };
    return { canonical, languages: pairLanguages(canonical, `${config.siteUrl}${pair.japanesePath}`) };
  } catch { return { canonical, languages: { en: canonical, "x-default": canonical } }; }
}

/**
 * hreflang for an English experience page: itself and `x-default`, plus `ja` only when the Japanese page
 * would really render — the static release the /ja layout needs, and this slug paired in that release's
 * catalog with its detail from the same release (localized-mapping.ts). Otherwise /ja shows "unavailable".
 */
export async function experienceAlternates(slug: string, canonical: string): Promise<Metadata["alternates"]> {
  try {
    const [release, catalog, detail] = await Promise.all([getPreparedJapaneseStaticRelease(), getJapaneseCatalog(), getJapaneseDetail(slug)]);
    const link = mapJapaneseExperiences(release.releaseId, catalog, [detail]).get(slug);
    if (link) return { canonical, languages: pairLanguages(canonical, `${config.siteUrl}${link.japanesePath}`) };
  } catch { /* no Japanese page renders */ }
  return { canonical, languages: { en: canonical, "x-default": canonical } };
}

/**
 * hreflang for a rendered Japanese experience page: the same pair as the English page, and only while the
 * English page is published (in the English catalog the sitemap lists). Otherwise canonical alone, so no
 * hreflang points one way at a missing page.
 */
export async function japaneseExperienceAlternates(slug: string, canonical: string): Promise<Metadata["alternates"]> {
  try {
    const [release, catalog, detail, english] = await Promise.all([getPreparedJapaneseStaticRelease(), getJapaneseCatalog(), getJapaneseDetail(slug), listExperiencesForSite("kamakura")]);
    const link = mapJapaneseExperiences(release.releaseId, catalog, [detail]).get(slug);
    if (link && english.ok && english.data.experiences.some((item) => item.slug === slug)) {
      return { canonical, languages: pairLanguages(`${config.siteUrl}${link.englishPath}`, canonical) };
    }
  } catch { /* English page unconfirmed: no hreflang */ }
  return { canonical };
}

export async function japaneseStaticMetadata(pageId: Extract<PageId, "home" | "experiences" | "host" | "help">, filtered = false): Promise<Metadata> {
  const release = await getPreparedJapaneseStaticRelease();
  const page = release.pageById[pageId];
  const canonical = `${config.siteUrl}${page.route.path}`;
  const pair = staticPair(page);
  const indexable = isIndexableJapanesePage(page) && config.indexingAllowed && !filtered;
  const alternates: Metadata["alternates"] = {
    canonical,
    ...(pair ? { languages: pairLanguages(`${config.siteUrl}${pair.englishPath}`, canonical) } : {}),
  };
  return {
    title: page.seo.title,
    description: page.seo.description,
    alternates,
    robots: indexable ? undefined : { index: false, follow: pageId === "help" || filtered },
    openGraph: isIndexableJapanesePage(page)
      ? { title: page.seo.title, description: page.seo.description, url: canonical, locale: "ja_JP", images: [] }
      : undefined,
  };
}
