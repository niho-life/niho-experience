import type { ExperienceOffer } from "@niho-experience/api-client";

/**
 * Display summaries of when an experience runs. Offer weekdays are a summary only
 * (contract: the real dates come from availability), so these never promise a date.
 */

const WEEKDAY_SHORT: readonly string[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Travelers read a week from Monday; Sunday goes last.
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

type ScheduleOffer = Pick<ExperienceOffer, "weekdays" | "startTime">;

/** "18:00" (JST local time) → "6:00 PM". */
export function formatClock(hhmm: string, locale: "en" | "ja" = "en"): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!match) return hhmm;
  const hours = Number(match[1]);
  const suffix = hours >= 12 ? "PM" : "AM";
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return locale === "ja" ? `${String(hours).padStart(2, "0")}:${match[2]}` : `${hour12}:${match[2]} ${suffix}`;
}

/** "18:00" + 120 minutes → "20:00" (same JST day or wrapping past midnight). */
export function addMinutesToClock(hhmm: string, minutes: number): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!match) return hhmm;
  const total = (Number(match[1]) * 60 + Number(match[2]) + minutes) % (24 * 60);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

function sortedWeekdays(offers: ScheduleOffer[]): number[] {
  const days = new Set(offers.flatMap((offer) => offer.weekdays));
  return WEEK_ORDER.filter((day) => days.has(day));
}

function sortedTimes(offers: ScheduleOffer[], locale: "en" | "ja"): string[] {
  return [...new Set(offers.map((offer) => offer.startTime))].sort().map((time) => formatClock(time, locale));
}

/** "Tue · Thu · Sat · 6:00 PM" for cards and compact rows. Null when nothing is scheduled. */
export function scheduleSummary(offers: ScheduleOffer[], locale: "en" | "ja" = "en"): string | null {
  const days = sortedWeekdays(offers);
  const times = sortedTimes(offers, locale);
  if (!days.length) return null;
  const dayPart = days.length === 7 ? (locale === "ja" ? "毎日" : "Every day") : days.map((day) => locale === "ja" ? `${["日", "月", "火", "水", "木", "金", "土"][day]}曜` : WEEKDAY_SHORT[day] ?? "").join(" · ");
  return times.length ? `${dayPart} · ${times.join(" / ")}` : dayPart;
}

/** "Tue, Thu & Sat · 6:00 PM" for the short hand-written line above a heading ("6 PM" with `compact`). */
export function scheduleLine(offers: ScheduleOffer[], { compact = false, locale = "en" }: { compact?: boolean; locale?: "en" | "ja" } = {}): string | null {
  const days = sortedWeekdays(offers);
  const times = sortedTimes(offers, locale).map((time) => (compact && locale === "en" ? time.replace(":00 ", " ") : time));
  if (!days.length) return null;
  const names = days.map((day) => locale === "ja" ? `${["日", "月", "火", "水", "木", "金", "土"][day]}曜` : WEEKDAY_SHORT[day] ?? "");
  const dayPart = days.length === 7 ? (locale === "ja" ? "毎日" : "Every day") : locale === "ja" ? names.join("・") : joinAnd(names);
  return times.length ? `${dayPart} · ${times.join(locale === "ja" ? "・" : " & ")}` : dayPart;
}

/** "A", "A & B", "A, B & C". */
export function joinAnd(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} & ${items[items.length - 1]}`;
}

/** "14:00": the time of an instant in Japan, written as offers write their start time. */
export function japanClock(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

/**
 * The start time and length of the chosen date: the occurrence's own once it is read, since a host may move
 * one occurrence away from its offer's usual time (#285); the offer's until then, or if the times are unusable.
 */
export function occurrenceTiming(
  offer: Pick<ExperienceOffer, "startTime" | "durationMinutes">,
  occurrence: { startAt: string; endAt: string } | null,
): { startTime: string; durationMinutes: number } {
  const usual = { startTime: offer.startTime, durationMinutes: offer.durationMinutes };
  if (!occurrence) return usual;
  const start = Date.parse(occurrence.startAt);
  const minutes = Math.round((Date.parse(occurrence.endAt) - start) / 60_000);
  if (!Number.isFinite(start) || !Number.isFinite(minutes) || minutes <= 0) return usual;
  return { startTime: japanClock(occurrence.startAt), durationMinutes: minutes };
}
