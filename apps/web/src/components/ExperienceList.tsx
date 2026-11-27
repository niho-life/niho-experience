"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { Occurrence } from "@niho-experience/api-client";
import type { BookingSources } from "@/lib/booking-source";
import type { BrowseContext } from "@/lib/browse-context";
import type { CardModel } from "@/lib/card-model";
import { dayOption, fitsPartySize, matchingOccurrence } from "@/lib/date-filter";
import { formatTime, pluralize } from "@/lib/format";
import { chosenDayLabel } from "@/lib/search-text";
import { useCardAvailability } from "@/lib/use-card-availability";
import { ExperienceCard } from "./ExperienceCard";
import { ExperienceSearchBar, type SearchThemeFilter } from "./ExperienceSearchBar";
import { HandIcon } from "./HandIcon";
import { buttonClass } from "./ui";
import { useSiteCopy, useSiteLocale } from "./SiteLocale";

/**
 * The list under its search bar (#698). Cards are server-rendered for every experience; the browser reads each experience's
 * availability once and then shows only those with a bookable session that fits the chosen day and group. The bar, the
 * category tabs and the heading row with the count are drawn here because they share this state. If availability cannot be
 * read, the date filter fails open: every experience stays and the calendar lets every day be chosen.
 */
export function ExperienceList({
  cards,
  initialDate,
  initialGuests,
  initialQuery,
  category,
  heading,
  note,
  themeFilter,
  tabs,
  windowStart,
  windowEnd,
  browseContext,
  catalogDateFiltered,
  preview,
  bookingSources,
  empty,
  columns = "three",
}: {
  cards: CardModel[];
  initialDate: string | null;
  initialGuests: number | null;
  /** The search word in the address, shown in the bar. */
  initialQuery: string;
  /** The chosen category: the bar keeps it when the keyword is submitted. */
  category: string | null;
  /** The h1: 「すべての体験」 / "All experiences", or the chosen category's name. */
  heading: string;
  /** A small note beside the count (English only, `lib/list-text.tsx`). */
  note: string | null;
  /** The mock API's theme select, beside the bar. */
  themeFilter?: SearchThemeFilter;
  /** The category tabs, drawn under the bar. */
  tabs: ReactNode;
  /** The days the bar's calendar offers (JST). */
  windowStart: string;
  windowEnd: string;
  browseContext?: Partial<BrowseContext>;
  catalogDateFiltered: boolean;
  preview: boolean;
  /** Where each card's availability is read: NIHO's API, or this site's for an experience sold here (#285). */
  bookingSources: BookingSources;
  columns?: "two" | "three";
  /** Shown instead of the list when the server returned no experiences (search or empty catalog). */
  empty: ReactNode;
}) {
  const router = useRouter();
  const copy = useSiteCopy();
  const { locale } = useSiteLocale();
  const [date, setDate] = useState<string | null>(initialDate);
  const [guests, setGuests] = useState<number | null>(initialGuests);
  // The address can change under us (the back button): follow it, but not the changes this list made itself.
  const [seen, setSeen] = useState({ initialDate, initialGuests });
  if (seen.initialDate !== initialDate || seen.initialGuests !== initialGuests) {
    setSeen({ initialDate, initialGuests });
    setDate(initialDate);
    setGuests(initialGuests);
  }
  const { availability, retry } = useCardAvailability(cards, preview, bookingSources);

  const ready = availability.state === "ready" ? availability.bySlug : null;
  const failed = availability.state === "failed";

  // The English API's own date filter already narrowed the cards to the day: nothing to mark in the calendar.
  const markable = catalogDateFiltered ? null : ready;

  const matches = useMemo(() => {
    if (!ready || !date) return null;
    const found = new Map<string, Occurrence>();
    for (const card of cards) {
      const occurrence = matchingOccurrence(ready.get(card.slug) ?? [], card.offers, date, guests);
      if (occurrence) found.set(card.slug, occurrence);
    }
    return found;
  }, [ready, date, guests, cards]);

  const visible = cards.filter((card) => fitsPartySize(card.offers, guests) && (failed || !matches || matches.has(card.slug)));
  const chosenLabel = date ? chosenDayLabel(date, locale) : null;

  function syncUrl(nextDate: string | null, nextGuests: number | null) {
    const params = new URLSearchParams(window.location.search);
    if (nextDate) params.set("date", nextDate);
    else params.delete("date");
    if (nextGuests !== null) params.set("guests", String(nextGuests));
    else params.delete("guests");
    const query = params.toString();
    router.push(query ? `${window.location.pathname}?${query}` : window.location.pathname, { scroll: false });
  }
  function chooseDate(next: string | null) {
    setDate(next);
    syncUrl(next, guests);
  }
  function chooseGuests(next: number | null) {
    setGuests(next);
    syncUrl(date, next);
  }
  function clearFilters() {
    setDate(null);
    setGuests(null);
    syncUrl(null, null);
  }

  const bar = (
    <div className="sticky top-16 z-20 mt-[22px] border-b border-line bg-white/95 py-3 backdrop-blur">
      <div className="container-page">
        <ExperienceSearchBar
          locale={locale}
          mode="filter"
          initialQuery={initialQuery}
          category={category}
          date={date}
          guests={guests}
          onDateChange={chooseDate}
          onGuestsChange={chooseGuests}
          onClearFilters={clearFilters}
          windowStart={windowStart}
          windowEnd={windowEnd}
          cards={cards}
          availability={markable}
          resultCount={visible.length}
          themeFilter={themeFilter}
        />
      </div>
    </div>
  );

  const party = guests === null ? "" : locale === "ja" ? `（${guests}名）` : ` for ${guests} guest${guests === 1 ? "" : "s"}`;
  let status: ReactNode = null;
  if (cards.length) {
    const count = <b className="font-extrabold text-ink">{locale === "ja" ? `${visible.length}件` : pluralize(visible.length, "experience")}</b>;
    if (chosenLabel && !failed && !ready) status = locale === "ja" ? `${chosenLabel}の開催を確認しています…` : `Checking which experiences run on ${chosenLabel}…`;
    else if (chosenLabel && !failed) status = locale === "ja" ? <>{chosenLabel}：{count}{party}</> : <>{count} on {chosenLabel}{party}</>;
    else status = <>{count}{party}</>;
  }

  const headingRow = (
    <div className="container-page flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 pt-[22px]">
      <h1 className="text-[1.25rem] leading-snug sm:text-[1.5rem]">{heading}</h1>
      <p className="text-[0.9375rem] text-ink-soft">
        <span role="status">{status}</span>
        {note && cards.length ? <small className="ml-1.5 text-[0.8125rem] text-muted">· {note}</small> : null}
      </p>
    </div>
  );

  if (!cards.length)
    return (
      <div>
        {bar}
        {tabs}
        {headingRow}
        <div className="container-page mt-4">{empty}</div>
      </div>
    );

  return (
    <div>
      {bar}
      {tabs}
      {headingRow}
      {failed ? (
        <div className="container-page mt-4">
          <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-sand p-4 text-ink-soft">
            <HandIcon name="cal" className="size-6 text-moss" />
            {/* A width to wrap at: on a phone the button drops below instead of squeezing the sentence into a few characters a line. */}
            <p role="status" className="min-w-[14rem] flex-1">{locale === "en" ? "Dates couldn't be checked. Showing experiences for your group." : copy.text("catalogue.availabilityWarning")}</p>
            <button type="button" className={buttonClass("secondary")} onClick={retry}>{locale === "en" ? "Retry dates" : copy.text("common.tryAgain")}</button>
          </div>
        </div>
      ) : null}

      <section className="container-page pt-5" aria-label={copy.text("chrome.experiences")}>
        {visible.length ? (
          <>
          {/* The page's h1 is followed by the cards' h3: this keeps h1 → h2 → h3 (#139). */}
          <h2 className="sr-only">{copy.text("chrome.experiences")}</h2>
          <ul className={`grid gap-x-6 gap-y-10 sm:grid-cols-2 sm:gap-y-11 ${columns === "two" ? "lg:grid-cols-2" : "lg:grid-cols-3"}`}>
            {visible.map((card, index) => {
              const occurrence = matches?.get(card.slug);
              return (
                <li key={card.slug}>
                  <ExperienceCard
                    card={card}
                    browseContext={{ ...browseContext, date: date ?? undefined, guests: guests ?? undefined }}
                    offerId={occurrence?.offerId}
                    priority={index < 2}
                    highlight={occurrence ? `${dayOption(occurrence.date, locale).label} · ${formatTime(occurrence.startAt, locale)}` : null}
                  />
                </li>
              );
            })}
          </ul>
          </>
        ) : (
          <div className="rounded-[var(--radius-card)] border border-dashed border-line-strong bg-sand px-6 py-12 text-center">
            <h2 className="text-2xl">{chosenLabel ? (locale === "ja" ? `${chosenLabel}${party}に開催する体験はありません` : `Nothing on ${chosenLabel}${party}`) : (locale === "ja" ? `${guests}名で参加できる体験はありません` : `No experiences for ${guests} guests`)}</h2>
            <p className="mx-auto mt-3 max-w-md text-ink-soft">{copy.text(chosenLabel ? "catalogue.noDayMatch" : "catalogue.noGroupMatch")}</p>
            <div className="mt-6 flex justify-center">
              {chosenLabel ? (
                <button type="button" className={buttonClass("primary")} onClick={() => chooseDate(null)}>
                  {copy.text("catalogue.showAnyDay")}
                </button>
              ) : (
                <button type="button" className={buttonClass("primary")} onClick={() => chooseGuests(null)}>
                  {copy.text("catalogue.showAll")}
                </button>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
