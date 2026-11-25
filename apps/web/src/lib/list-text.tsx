import type { ExperienceCategoryId } from "@niho-experience/experience-domain";
import { categoryLabel, categoryLeadJa, type SiteLocale } from "./experience-categories";

/**
 * The list's words and the few intended differences between the English and the Japanese list (#658, owner decision
 * 2026-11-25: one component for both languages; the English shape is the base). The heading and the description follow the
 * chosen category; everything the shared `ExperiencesPageView` does not read from the interface copy is here.
 */
const TEXT = {
  en: {
    heading: "Kamakura experiences with local hosts",
    intro: "Hosted by people who live here, one hour from Tokyo.",
  },
  ja: {
    heading: "すべての体験",
    intro: "鎌倉・逗子・葉山の人と活動に、会いにいく。料金は日本円、時刻は日本時間です。",
  },
} as const;

export function listHeading(locale: SiteLocale, category: ExperienceCategoryId | null): { heading: string; intro: string } {
  const base = TEXT[locale];
  if (!category) return { heading: base.heading, intro: base.intro };
  // English: the category's name as the heading, the same description. Japanese: its name and its own one-line description.
  return { heading: categoryLabel(category, locale), intro: locale === "ja" ? categoryLeadJa(category) : base.intro };
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
