"use client";

import { useId, useState } from "react";
import type { Occurrence } from "@niho-experience/api-client";
import { calendarDayDate, calendarDayLabel, calendarMonths, initialCalendarMonth, monthOf, monthWeeks, occurrenceStartTime, occurrencesOn, placesLeftLabel, type CalendarDay } from "@/lib/experience/booking-calendar";

/*
 * The booking form's date picker (#638, docs/embed.md「旅行者の流れ」): a month of every offer's occurrences, so each 開催枠
 * the host added is a day here. Only a bookable day can be pressed; pressing it chooses that day's earliest bookable start
 * and shows its time (JST) and places left. A day with more than one start asks which. The public booking page and the
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

/** Why a start of the chosen day cannot be taken, beside its time. */
function closedLabel(occurrence: Occurrence, locale: Locale): string {
  if (occurrence.reason === "FULL") return locale === "ja" ? "満席" : "Full";
  if (occurrence.reason === "CUTOFF") return locale === "ja" ? "受付終了" : "Booking closed";
  return locale === "ja" ? "予約できません" : "Unavailable";
}

export function BookingCalendar({ occurrences, value, offerId, onChange, noteOf, locale = "en", loading = false, failed = false }: {
  /** Every offer's occurrences, as one availability read gave them. */
  occurrences: readonly Occurrence[];
  /** The chosen date and, on it, the chosen offer (its start time). */
  value: string;
  offerId: string;
  onChange: (occurrence: Occurrence) => void;
  /** Said beside each start of a day that has several, e.g. its price when the starts are priced differently. */
  noteOf?: (occurrence: Occurrence) => string | null;
  locale?: Locale;
  loading?: boolean;
  failed?: boolean;
}) {
  const ja = locale === "ja";
  const startsName = useId();
  // The month shown belongs to one availability read: a new read opens its own first month again.
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
  const starts = value ? occurrencesOn(occurrences, value) : [];
  const selected = starts.find((occurrence) => occurrence.offerId === offerId && occurrence.bookable) ?? null;
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
          return <button key={day.date} type="button" className={`${DAY} ${look}`} disabled={day.state !== "bookable"} aria-pressed={day.state === "bookable" ? pressed : undefined} aria-label={dayAriaLabel(day, locale)} onClick={() => { if (day.occurrence && !pressed) onChange(day.occurrence); }}>{day.day}</button>;
        })}
      </div>
      <p className="mx-0.5 mt-2.5 flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-muted">
        <span><i aria-hidden="true" className="mr-1.5 inline-block size-3 rounded-[4px] border border-leaf bg-leaf-pale align-[-1px]" />{ja ? "予約できる日" : "Available"}</span>
        <span><i aria-hidden="true" className="mr-1.5 inline-block size-3 rounded-[4px] border border-line-strong bg-white align-[-1px]" />{ja ? "満席・開催なし" : "Full or not offered"}</span>
      </p>
    </div> : null}
    {/* Always in the page, so every choice is read out: the day, the start chosen on it, and that other starts exist. */}
    <p className="sr-only" aria-live="polite">{selected ? ja
      ? `選択中：${calendarDayLabel(selected.date, locale)}、${occurrenceStartTime(selected.startAt, locale)} JST、${placesLeftLabel(selected.seatsLeft, locale)}。${starts.length > 1 ? `この日の開始時刻は${starts.length}つあります。` : ""}`
      : `Selected: ${calendarDayLabel(selected.date, locale)}, ${occurrenceStartTime(selected.startAt, locale)} JST, ${placesLeftLabel(selected.seatsLeft, locale)}.${starts.length > 1 ? ` ${starts.length} start times that day.` : ""}` : ""}</p>
    {bookableCount > 0 ? selected
      ? starts.length > 1
        ? <div role="radiogroup" aria-label={ja ? `${calendarDayLabel(selected.date, locale)}の開始時刻` : `Start time on ${calendarDayLabel(selected.date, locale)}`} className="grid grid-cols-1 gap-2 rounded-xl bg-sand px-3 py-2.5 text-sm">
          <p><b>{calendarDayLabel(selected.date, locale)}</b> · {ja ? "開始時刻を選んでください" : "Choose a start time"}</p>
          {starts.map((occurrence) => {
            const note = occurrence.bookable ? noteOf?.(occurrence) ?? null : null;
            return <label key={`${occurrence.offerId}|${occurrence.startAt}`} className={`flex min-h-11 items-center gap-2.5 ${occurrence.bookable ? "cursor-pointer" : "text-muted"}`}>
              <input type="radio" name={startsName} className="size-4 shrink-0" checked={occurrence.offerId === selected.offerId} disabled={!occurrence.bookable} onChange={() => onChange(occurrence)} />
              <span className="min-w-0 wrap-anywhere">{occurrenceStartTime(occurrence.startAt, locale)} JST · {occurrence.bookable ? placesLeftLabel(occurrence.seatsLeft, locale) : closedLabel(occurrence, locale)}{note ? ` · ${note}` : ""}</span>
            </label>;
          })}
        </div>
        : <p className="rounded-xl bg-sand px-3 py-2.5 text-sm"><b>{calendarDayLabel(selected.date, locale)}</b> · {occurrenceStartTime(selected.startAt, locale)} JST · {placesLeftLabel(selected.seatsLeft, locale)}</p>
      : <p className="text-sm text-muted">{ja ? "日にちを選ぶと、開始時刻と残りの席数が出ます。" : "Choose a date to see the time and the places left."}</p>
      : null}
  </div>;
}
