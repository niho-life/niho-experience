import { EXPERIENCE_TIME_ZONE, type LocalDate, type LocalTime, type UtcInstant, type Weekday } from "#types";
import { assertLocalDate, assertLocalTime } from "#validation";

const TOKYO_OFFSET_MILLISECONDS = 9 * 60 * 60 * 1_000;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;
const WEEKDAYS: readonly Weekday[] = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
];

function localDateMilliseconds(localDate: LocalDate): number {
  assertLocalDate(localDate);
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, day);
}

export function tokyoLocalToUtc(localDate: LocalDate, localTime: LocalTime): UtcInstant {
  assertLocalDate(localDate, "localDate");
  assertLocalTime(localTime, "localTime");
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  const [hour, minute] = localTime.split(":").map(Number) as [number, number];
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - TOKYO_OFFSET_MILLISECONDS).toISOString();
}

export function addMinutes(instant: UtcInstant, minutes: number): UtcInstant {
  return new Date(Date.parse(instant) + minutes * 60_000).toISOString();
}

export function addLocalDays(localDate: LocalDate, days: number): LocalDate {
  return new Date(localDateMilliseconds(localDate) + days * DAY_MILLISECONDS).toISOString().slice(0, 10);
}

export function localDateDistance(fromDate: LocalDate, toDate: LocalDate): number {
  return Math.round((localDateMilliseconds(toDate) - localDateMilliseconds(fromDate)) / DAY_MILLISECONDS);
}

export function weekdayOf(localDate: LocalDate): Weekday {
  const weekday = WEEKDAYS[new Date(localDateMilliseconds(localDate)).getUTCDay()];
  if (weekday === undefined) throw new Error(`Unable to resolve weekday in ${EXPERIENCE_TIME_ZONE}`);
  return weekday;
}
