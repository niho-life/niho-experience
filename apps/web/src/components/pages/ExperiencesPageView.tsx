import type { ReactNode } from "react";
import type { ExperienceSiteTheme } from "@niho-experience/api-client";
import type { ExperienceCategoryId } from "@niho-experience/experience-domain";
import type { StaticCopyAccessorV1 } from "@niho/experience-presentation/v1";
import { BookingAssurance } from "@/components/BookingAssurance";
import { CategoryTabs } from "@/components/CategoryTabs";
import { ExperienceList } from "@/components/ExperienceList";
import { EmptyResults } from "@/components/States";
import type { BookingSources } from "@/lib/booking-source";
import type { CardModel } from "@/lib/card-model";
import type { DayOption } from "@/lib/date-filter";
import { EXPERIENCE_SITE_THEMES, EXPERIENCE_THEME_LABELS } from "@/lib/filters";
import { listHeading, listNote } from "@/lib/list-text";

/**
 * The experience list, one component for both languages (#658): the English shape is the base; the words and the intended
 * differences come from `lib/list-text.tsx` and the nodes the page passes (#698). Top to bottom: the search bar (sticky), the category
 * tabs (only when some category has an experience), the heading row (a small h1 and the count), the cards, how booking works, the
 * reading section (when there is one) and the consultation notice (Japanese only, when the inquiry is open).
 */
export function ExperiencesPageView({
  locale, copy, cards, days, initialDate, initialGuests, searchQuery, category, categories, theme, themesEnabled = false,
  catalogDateFiltered = false, preview = false, bookingSources, empty, readings, consult,
}: {
  locale: "en" | "ja";
  copy: StaticCopyAccessorV1;
  cards: CardModel[];
  days: DayOption[];
  initialDate: string | null;
  initialGuests: number | null;
  searchQuery: string;
  /** The chosen category (the list is already narrowed to it). */
  category: ExperienceCategoryId | null;
  /** The categories to offer: the ones that have an experience on this list, plus the chosen one. */
  categories: readonly ExperienceCategoryId[];
  /** The English mock's theme (the live lists have none): it only shapes the card links and the list's identity. */
  theme?: ExperienceSiteTheme;
  /** Offer the theme select beside the search bar (the mock API's 1.2 filter only). */
  themesEnabled?: boolean;
  catalogDateFiltered?: boolean;
  preview?: boolean;
  bookingSources: BookingSources;
  /** Shown instead of the cards when there are none; the plain "no results" by default. */
  empty?: ReactNode;
  readings?: ReactNode;
  consult?: ReactNode;
}) {
  const heading = listHeading(locale, category);
  const filtersActive = Boolean(searchQuery || theme || initialDate || initialGuests !== null || category);
  const windowStart = days[0]?.key ?? "";
  const windowEnd = days[days.length - 1]?.key ?? "";
  return <>
    <ExperienceList
      key={JSON.stringify([searchQuery, theme, category])}
      cards={cards}
      initialDate={initialDate}
      initialGuests={initialGuests}
      initialQuery={searchQuery}
      category={category}
      heading={heading}
      note={listNote(locale)}
      themeFilter={themesEnabled ? { label: copy.text("catalogue.theme"), any: copy.text("catalogue.anyTheme"), selected: theme ?? "", options: EXPERIENCE_SITE_THEMES.map((value) => ({ value, label: EXPERIENCE_THEME_LABELS[value] })) } : undefined}
      tabs={<CategoryTabs variant="list" locale={locale} categories={categories} selected={category} query={{ date: initialDate, guests: initialGuests, q: searchQuery }} />}
      windowStart={windowStart}
      windowEnd={windowEnd}
      browseContext={{ q: searchQuery || undefined, theme }}
      catalogDateFiltered={catalogDateFiltered}
      preview={preview}
      bookingSources={bookingSources}
      columns="three"
      empty={empty ?? <EmptyResults key="empty-results" clearHref={filtersActive ? (locale === "ja" ? "/ja/experiences" : "/experiences") : null} searchActive={Boolean(searchQuery)} />}
    />
    <BookingAssurance locale={locale} />
    {readings}
    {consult}
  </>;
}
