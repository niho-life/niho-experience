"use client";

import { useState } from "react";
import { calendarDayDate, calendarDayLabel, monthOf, monthWeeks } from "@/lib/experience/booking-calendar";
import { searchText } from "@/lib/search-text";

/*
 * The search bar's date picker (#698): a month grid over the search window, looking like the booking calendar
 * (BookingCalendar.tsx). A day with something on is pale green and bold; the chosen day is green with a moss ring (never
 * black); the others are muted and cannot be pressed. No per-day counts. `available` null means availability is unknown
 * (not read yet, or it failed): every day of the window can be chosen and none is marked, so the page fails open.
 */

const WEEKDAYS = { en: ["S", "M", "T", "W", "T", "F", "S"], ja: ["日", "月", "火", "水", "木", "金", "土"] } as const;
const NAV = "grid size-10 place-items-center rounded-full border border-line-strong bg-white text-lg leading-none hover:bg-sand disabled:cursor-default disabled:opacity-35";
const DAY = "grid min-h-10 w-full min-w-0 place-items-center rounded-xl text-[0.9375rem]";

function monthsBetween(first: string, last: string): string[] {
  const months: string[] = [];
  let [year, month] = first.split("-").map(Number) as [number, number];
  const [lastYear, lastMonth] = last.split("-").map(Number) as [number, number];
  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    months.push(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return months;
}

export function ExperienceSearchCalendar({ locale, start, end, value, available, onChange }: {
  locale: "en" | "ja";
  /** First and last selectable day (JST, `YYYY-MM-DD`). */
  start: string;
  end: string;
  value: string | null;
  /** The days with something on, or null when unknown. */
  available: ReadonlySet<string> | null;
  onChange: (date: string | null) => void;
}) {
  const words = searchText(locale);
  const ja = locale === "ja";
  // A day chosen through the address (e.g. an old link) may lie outside the window: its month is shown and it stays pressed.
  const firstKey = value && value < start ? value : start;
  const lastKey = value && value > end ? value : end;
  const months = monthsBetween(monthOf(firstKey) ?? "1970-01", monthOf(lastKey) ?? "1970-01");
  // Until a month is turned to, the calendar opens on the chosen day's month, else the first month with something on (known only
  // once availability has been read), else today's.
  const [viewed, setViewed] = useState<string | null>(null);
  const firstMarked = available ? [...available].filter((day) => day >= start && day <= end).sort()[0] : undefined;
  const opening = (value && monthOf(value)) || (firstMarked && monthOf(firstMarked)) || monthOf(start) || months[0]!;
  const month = viewed && months.includes(viewed) ? viewed : months.includes(opening) ? opening : months[0]!;
  const index = months.indexOf(month);
  const go = (step: -1 | 1) => { const next = months[index + step]; if (next) setViewed(next); };

  return <div className="w-[322px] max-w-full max-sm:w-full font-normal">
    <div className="mb-2 flex items-center justify-between gap-2">
      <button type="button" className={NAV} aria-label={words.previousMonth} disabled={index <= 0} onClick={() => go(-1)}>‹</button>
      <strong className="text-[0.9375rem] font-extrabold" aria-live="polite">{new Intl.DateTimeFormat(ja ? "ja-JP" : "en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(calendarDayDate(`${month}-01`))}</strong>
      <button type="button" className={NAV} aria-label={words.nextMonth} disabled={index >= months.length - 1} onClick={() => go(1)}>›</button>
    </div>
    <div className="grid grid-cols-7 gap-1 text-center">
      {WEEKDAYS[locale].map((weekday, position) => <span key={position} aria-hidden="true" className="py-1 text-[0.6875rem] font-extrabold text-muted">{weekday}</span>)}
      {monthWeeks(month, []).flat().map((day, position) => {
        if (!day) return <span key={`blank-${position}`} aria-hidden="true" />;
        const chosen = day.date === value;
        const inWindow = day.date >= start && day.date <= end;
        const marked = inWindow && available !== null && available.has(day.date);
        const enabled = chosen || (inWindow && (available === null || marked));
        const look = chosen
          ? "bg-leaf font-extrabold text-ink ring-2 ring-inset ring-moss"
          : marked
            ? "cursor-pointer bg-leaf-pale font-extrabold text-ink hover:ring-[1.5px] hover:ring-inset hover:ring-moss"
            : enabled ? "cursor-pointer text-ink hover:bg-sand" : "text-muted opacity-50";
        const note = available === null || !inWindow ? "" : `${ja ? "、" : ", "}${marked ? words.dayOn : words.dayOff}`;
        return <button key={day.date} type="button" className={`${DAY} ${look}`} disabled={!enabled} aria-pressed={chosen} aria-label={`${calendarDayLabel(day.date, locale)}${note}`} onClick={() => onChange(day.date)}>{day.day}</button>;
      })}
    </div>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-xs text-muted">
      {available === null ? <span /> : <p className="flex flex-wrap gap-x-3.5 gap-y-1">
        <span><i aria-hidden="true" className="mr-1.5 inline-block size-3 rounded-[4px] border border-leaf bg-leaf-pale align-[-1px]" />{words.legendOn}</span>
        <span><i aria-hidden="true" className="mr-1.5 inline-block size-3 rounded-[4px] border border-line-strong bg-white align-[-1px]" />{words.legendOff}</span>
      </p>}
      <button type="button" className="text-[0.8125rem] font-extrabold whitespace-nowrap text-moss underline underline-offset-[3px]" onClick={() => onChange(null)}>{words.anyDay}</button>
    </div>
  </div>;
}
