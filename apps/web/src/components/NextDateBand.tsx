import type { Occurrence } from "@niho-experience/api-client";
import { dayOption } from "@/lib/date-filter";
import { formatTime, jstDateKey } from "@/lib/format";
import type { SiteLocale } from "@/lib/localized-content";
import { LocalizedLink as Link } from "./LocalizedLink";

/**
 * When the booking of an occurrence closes, for the line "Book by …" (#146): its `bookingClosesAt` when that is a real cutoff
 * (before the start), else null. A cutoff of zero minutes (the same instant as the start), no value (a provider that does not
 * say) or an unreadable one shows nothing: the page never guesses a deadline.
 */
export function bookingCloseOf(occurrence: Pick<Occurrence, "startAt" | "bookingClosesAt">): string | null {
  const closes = occurrence.bookingClosesAt;
  if (typeof closes !== "string") return null;
  const closing = Date.parse(closes);
  const starting = Date.parse(occurrence.startAt);
  return Number.isFinite(closing) && Number.isFinite(starting) && closing < starting ? closes : null;
}

/**
 * The next dates under the facts of an experience's page (#146): the next date and its time, the few after it, and when the
 * next one stops taking bookings. "All dates" goes to the booking section (`#book` on the page that has one) or, on the
 * mobile layout and where there is none, to the booking page.
 */
export function NextDateBand({ dates, locale, bookingHref, allDatesHref = "#book" }: { dates: readonly Occurrence[]; locale: SiteLocale; bookingHref: string; allDatesHref?: string }) {
  const [next, ...later] = dates;
  if (!next) return null;
  const label = locale === "ja"
    ? { next: "次回", more: "ほかの日程", all: "すべての日程", closes: "予約締切" }
    : { next: "Next date", more: "More dates", all: "All dates", closes: "Book by" };
  const closes = bookingCloseOf(next);
  return (
    <div data-next-date-band className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[18px] bg-leaf-pale px-4 py-3 text-[0.875rem] sm:px-5">
      <p className="font-extrabold text-moss">
        <span className="mr-2 text-[0.75rem] tracking-[0.08em] uppercase">{label.next}</span>
        <time dateTime={next.startAt}>{dayOption(next.date, locale).label} · {formatTime(next.startAt, locale)} JST</time>
      </p>
      {later.length ? (
        <p className="flex flex-wrap items-center gap-1.5 text-ink-soft">
          <span className="sr-only">{label.more}: </span>
          {later.map((occurrence) => <time key={`${occurrence.offerId}-${occurrence.date}`} dateTime={occurrence.startAt} className="rounded-full bg-white/75 px-2.5 py-1 font-bold">{dayOption(occurrence.date, locale).label}</time>)}
        </p>
      ) : null}
      {closes ? (
        <p data-booking-closes className="text-ink-soft">
          <span className="mr-1.5 text-[0.75rem] tracking-[0.08em] uppercase">{label.closes}</span>
          <time dateTime={closes} className="font-bold text-ink">{dayOption(jstDateKey(closes), locale).label} · {formatTime(closes, locale)} JST</time>
        </p>
      ) : null}
      <a href={allDatesHref} className="link-leaf ml-auto hidden shrink-0 lg:inline">{label.all}</a>
      <Link href={bookingHref} className="link-leaf ml-auto shrink-0 lg:hidden">{label.all}</Link>
    </div>
  );
}
