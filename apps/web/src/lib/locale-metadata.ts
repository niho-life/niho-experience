import "server-only";
import type { Metadata } from "next";
import type { PageId } from "./page-document-contract";
import { config } from "./config";
import { assertSameJapaneseRelease, getJapaneseDetail, getPreparedJapaneseStaticRelease } from "./localized-content";

export async function englishAlternates(sourcePath: string, indexable = true): Promise<Metadata["alternates"]> {
  const canonical = `${config.siteUrl}${sourcePath === "/" ? "/" : sourcePath}`;
  if (!indexable) return { canonical };
  try {
    const release = await getPreparedJapaneseStaticRelease();
    const page = release.pages.find((candidate) => candidate.route.sourcePath === sourcePath);
    if (!page?.route.indexable || !page.seo.indexable) return { canonical, languages: { en: canonical, "x-default": canonical } };
    return { canonical, languages: { en: canonical, ja: `${config.siteUrl}${page.route.path}`, "x-default": canonical } };
  } catch { return { canonical, languages: { en: canonical, "x-default": canonical } }; }
}

/**
 * hreflang for an English experience page: itself and `x-default`, plus `ja` only when the Japanese page
 * would really render — the static release the /ja layout needs and this slug's detail, from one release.
 * Otherwise /ja shows "unavailable", and hreflang must not point there.
 */
export async function experienceAlternates(slug: string, canonical: string): Promise<Metadata["alternates"]> {
  try {
    const [release, detail] = await Promise.all([getPreparedJapaneseStaticRelease(), getJapaneseDetail(slug)]);
    assertSameJapaneseRelease(release.releaseId, detail);
    return { canonical, languages: { en: canonical, ja: `${config.siteUrl}/ja/experiences/${slug}`, "x-default": canonical } };
  } catch { return { canonical, languages: { en: canonical, "x-default": canonical } }; }
}

export async function japaneseStaticMetadata(pageId: Extract<PageId, "home" | "experiences" | "host" | "help">, filtered = false): Promise<Metadata> {
  const release = await getPreparedJapaneseStaticRelease();
  const page = release.pageById[pageId];
  const canonical = `${config.siteUrl}${page.route.path}`;
  const english = `${config.siteUrl}${page.route.sourcePath}`;
  const indexable = page.route.indexable && page.seo.indexable && config.indexingAllowed && !filtered;
  const alternates: Metadata["alternates"] = {
    canonical,
    ...(page.route.indexable && page.seo.indexable ? { languages: { en: english, ja: canonical, "x-default": english } } : {}),
  };
  return {
    title: page.seo.title,
    description: page.seo.description,
    alternates,
    robots: indexable ? undefined : { index: false, follow: pageId === "help" || filtered },
    openGraph: page.route.indexable && page.seo.indexable
      ? { title: page.seo.title, description: page.seo.description, url: canonical, locale: "ja_JP", images: [] }
      : undefined,
  };
}
