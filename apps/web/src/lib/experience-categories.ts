import { EXPERIENCE_AREAS, EXPERIENCE_CATEGORIES, isExperienceCategoryId, type ExperienceAreaId, type ExperienceCategoryId } from "@niho-experience/experience-domain";

/*
 * 体験のカテゴリー（#658）：日英の一覧で同じ「カテゴリーの並び」を使う。id は分類（`packages/experience-domain`）が正本で、
 * 日本語の名前・ひとことはそこにある。英語の名前だけここ（apps/web）に持つ。
 */

export type SiteLocale = "en" | "ja";

const NAMES_EN: Readonly<Record<ExperienceCategoryId, string>> = {
  walk: "Walks",
  food: "Cook & eat",
  craft: "Make by hand",
  zen: "Zen & temples",
  time: "Dawn & dusk",
  sea: "By the sea",
  people: "Meet people",
  group: "Groups & teams",
};

const AREA_NAMES_EN: Readonly<Record<ExperienceAreaId, string>> = {
  kamakura: "Around Kamakura Station",
  kita: "Kita-Kamakura",
  hase: "Hase & Yuigahama",
  zai: "Zaimokuza",
  east: "Nikaido & Juniso",
  kosh: "Koshigoe",
  ofuna: "Ofuna & the hills",
  zushi: "Zushi",
  hayama: "Hayama",
};

export const ALL_CATEGORIES_LABEL: Readonly<Record<SiteLocale, string>> = { en: "All", ja: "すべて" };

export const CATEGORIES_NAV_LABEL: Readonly<Record<SiteLocale, string>> = { en: "Categories", ja: "カテゴリー" };

export function categoryLabel(id: ExperienceCategoryId, locale: SiteLocale): string {
  if (locale === "en") return NAMES_EN[id];
  return EXPERIENCE_CATEGORIES.find((item) => item.id === id)!.label;
}

/** The area's name (the Japanese one is the classification's own label). */
export function areaLabel(id: ExperienceAreaId, locale: SiteLocale): string {
  if (locale === "en") return AREA_NAMES_EN[id];
  return EXPERIENCE_AREAS.find((item) => item.id === id)!.label;
}

/** The category's hand-written word (the English one), shown above a detail page's title. */
export const categoryHand = (id: ExperienceCategoryId): string => EXPERIENCE_CATEGORIES.find((item) => item.id === id)!.hand;

/** The Japanese one-line description of a category (the English list keeps its own description). */
export const categoryLeadJa = (id: ExperienceCategoryId): string => EXPERIENCE_CATEGORIES.find((item) => item.id === id)!.lead;

/** The `category` query value, or null when it is absent or not one of the ids. */
export function parseCategoryParam(value: string | string[] | undefined): ExperienceCategoryId | null {
  return typeof value === "string" && isExperienceCategoryId(value) ? value : null;
}

/** The categories (in the list's fixed order) that have at least one experience on this list; the chosen one stays even when it has none. */
export function visibleCategories(counts: ReadonlySet<ExperienceCategoryId>, selected: ExperienceCategoryId | null): ExperienceCategoryId[] {
  return EXPERIENCE_CATEGORIES.map((item) => item.id).filter((id) => counts.has(id) || id === selected);
}

/**
 * What the list offers from the categories: the ones with an experience (read from `bySlug`, the slug → category of every
 * experience on this list), and the category the visitor chose. When the classification could not be read (`bySlug` null)
 * nothing is offered and nothing is filtered: the list still shows.
 */
export function resolveCategories(listedSlugs: readonly string[], bySlug: ReadonlyMap<string, ExperienceCategoryId> | null, requested: ExperienceCategoryId | null): { available: ExperienceCategoryId[]; selected: ExperienceCategoryId | null } {
  if (!bySlug) return { available: [], selected: null };
  const have = new Set<ExperienceCategoryId>();
  for (const slug of listedSlugs) {
    const id = bySlug.get(slug);
    if (id) have.add(id);
  }
  const available = visibleCategories(have, requested);
  return { available, selected: requested };
}

/** The cards in the chosen category (all of them when none is chosen or the classification is unavailable). */
export function filterByCategory<T extends { readonly slug: string }>(cards: readonly T[], bySlug: ReadonlyMap<string, ExperienceCategoryId> | null, selected: ExperienceCategoryId | null): T[] {
  if (!selected || !bySlug) return [...cards];
  return cards.filter((card) => bySlug.get(card.slug) === selected);
}
