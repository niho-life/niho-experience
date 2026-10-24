import type { HostExperience } from "./types";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

function parts(date: string): { year: number; month: number; day: number } {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  return { year, month, day };
}

/** Weekday of a calendar date (YYYY-MM-DD). The date is already in JST, so no time zone math. */
export function weekdayJa(date: string): string {
  const { year, month, day } = parts(date);
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]!;
}

/** "10月22日（木）" */
export function dateWithWeekdayJa(date: string): string {
  const { month, day } = parts(date);
  return `${month}月${day}日（${weekdayJa(date)}）`;
}

/** "10/22（木）": the short form for one line (ホーム's requests, a thread's booking). */
export function shortDateWithWeekdayJa(date: string): string {
  const { month, day } = parts(date);
  return `${month}/${day}（${weekdayJa(date)}）`;
}

/** The calendar date `days` after `date` (YYYY-MM-DD). */
export function addDays(date: string, days: number): string {
  const { year, month, day } = parts(date);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** Minutes from `from` to `to` (both YYYY-MM-DDTHH:MM in Japan; negative when `to` is earlier). */
export function minutesBetween(from: string, to: string): number {
  const at = (moment: string) => {
    const [date = "", time = "00:00"] = moment.split("T");
    const { year, month, day } = parts(date);
    const [hours = 0, minutes = 0] = time.split(":").map(Number);
    return Date.UTC(year, month - 1, day, hours, minutes);
  };
  return Math.round((at(to) - at(from)) / 60_000);
}

/** How long ago `at` was, rounded down: "たった今", "40 分前", "2 時間前", "3 日前". */
export function agoJa(at: string, now: string): string {
  const minutes = minutesBetween(at, now);
  if (minutes < 1) return "たった今";
  if (minutes < 60) return `${minutes} 分前`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 時間前`;
  return `${Math.floor(minutes / (24 * 60))} 日前`;
}

/**
 * The time left before a deadline, rounded down so it never promises more: "あと 40 分",
 * "あと 6 時間" (up to two days: "あと 44 時間" says more than "あと 1 日"), then "あと 2 日".
 */
export function remainingJa(deadline: string, now: string): string {
  const minutes = minutesBetween(now, deadline);
  if (minutes <= 0) return "期限を過ぎています";
  if (minutes < 60) return `あと ${minutes} 分`;
  if (minutes < 48 * 60) return `あと ${Math.floor(minutes / 60)} 時間`;
  return `あと ${Math.floor(minutes / (24 * 60))} 日`;
}

/** "10月19日" */
export function monthDayJa(date: string): string {
  const { month, day } = parts(date);
  return `${month}月${day}日`;
}

/** "2026年10月12日" */
export function fullDateJa(date: string): string {
  const { year, month, day } = parts(date);
  return `${year}年${month}月${day}日`;
}

export function dayOfMonth(date: string): number {
  return parts(date).day;
}

/** Today's date in Japan (YYYY-MM-DD): bookings and sales are kept in JST. */
export function todayInJapan(now: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
}

/** "¥60,000" / "−¥60,000" (a real minus sign, as in the design). */
export function yen(amount: number): string {
  return `${amount < 0 ? "−" : ""}¥${Math.abs(amount).toLocaleString("ja-JP")}`;
}

/** 120 → "2時間", 90 → "1時間30分", 45 → "45分". */
export function durationJa(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest}分`;
  return rest ? `${hours}時間${rest}分` : `${hours}時間`;
}

/** "表紙写真と料金" / "A、B、C" */
export function listJa(items: readonly string[]): string {
  return items.length === 2 ? `${items[0]}と${items[1]}` : items.join("、");
}

/** The English not confirmed yet, among what a draft still needs (#110): it is not something to type in. */
const ENGLISH_UNCONFIRMED = "英語の確定";

/**
 * What a draft still needs, in one line: "表紙写真・料金が未入力", with "英語が未確定" after it for
 * a page written in Japanese whose English is not confirmed. `join` lists the inputs.
 */
export function missingLine(missing: readonly string[], join: (items: readonly string[]) => string): string {
  const inputs = missing.filter((item) => item !== ENGLISH_UNCONFIRMED);
  return [inputs.length ? `${join(inputs)}が未入力` : null, missing.includes(ENGLISH_UNCONFIRMED) ? "英語が未確定" : null].filter(Boolean).join(" · ");
}

/** The line under an experience title: "火・木・土 18:00 · 2時間 · 定員8 · ¥30,000〜", or what a draft still needs. */
export function experienceMeta(experience: Pick<HostExperience, "schedule" | "missing">): string {
  if (experience.missing.length > 0) return missingLine(experience.missing, (items) => items.join("・"));
  const schedule = experience.schedule;
  if (!schedule) return "日程と料金が未入力";
  return [`${schedule.weekdays.join("・")} ${schedule.start}`, durationJa(schedule.durationMinutes), `定員${schedule.capacity}`, `${yen(schedule.priceFromYen)}〜`].join(" · ");
}
