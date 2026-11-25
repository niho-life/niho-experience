import type { Occurrence } from "@niho-experience/api-client";

/*
 * The booking form's month calendar (#638, docs/embed.md「旅行者の流れ」). Pure: the occurrences of the chosen offer in, the
 * months, their week rows and each day's state out. A date is the Tokyo calendar day the availability read gives
 * (`YYYY-MM-DD`); every calculation is on that string and on UTC dates at noon, so the browser's time zone never moves a day.
 */

export type CalendarOccurrence = Pick<Occurrence, "date" | "bookable" | "seatsLeft" | "startAt">;
/** `bookable`: can be chosen. `unavailable`: there is an occurrence, but it cannot be booked. `none`: nothing that day. */
export type CalendarDayState = "bookable" | "unavailable" | "none";
export type CalendarDay<T extends CalendarOccurrence = CalendarOccurrence> = {
  readonly date: string;
  readonly day: number;
  readonly state: CalendarDayState;
  readonly occurrence: T | null;
};
/** A week row, Sunday first; the days before the 1st and after the last day are null. */
export type CalendarWeek<T extends CalendarOccurrence = CalendarOccurrence> = readonly (CalendarDay<T> | null)[];

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM` of a `YYYY-MM-DD` date, or null for anything else. */
export function monthOf(date: string): string | null {
  const match = DATE.exec(date);
  if (!match) return null;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(Number(match[1]), month)) return null;
  return `${match[1]}-${match[2]}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0, 12)).getUTCDate();
}

function nextMonth(key: string): string {
  const [year, month] = key.split("-").map(Number) as [number, number];
  return month === 12 ? `${String(year + 1).padStart(4, "0")}-01` : `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}`;
}

/** The months from the first occurrence's month to the last one's, in order. Empty without occurrences. */
export function calendarMonths(occurrences: readonly CalendarOccurrence[]): string[] {
  const keys = occurrences.map((occurrence) => monthOf(occurrence.date)).filter((key): key is string => key !== null).sort();
  if (keys.length === 0) return [];
  const last = keys[keys.length - 1]!;
  const months: string[] = [];
  for (let key = keys[0]!; key <= last; key = nextMonth(key)) months.push(key);
  return months;
}

/** The occurrence of a date: a bookable one if any, else the first. */
export function occurrenceOn<T extends CalendarOccurrence>(occurrences: readonly T[], date: string): T | null {
  const same = occurrences.filter((occurrence) => occurrence.date === date);
  return same.find((occurrence) => occurrence.bookable) ?? same[0] ?? null;
}

export function dayState(occurrences: readonly CalendarOccurrence[], date: string): CalendarDayState {
  const occurrence = occurrenceOn(occurrences, date);
  return occurrence === null ? "none" : occurrence.bookable ? "bookable" : "unavailable";
}

/** One month as week rows, Sunday first. */
export function monthWeeks<T extends CalendarOccurrence>(month: string, occurrences: readonly T[]): CalendarWeek<T>[] {
  if (monthOf(`${month}-01`) === null) return [];
  const [year, monthNumber] = month.split("-").map(Number) as [number, number];
  const leading = new Date(`${month}-01T12:00:00Z`).getUTCDay();
  const days = daysInMonth(year, monthNumber);
  const cells: (CalendarDay<T> | null)[] = Array.from({ length: leading }, () => null);
  for (let day = 1; day <= days; day += 1) {
    const date = `${month}-${String(day).padStart(2, "0")}`;
    const occurrence = occurrenceOn(occurrences, date);
    cells.push({ date, day, state: occurrence === null ? "none" : occurrence.bookable ? "bookable" : "unavailable", occurrence });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: CalendarWeek<T>[] = [];
  for (let start = 0; start < cells.length; start += 7) weeks.push(cells.slice(start, start + 7));
  return weeks;
}

/** The month to open first: the first bookable occurrence's, else the first month; null without occurrences. */
export function initialCalendarMonth(occurrences: readonly CalendarOccurrence[]): string | null {
  const bookable = occurrences.filter((occurrence) => occurrence.bookable).map((occurrence) => monthOf(occurrence.date)).filter((key): key is string => key !== null).sort();
  return bookable[0] ?? calendarMonths(occurrences)[0] ?? null;
}

/** The `Date` of a calendar day for formatting with `timeZone: "UTC"` (noon, so no time zone moves it). */
export function calendarDayDate(date: string): Date {
  return new Date(`${date}T12:00:00Z`);
}

/** "Sat 5 Dec" / "12月5日(土)": a calendar day, whatever the browser's time zone. */
export function calendarDayLabel(date: string, locale: "en" | "ja" = "en"): string {
  const day = calendarDayDate(date);
  const formatter = new Intl.DateTimeFormat(locale === "ja" ? "ja-JP" : "en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
  if (locale === "ja") return formatter.format(day);
  return formatter.formatToParts(day).filter((part) => part.type === "weekday" || part.type === "day" || part.type === "month").map((part) => part.value).join(" ");
}

/** "6:00 PM" / "18:00": the start time in Tokyo, as the date options always showed it. */
export function occurrenceStartTime(startAt: string, locale: "en" | "ja" = "en"): string {
  return new Intl.DateTimeFormat(locale === "ja" ? "ja-JP" : "en-US", { timeZone: "Asia/Tokyo", hour: "numeric", minute: "2-digit" }).format(new Date(startAt));
}

/** "6 places left" / "残り6席". */
export function placesLeftLabel(seats: number, locale: "en" | "ja" = "en"): string {
  return locale === "ja" ? `残り${seats}席` : `${seats} ${seats === 1 ? "place" : "places"} left`;
}
