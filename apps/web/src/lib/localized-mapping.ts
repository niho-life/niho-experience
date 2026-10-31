import type { SelectedExperienceDetailResponse } from "@niho-experience/api-client";
import { japaneseBookingAllowed } from "./localized-release";

/**
 * Which English page has which Japanese page (#59). The language switch, the sitemap and hreflang all read
 * these functions, so a pair shows up in all three or in none.
 *
 * Experiences (owner decision 2026-10-31): English slug S pairs with /ja/experiences/S when S is in the
 * Japanese catalog of the release the copy and static pages come from. A detail read for S must be from that
 * release too. Without that release nothing pairs. When NIHO's contract names the source slug, use it instead.
 */

/** The public contract's slug: lowercase letters, digits, single hyphens. Anything else is not paired. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * English static pages that are indexed, in sitemap order. `/help` is noindex (docs/seo.md), so it gets no pair. `/privacy`
 * (the traveler privacy notice, #285) is indexed and English only: it has no Japanese page, so it never pairs.
 */
export const INDEXED_ENGLISH_STATIC_PATHS = ["/", "/experiences", "/host", "/privacy"] as const;

export type LocalizedPair = Readonly<{ englishPath: string; japanesePath: string }>;
export type JapaneseExperienceLink = LocalizedPair & Readonly<{
  slug: string;
  /** Japanese booking is known to be open. The catalog does not say, so only a detail of the release sets it. */
  bookingReady: boolean;
}>;
export type JapaneseExperienceMapping = ReadonlyMap<string, JapaneseExperienceLink>;

type StaticPage = Readonly<{ route: Readonly<{ sourcePath: string; path: string; indexable: boolean }>; seo: Readonly<{ indexable: boolean }> }>;
type CatalogInput = Readonly<{ releaseId: string; experiences: readonly Readonly<{ slug: string }>[] }>;
type DetailInput = Readonly<{ releaseId: string; experience: Readonly<{ slug: string }> }> & Pick<SelectedExperienceDetailResponse, "localization">;

/** A Japanese static page may be indexed only when its route and SEO projections both say so. */
export function isIndexableJapanesePage(page: StaticPage): boolean {
  return page.route.indexable && page.seo.indexable;
}

/** The hreflang pair of a static page: both the Japanese and the English page are indexed. */
export function staticPair(page: StaticPage): LocalizedPair | null {
  const englishIndexed = (INDEXED_ENGLISH_STATIC_PATHS as readonly string[]).includes(page.route.sourcePath);
  return englishIndexed && isIndexableJapanesePage(page) ? { englishPath: page.route.sourcePath, japanesePath: page.route.path } : null;
}

/**
 * Experience pairs of one release. `releaseId` is the release the copy and static pages already agree on.
 * Details only narrow the catalog: one from another release drops its slug, one that is ready opens booking.
 */
export function mapJapaneseExperiences(releaseId: string, catalog: CatalogInput | null, details: readonly DetailInput[] = []): JapaneseExperienceMapping {
  const links = new Map<string, JapaneseExperienceLink>();
  if (!catalog || catalog.releaseId !== releaseId) return links;
  for (const { slug } of catalog.experiences) {
    if (SLUG.test(slug)) links.set(slug, { slug, englishPath: `/experiences/${slug}`, japanesePath: `/ja/experiences/${slug}`, bookingReady: false });
  }
  for (const detail of details) {
    const link = links.get(detail.experience.slug);
    if (!link) continue;
    if (detail.releaseId !== releaseId) links.delete(link.slug);
    else links.set(link.slug, { ...link, bookingReady: japaneseBookingAllowed(detail) });
  }
  return links;
}

/** Language-switch rows: every paired detail, and its booking page only where Japanese booking is known open. */
export function experienceCounterparts(mapping: JapaneseExperienceMapping): Record<string, string> {
  const rows: Record<string, string> = {};
  for (const link of mapping.values()) {
    rows[link.englishPath] = link.japanesePath;
    if (link.bookingReady) rows[`${link.englishPath}/book`] = `${link.japanesePath}/book`;
  }
  return rows;
}

/** hreflang for one pair of absolute URLs. Page metadata and the sitemap both build it here. */
export function pairLanguages(english: string, japanese: string): { en: string; ja: string; "x-default": string } {
  return { en: english, ja: japanese, "x-default": english };
}
