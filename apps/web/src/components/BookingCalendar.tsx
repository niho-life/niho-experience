"use client";

import { useState } from "react";
import type { Occurrence } from "@niho-experience/api-client";
import { calendarDayDate, calendarDayLabel, calendarMonths, initialCalendarMonth, monthOf, monthWeeks, occurrenceStartTime, placesLeftLabel, type CalendarDay } from "@/lib/experience/booking-calendar";

/*
 * The booking form's date picker (#638, docs/embed.md「旅行者の流れ」): a month of the chosen offer's occurrences. Only a
 * bookable day can be pressed; pressing it shows the start time (JST) and the places left. The public booking page and the
 * embedded widget both use it. Failure to read availability shows no grid: the form's own alert says so.
 */

type Locale = "en" | "ja";

const WEEKDAYS: Record<Locale, readonly string[]> = { en: ["S", "M", "T", "W", "T", "F", "S"], ja: ["日", "月", "火", "水", "木", "金", "土"] };
const NAV_BUTTON = "grid size-10 place-items-center rounded-full border border-line-strong bg-white text-lg leading-none disabled:cursor-default disabled:opacity-35";
const DAY = "grid min-h-11 w-full min-w-0 place-items-center rounded-xl text-[0.9375rem]";

function dayAriaLabel(day: CalendarDay<Occurrence>, locale: Locale): string {
  const label = calendarDayLabel(day.date, locale);
  const separator = locale === "ja" ? "、" : ", ";
  if (day.state === "bookable") return `${label}${separator}${placesLeftLabel(day.occurrence!.seatsLeft, locale)}`;
  if (day.state === "unavailable") return `${label}${separator}${locale === "ja" ? "予約できません" : "unavailable"}`;
  return `${label}${separator}${locale === "ja" ? "開催なし" : "not offered"}`;
}

export function BookingCalendar({ occurrences, value, onChange, locale = "en", loading = false, failed = false }: {
  occurrences: readonly Occurrence[];
  value: string;
  onChange: (date: string) => void;
  locale?: Locale;
  loading?: boolean;
  failed?: boolean;
}) {
  const ja = locale === "ja";
  // The month shown belongs to one availability read: a new offer (a new read) opens its own first month again.
  const [viewed, setViewed] = useState<{ readonly occurrences: readonly Occurrence[]; readonly month: string } | null>(null);
  const months = calendarMonths(occurrences);
  const selectedMonth = value ? monthOf(value) : null;
  const month = viewed?.occurrences === occurrences && months.includes(viewed.month)
    ? viewed.month
    : selectedMonth && months.includes(selectedMonth) ? selectedMonth : initialCalendarMonth(occurrences);

  if (loading) return <p role="status" className="rounded-xl border border-line-strong p-3 text-sm font-normal text-muted">{ja ? "日時を読み込み中…" : "Loading dates…"}</p>;
  if (failed) return null;

  const bookableCount = occurrences.filter((occurrence) => occurrence.bookable).length;
  const index = month ? months.indexOf(month) : -1;
  const selected = value ? occurrences.find((occurrence) => occurrence.date === value && occurrence.bookable) ?? null : null;
  const go = (step: -1 | 1) => { const next = months[index + step]; if (next) setViewed({ occurrences, month: next }); };

  return <div className="grid min-w-0 grid-cols-1 gap-3 font-normal">
    {bookableCount === 0 ? <p role="status" className="rounded-xl bg-sand p-3 text-sm text-ink-soft">{ja ? "現在、予約できる日程はありません。" : "No dates are open for booking right now."}</p> : null}
    {month ? <div className="min-w-0 rounded-xl border border-line-strong p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <button type="button" className={NAV_BUTTON} aria-label={ja ? "前の月" : "Previous month"} disabled={index <= 0} onClick={() => go(-1)}>‹</button>
        <strong className="text-[0.9375rem] font-extrabold" aria-live="polite">{new Intl.DateTimeFormat(ja ? "ja-JP" : "en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(calendarDayDate(`${month}-01`))}</strong>
        <button type="button" className={NAV_BUTTON} aria-label={ja ? "次の月" : "Next month"} disabled={index >= months.length - 1} onClick={() => go(1)}>›</button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center">
        {WEEKDAYS[locale].map((weekday, position) => <span key={position} aria-hidden="true" className="py-1 text-[0.6875rem] font-extrabold text-muted">{weekday}</span>)}
        {monthWeeks(month, occurrences).flat().map((day, position) => {
          if (!day) return <span key={`blank-${position}`} aria-hidden="true" />;
          const pressed = day.state === "bookable" && day.date === value;
          const look = pressed
            ? "bg-ink font-extrabold text-white"
            : day.state === "bookable"
              ? "cursor-pointer bg-leaf-pale font-extrabold text-ink hover:bg-leaf"
              : day.state === "unavailable" ? "text-muted line-through" : "text-muted opacity-50";
          return <button key={day.date} type="button" className={`${DAY} ${look}`} disabled={day.state !== "bookable"} aria-pressed={day.state === "bookable" ? pressed : undefined} aria-label={dayAriaLabel(day, locale)} onClick={() => onChange(day.date)}>{day.day}</button>;
        })}
      </div>
      <p className="mx-0.5 mt-2.5 flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-muted">
        <span><i aria-hidden="true" className="mr-1.5 inline-block size-3 rounded-[4px] border border-leaf bg-leaf-pale align-[-1px]" />{ja ? "予約できる日" : "Available"}</span>
        <span><i aria-hidden="true" className="mr-1.5 inline-block size-3 rounded-[4px] border border-line-strong bg-white align-[-1px]" />{ja ? "満席・開催なし" : "Full or not offered"}</span>
      </p>
    </div> : null}
    {bookableCount > 0 ? selected
      ? <p className="rounded-xl bg-sand px-3 py-2.5 text-sm" aria-live="polite"><b>{calendarDayLabel(selected.date, locale)}</b> · {occurrenceStartTime(selected.startAt, locale)} JST · {placesLeftLabel(selected.seatsLeft, locale)}</p>
      : <p className="text-sm text-muted">{ja ? "日にちを選ぶと、開始時刻と残りの席数が出ます。" : "Choose a date to see the time and the places left."}</p>
      : null}
  </div>;
}
