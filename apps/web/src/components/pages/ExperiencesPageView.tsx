import type { ReactNode } from "react";
import type { ExperienceCategoryId } from "@niho-experience/experience-domain";
import { CatalogueViewV1, type StaticCopyAccessorV1 } from "@niho/experience-presentation/v1";
import { BookingAssurance } from "@/components/BookingAssurance";
import { CategoryChips } from "@/components/CategoryChips";
import { ExperienceFiltersForm } from "@/components/ExperienceFiltersForm";
import { ExperienceList } from "@/components/ExperienceList";
import { EmptyResults } from "@/components/States";
import type { BookingSources } from "@/lib/booking-source";
import type { CardModel } from "@/lib/card-model";
import type { DayOption } from "@/lib/date-filter";
import { listHeading } from "@/lib/list-text";

/**
 * The experience list, one component for both languages (#658): the English shape is the base; the words and the intended
 * differences come from `lib/list-text.tsx` and the nodes the page passes. Top to bottom: heading and description, the category
 * row (only when some category has an experience), the list with its date chips and search, how booking works, the reading
 * section (when there is one) and the consultation notice (Japanese only, when the inquiry is open).
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
  /** The English mock's theme filter; the live lists have none. */
  theme?: Parameters<typeof ExperienceFiltersForm>[0]["theme"];
  themesEnabled?: boolean;
  catalogDateFiltered?: boolean;
  preview?: boolean;
  bookingSources: BookingSources;
  /** Shown instead of the cards when there are none; the plain "no results" by default. */
  empty?: ReactNode;
  readings?: ReactNode;
  consult?: ReactNode;
}) {
  const { heading, intro } = listHeading(locale, category);
  const filtersActive = Boolean(searchQuery || theme || initialDate || initialGuests !== null || category);
  const searchProps = { searchQuery, theme, date: initialDate ?? undefined, guests: initialGuests, category, filtersEnabled: themesEnabled, filtersActive };
  return <>
    <CatalogueViewV1 copy={copy} heading={heading} intro={intro} content={<>
      <CategoryChips locale={locale} categories={categories} selected={category} query={{ date: initialDate, guests: initialGuests, q: searchQuery }} />
      <ExperienceList
        key={JSON.stringify([searchQuery, theme, initialDate, initialGuests, category])}
        cards={cards}
        days={days}
        initialDate={initialDate}
        initialGuests={initialGuests}
        browseContext={{ q: searchQuery || undefined, theme }}
        catalogDateFiltered={catalogDateFiltered}
        preview={preview}
        bookingSources={bookingSources}
        search={<ExperienceFiltersForm key="bar-search" {...searchProps} placement="bar" />}
        inlineSearch={<ExperienceFiltersForm key="inline-search" {...searchProps} placement="inline" />}
        columns="three"
        dayChips="available"
        empty={empty ?? <EmptyResults key="empty-results" clearHref={filtersActive ? (locale === "ja" ? "/ja/experiences" : "/experiences") : null} searchActive={Boolean(searchQuery)} />}
      />
    </>} />
    <BookingAssurance locale={locale} />
    {readings}
    {consult}
  </>;
}
