import type { Occurrence } from "@niho-experience/api-client";
import type { CardOffer } from "./card-model";

/**
 * Date and party-size filtering for the experience list (and the home finder).
 * Dates are Japan dates (JST). The availability itself is read in the browser and
 * only used to decide what to show: seats left are never displayed.
 */

export type DayOption = {
  /** YYYY-MM-DD in JST. */
  key: string;
  weekday: string;
  day: string;
  /** "Sat 24 Oct". */
  label: string;
};

export const MAX_GUESTS = 8;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** Today's date in Japan as YYYY-MM-DD. */
export function jstToday(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function dayOption(key: string, locale: "en" | "ja" = "en"): DayOption {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  const weekday = locale === "ja" ? `${["日", "月", "火", "水", "木", "金", "土"][date.getUTCDay()]}曜` : WEEKDAY_SHORT[date.getUTCDay()]!;
  return { key, weekday, day: String(d), label: locale === "ja" ? `${m}月${d}日（${weekday}）` : `${weekday} ${d} ${MONTH_SHORT[m - 1]}` };
}

export function dayLabelWithoutWeekday(day: DayOption, locale: "en" | "ja" = "en"): string {
  return locale === "ja" ? day.label.replace(/（[^）]+）$/, "") : day.label.slice(day.weekday.length + 1);
}

/** `count` consecutive JST days from today. */
export function upcomingDays(now: Date, count: number, locale: "en" | "ja" = "en"): DayOption[] {
  const [y, m, d] = jstToday(now).split("-").map(Number) as [number, number, number];
  return Array.from({ length: count }, (_, offset) => {
    const date = new Date(Date.UTC(y, m - 1, d + offset));
    const pad = (value: number) => String(value).padStart(2, "0");
    return dayOption(`${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`, locale);
  });
}

/** A `date` query value is used only when it is one of the offered days. */
export function parseDateParam(value: string | string[] | undefined, allowed: readonly DayOption[]): string | null {
  if (typeof value !== "string" || !DATE_KEY.test(value)) return null;
  return allowed.some((day) => day.key === value) ? value : null;
}

/** `guests` query value: an explicitly selected group size from 1–8, otherwise no group filter. */
export function parseGuestsParam(value: string | string[] | undefined): number | null {
  if (typeof value !== "string" || !/^\d{1,2}$/.test(value)) return null;
  const guests = Number(value);
  return guests >= 1 && guests <= MAX_GUESTS ? guests : null;
}

/**
 * The first bookable session on `date` that fits the selected group. With no group
 * selected, a known option needs enough seats for its minimum party. Options unknown
 * to the card (its detail could not be read) are judged by seats alone.
 */
export function matchingOccurrence(occurrences: readonly Occurrence[], offers: readonly CardOffer[], date: string, guests: number | null): Occurrence | null {
  const byId = new Map(offers.map((offer) => [offer.id, offer]));
  return (
    occurrences.find((occurrence) => {
      if (occurrence.date !== date || !occurrence.bookable) return false;
      const offer = byId.get(occurrence.offerId);
      if (!offer) return offers.length === 0 && occurrence.seatsLeft >= (guests ?? 1);
      const minimum = guests ?? offer.minimumParticipants;
      return occurrence.seatsLeft >= minimum && offer.minimumParticipants <= minimum && offer.maxPartySize >= minimum;
    }) ?? null
  );
}

/** With no group selected, every experience is eligible. Unknown details fail open. */
export function fitsPartySize(offers: readonly CardOffer[], guests: number | null): boolean {
  return guests === null || offers.length === 0 || offers.some((offer) => offer.minimumParticipants <= guests && offer.maxPartySize >= guests);
}

/** Next bookable sessions (one per date and option), soonest first. */
export function nextBookable(occurrences: readonly Occurrence[], limit: number): Occurrence[] {
  return occurrences
    .filter((occurrence) => occurrence.bookable)
    .sort((a, b) => a.startAt.localeCompare(b.startAt))
    .slice(0, limit);
}

/** Earliest bookable occurrence on each distinct JST date, soonest first. */
export function nextBookableDays(occurrences: readonly Occurrence[], limit: number): Occurrence[] {
  const dates = new Set<string>();
  const selected: Occurrence[] = [];
  for (const occurrence of nextBookable(occurrences, Number.POSITIVE_INFINITY)) {
    if (dates.has(occurrence.date)) continue;
    dates.add(occurrence.date);
    selected.push(occurrence);
    if (selected.length === limit) break;
  }
  return selected;
}
