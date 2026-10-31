"use client";

import { useEffect, useState } from "react";
import { computeExpectedTotalYen, type ExperienceApiClient, type ExperienceOffer, type Occurrence } from "@niho-experience/api-client";
import { getBookingApi } from "@/lib/browser-api";
import type { BookingSource } from "@/lib/booking-source";
import { dayLabelWithoutWeekday, dayOption } from "@/lib/date-filter";
import type { ExperienceDetailForSite } from "@/lib/experience-types";
import { formatDuration, formatTime, formatYen, pluralize } from "@/lib/format";
import { slotAvailabilityLabel } from "@/lib/availability-copy";
import { track } from "@/lib/analytics";
import { BookingSelectionViewV1, type BookingSelectionViewModelV1 } from "@niho/experience-presentation/v1";
import { PRESENTATION_PRIMITIVES_V1 } from "./PresentationV1";
import { formatClock } from "@/lib/schedule";
import { useSiteCopy, useSiteLocale } from "./SiteLocale";
import { readAvailabilityFromApi } from "@/lib/browser-availability";

export type BookingSelection = { offerId: string; date: string; adultCount: number; childCount: number };

/** Dates shown before "Show more dates" (two columns, three rows). */
const FIRST_DATES = 6;

export function SlotPicker({ experience, slug, offers, preview, availabilityIsProvisional, bookingSource, onContinue, initialOfferId, initialDate, initialAdultCount = 1, initialChildCount = 0, titleAs = "h1" }: { experience: ExperienceDetailForSite; slug: string; offers: ExperienceOffer[]; preview: boolean; availabilityIsProvisional: boolean; bookingSource: BookingSource; onContinue: (selection: BookingSelection) => void; initialOfferId?: string; initialDate?: string; initialAdultCount?: number; initialChildCount?: number; titleAs?: "h1" | "p" }) {
  const copy = useSiteCopy();
  const { locale, releaseId } = useSiteLocale();
  const [api, setApi] = useState<ExperienceApiClient | null>(null);
  // A date chosen on the detail page arrives pre-selected; it is kept only if it is still bookable (below).
  const [offerId, setOfferId] = useState(offers.some((item) => item.id === initialOfferId) ? initialOfferId! : (offers[0]?.id ?? ""));
  const [occurrences, setOccurrences] = useState<Occurrence[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [date, setDate] = useState(initialDate ?? "");
  const [adultCount, setAdultCount] = useState(initialAdultCount);
  const [childCount, setChildCount] = useState(initialChildCount);
  const [showAllDates, setShowAllDates] = useState(false);
  const offer = offers.find((item) => item.id === offerId);
  const selected = occurrences.find((item) => item.offerId === offerId && item.date === date);
  const headCount = adultCount + childCount;
  const total = offer ? computeExpectedTotalYen(offer.pricing, adultCount, childCount) : null;
  const countsValid = !!offer && headCount >= offer.minimumParticipants && headCount <= offer.maxPartySize && adultCount >= 0 && childCount >= 0 && (!offer.pricing.child || !offer.pricing.child.adultRequired || childCount === 0 || adultCount > 0);
  const canContinue = countsValid && total !== null && !!selected?.bookable && selected.seatsLeft >= headCount;

  useEffect(() => {
    let active = true;
    getBookingApi(preview, bookingSource).then((client) => { if (active) setApi(client); }).catch(() => { if (active) { setError(true); setLoading(false); } });
    return () => { active = false; };
  }, [preview, bookingSource]);

  useEffect(() => {
    if (!api) return;
    let active = true;
    readAvailabilityFromApi(api, slug, locale, releaseId, offerId).then((nextOccurrences) => {
      if (!active) return;
      const valid = nextOccurrences !== null;
      setLoading(false);
      setError(!valid);
      setOccurrences(nextOccurrences ?? []);
      setDate((current) => (current && nextOccurrences?.some((item) => item.offerId === offerId && item.date === current && item.bookable) ? current : ""));
    });
    return () => { active = false; };
  }, [api, slug, offerId, locale, releaseId]);

  // A pre-selected date further down the list opens the full list so it stays in view.
  const selectedIndex = occurrences.findIndex((item) => item.date === date);
  const shownDates = showAllDates || selectedIndex >= FIRST_DATES ? occurrences : occurrences.slice(0, FIRST_DATES);
  const moreDates = occurrences.length - shownDates.length;
  const hint = selected?.bookable && selected.seatsLeft < headCount ? availabilityIsProvisional ? copy.text("booking.samplePartySize") : copy.text("booking.onlyPlaces", { places: pluralize(selected.seatsLeft, locale === "ja" ? "名" : "place", locale === "ja" ? "名" : "places") }) : copy.text("booking.chooseValid");

  const summary = { title: experience.title, image: experience.cover ? { src: experience.cover.url, alt: "" } : null, summary: offer ? `${formatDuration(offer.durationMinutes, locale)} · ${formatClock(offer.startTime, locale)} JST · ${offer.name}` : undefined };
  const model: BookingSelectionViewModelV1 = {
    summary,
    ...(offers.length ? {} : { unavailableMessage: copy.text("booking.newDatesSoon") }),
    offerDescription: offers.length === 1 ? offer?.shortDescription ?? undefined : undefined,
    offers: offers.map((item) => ({ id: item.id, name: item.name, description: item.shortDescription ?? undefined, adultPrice: formatYen(item.pricing.adultPriceYen, locale), selected: offerId === item.id })),
    dates: { state: loading ? "loading" : error ? "error" : occurrences.length ? "ready" : "empty", provisional: availabilityIsProvisional, options: shownDates.map((item) => { const day = dayOption(item.date, locale); return { id: item.date, weekday: day.weekday, day: dayLabelWithoutWeekday(day, locale), time: `${formatTime(item.startAt, locale)} – ${formatTime(item.endAt, locale)}`, availability: item.bookable && availabilityIsProvisional ? undefined : slotAvailabilityLabel(item, availabilityIsProvisional, copy, locale), bookable: item.bookable, selected: date === item.date }; }), moreCount: moreDates },
    counters: offer ? [
      { id: "adult-count", label: copy.text("booking.adults"), note: copy.text(offer.minimumParticipants > 1 ? "booking.adultMinimum" : "booking.each", { price: formatYen(offer.pricing.adultPriceYen, locale), minimum: offer.minimumParticipants }), value: adultCount, maximum: offer.maxPartySize, full: headCount >= offer.maxPartySize },
      ...(offer.pricing.child ? [{ id: "child-count", label: copy.text("booking.children"), note: copy.text(offer.pricing.child.adultRequired ? "booking.childPriceAdult" : "booking.childPrice", { minimumAge: offer.pricing.child.minAge, maximumAge: offer.pricing.child.maxAge, price: formatYen(offer.pricing.child.priceYen, locale) }), value: childCount, maximum: offer.maxPartySize, full: headCount >= offer.maxPartySize }] : []),
    ] : undefined,
    guestRange: offer ? { minimum: offer.minimumParticipants, maximum: offer.maxPartySize, childrenPrice: offer.pricing.child ? formatYen(offer.pricing.child.priceYen, locale) : undefined } : undefined,
    hint: canContinue ? undefined : hint,
    total: total !== null && countsValid ? formatYen(total, locale) : copy.text("booking.checkCounts"),
    totalIsAmount: total !== null && countsValid,
    line: selected ? `${dayOption(selected.date, locale).label} · ${formatTime(selected.startAt, locale)}` : copy.text("booking.chooseDateLine"),
    canContinue,
  };
  const retry = () => { setError(false); setLoading(true); if (api) readAvailabilityFromApi(api, slug, locale, releaseId, offerId).then((nextOccurrences) => { setLoading(false); setError(nextOccurrences === null); setOccurrences(nextOccurrences ?? []); }); else getBookingApi(preview, bookingSource).then(setApi).catch(() => { setError(true); setLoading(false); }); };
  return <BookingSelectionViewV1 model={model} titleAs={titleAs} primitives={PRESENTATION_PRIMITIVES_V1} copy={copy} callbacks={{ onOfferChange: (id) => { const item = offers.find((candidate) => candidate.id === id); setOfferId(id); setDate(""); setLoading(true); if (!item?.pricing.child) setChildCount(0); setShowAllDates(false); }, onDateChange: setDate, onCounterChange: (id, value) => id === "adult-count" ? setAdultCount(value) : setChildCount(value), onRetry: retry, onShowMore: () => setShowAllDates(true), onContinue: () => { if (locale === "en") track("slot_continue", { experience: slug, guests: headCount }); onContinue({ offerId, date, adultCount, childCount }); } }} />;
}
