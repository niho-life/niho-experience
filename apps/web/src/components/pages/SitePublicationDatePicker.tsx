"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Occurrence } from "@niho-experience/api-client";
import type { SitePublicExperience } from "@/lib/experience/site-publications";
import { getSiteBookingApi } from "@/lib/browser-api";
import { BookingCalendar } from "@/components/BookingCalendar";
import { buttonClass } from "@/components/ui";
import { formatTime, formatYen, jstDateKey } from "@/lib/format";
import { calendarDayLabel, occurrenceStartTime } from "@/lib/experience/booking-calendar";
import { expectedSiteBookingTotalYen } from "@/lib/experience/site-booking-rules";
import { cancellationSummary } from "@/lib/experience/site-card-model";
import { bookingCloseOf } from "@/components/NextDateBand";
import { dayOption } from "@/lib/date-filter";
import { jaYen } from "@/lib/ja-catalog";

type Props = {
  readonly item: SitePublicExperience;
  readonly locale: "en" | "ja";
  readonly siteOrigin: string;
  readonly bookingHref: string;
  readonly nextDates: readonly Occurrence[];
  readonly inquiryHref: string | null;
  readonly enabled: boolean;
  readonly priceFrom: number;
  readonly ratingLabel: string | null;
};

/** Date, occurrence and party selection stays on the detail page; only public selector values go to /book. */
export function SitePublicationDatePicker({ item, locale, siteOrigin, bookingHref, nextDates, inquiryHref, enabled, priceFrom, ratingLabel }: Props) {
  const card = useRef<HTMLElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [dialogStyle, setDialogStyle] = useState<CSSProperties>({});
  const [availability, setAvailability] = useState<{ state: "idle" | "loading" | "failed" | "ready"; occurrences: Occurrence[] }>({ state: "idle", occurrences: [] });
  const [selected, setSelected] = useState<Occurrence | null>(null);
  const [pendingDate, setPendingDate] = useState<{ readonly date: string; readonly offerId: string } | null>(null);
  const [adults, setAdults] = useState(1);
  const [children, setChildren] = useState(0);
  const [api] = useState(() => getSiteBookingApi(siteOrigin, locale));
  const offers = item.saleTerms?.offers ?? [];
  const offersById = useMemo(() => new Map(offers.map((offer) => [offer.id, offer])), [offers]);
  const offer = selected ? offersById.get(selected.offerId) : undefined;
  const selectedOccurrence = selected && availability.state === "ready"
    ? availability.occurrences.find((occurrence) => occurrence.offerId === selected.offerId && occurrence.date === selected.date && occurrence.bookable) ?? null
    : null;
  const total = offer && selectedOccurrence ? expectedSiteBookingTotalYen(offer, adults, children) : null;
  const ja = locale === "ja";
  const money = (amount: number) => ja ? jaYen(amount) : formatYen(amount, locale);
  const approval = offers.some((candidate) => candidate.acceptanceMode === "APPROVAL");
  const query = selectedOccurrence && offer && total !== null
    ? `?date=${encodeURIComponent(selectedOccurrence.date)}&offer=${encodeURIComponent(offer.id)}&adults=${adults}&children=${children}`
    : "";
  const selectionHref = `${bookingHref}${query}`;
  const partySize = adults + children;
  const partyLabel = ja ? `大人${adults}名${children > 0 ? `・子ども${children}名` : ""}` : `${adults} adults${children > 0 ? `, ${children} children` : ""}`;
  const selectedClose = selectedOccurrence ? bookingCloseOf(selectedOccurrence) : null;
  const cardActionLabel = selectedOccurrence && total !== null
    ? approval ? (ja ? "申込みへ進む" : "Request to book") : (ja ? "予約へ進む" : "Continue to book")
    : approval ? (ja ? "申込みへ進む" : "Request to book") : (ja ? "日にちを選ぶ" : "Choose a date");

  function positionDialog() {
    if (typeof window === "undefined") return;
    if (window.matchMedia("(max-width: 1023px)").matches) {
      setDialogStyle({ top: "auto", right: 0, bottom: 0, left: 0, width: "100vw", maxWidth: "none" });
      return;
    }
    const rect = card.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(560, window.innerWidth - 32);
    const height = Math.min(760, window.innerHeight * 0.9);
    const left = Math.max(16, Math.min(rect.left, window.innerWidth - width - 16));
    const top = Math.max(16, Math.min(rect.bottom + 8, window.innerHeight - height - 16));
    setDialogStyle({ top, left, width, maxWidth: width });
  }

  function openPicker(trigger: HTMLElement, date?: { readonly date: string; readonly offerId: string }) {
    opener.current = trigger;
    setPendingDate(date ?? null);
    positionDialog();
    setOpen(true);
  }

  function closePicker() {
    dialog.current?.close();
  }

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const reposition = () => positionDialog();
    window.addEventListener("resize", reposition);
    return () => window.removeEventListener("resize", reposition);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setAvailability({ state: "loading", occurrences: [] });
    api.getAvailability(item.publication.slug).then((result) => {
      if (!active) return;
      if (!result.ok) {
        setAvailability({ state: "failed", occurrences: [] });
        setSelected(null);
        return;
      }
      const offerIds = new Set(offers.map((candidate) => candidate.id));
      const fresh = result.data.occurrences.filter((occurrence) => offerIds.has(occurrence.offerId));
      setAvailability({ state: "ready", occurrences: fresh });
      setSelected((current) => current
        ? fresh.find((occurrence) => occurrence.bookable && occurrence.offerId === current.offerId && occurrence.date === current.date) ?? null
        : null);
    }).catch(() => {
      if (active) {
        setAvailability({ state: "failed", occurrences: [] });
        setSelected(null);
      }
    });
    return () => { active = false; };
  }, [api, item.publication.slug, offers, open]);

  function chooseOccurrence(occurrence: Occurrence) {
    const nextOffer = offersById.get(occurrence.offerId);
    if (!nextOffer || !occurrence.bookable) return;
    setSelected(occurrence);
    setAdults(nextOffer.minimumParticipants);
    setChildren(0);
  }

  useEffect(() => {
    if (availability.state !== "ready" || !pendingDate) return;
    const occurrence = availability.occurrences.find((candidate) => candidate.bookable && candidate.date === pendingDate.date && candidate.offerId === pendingDate.offerId);
    setPendingDate(null);
    if (occurrence) chooseOccurrence(occurrence);
  }, [availability, pendingDate, offersById]);

  useEffect(() => {
    if (availability.state !== "ready" || !selectedOccurrence || !offer) return;
    const max = Math.min(selectedOccurrence.seatsLeft, offer.maxPartySize);
    if (partySize > max) {
      setAdults(offer.minimumParticipants);
      setChildren(0);
    }
  }, [availability.state, selectedOccurrence?.seatsLeft, offer?.maxPartySize, offer?.minimumParticipants, partySize]);

  const setPartyCount = (kind: "adults" | "children", nextValue: number) => {
    if (kind === "adults") setAdults(nextValue);
    else setChildren(nextValue);
  };

  const button = (mobile = false) => <a
    href={selectionHref || bookingHref}
    onClick={(event) => {
      if (selectedOccurrence && total !== null) return;
      if (enabled && typeof dialog.current?.showModal === "function") {
        event.preventDefault();
        openPicker(event.currentTarget, undefined);
      }
    }}
    className={buttonClass("primary", mobile ? "w-auto min-w-[132px] whitespace-nowrap" : "mt-4 w-full")}
  >{cardActionLabel}</a>;

  const closeLine = selectedClose
    ? `${ja ? "予約締切：" : "Book by "}${dayOption(jstDateKey(selectedClose), locale).label} · ${formatTime(selectedClose, locale)} JST`
    : null;
  const cancellation = offer ? cancellationSummary(offer, locale) : null;
  const minimumCharge = offer && offer.minimumChargeableParticipants > 1
    ? ja ? `最低請求人数 ${offer.minimumChargeableParticipants}名` : `Minimum charge: ${offer.minimumChargeableParticipants} guests`
    : null;

  return <>
    <section ref={card} id="book" aria-label={ja ? "予約" : "Booking"} className="rounded-[var(--radius-card)] border border-line bg-white p-5">
      <p className="eyebrow">{ja ? "料金" : "From"}</p>
      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-3xl font-extrabold">{money(priceFrom)} <span className="text-sm font-normal">{ja ? "大人1名から" : "per adult"}</span>{ratingLabel ? <span className="text-sm font-bold text-moss">{ratingLabel}</span> : null}</p>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <button type="button" onClick={(event) => openPicker(event.currentTarget, undefined)} className="min-h-[60px] min-w-0 rounded-xl border border-line-strong px-3 py-2 text-left hover:bg-sand">
          <span className="block text-xs font-bold text-ink-soft">{ja ? "日にち" : "Date"}</span>
          <span className="block truncate font-extrabold">{selectedOccurrence ? calendarDayLabel(selectedOccurrence.date, locale) : ja ? "選択する" : "Choose"}</span>
        </button>
        <button type="button" onClick={(event) => openPicker(event.currentTarget, undefined)} className="min-h-[60px] min-w-0 rounded-xl border border-line-strong px-3 py-2 text-left hover:bg-sand">
          <span className="block text-xs font-bold text-ink-soft">{ja ? "人数" : "Party size"}</span>
          <span className="block truncate font-extrabold">{selectedOccurrence ? partyLabel : ja ? "選択する" : "Choose"}</span>
        </button>
      </div>
      {nextDates.length ? <div className="mt-4" aria-label={ja ? "近日の開催日" : "Upcoming dates"}>
        <p className="mb-2 text-xs font-extrabold text-ink-soft">{ja ? "近い開催日" : "Upcoming dates"}</p>
        <div className="flex flex-wrap gap-2">{nextDates.slice(0, 3).map((date) => <button key={`${date.offerId}-${date.date}`} type="button" onClick={(event) => openPicker(event.currentTarget, { date: date.date, offerId: date.offerId })} className="min-h-10 rounded-full border border-line-strong bg-white px-3 text-sm font-bold hover:bg-sand">{calendarDayLabel(date.date, locale)}</button>)}</div>
      </div> : null}
      {selectedOccurrence ? <div className="mt-4 grid gap-2 rounded-xl bg-sand p-3 text-sm">
        <p className="font-extrabold">{calendarDayLabel(selectedOccurrence.date, locale)} · {occurrenceStartTime(selectedOccurrence.startAt, locale)} JST</p>
        <p className="text-ink-soft">{ja ? `残り ${selectedOccurrence.seatsLeft} 席` : `${selectedOccurrence.seatsLeft} places left`}</p>
        <p className="flex justify-between gap-3 border-t border-line-strong pt-2"><span>{ja ? "合計" : "Total"}</span><b>{total === null ? ja ? "人数を確認してください" : "Check party size" : money(total)}</b></p>
        {cancellation ? <p className="border-t border-line-strong pt-2 text-ink-soft">{cancellation}</p> : null}
        {minimumCharge ? <p className="text-xs text-ink-soft">{minimumCharge}</p> : null}
      </div> : null}
      {button()}
      {closeLine ? <p className="mt-3 text-[0.8125rem] text-ink-soft">{closeLine}</p> : null}
    </section>
    {inquiryHref ? <a href={inquiryHref} className="mt-3 inline-flex min-h-11 items-center font-bold text-moss underline underline-offset-4">{ja ? "ほかの日・グループの相談" : "Ask about other dates or a group"}</a> : null}
    <dialog
      ref={dialog}
      aria-labelledby="experience-date-picker-title"
      onClose={() => {
        setOpen(false);
        const target = opener.current;
        requestAnimationFrame(() => target?.focus());
      }}
      onClick={(event) => { if (event.target === event.currentTarget) closePicker(); }}
      style={dialogStyle}
      className="fixed m-0 max-h-[92dvh] w-full max-w-none overflow-y-auto rounded-t-[22px] rounded-b-none border border-line bg-white p-0 text-ink shadow-2xl backdrop:bg-ink/45 lg:max-h-[min(90dvh,760px)] lg:rounded-[var(--radius-card)]"
    >
      <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-line bg-white px-5 py-4 sm:px-7">
        <div><h2 id="experience-date-picker-title" className="text-xl font-extrabold">{ja ? "日にちと人数を選ぶ" : "Choose a date and party size"}</h2><p className="mt-1 text-sm text-ink-soft">{ja ? `大人1名 ${money(priceFrom)}〜` : `From ${money(priceFrom)} per adult`}</p></div>
        <button type="button" autoFocus onClick={closePicker} className="grid size-11 shrink-0 place-items-center rounded-full border border-line-strong text-2xl" aria-label={ja ? "閉じる" : "Close"}>×</button>
      </div>
      <div className="grid gap-5 p-5 sm:p-7">
        <div role="group" aria-label={ja ? "開催日" : "Available dates"}>
          <BookingCalendar occurrences={availability.occurrences} value={selectedOccurrence?.date ?? ""} offerId={selectedOccurrence?.offerId ?? ""} onChange={chooseOccurrence} locale={locale} loading={availability.state === "idle" || availability.state === "loading"} failed={availability.state === "failed"} />
          {availability.state === "failed" ? <p role="alert" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-950">{ja ? "開催日を読み込めませんでした。ページを再読み込みしてください。" : "We couldn’t load available dates. Reload the page to try again."}</p> : null}
        </div>
        {selectedOccurrence && offer ? <>
          <div className="grid gap-3 rounded-2xl bg-sand p-4">
            <p className="font-extrabold">{calendarDayLabel(selectedOccurrence.date, locale)} · {occurrenceStartTime(selectedOccurrence.startAt, locale)} JST</p>
            <p className="text-sm text-ink-soft">{ja ? `残り ${selectedOccurrence.seatsLeft} 席` : `${selectedOccurrence.seatsLeft} places left`}</p>
            {closeLine ? <p className="text-sm text-ink-soft">{closeLine}</p> : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <PartyStepper label={ja ? "大人" : "Adults"} value={adults} price={offer.pricing.adultPriceYen} locale={locale} disabledMinus={adults <= 0 || partySize - 1 < offer.minimumParticipants || (children > 0 && Boolean(offer.pricing.child?.adultRequired) && adults <= 1)} disabledPlus={partySize >= Math.min(selectedOccurrence.seatsLeft, offer.maxPartySize)} onChange={(value) => setPartyCount("adults", value)} />
              {offer.pricing.child ? <PartyStepper label={ja ? `子ども（${offer.pricing.child.minAge}〜${offer.pricing.child.maxAge}歳）` : `Children (${offer.pricing.child.minAge}–${offer.pricing.child.maxAge})`} value={children} price={offer.pricing.child.priceYen} locale={locale} disabledMinus={children <= 0 || partySize - 1 < offer.minimumParticipants} disabledPlus={partySize >= Math.min(selectedOccurrence.seatsLeft, offer.maxPartySize)} onChange={(value) => setPartyCount("children", value)} /> : null}
            </div>
            <p className="text-sm text-ink-soft">{ja ? `参加人数 ${partyLabel}` : partyLabel}</p>
            <div className="flex items-center justify-between border-t border-line-strong pt-3"><span className="font-bold">{ja ? "合計" : "Total"}</span><b className="text-lg">{total === null ? (ja ? "人数を確認してください" : "Check party size") : money(total)}</b></div>
            {minimumCharge ? <p className="text-xs text-ink-soft">{minimumCharge}</p> : null}
          </div>
          <p className="text-xs text-muted">{ja ? "次の画面で連絡先と同意内容を入力します。お名前やメールアドレスはURLに含まれません。" : "Add your contact details and consent on the next page. Names and email addresses are never included in the URL."}</p>
          <a href={selectionHref || bookingHref} aria-disabled={total === null ? true : undefined} onClick={(event) => { if (total === null) event.preventDefault(); }} className={buttonClass("primary", "w-full")}>
            {approval ? ja ? "申込みへ進む" : "Request to book" : ja ? "予約へ進む" : "Continue to book"}
          </a>
        </> : <p className="text-sm text-ink-soft">{ja ? "開催日を選ぶと、開始時刻と参加人数を選べます。" : "Choose a date to see its start time and party size options."}</p>}
      </div>
    </dialog>
    {enabled ? <div className="fixed inset-x-0 bottom-0 z-30 flex items-center justify-between gap-3 border-t border-line bg-white px-4 py-3 lg:hidden">
      <p className="min-w-0 text-[0.9375rem]">{selectedOccurrence && total !== null ? <><b className="block truncate">{money(total)}</b><span className="block truncate text-[0.75rem] text-ink-soft">{calendarDayLabel(selectedOccurrence.date, locale)} · {partyLabel}</span></> : <><b className="text-[1.125rem]">{money(priceFrom)}</b><span className="text-[0.8125rem] text-ink-soft">{ja ? "〜 / 人" : " / adult"}{nextDates[0] ? ` · ${ja ? "次回" : "Next"} ${calendarDayLabel(nextDates[0].date, locale)}` : ""}</span></>}</p>
      {selectedOccurrence && total !== null
        ? <a href={selectionHref} className={buttonClass("primary", "w-auto min-w-[132px] whitespace-nowrap")}>{approval ? ja ? "申込みへ進む" : "Request to book" : ja ? "予約へ進む" : "Continue to book"}</a>
        : <button type="button" onClick={(event) => openPicker(event.currentTarget, undefined)} className={buttonClass("primary", "w-auto min-w-[132px] whitespace-nowrap")}>{approval ? ja ? "申込みへ進む" : "Request to book" : ja ? "日にちを選ぶ" : "Choose a date"}</button>}
    </div> : null}
  </>;
}

function PartyStepper({ label, value, price, locale, disabledMinus, disabledPlus, onChange }: {
  label: string;
  value: number;
  price: number;
  locale: "en" | "ja";
  disabledMinus: boolean;
  disabledPlus: boolean;
  onChange: (value: number) => void;
}) {
  return <div className="flex min-h-12 min-w-0 items-center justify-between gap-2 rounded-xl border border-line-strong bg-white px-3">
    <span className="min-w-0 text-sm font-bold">{label}<span className="block text-xs font-normal text-ink-soft">{locale === "ja" ? jaYen(price) : formatYen(price, locale)} {locale === "ja" ? "/人" : "each"}</span></span><div className="flex shrink-0 items-center gap-2">
      <button type="button" aria-label={`${label} −`} disabled={disabledMinus} onClick={() => onChange(Math.max(0, value - 1))} className="grid size-9 place-items-center rounded-full border border-line-strong disabled:opacity-40">−</button>
      <output className="min-w-5 text-center font-extrabold" aria-live="polite">{value}</output>
      <button type="button" aria-label={`${label} +`} disabled={disabledPlus} onClick={() => onChange(value + 1)} className="grid size-9 place-items-center rounded-full border border-line-strong disabled:opacity-40">+</button>
    </div>
  </div>;
}
