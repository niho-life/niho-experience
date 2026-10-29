import type { AvailabilityReason } from "@niho-experience/experience-domain";

export const TOKYO_TIME_ZONE = "Asia/Tokyo";
export const WEEKDAY_LABELS = ["月", "火", "水", "木", "金", "土", "日"] as const;

export function todayInTokyo(now = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: TOKYO_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function addDays(day: string, count: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + count * 86_400_000).toISOString().slice(0, 10);
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
  const dayStart = Date.parse(`${day}T00:00:00+09:00`);
  const dayEnd = dayStart + 86_400_000;
  const start = Date.parse(startUtc);
  const end = Date.parse(endUtc);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= dayEnd || end <= dayStart) return null;
  const clippedStart = Math.max(start, dayStart);
  const clippedEnd = Math.min(end, dayEnd);
  if (clippedStart === dayStart && clippedEnd === dayEnd) return "終日";
  const startLabel = clippedStart === dayStart ? "00:00" : timeLabel(new Date(clippedStart).toISOString());
  const endLabel = clippedEnd === dayEnd ? "24:00" : timeLabel(new Date(clippedEnd).toISOString());
  return `${startLabel}–${endLabel}`;
}

export function availabilityLabel(reason: AvailabilityReason): string {
  switch (reason) {
    case "AVAILABLE": return "受付中";
    case "MANUALLY_CLOSED": return "休止";
    case "BOOKING_CUTOFF_REACHED": return "締切";
    case "INSUFFICIENT_CAPACITY": return "満席";
    case "GOOGLE_BUSY": return "予定あり";
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
