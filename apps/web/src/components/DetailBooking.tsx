"use client";

import { useEffect, useState } from "react";
import type { Occurrence } from "@niho-experience/api-client";
import { readBookingAvailability } from "@/lib/browser-availability";
import type { BookingSource } from "@/lib/booking-source";
import { browseHref, type BrowseContext } from "@/lib/browse-context";
import { dayLabelWithoutWeekday, dayOption, nextBookable } from "@/lib/date-filter";
import { formatTime, formatYen } from "@/lib/format";
import { type HandIconName } from "./HandIcon";
import { buttonClass } from "./ui";
import { DetailBookingCardV1, DetailBookingDatesV1, type StaticCopyAccessorV1 } from "@niho/experience-presentation/v1";
import { bookingCardModel, presentationBookingHref as bookHref } from "@/lib/presentation-booking-model";
import { PRESENTATION_PRIMITIVES_V1 } from "./PresentationV1";
import { LocalizedLink } from "./LocalizedLink";
import { useSiteCopy, useSiteLocale } from "./SiteLocale";

export type BookingSummary = {
  slug: string;
  offers: { id: string; name: string; adultPriceYen: number }[];
  /** "¥30,000". */
  price: string;
  priceIsFrom: boolean;
  /** "Children 6–17 ¥12,000", when children can join. */
  childNote: string | null;
  /** "Tue · Thu · Sat · 6:00 PM". */
  schedule: string | null;
  canBook: boolean;
  assurances: { icon: HandIconName; text: string }[];
  preview: boolean;
  availabilityIsProvisional: boolean;
  /** NIHO's API, or this site's routes for an experience sold here (#285). */
  bookingSource: BookingSource;
  browseContext?: Partial<BrowseContext>;
  preferredOfferId?: string;
};

const NEXT_DATES = 3;

/** Next bookable sessions read in the browser (never cached, never shown as seat counts). */
function useNextDates(summary: BookingSummary): Occurrence[] | null | "failed" {
  const [dates, setDates] = useState<Occurrence[] | null | "failed">(null);
  const { slug, preview, bookingSource, canBook } = summary;
  const { locale, releaseId } = useSiteLocale();
  useEffect(() => {
    if (!canBook) return;
    let active = true;
    readBookingAvailability(slug, preview, bookingSource, locale, releaseId).then((read) => {
      if (active) setDates(read.ok ? nextBookable(read.occurrences, NEXT_DATES) : "failed");
    });
    return () => {
      active = false;
    };
  }, [slug, preview, bookingSource, canBook, locale, releaseId]);
  return dates;
}

/** The booking page pre-selects this date and option; the guest still confirms everything there. */
const bookDateHref = (summary: BookingSummary, occurrence: Occurrence) =>
  browseHref(`/experiences/${summary.slug}/book`, { ...summary.browseContext, date: occurrence.date }, occurrence.offerId);
const offerFor = (summary: BookingSummary, occurrence: Occurrence) => summary.offers.find((offer) => offer.id === occurrence.offerId);
const sessionLabel = (summary: BookingSummary, occurrence: Occurrence, locale: "en" | "ja", copy: StaticCopyAccessorV1) => {
  const offer = offerFor(summary, occurrence);
  return `${dayOption(occurrence.date, locale).label} · ${formatTime(occurrence.startAt, locale)} · ${offer?.name ?? copy.text("booking.optionFallback")}`;
};
/** The bottom bar names the option only when there is more than one. */
const nextLabel = (summary: BookingSummary, occurrence: Occurrence, locale: "en" | "ja", copy: StaticCopyAccessorV1) =>
  summary.offers.length > 1 ? sessionLabel(summary, occurrence, locale, copy) : `${dayOption(occurrence.date, locale).label} · ${formatTime(occurrence.startAt, locale)}`;

function Price({ summary, size = "lg" }: { summary: BookingSummary; size?: "lg" | "sm" }) {
  const copy = useSiteCopy();
  return (
    <p className={size === "lg" ? "text-[0.9375rem] text-ink-soft" : "text-sm text-ink-soft"}>
      {summary.priceIsFrom ? `${copy.text("common.from")} ` : ""}
      <b className={`font-extrabold text-ink ${size === "lg" ? "text-[1.75rem]" : "text-lg"}`}>{summary.price}</b> {copy.text("common.perAdult")}
    </p>
  );
}

/** Desktop: the sticky card beside the description. Party size and totals stay on the booking page. */
export function BookingCard({ summary, label }: { summary: BookingSummary; label?: string }) {
  const copy = useSiteCopy();
  return <DetailBookingCardV1 model={bookingCardModel(summary, <BookingDatesController summary={summary} />, label ?? copy.text("detail.checkDates"))} primitives={PRESENTATION_PRIMITIVES_V1} copy={copy} />;
}

/** Maps public availability into the narrow behavior seam used by the frozen card view. */
export function BookingDatesController({ summary }: { summary: BookingSummary }) {
  const copy = useSiteCopy();
  const { locale } = useSiteLocale();
  const dates = useNextDates(summary);
  const state = dates === null ? "loading" : dates === "failed" ? "failed" : dates.length ? "ready" : "empty";
  const items = Array.isArray(dates) ? dates.map((occurrence) => {
    const day = dayOption(occurrence.date, locale);
    const offer = offerFor(summary, occurrence);
    const optionPrice = offer ? formatYen(offer.adultPriceYen, locale) : copy.text("booking.seeOption");
    const option = offer?.name ?? copy.text("booking.optionFallback");
    const session = sessionLabel(summary, occurrence, locale, copy);
    return { id: `${occurrence.offerId}-${occurrence.date}`, href: bookDateHref(summary, occurrence), ariaLabel: copy.text("booking.bookDateAria", { session, price: optionPrice }), weekday: day.weekday, day: dayLabelWithoutWeekday(day, locale), time: formatTime(occurrence.startAt, locale), option, price: optionPrice };
  }) : [];
  return <DetailBookingDatesV1 state={state} dates={items} provisional={summary.availabilityIsProvisional} primitives={PRESENTATION_PRIMITIVES_V1} copy={copy} />;
}

/** Phones and tablets: price, the next date and one action, always within reach. */
export function MobileBookingBar({ summary }: { summary: BookingSummary }) {
  const copy = useSiteCopy();
  const { locale } = useSiteLocale();
  const dates = useNextDates(summary);
  const next = Array.isArray(dates) ? dates[0] : undefined;
  const line = next ? copy.text("booking.nextLine", { session: nextLabel(summary, next, locale, copy) }) : summary.schedule;
  return (
    <div data-sticky-bar className="sticky bottom-0 z-20 mt-14 border-t border-line bg-white/95 backdrop-blur lg:hidden">
      <div className="container-page flex items-center justify-between gap-3 py-3">
        <div className="min-w-0 leading-tight">
          <Price summary={summary} size="sm" />
          {summary.canBook && line ? <p className="mt-1 truncate text-[0.8125rem] font-extrabold text-moss">{line}</p> : null}
        </div>
        {summary.canBook ? (
          <LocalizedLink href={bookHref(summary)} className={buttonClass("primary", "shrink-0 px-5")}>
            {copy.text("booking.checkDates")}
          </LocalizedLink>
        ) : (
          <p className="shrink-0 text-sm font-bold text-ink-soft">{copy.text("booking.pausedShort")}</p>
        )}
      </div>
    </div>
  );
}
