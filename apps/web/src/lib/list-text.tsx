import type { ExperienceCategoryId } from "@niho-experience/experience-domain";
import { categoryLabel, type SiteLocale } from "./experience-categories";

/**
 * The list's words and the one intended difference between the English and the Japanese list (#658, owner decision
 * 2026-11-25: one component for both languages; #698: the eyebrow and the intro sentence are gone). The h1 is small: 「すべての体験」 /
 * "All experiences", or the chosen category's name. Everything the shared `ExperiencesPageView` does not read from the interface
 * copy is here.
 */
const TEXT = {
  en: { heading: "All experiences", note: "Prices in yen, tax included · Times in Japan time" },
  // Japanese readers are told the yen and Japan time in the cards and the booking steps; the list keeps only the count.
  ja: { heading: "すべての体験", note: null },
} as const;

export function listHeading(locale: SiteLocale, category: ExperienceCategoryId | null): string {
  return category ? categoryLabel(category, locale) : TEXT[locale].heading;
}

/**
 * A small note beside the count. The one intended en/ja difference of the list (#698): English readers are told once that prices
 * are in yen with tax and times are Japan time; the Japanese page says only the count.
 */
export function listNote(locale: SiteLocale): string | null {
  return TEXT[locale].note;
}

/** Search over the Japanese card's own text: the title, the lead and who it is with. Every word must match. */
export function filterCardsByText<T extends { readonly title: string; readonly lead: string; readonly withLabel: string }>(cards: readonly T[], query: string): T[] {
  const terms = query.toLocaleLowerCase("ja").split(" ").filter(Boolean);
  if (!terms.length) return [...cards];
  return cards.filter((card) => {
    const text = `${card.title} ${card.lead} ${card.withLabel}`.toLocaleLowerCase("ja");
    return terms.every((term) => text.includes(term));
  });
}
