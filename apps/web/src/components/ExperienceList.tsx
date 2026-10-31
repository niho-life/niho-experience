"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { Occurrence } from "@niho-experience/api-client";
import { readBookingAvailability } from "@/lib/browser-availability";
import { bookingSourceFor, type BookingSources } from "@/lib/booking-source";
import type { BrowseContext } from "@/lib/browse-context";
import type { CardModel } from "@/lib/card-model";
import { dayOption, fitsPartySize, matchingOccurrence, MAX_GUESTS, type DayOption } from "@/lib/date-filter";
import { formatTime, pluralize } from "@/lib/format";
import { ExperienceCard } from "./ExperienceCard";
import { HandIcon } from "./HandIcon";
import { buttonClass } from "./ui";
import { useSiteCopy, useSiteLocale } from "./SiteLocale";

type Availability = { state: "loading" } | { state: "failed" } | { state: "ready"; bySlug: Map<string, Occurrence[]> };

/**
 * The list with date chips and a party-size filter. Cards are server-rendered for
 * every experience; the browser reads each experience's availability once and then
 * shows only those with a bookable session that fits the chosen day and group.
 * If availability cannot be read, the date filter fails open.
 */
export function ExperienceList({
  cards,
  days,
  initialDate,
  initialGuests,
  browseContext,
  catalogDateFiltered,
  preview,
  bookingSources,
  empty,
  search,
  inlineSearch,
  columns = "three",
}: {
  cards: CardModel[];
  days: DayOption[];
  initialDate: string | null;
  initialGuests: number | null;
  browseContext?: Partial<BrowseContext>;
  catalogDateFiltered: boolean;
  preview: boolean;
  /** Where each card's availability is read: NIHO's API, or this site's for an experience sold here (#285). */
  bookingSources: BookingSources;
  columns?: "two" | "three";
  /** Shown instead of the list when the server returned no experiences (search or empty catalog). */
  empty: ReactNode;
  /** The round search button at the end of the date chips (ExperienceFiltersForm, placement "bar"). */
  search: ReactNode;
  /** The same search on its own line, for when the chips are not shown (no results, dates unreadable). */
  inlineSearch: ReactNode;
}) {
  const router = useRouter();
  const copy = useSiteCopy();
  const { locale, releaseId } = useSiteLocale();
  const [date, setDate] = useState<string | null>(initialDate);
  const [guests, setGuests] = useState<number | null>(initialGuests);
  const [availability, setAvailability] = useState<Availability>({ state: "loading" });
  const [readAttempt, setReadAttempt] = useState(0);
  const chips = useRef<HTMLDivElement>(null);

  // A date arriving in the URL (e.g. from the home finder) may be off-screen on a phone.
  useEffect(() => {
    const row = chips.current;
    const chip = row?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (row && chip && initialDate) row.scrollLeft = chip.offsetLeft - row.clientWidth / 2 + chip.offsetWidth / 2;
  }, [initialDate]);

  useEffect(() => {
    if (!cards.length) return;
    let active = true;
    Promise.all(cards.map((card) => readBookingAvailability(card.slug, preview, bookingSourceFor(bookingSources, card.slug), locale, releaseId))).then((reads) => {
      if (!active) return;
      if (reads.some((read) => !read.ok)) {
        setAvailability({ state: "failed" });
        return;
      }
      const bySlug = new Map<string, Occurrence[]>();
      reads.forEach((read, index) => {
        if (read.ok) bySlug.set(cards[index]!.slug, read.occurrences);
      });
      setAvailability({ state: "ready", bySlug });
    });
    return () => {
      active = false;
    };
  }, [cards, preview, bookingSources, readAttempt, locale, releaseId]);

  const ready = availability.state === "ready" ? availability.bySlug : null;
  const failed = availability.state === "failed";

  const matches = useMemo(() => {
    if (!ready || !date) return null;
    const found = new Map<string, Occurrence>();
    for (const card of cards) {
      const occurrence = matchingOccurrence(ready.get(card.slug) ?? [], card.offers, date, guests);
      if (occurrence) found.set(card.slug, occurrence);
    }
    return found;
  }, [ready, date, guests, cards]);

  const counts = useMemo(() => {
    if (!ready) return null;
    return new Map(days.map((day) => [day.key, cards.filter((card) => matchingOccurrence(ready.get(card.slug) ?? [], card.offers, day.key, guests)).length]));
  }, [ready, days, cards, guests]);

  if (!cards.length)
    return (
      <div className="container-page mt-6 space-y-6">
        {inlineSearch}
        {empty}
      </div>
    );

  const visible = cards.filter((card) => fitsPartySize(card.offers, guests) && (failed || !matches || matches.has(card.slug)));
  const chosenDay = date ? (days.find((day) => day.key === date) ?? dayOption(date, locale)) : null;

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

  const party = guests === null ? "" : locale === "ja" ? `（${guests}名）` : ` for ${guests} guest${guests === 1 ? "" : "s"}`;
  let status: ReactNode;
  const count = <b className="font-extrabold text-ink">{locale === "ja" ? `${visible.length}件の体験` : pluralize(visible.length, "experience")}</b>;
  if (chosenDay && !failed && !ready) status = locale === "ja" ? `${chosenDay.label}の開催を確認しています…` : `Checking which experiences run on ${chosenDay.label}…`;
  else if (chosenDay && !failed) status = locale === "ja" ? <>{chosenDay.label}：{count}{party}</> : <>{count} on {chosenDay.label}{party}</>;
  else status = <>{count}{party} · {copy.text("catalogue.priceTimeNote")}</>;

  return (
    <div>
      {failed ? (
        <div className="container-page mt-6 space-y-4">
          <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-sand p-4 text-ink-soft">
            <HandIcon name="cal" className="size-6 text-moss" />
            <p role="status" className="min-w-0 flex-1">{locale === "en" ? "Dates couldn't be checked. Showing experiences for your group." : copy.text("catalogue.availabilityWarning")}</p>
            <button type="button" className={buttonClass("secondary")} onClick={() => {
              setAvailability({ state: "loading" });
              setReadAttempt((attempt) => attempt + 1);
            }}>{locale === "en" ? "Retry dates" : copy.text("common.tryAgain")}</button>
          </div>
          {inlineSearch}
        </div>
      ) : (
        <div className="sticky top-16 z-20 mt-[22px] border-y border-line bg-white/95 backdrop-blur">
          {/* Phones: guests above the chips. Desktop: one row, guests pill centred on the 68px chips, then a divider. Phone-only values are max-lg: because package-scoped base classes would beat lg: ones. */}
          <div className="container-page flex py-3 max-lg:flex-col max-lg:gap-2.5 lg:gap-4">
            <label className="relative flex shrink-0 items-center gap-2 self-start rounded-full border border-line-strong bg-white text-sm font-extrabold max-lg:py-1.5 max-lg:pr-3 max-lg:pl-2.5 lg:mt-[11px] lg:h-[46px] lg:pr-4 lg:pl-3">
              <HandIcon name="people" className="size-[22px]" />
              <span className="sr-only">{copy.text("home.guests")}</span>
              <select
                value={guests ?? ""}
                onChange={(event) => chooseGuests(event.target.value ? Number(event.target.value) : null)}
                className="cursor-pointer appearance-none bg-transparent px-1"
              >
                <option value="">{copy.text("catalogue.anyGroup")}</option>
                {Array.from({ length: MAX_GUESTS }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {locale === "ja" ? `${n}名` : pluralize(n, "guest")}
                  </option>
                ))}
              </select>
            </label>
            <div className="relative lg:min-w-0 lg:flex-1 lg:border-l lg:border-line lg:pl-4">
              <div ref={chips} role="group" aria-label={copy.text("catalogue.date")} className="scrollbar-none relative flex min-w-0 gap-2 overflow-x-auto pr-[60px]">
                <button
                  type="button"
                  aria-pressed={date === null}
                  onClick={() => chooseDate(null)}
                  className={`flex h-[68px] shrink-0 items-center rounded-2xl border px-4 text-sm font-extrabold ${date === null ? "border-ink bg-ink text-white" : "border-line-strong bg-white"}`}
                >
                  {copy.text("home.anyDay")}
                </button>
                {days.map((day) => {
                  const selected = date === day.key;
                  const count = catalogDateFiltered && !selected ? undefined : counts?.get(day.key);
                  const disabled = !catalogDateFiltered && count === 0 && !selected;
                  return (
                    <button
                      key={day.key}
                      type="button"
                      aria-pressed={selected}
                      disabled={disabled}
                      aria-label={`${day.label}${count === undefined ? "" : `, ${count ? (locale === "ja" ? `${count}件` : pluralize(count, "experience")) : (locale === "ja" ? "開催なし" : "nothing on this day")}`}`}
                      onClick={() => chooseDate(day.key)}
                      className={`flex h-[68px] w-14 shrink-0 flex-col items-center justify-center rounded-2xl border leading-[1.15] disabled:cursor-not-allowed disabled:opacity-40 ${selected ? "border-ink bg-ink text-white" : "border-line-strong bg-white"}`}
                    >
                      <small className={`text-xs font-extrabold ${selected ? "text-white/85" : "text-muted"}`}>{day.weekday}</small>
                      <b className="text-[1.1875rem] font-extrabold">{day.day}</b>
                      <i className={`text-[0.6875rem] font-extrabold not-italic ${selected ? "text-white/85" : "text-moss"}`} aria-hidden>
                        {count === undefined ? "·" : count || "—"}
                      </i>
                    </button>
                  );
                })}
              </div>
              {search}
            </div>
          </div>
        </div>
      )}

      <section className="container-page" aria-label={copy.text("chrome.experiences")}>
        <p role="status" className="py-[22px] text-[0.9375rem] text-ink-soft">
          {status}
        </p>
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
                    variant="list"
                    priority={index < 2}
                    dates={{ kind: "given", occurrences: ready ? (ready.get(card.slug) ?? []) : null }}
                    highlight={occurrence ? `${dayOption(occurrence.date, locale).label} · ${formatTime(occurrence.startAt, locale)}` : null}
                  />
                </li>
              );
            })}
          </ul>
          </>
        ) : (
          <div className="rounded-[var(--radius-card)] border border-dashed border-line-strong bg-sand px-6 py-12 text-center">
            <h2 className="text-2xl">{chosenDay ? (locale === "ja" ? `${chosenDay.label}${party}に開催する体験はありません` : `Nothing on ${chosenDay.label}${party}`) : (locale === "ja" ? `${guests}名で参加できる体験はありません` : `No experiences for ${guests} guests`)}</h2>
            <p className="mx-auto mt-3 max-w-md text-ink-soft">{copy.text(chosenDay ? "catalogue.noDayMatch" : "catalogue.noGroupMatch")}</p>
            <div className="mt-6 flex justify-center">
              {chosenDay ? (
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
