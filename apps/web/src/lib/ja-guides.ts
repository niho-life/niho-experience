import "server-only";
import type { Guide } from "@/content/guides";
import { listSitePublicExperiences, type SitePublicExperience } from "@/lib/experience/site-publications";
import { findJapaneseGuide, japaneseGuides } from "@/lib/guide-registry";

/** 読みもの (#154) for the Japanese site: the guides written in Japanese, and for one article the experiences it points to. */

export const loadJapaneseGuides = (): Promise<readonly Guide[]> => japaneseGuides();

export type JapaneseGuidePageData = { readonly guide: Guide; readonly experiences: readonly SitePublicExperience[] };

/** One article and the experiences it links to that are on sale with a Japanese manuscript (in the order the writer linked them). */
export async function loadJapaneseGuide(slug: string): Promise<JapaneseGuidePageData | null> {
  const guide = await findJapaneseGuide(slug);
  if (!guide) return null;
  let experiences: readonly SitePublicExperience[] = [];
  if (guide.relatedExperienceSlugs.length > 0) {
    try {
      const catalog = await listSitePublicExperiences("ja");
      const order = new Map(guide.relatedExperienceSlugs.map((experienceSlug, index) => [experienceSlug, index] as const));
      experiences = catalog.experiences
        .filter((item) => order.has(item.publication.slug) && item.saleTerms !== null)
        .sort((a, b) => (order.get(a.publication.slug) ?? 0) - (order.get(b.publication.slug) ?? 0));
    } catch { experiences = []; }
  }
  return { guide, experiences };
}

/** 2026年11月14日 */
export function formatJapaneseDate(value: string): string {
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" }).format(new Date(Date.UTC(y, m - 1, d)));
}
