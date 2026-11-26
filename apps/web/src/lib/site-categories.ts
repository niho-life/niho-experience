import "server-only";
import { cache } from "react";
import { listExperiencesForSite } from "./api";
import { resolveCategories } from "./experience-categories";
import { loadCategoryBySlug } from "./experience-categories-server";
import { englishListCatalog, japaneseListPublication } from "./experience-list-catalog";
import { listSitePublicExperiences } from "./experience/site-publications";
import type { SiteLocale } from "./localized-content";

/** Surrounding navigation uses the unfiltered list. A requested category never forces an empty link to appear. */
export const loadSiteCategories = cache(async (locale: SiteLocale) => {
  const bySlug = await loadCategoryBySlug();
  if (!bySlug?.size) return [];
  try {
    const catalog = await listSitePublicExperiences(locale);
    if (locale === "ja") {
      const slugs = catalog.experiences.filter(japaneseListPublication).map(({ publication }) => publication.slug);
      return resolveCategories(slugs, bySlug, null).available;
    }
    const result = await listExperiencesForSite("kamakura");
    const { slugs } = englishListCatalog(result.ok ? result.data.experiences : [], catalog);
    return resolveCategories(slugs, bySlug, null).available;
  } catch {
    return [];
  }
});
