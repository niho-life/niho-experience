import { useMemo } from "react";
import type { HostCalendarData } from "@/experience/calendar-contract";
import { availabilityLabel, calendarTimeRange, dateLabel, intervalForDay, minutesLabel, overlapLayout, timeLabel } from "./calendar-ui";

type OccurrenceItem = HostCalendarData["occurrences"][number];
type BusyItem = HostCalendarData["busyIntervals"][number];

const PRODUCT_TONES = [
  "border-moss bg-leaf-pale text-moss",
  "border-info bg-info-pale text-info",
  "border-warn bg-warn-pale text-warn",
  "border-ink-soft bg-sand text-ink-soft",
  "border-danger bg-danger-pale text-danger",
] as const;

export function productTone(index: number): string {
  return PRODUCT_TONES[index % PRODUCT_TONES.length]!;
}

interface TimedItem {
  readonly id: string;
  readonly interval: { readonly startMinutes: number; readonly endMinutes: number };
  readonly occurrence?: OccurrenceItem;
  readonly busy?: BusyItem;
}

function itemsForDay(day: string, occurrences: readonly OccurrenceItem[], busyIntervals: readonly BusyItem[]): TimedItem[] {
  const items: TimedItem[] = [];
  for (const occurrence of occurrences) {
    const interval = intervalForDay(occurrence.startUtc, occurrence.endUtc, day);
    if (interval) items.push({ id: `occurrence:${occurrence.id}`, interval, occurrence });
  }
  busyIntervals.forEach((busy, index) => {
    const interval = intervalForDay(busy.startUtc, busy.endUtc, day);
    if (interval) items.push({ id: `busy:${index}:${busy.startUtc}:${busy.endUtc}`, interval, busy });
  });
  return items;
}

export function HostWeekCalendar({ days, today, occurrences, busyIntervals, productIndexes, onOpen, onSelectDay }: {
  days: readonly string[];
  today: string;
  occurrences: readonly OccurrenceItem[];
  busyIntervals: readonly BusyItem[];
  productIndexes: ReadonlyMap<string, number>;
  onOpen: (item: OccurrenceItem) => void;
  onSelectDay: (day: string) => void;
}) {
  const dayItems = useMemo(() => new Map(days.map((day) => [day, itemsForDay(day, occurrences, busyIntervals)])), [busyIntervals, days, occurrences]);
  const range = useMemo(() => calendarTimeRange([...dayItems.values()].flatMap((items) => items.map((item) => item.interval))), [dayItems]);
  const hourHeight = 54;
  const totalHeight = ((range.endMinutes - range.startMinutes) / 60) * hourHeight;
  const hours = Array.from({ length: (range.endMinutes - range.startMinutes) / 60 + 1 }, (_, index) => range.startMinutes + index * 60);

  return <section aria-label="週カレンダー" className="hidden min-w-0 lg:block">
    <div className="overflow-hidden rounded-2xl border border-line bg-canvas">
      <div className="grid grid-cols-[52px_repeat(7,minmax(0,1fr))] border-b border-line">
        <span aria-hidden="true" />
        {days.map((day) => <button key={day} type="button" data-calendar-day={day} onClick={() => onSelectDay(day)} aria-label={`${dateLabel(day)}の日表示`} aria-current={day === today ? "date" : undefined} className={`min-h-14 border-l border-line px-1 text-center hover:bg-sand ${day === today ? "bg-leaf-pale" : ""}`}><span className="block text-xs text-muted">{"月火水木金土日"[days.indexOf(day)]}</span><strong className={`mx-auto mt-0.5 grid size-7 place-items-center rounded-full font-sans text-sm ${day === today ? "bg-ink text-canvas" : ""}`}>{Number(day.slice(8))}</strong></button>)}
      </div>
      <div className="grid grid-cols-[52px_repeat(7,minmax(0,1fr))]">
        <div aria-hidden="true" className="relative border-r border-line bg-canvas" style={{ height: totalHeight + 44 }}>
          {hours.map((minutes) => <span key={minutes} className="absolute right-2 -translate-y-1/2 text-[0.6875rem] leading-none text-muted tabular-nums" style={{ top: ((minutes - range.startMinutes) / 60) * hourHeight }}>{minutesLabel(minutes)}</span>)}
        </div>
        {days.map((day) => {
          const items = dayItems.get(day) ?? [];
          // Reserve each button's full hit area when assigning lanes, including short adjacent slots.
          const layout = overlapLayout(items.map((item) => ({ id: item.id, ...item.interval, endMinutes: Math.max(item.interval.endMinutes, item.interval.startMinutes + (44 / hourHeight) * 60) })));
          return <div key={day} className="relative border-r border-line last:border-r-0" style={{ height: totalHeight + 44, backgroundImage: "linear-gradient(to bottom, transparent calc(100% - 1px), var(--color-line) 1px)", backgroundSize: `100% ${hourHeight}px` }}>
            {items.map((item) => {
              const placement = layout.get(item.id) ?? { column: 0, columns: 1 };
              const top = ((item.interval.startMinutes - range.startMinutes) / 60) * hourHeight;
              const height = Math.max(44, ((item.interval.endMinutes - item.interval.startMinutes) / 60) * hourHeight - 3);
              const left = `calc(${(placement.column / placement.columns) * 100}% + 3px)`;
              const width = `calc(${100 / placement.columns}% - 6px)`;
              if (item.busy) return <div key={item.id} role="note" aria-label={`${dateLabel(day)} ${minutesLabel(item.interval.startMinutes)}–${minutesLabel(item.interval.endMinutes)} 予定あり`} className="absolute z-[1] flex min-w-0 items-center justify-center overflow-hidden rounded-md border border-line-strong bg-sand px-1 text-center text-[0.6875rem] font-bold text-ink-soft [background-image:repeating-linear-gradient(135deg,transparent,transparent_4px,var(--color-line)_4px,var(--color-line)_5px)]" style={{ top, height, left, width }}><span>予定あり</span></div>;
              const occurrence = item.occurrence!;
              const productClass = productTone(productIndexes.get(occurrence.experienceId) ?? 0);
              const booked = (occurrence.confirmedSeats ?? 0) > 0 || (occurrence.heldSeats ?? 0) > 0;
              const state = booked ? "予約あり" : availabilityLabel(occurrence.availabilityReason);
              return <button key={item.id} type="button" onClick={() => onOpen(occurrence)} aria-label={`${dateLabel(day)} ${timeLabel(occurrence.startUtc)}–${timeLabel(occurrence.endUtc)} ${occurrence.experienceTitle} ${state}`} className={`absolute z-[2] min-w-0 overflow-hidden rounded-md border-l-[3px] p-1.5 text-left hover:brightness-[0.97] focus-visible:z-10 ${productClass} ${occurrence.status === "CLOSED" ? "border-dashed bg-sand text-ink-soft" : ""}`} style={{ top, height, left, width }}><span className="flex min-w-0 items-center justify-between gap-1 text-[0.6875rem] leading-4 font-bold"><span className="truncate tabular-nums">{timeLabel(occurrence.startUtc)}{height >= 64 ? `–${timeLabel(occurrence.endUtc)}` : ""}</span><span className="shrink-0">{state}</span></span><strong className="block truncate text-xs leading-4 text-ink">{occurrence.experienceTitle}</strong></button>;
            })}
          </div>;
        })}
      </div>
    </div>
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs font-bold text-muted"><span>● 受付中</span><span>● 予約あり</span><span>◇ 休止</span><span>▨ 予定あり</span></div>
  </section>;
}
