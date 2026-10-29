import type { HostCalendarData } from "@/experience/calendar-contract";
import { availabilityLabel, busyIntervalLabelForDay, dateLabel, intervalForDay, timeLabel } from "./calendar-ui";
import { HOST_SURFACE } from "./host-ui";
import { productTone } from "./HostWeekCalendar";
import { StatusPill } from "./ui";

type OccurrenceItem = HostCalendarData["occurrences"][number];

function statePill(item: OccurrenceItem) {
  const label = availabilityLabel(item.availabilityReason);
  const tone = item.availabilityReason === "AVAILABLE" ? "ok" : item.availabilityReason === "MANUALLY_CLOSED" ? "stop" : item.availabilityReason === "GOOGLE_SYNC_UNAVAILABLE" || item.availabilityReason === "RESOURCE_GOOGLE_UNAVAILABLE" || item.availabilityReason === "EXTERNAL_RESERVATION_READ_UNAVAILABLE" ? "wait" : "draft";
  return <StatusPill status={{ label, tone }} />;
}

export function HostCalendarAgenda({ day, occurrences, busyIntervals, productIndexes, onOpen }: {
  day: string;
  occurrences: readonly OccurrenceItem[];
  busyIntervals: HostCalendarData["busyIntervals"];
  productIndexes: ReadonlyMap<string, number>;
  onOpen: (item: OccurrenceItem) => void;
}) {
  const items = [
    ...occurrences.flatMap((item) => item.localDate === day ? [{ kind: "occurrence" as const, start: Date.parse(item.startUtc), item }] : []),
    ...busyIntervals.flatMap((item, index) => intervalForDay(item.startUtc, item.endUtc, day) ? [{ kind: "busy" as const, start: Date.parse(item.startUtc), item, index }] : []),
  ].sort((a, b) => a.start - b.start);
  return <section aria-labelledby="calendar-agenda-title" className={`${HOST_SURFACE} min-w-0 p-3.5 md:p-5`}>
    <h2 id="calendar-agenda-title" className="font-sans text-sm font-extrabold tracking-normal">{dateLabel(day)}</h2>
    {items.length === 0 ? <p className="py-12 text-center text-sm text-muted">予定はありません</p> : <ul className="mt-3 grid gap-3">{items.map((entry) => {
      if (entry.kind === "busy") return <li key={`busy:${entry.index}:${entry.item.startUtc}`} className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-start gap-2.5"><span className="whitespace-pre-line pt-3 text-xs font-bold text-ink-soft tabular-nums">{busyIntervalLabelForDay(entry.item.startUtc, entry.item.endUtc, day)?.replace("–", "\n")}</span><div role="note" aria-label={`${dateLabel(day)} ${busyIntervalLabelForDay(entry.item.startUtc, entry.item.endUtc, day)} 予定あり`} className="flex min-h-14 items-center rounded-xl border border-line bg-sand px-3"><StatusPill status={{ label: "予定あり", tone: "draft" }} /></div></li>;
      const item = entry.item;
      const booked = (item.confirmedSeats ?? 0) > 0 || (item.heldSeats ?? 0) > 0;
      return <li key={item.id} className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-start gap-2.5"><span className="whitespace-pre-line pt-3 text-xs font-bold text-ink-soft tabular-nums">{timeLabel(item.startUtc)}{"\n"}{timeLabel(item.endUtc)}</span><button type="button" onClick={() => onOpen(item)} className={`min-h-14 min-w-0 rounded-xl border border-l-[3px] bg-canvas p-3 text-left hover:bg-sand ${productTone(productIndexes.get(item.experienceId) ?? 0).split(" ")[0]}`}><span className="block truncate text-sm font-extrabold">{item.experienceTitle}</span><span className="mt-2 flex flex-wrap items-center gap-2">{statePill(item)}{booked ? <strong className="text-xs text-info">予約あり</strong> : null}</span></button></li>;
    })}</ul>}
  </section>;
}
