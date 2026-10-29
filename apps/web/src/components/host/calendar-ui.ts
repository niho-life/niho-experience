import type { AvailabilityReason } from "@niho-experience/experience-domain";

export const TOKYO_TIME_ZONE = "Asia/Tokyo";
export const WEEKDAY_LABELS = ["月", "火", "水", "木", "金", "土", "日"] as const;

export function todayInTokyo(now = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: TOKYO_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function addDays(day: string, count: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + count * 86_400_000).toISOString().slice(0, 10);
}

export function weekStart(day: string): string {
  const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  return addDays(day, -((weekday + 6) % 7));
}

export function weekDays(day: string): readonly string[] {
  const start = weekStart(day);
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

export function weekLabel(day: string): string {
  const start = weekStart(day);
  const end = addDays(start, 6);
  const [startYear, startMonth, startDay] = start.split("-").map(Number);
  const [endYear, endMonth, endDay] = end.split("-").map(Number);
  if (startYear === endYear && startMonth === endMonth) return `${startYear}年${startMonth}月${startDay}–${endDay}日`;
  if (startYear === endYear) return `${startYear}年${startMonth}月${startDay}日–${endMonth}月${endDay}日`;
  return `${startYear}年${startMonth}月${startDay}日–${endYear}年${endMonth}月${endDay}日`;
}

export function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

export function addMonths(day: string, count: number): string {
  const value = new Date(`${monthStart(day)}T00:00:00.000Z`);
  value.setUTCMonth(value.getUTCMonth() + count);
  return value.toISOString().slice(0, 10);
}

export function dateInMonth(day: string, month: string): string {
  const yearMonth = monthStart(month).slice(0, 7);
  const lastDay = new Date(`${yearMonth}-01T00:00:00.000Z`);
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1);
  lastDay.setUTCDate(0);
  return `${yearMonth}-${String(Math.min(Number(day.slice(8, 10)), lastDay.getUTCDate())).padStart(2, "0")}`;
}

export function monthGrid(month: string): readonly string[] {
  const first = monthStart(month);
  const weekday = new Date(`${first}T00:00:00.000Z`).getUTCDay();
  const mondayOffset = (weekday + 6) % 7;
  const start = addDays(first, -mondayOffset);
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}

export function monthLabel(day: string): string {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "UTC", year: "numeric", month: "long" }).format(new Date(`${monthStart(day)}T00:00:00.000Z`));
}

export function dateLabel(day: string): string {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "UTC", month: "long", day: "numeric", weekday: "short" }).format(new Date(`${day}T00:00:00.000Z`));
}

export function timeLabel(instant: string): string {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: TOKYO_TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(instant));
}

export function busyIntervalLabelForDay(startUtc: string, endUtc: string, day: string): string | null {
  const interval = intervalForDay(startUtc, endUtc, day);
  if (interval === null) return null;
  if (interval.startMinutes === 0 && interval.endMinutes === 1440) return "終日";
  return `${minutesLabel(interval.startMinutes)}–${minutesLabel(interval.endMinutes)}`;
}

export interface DayInterval {
  readonly startMinutes: number;
  readonly endMinutes: number;
}

export function intervalForDay(startUtc: string, endUtc: string, day: string): DayInterval | null {
  const dayStart = Date.parse(`${day}T00:00:00+09:00`);
  const dayEnd = dayStart + 86_400_000;
  const start = Date.parse(startUtc);
  const end = Date.parse(endUtc);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= dayEnd || end <= dayStart) return null;
  const clippedStart = Math.max(start, dayStart);
  const clippedEnd = Math.min(end, dayEnd);
  return { startMinutes: Math.round((clippedStart - dayStart) / 60_000), endMinutes: Math.round((clippedEnd - dayStart) / 60_000) };
}

export function minutesLabel(minutes: number): string {
  if (minutes === 1440) return "24:00";
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function calendarTimeRange(intervals: readonly DayInterval[]): { readonly startMinutes: number; readonly endMinutes: number } {
  let startMinutes = 9 * 60;
  let endMinutes = 20 * 60;
  for (const interval of intervals) {
    startMinutes = Math.min(startMinutes, Math.floor(interval.startMinutes / 60) * 60);
    endMinutes = Math.max(endMinutes, Math.ceil(interval.endMinutes / 60) * 60);
  }
  return { startMinutes: Math.max(0, startMinutes), endMinutes: Math.min(1440, Math.max(startMinutes + 60, endMinutes)) };
}

export interface OverlapInput extends DayInterval {
  readonly id: string;
}

export interface OverlapLayout {
  readonly column: number;
  readonly columns: number;
}

/** Assigns overlapping events to stable side-by-side columns within each collision group. */
export function overlapLayout(items: readonly OverlapInput[]): ReadonlyMap<string, OverlapLayout> {
  const sorted = [...items].sort((a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes || a.id.localeCompare(b.id));
  const result = new Map<string, OverlapLayout>();
  let group: { item: OverlapInput; column: number }[] = [];
  let groupEnd = -1;
  let columnEnds: number[] = [];
  const finish = () => {
    const columns = Math.max(1, columnEnds.length);
    for (const entry of group) result.set(entry.item.id, { column: entry.column, columns });
    group = [];
    groupEnd = -1;
    columnEnds = [];
  };
  for (const item of sorted) {
    if (group.length > 0 && item.startMinutes >= groupEnd) finish();
    const available = columnEnds.findIndex((end) => end <= item.startMinutes);
    const column = available === -1 ? columnEnds.length : available;
    columnEnds[column] = item.endMinutes;
    group.push({ item, column });
    groupEnd = Math.max(groupEnd, item.endMinutes);
  }
  finish();
  return result;
}

export function availabilityLabel(reason: AvailabilityReason): string {
  switch (reason) {
    case "AVAILABLE": return "受付中";
    case "MANUALLY_CLOSED": return "休止";
    case "BOOKING_CUTOFF_REACHED": return "締切";
    case "INSUFFICIENT_CAPACITY": return "満席";
    case "GROUP_RESERVED": return "予約あり";
    case "RESOURCE_INACTIVE": return "休止";
    case "RESOURCE_BUSY": return "予定あり";
    case "RESOURCE_GOOGLE_BUSY": return "予定あり";
    case "RESOURCE_GOOGLE_UNAVAILABLE": return "確認待ち";
    case "GOOGLE_BUSY": return "予定あり";
    case "EXTERNAL_RESERVATION_UNRESOLVED": return "要確認";
    case "GOOGLE_SYNC_UNAVAILABLE": return "確認待ち";
  }
}

export function keyboardDate(day: string, key: string): string | null {
  if (key === "ArrowLeft") return addDays(day, -1);
  if (key === "ArrowRight") return addDays(day, 1);
  if (key === "ArrowUp") return addDays(day, -7);
  if (key === "ArrowDown") return addDays(day, 7);
  return null;
}
