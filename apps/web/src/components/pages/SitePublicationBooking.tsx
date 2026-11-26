"use client";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type MouseEvent } from "react";
import type { ExperienceApiClient, ExperienceCheckoutRequest, Occurrence } from "@niho-experience/api-client";
import { createClientRequestKey } from "@niho-experience/api-client";
import { getSiteBookingApi } from "@/lib/browser-api";
import { formatYen } from "@/lib/format";
import { cancellationSummary, scheduleDescription } from "@/lib/experience/site-card-model";
import { attributionWithDefault, readBookingAttribution, type BookingAttribution } from "@/lib/booking-attribution";
import { bookingReturnCopy, readReturnType, type BookingReturnType } from "@/lib/booking-return-copy";
import { calendarDayLabel, occurrenceStartTime } from "@/lib/experience/booking-calendar";
import { doNotTrackEnabled } from "@/lib/analytics";
import { embedParentOrigin, leaveFrameTo, postEmbedTop, useEmbedFrame } from "@/lib/experience/embed-frame";
import { BookingCalendar } from "@/components/BookingCalendar";
import { expectedSiteBookingTotalYen } from "@/lib/experience/site-booking-rules";
import { answersForCheckout } from "@/lib/experience/site-booking-answers";
import type { SitePublicExperience, SitePublicOffer } from "@/lib/experience/site-publications";
import { siteSellerDisplayName, siteSellerInformationHref } from "@/lib/experience/site-seller-information";
import { buttonClass } from "@/components/ui";

type QuestionAnswers = Record<string, string | string[]>;
const FIELD_LABEL = "grid min-w-0 grid-cols-1 gap-2 text-sm font-extrabold";
const FIELD_INPUT = "min-h-12 w-full min-w-0 rounded-xl border border-line-strong px-3 text-base font-normal";
const FIELD_SELECT = `${FIELD_INPUT} truncate`;
const FIELD_TEXTAREA = "min-h-24 w-full min-w-0 rounded-xl border border-line-strong p-3 text-base font-normal";
const FORM_FRAME = "rounded-[var(--radius-card)] border border-line bg-white p-5 sm:p-7";
const PRIMARY_BUTTON = "min-h-12 rounded-full bg-ink px-6 font-extrabold text-white disabled:cursor-not-allowed disabled:opacity-45";
const UNAVAILABLE = "rounded-2xl bg-sand p-5 text-ink-soft";

/** What the checkout route reads beside NIHO's request: the sales plan revision, and the widget's sales channel (#638). */
type EmbedChannelFields = { salesPlanRevision?: number; salesChannel?: "embed"; embedOrigin?: string };

/** The embedded widget's steps (#638, docs/embed.md「旅行者の流れ」): 1 date and guests, 2 details, 3 pay (or done). */
type EmbedStep = 1 | 2 | 3;
type EmbedOutcome = { readonly kind: "pay"; readonly checkoutUrl: string } | { readonly kind: "done"; readonly type: BookingReturnType | null; readonly free: boolean };
export type SiteBookingSelection = { readonly date: string; readonly offerId: string; readonly adults: number; readonly children: number };

/**
 * The booking form. `layout="page"` is the public booking page: one screen, and checkout opens on its own after the request.
 * `layout="embed"` is the widget another site frames (/embed, docs/embed.md): the same fields in three steps; payment opens
 * in the top window only from a button the traveler presses, and a booking that needs no payment ends inside the frame.
 */
export function SitePublicationBooking({ item, siteOrigin, consentVersion, bookingsEnabled, locale = "en", attributionEnabled = false, layout = "page", preview = false, defaultAttribution, initialSelection = null }: { item: SitePublicExperience; siteOrigin: string; consentVersion: string; bookingsEnabled: boolean; locale?: "en" | "ja"; attributionEnabled?: boolean; layout?: "page" | "embed"; preview?: boolean; defaultAttribution?: BookingAttribution; initialSelection?: SiteBookingSelection | null }) {
  const embed = layout === "embed";
  const { publication, saleTerms } = item;
  const ja = locale === "ja";
  const sellerInformationUrl = siteSellerInformationHref(item, locale);
  const sellerInformationName = siteSellerDisplayName(item, locale);
  const offers = saleTerms?.offers ?? [];
  const firstOffer = offers[0];
  const [api] = useState<ExperienceApiClient>(() => getSiteBookingApi(siteOrigin, locale));
  // An offer is one 開催枠 of this experience (a schedule rule: its start time, and its price when the host set one). The
  // traveler chooses a date, and the date chooses the offer; until then the first offer stands for the terms all offers share.
  const [offerId, setOfferId] = useState(firstOffer?.id ?? "");
  const [availability, setAvailability] = useState<{ state: "loading" | "failed" | "ready"; occurrences: Occurrence[] }>({ state: "loading", occurrences: [] });
  // Counts the availability reads asked for: one on arrival, one more after a date turned out to be taken.
  const [availabilityRead, setAvailabilityRead] = useState(0);
  const loading = availability.state === "loading";
  const loadError = availability.state === "failed";
  // Every offer's dates in one calendar. One array per availability read: the calendar keeps the month the traveler turned
  // to while other fields re-render the form.
  const occurrences = useMemo(() => {
    const offerIds = new Set((saleTerms?.offers ?? []).map((item) => item.id));
    return availability.occurrences.filter((occurrence) => offerIds.has(occurrence.offerId));
  }, [availability, saleTerms]);
  const [date, setDate] = useState("");
  const [adults, setAdults] = useState(1);
  const [children, setChildren] = useState(0);
  const [validatedInitialSelection, setValidatedInitialSelection] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [answers, setAnswers] = useState<QuestionAnswers>({});
  const [agreed, setAgreed] = useState(false);
  const [problem, setProblem] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const [step, setStep] = useState<EmbedStep>(1);
  const [outcome, setOutcome] = useState<EmbedOutcome | null>(null);
  const embedRoot = useRef<HTMLDivElement>(null);
  const shownStep = useRef<EmbedStep>(1);
  const dateHeadingId = useId();
  useEmbedFrame(embedRoot, embed);
  const offer = offers.find((candidate) => candidate.id === offerId);
  const approval = offer?.acceptanceMode === "APPROVAL";
  const selectedOccurrence = occurrences.find((occurrence) => occurrence.offerId === offerId && occurrence.date === date);
  const selectedPartyFitsSeats = !selectedOccurrence || adults + children <= selectedOccurrence.seatsLeft;
  const total = offer && selectedPartyFitsSeats ? expectedSiteBookingTotalYen(offer, adults, children) : null;
  // 無料（0円）の予約は決済に進まず、そのまま確定する。支払い前提の文言を出さない（#59）。
  const free = !approval && total === 0;
  const submitLabel = approval
    ? (submitting ? (ja ? "リクエストを送信中…" : "Sending your request…") : (ja ? "予約をリクエストする" : "Send booking request"))
    : free
      ? (submitting ? (ja ? "予約を確定しています…" : "Confirming your booking…") : (ja ? "無料で予約する" : "Book for free"))
      : (submitting ? (ja ? "決済を開いています…" : "Opening secure checkout…") : (ja ? "安全な決済へ進む" : "Continue to secure checkout"));
  const connectionError = approval
    ? (ja ? "リクエストを送信できませんでした。再度お試しください。" : "We couldn’t send your request. Please try again.")
    : free
      ? (ja ? "予約を確定できませんでした。再度お試しください。" : "We couldn't confirm your booking. You can retry this request safely.")
      : (ja ? "決済に接続できませんでした。再度お試しください。" : "We couldn't reach checkout. You can retry this request safely.");
  const validAnswers = offer?.bookingQuestions.every((question) => {
    const answer = answers[question.id];
    return !question.required || (Array.isArray(answer) ? answer.length > 0 : typeof answer === "string" && answer.trim().length > 0);
  }) ?? false;

  // A new step starts at the frame's top: ask the parent page to scroll there (nothing else is sent).
  useEffect(() => {
    if (!embed || shownStep.current === step) return;
    shownStep.current = step;
    // A frame of fixed height (pasted as a URL only) scrolls inside itself: the new step starts at its top there too.
    window.scrollTo(0, 0);
    postEmbedTop();
  }, [embed, step]);

  const sold = offers.length > 0;
  useEffect(() => {
    if (!sold) return;
    let active = true;
    api.getAvailability(publication.slug).then((result) => {
      if (!active) return;
      if (!result.ok) { setAvailability({ state: "failed", occurrences: [] }); setDate(""); setValidatedInitialSelection(false); return; }
      const freshOccurrences = result.data.occurrences.filter((occurrence) => offers.some((item) => item.id === occurrence.offerId));
      setAvailability({ state: "ready", occurrences: freshOccurrences });
      const incoming = availabilityRead === 0 && initialSelection && freshOccurrences.find((occurrence) => occurrence.offerId === initialSelection.offerId && occurrence.date === initialSelection.date && occurrence.bookable);
      const incomingOffer = incoming ? offers.find((item) => item.id === incoming.offerId) : undefined;
      const incomingPartyFitsSeats = incoming && initialSelection && initialSelection.adults + initialSelection.children <= incoming.seatsLeft;
      if (incoming && incomingOffer && initialSelection && incomingPartyFitsSeats && expectedSiteBookingTotalYen(incomingOffer, initialSelection.adults, initialSelection.children) !== null) {
        setDate(incoming.date);
        setOfferId(incoming.offerId);
        setAdults(initialSelection.adults);
        setChildren(initialSelection.children);
        setValidatedInitialSelection(true);
      } else {
        setDate("");
        setValidatedInitialSelection(false);
      }
    }).catch(() => { if (active) { setAvailability({ state: "failed", occurrences: [] }); setDate(""); setValidatedInitialSelection(false); } });
    return () => { active = false; };
  }, [api, publication.slug, sold, availabilityRead, initialSelection, offers]);

  /** A day of the calendar, or one of its start times: the date and the offer held then. */
  function chooseOccurrence(occurrence: Occurrence) {
    const next = offers.find((item) => item.id === occurrence.offerId);
    if (!next || !occurrence.bookable) return;
    setDate(occurrence.date);
    setOfferId(next.id);
    setValidatedInitialSelection(false);
    if (!next.pricing.child) setChildren(0);
    // The questions belong to the experience: answers stay when the date changes, unless that offer asks something else.
    if (next.bookingQuestionsFingerprint !== offer?.bookingQuestionsFingerprint) setAnswers({});
  }

  function updateAnswer(questionId: string, value: string | string[]) {
    setAnswers((current) => ({ ...current, [questionId]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!api || !offer || !selectedOccurrence?.bookable || total === null || !agreed || !validAnswers || submitting) return;
    if (embed && (step !== 2 || preview)) return;
    setProblem("");
    const answersBody = answersForCheckout(offer.bookingQuestions, answers);
    // 販売経路 (#638): the widget says it is embedded, with the framing page's origin when the browser tells it (never a path).
    // Under Do Not Track the origin is not sent, as the utm_* marks; the channel still is.
    const parentOrigin = embed && !doNotTrackEnabled(navigator.doNotTrack) ? embedParentOrigin() : null;
    const bodyWithoutKey: Omit<ExperienceCheckoutRequest, "clientRequestKey"> & EmbedChannelFields = {
      offerId: offer.id,
      occurrenceDate: date,
      adultCount: adults,
      childCount: children,
      expectedTotalYen: total,
      bookingQuestionsFingerprint: offer.bookingQuestionsFingerprint,
      guestName: name.trim(),
      guestEmail: email.trim(),
      ...(note.trim() ? { note: note.trim() } : {}),
      answers: answersBody,
      consent: { agreedVersion: consentVersion },
      ...(saleTerms?.salesPlanRevision === undefined ? {} : { salesPlanRevision: saleTerms.salesPlanRevision }),
      // 流入の印（utm_*）：最初の流入だけをメモリに持ち、Do Not Track なら送らない（lib/booking-attribution.ts）。
      // The widget's default mark (utm_source=provider, utm_medium=embed) goes under what was captured, and never with Do Not Track.
      ...(attributionEnabled ? attributionForCheckout(defaultAttribution) : {}),
      ...(embed ? { salesChannel: "embed" as const, ...(parentOrigin === null ? {} : { embedOrigin: parentOrigin }) } : {}),
    };
    const signature = JSON.stringify(bodyWithoutKey);
    if (attempt.current?.signature !== signature) attempt.current = { signature, key: createClientRequestKey() };
    const body: ExperienceCheckoutRequest & EmbedChannelFields = { ...bodyWithoutKey, clientRequestKey: attempt.current.key };
    setSubmitting(true);
    try {
      const result = await api.startCheckout(publication.slug, body);
      if (result.ok) {
        if (embed) { showEmbedOutcome(result.checkoutUrl); return; }
        window.location.assign(result.checkoutUrl);
        return;
      }
      if (result.kind === "rejected") {
        const code = result.error.code;
        if (code === "PRICE_CHANGED" || code === "QUESTIONS_CHANGED" || code === "CONSENT_OUTDATED") {
          setProblem(ja ? "予約条件が変更されました。ページを再読み込みして料金と空き状況をご確認ください。" : "The booking details changed. Reload this page to review the latest terms and availability.");
          return;
        }
        if (code === "FULL" || code === "OCCURRENCE_INVALID" || code === "UNAVAILABLE") {
          setProblem(ja ? "この日時は予約できなくなりました。別の日時を選んでください。" : "That date is no longer available. Choose another date.");
          setDate("");
          // What the calendar shows is from before: read it again, so the start that just filled up is not chosen again.
          setAvailability({ state: "loading", occurrences: [] });
          setAvailabilityRead((count) => count + 1);
          if (embed) setStep(1);
          return;
        }
        if (code === "RATE_LIMITED") setProblem(ja ? "操作が多すぎます。少し待ってから再度お試しください。" : "Too many attempts. Please wait a moment and try again.");
        else setProblem(approval ? connectionError : free ? (ja ? "予約を確定できませんでした。入力内容を確認して再度お試しください。" : "We couldn't confirm your booking. Check the details and try again.") : ja ? "決済を開始できませんでした。入力内容を確認して再度お試しください。" : "We couldn't start checkout. Check the details and try again.");
      } else {
        setProblem(connectionError);
      }
    } catch {
      setProblem(connectionError);
    } finally {
      setSubmitting(false);
    }
  }

  /** Where checkout answered decides the last step: Stripe is paid in the top window, this site's return page ends here. */
  function showEmbedOutcome(checkoutUrl: string) {
    let target: URL;
    try { target = new URL(checkoutUrl, siteOrigin); } catch { setProblem(connectionError); return; }
    if (target.origin !== siteOrigin) {
      setOutcome({ kind: "pay", checkoutUrl: target.href });
    } else {
      setOutcome({ kind: "done", type: readReturnType(target.searchParams.get("type")), free: target.searchParams.get("payment") === "free" });
    }
    setStep(3);
  }

  function payInTopWindow(event: MouseEvent<HTMLAnchorElement>, checkoutUrl: string) {
    // When nothing was opened (not an https address), the link itself still goes to the top window.
    if (leaveFrameTo(checkoutUrl) !== null) event.preventDefault();
  }

  function continueToDetails() {
    if (preview || !selectedOccurrence?.bookable || total === null) return;
    setProblem("");
    setStep(2);
  }

  if (!bookingsEnabled || !saleTerms || !firstOffer) {
    const unavailable = <p role="status" className={UNAVAILABLE}>{ja ? "現在、この体験はオンライン予約できません。" : "Online booking is temporarily unavailable for this experience."}</p>;
    return embed ? <EmbedRoot rootRef={embedRoot} siteOrigin={siteOrigin}>{unavailable}</EmbedRoot> : unavailable;
  }

  const pricePerAdult = (item: SitePublicOffer) => `${formatYen(item.pricing.adultPriceYen, locale)} ${ja ? "/ 大人1名" : "per adult"}`;
  const heading = <h1 className="text-3xl">{approval ? (ja ? `${publication.japanese!.title}の予約リクエスト` : `Request to book ${publication.publicTitle}`) : (ja ? `${publication.japanese!.title}を予約` : `Book ${publication.publicTitle}`)}</h1>;
  // The cancellation terms and the minimum charge, as one line: beside the dates, and again where the traveler agrees to them.
  const cancellationLine = offer ? `${cancellationSummary(offer, locale)}${offer.minimumChargeableParticipants > 1 ? (ja ? ` · 最低請求人数は${offer.minimumChargeableParticipants}名` : ` · Minimum charge is ${offer.minimumChargeableParticipants} guests`) : ""}` : "";
  // Several offers are the same experience at other times: the calendar holds all their dates, and what differs between
  // them (start time, length, price) is said for the chosen date. Before a date, only what every offer shares is said.
  const oneOffer = offers.length === 1;
  const chosen = oneOffer || Boolean(selectedOccurrence);
  const onePrice = offers.every((item) => item.pricing.adultPriceYen === firstOffer.pricing.adultPriceYen);
  // "From": the lowest price a traveler can book now, not one of an offer without an open date.
  const open = new Set(occurrences.filter((occurrence) => occurrence.bookable).map((occurrence) => occurrence.offerId));
  const bookableOffers = offers.filter((item) => open.has(item.id));
  const lowestPrice = formatYen(Math.min(...(bookableOffers.length > 0 ? bookableOffers : offers).map((item) => item.pricing.adultPriceYen)), locale);
  const shownOffer = offer ?? firstOffer;
  const scheduleLine = oneOffer
    ? `${scheduleDescription(shownOffer, locale)} · ${formatDurationLabel(shownOffer.durationMinutes, locale)}`
    : chosen || offers.every((item) => item.durationMinutes === firstOffer.durationMinutes)
      ? `${ja ? "所要時間：" : "Duration: "}${formatDurationLabel(shownOffer.durationMinutes, locale)}`
      : null;
  const offerAndSchedule = <>
      <div className="wrap-anywhere text-sm">
        <p className="font-extrabold">{chosen || onePrice ? pricePerAdult(shownOffer) : ja ? `${lowestPrice}〜 / 大人1名` : `From ${lowestPrice} per adult`}</p>
        {chosen && shownOffer.name !== publication.publicTitle ? <p className="mt-1 text-ink-soft">{shownOffer.name}</p> : null}
      </div>
      {scheduleLine ? <p className="-mt-3 text-sm text-ink-soft">{scheduleLine}</p> : null}
      {offer ? <p className={`${scheduleLine ? "-mt-4" : "-mt-3"} text-sm text-ink-soft`}>{cancellationLine}</p> : null}
  </>;
  const dateField = <>
      <div role="group" aria-labelledby={dateHeadingId} className={FIELD_LABEL}>
        <p id={dateHeadingId}>{ja ? "日にち" : "Date"}</p>
        <BookingCalendar occurrences={occurrences} value={date} offerId={offerId} onChange={chooseOccurrence} locale={locale} loading={loading} failed={loadError}
          noteOf={onePrice ? undefined : (occurrence) => { const held = offers.find((item) => item.id === occurrence.offerId); return held ? pricePerAdult(held) : null; }} />
      </div>
      {loadError ? <p role="alert" className="text-sm text-red-700">{ja ? "空き状況を確認できませんでした。ページを再読み込みしてください。" : "Dates couldn’t be checked. Retry the page or contact us before paying."}</p> : null}
  </>;
  const guestCounts = <div className="grid grid-cols-2 gap-4">
        <label className={FIELD_LABEL}>{ja ? "大人の人数" : "Adults"}
          <input type="number" min={0} max={Math.min(offer?.maxPartySize ?? 1, selectedOccurrence?.seatsLeft ?? offer?.maxPartySize ?? 1)} value={adults} onChange={(event) => setAdults(Number(event.target.value))} className={FIELD_INPUT} />
        </label>
        {offer?.pricing.child ? <label className={FIELD_LABEL}>{ja ? "子どもの人数" : "Children"} ({offer.pricing.child.minAge}–{offer.pricing.child.maxAge}{ja ? "歳" : ""})
          <input type="number" min={0} max={Math.min(offer.maxPartySize, selectedOccurrence?.seatsLeft ?? offer.maxPartySize)} value={children} onChange={(event) => setChildren(Number(event.target.value))} className={FIELD_INPUT} />
        </label> : null}
      </div>;
  const questions = offer?.bookingQuestions.map((question) => <QuestionField key={question.id} question={question} value={answers[question.id]} onChange={(value) => updateAnswer(question.id, value)} locale={locale} />);
  const contactFields = <>
      <label className={FIELD_LABEL}>{ja ? "お名前" : "Full name"}
        <input required autoComplete="name" maxLength={200} value={name} onChange={(event) => setName(event.target.value)} className={FIELD_INPUT} />
      </label>
      <label className={FIELD_LABEL}>{ja ? "メールアドレス" : "Email"}
        <input type="email" required autoComplete="email" maxLength={320} value={email} onChange={(event) => setEmail(event.target.value)} className={FIELD_INPUT} />
      </label>
      <label className={FIELD_LABEL}>{ja ? "ホストに伝えておきたいこと" : "Note for your host"} <span className="font-normal text-muted">{ja ? "（任意）" : "Optional"}</span>
        <textarea maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} className={FIELD_TEXTAREA} />
      </label>
  </>;
  const totalBox = <div className="rounded-xl bg-sand p-4 text-sm">
        <div className="flex justify-between gap-3"><span>{ja ? "合計" : "Total"}</span><b>{!chosen && !onePrice ? ja ? "日にちを選んでください" : "Choose a date" : total === null ? ja ? "人数を確認してください" : "Check guest counts" : formatYen(total, locale)}</b></div>
        <p className="mt-2 text-ink-soft">{ja ? "最低請求人数がある場合は合計に含まれます。席を確保する前に最終金額を再確認します。" : "The total includes the offer’s minimum chargeable guest count where one is set. The final amount is checked again before a seat is held."}</p>
      </div>;
  const sellerAndConsent = <>
      {!sellerInformationUrl ? <p className="wrap-anywhere text-sm text-ink-soft">{ja ? `販売者：${sellerInformationName}` : `Sold by ${sellerInformationName}`}</p> : null}
      <label className="flex items-start gap-3 text-sm text-ink-soft">
        <input type="checkbox" required checked={agreed} onChange={(event) => setAgreed(event.target.checked)} className="mt-1 size-4 shrink-0" />
        <span className="min-w-0 wrap-anywhere">{ja ? "上記の予約・キャンセル条件と" : "I agree to the booking and cancellation conditions shown above and the "}<a className="font-extrabold underline" href="/privacy" target="_blank" rel="noreferrer">{ja ? "プライバシーポリシー" : "Privacy Policy"}</a>{sellerInformationUrl ? <>{ja ? "、および" : ", and "}<a className="underline underline-offset-2" href={sellerInformationUrl} target="_blank" rel="noreferrer">{ja ? `${sellerInformationName}の販売者情報` : `seller information for ${sellerInformationName}`}</a></> : null}{ja ? "に同意します。" : "."}</span>
      </label>
  </>;
  const problemAlert = problem ? <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{problem}</p> : null;
  const submitButton = <button type="submit" disabled={!api || !selectedOccurrence?.bookable || total === null || !agreed || !validAnswers || submitting || loading || loadError} className={embed ? PRIMARY_BUTTON : buttonClass("primary", "w-full")}>{submitLabel}</button>;
  const submitNote = <p className="text-center text-xs text-muted">{approval
        ? (ja ? "リクエスト時のお支払いはありません。承認後、事務局からお支払いリンクをメールでお送りします。" : "No payment is taken when you request. If NIHO approves your request, we’ll email you a payment link.")
        : free
          ? (ja ? "お支払いは不要です。氏名、メールアドレス、回答は予約の作成にのみ使用します。" : "No payment is needed. Your name, email and answers are sent only to create this booking.")
          : (ja ? "お支払い情報はStripe Checkoutで入力します。氏名、メールアドレス、回答は予約の作成にのみ使用します。" : "Payment details are entered on Stripe Checkout. Your name, email and answers are sent only to create this booking.")}</p>;
  const showValidatedSelection = validatedInitialSelection && Boolean(selectedOccurrence?.bookable) && total !== null;
  const validatedSelectionSummary = selectedOccurrence && showValidatedSelection ? <div className="grid gap-3 rounded-xl bg-sand p-4 text-sm">
    <div className="flex justify-between gap-3"><span>{ja ? "日時" : "Date and time"}</span><b className="text-right">{calendarDayLabel(selectedOccurrence.date, locale)} · {occurrenceStartTime(selectedOccurrence.startAt, locale)} JST</b></div>
    <div className="flex justify-between gap-3"><span>{ja ? "人数" : "Guests"}</span><b className="text-right">{guestCountLabel(adults, children, locale)}</b></div>
    <div className="flex justify-between gap-3 border-t border-line-strong pt-2"><span>{ja ? "合計" : "Total"}</span><b>{total === null ? "" : formatYen(total, locale)}</b></div>
    <button type="button" onClick={() => setValidatedInitialSelection(false)} className="justify-self-start text-sm font-extrabold text-moss underline underline-offset-4">{ja ? "日時・人数を変更する" : "Change date or party size"}</button>
  </div> : null;

  if (!embed) return <form onSubmit={submit} className={FORM_FRAME}>
    {heading}
    <div className="mt-6 grid grid-cols-1 gap-5">
      {offerAndSchedule}
      {showValidatedSelection ? validatedSelectionSummary : <>{dateField}{guestCounts}</>}
      {questions}
      {contactFields}
      {totalBox}
      {sellerAndConsent}
      {problemAlert}
      {submitButton}
      {submitNote}
    </div>
  </form>;

  const noPayment = approval || free;
  const stepNames = ja ? ["日にち", "お客さま情報", noPayment ? "完了" : "お支払い"] : ["Date", "Details", noPayment ? "Done" : "Pay"];
  const chosenSummary = selectedOccurrence ? <div className="grid gap-2 rounded-xl bg-sand p-4 text-sm">
    <div className="flex justify-between gap-3"><span>{ja ? "日時" : "Date"}</span><b className="text-right">{calendarDayLabel(selectedOccurrence.date, locale)} · {occurrenceStartTime(selectedOccurrence.startAt, locale)} JST</b></div>
    <div className="flex justify-between gap-3"><span>{ja ? "人数" : "Guests"}</span><b className="text-right">{guestCountLabel(adults, children, locale)}</b></div>
    <div className="flex justify-between gap-3"><span>{ja ? "合計" : "Total"}</span><b>{total === null ? "" : formatYen(total, locale)}</b></div>
    {/* The conditions the consent below refers to: step 1 showed them, and this step is where they are agreed to. */}
    {cancellationLine ? <p className="border-t border-line-strong pt-2 text-ink-soft">{cancellationLine}</p> : null}
  </div> : null;
  const done = outcome?.kind === "done" ? bookingReturnCopy(outcome.type, outcome.free, locale) : null;

  return <EmbedRoot rootRef={embedRoot} siteOrigin={siteOrigin}>
    <form onSubmit={submit} className={FORM_FRAME}>
      {heading}
      <ol className="mt-3.5 flex list-none gap-1.5 p-0 text-xs font-extrabold text-muted">
        {stepNames.map((name, index) => <li key={name} aria-current={step === index + 1 ? "step" : undefined} className={`flex-1 border-t-[3px] pt-1.5 ${step === index + 1 ? "border-ink text-ink" : "border-line"}`}>{index + 1} {name}</li>)}
      </ol>
      <div className="mt-6 grid grid-cols-1 gap-5">
        {step === 1 ? <>
          {/* On top: a date that filled up brings the traveler back here, and the parent page shows the frame from its top. */}
          {problemAlert}
          {offerAndSchedule}
          {dateField}
          {guestCounts}
          {totalBox}
          {preview ? <p role="status" className="rounded-xl bg-sand p-3 text-center text-sm text-ink-soft">{ja ? "プレビューです。ここでは予約できません。" : "Preview. Booking is turned off here."}</p> : null}
          <button type="button" onClick={continueToDetails} disabled={preview || !selectedOccurrence?.bookable || total === null || loading || loadError} className={PRIMARY_BUTTON}>{ja ? "次へ" : "Continue"}</button>
        </> : null}
        {step === 2 ? <>
          {chosenSummary}
          {questions}
          {contactFields}
          {sellerAndConsent}
          {problemAlert}
          {submitButton}
          <button type="button" onClick={() => setStep(1)} disabled={submitting} className="justify-self-center text-sm font-extrabold underline underline-offset-2 disabled:opacity-45">{ja ? "← 戻る" : "← Back"}</button>
          {submitNote}
        </> : null}
        {step === 3 && outcome?.kind === "pay" ? <>
          <div className="rounded-xl bg-leaf-pale p-4 text-sm">
            <b className="block font-extrabold">{ja ? "席を確保しました" : "Seats held"}</b>
            <span className="text-ink-soft">{ja ? "これから30分間、席を確保しています。" : "Your seats are held for the next 30 minutes."}</span>
          </div>
          {chosenSummary}
          <a href={outcome.checkoutUrl} target="_top" rel="noopener noreferrer" onClick={(event) => payInTopWindow(event, outcome.checkoutUrl)} className={`${PRIMARY_BUTTON} grid place-items-center text-center`}>{ja ? "Stripeで安全に支払う" : "Pay securely on Stripe"}</a>
          <a href={outcome.checkoutUrl} target="_blank" rel="noopener noreferrer" className="justify-self-center text-sm underline underline-offset-2">{ja ? "新しいタブで支払いを開く" : "Open payment in a new tab"}</a>
          <p className="text-center text-xs text-muted">{ja ? "このページを離れて、Stripeでお支払いいただきます。確認はあとでメールでお送りします。" : "You’ll leave this page to pay on Stripe. We email your confirmation afterwards."}</p>
        </> : null}
        {step === 3 && done ? <div role="status" className="rounded-xl bg-leaf-pale p-4">
          <h2 className="text-2xl">{done.heading}</h2>
          <p className="mt-2 text-ink-soft">{done.lead}</p>
        </div> : null}
      </div>
    </form>
  </EmbedRoot>;
}

/** The widget's frame: everything the parent page sizes, ending at "Powered by" with no space below it. */
function EmbedRoot({ rootRef, siteOrigin, children }: { rootRef: React.RefObject<HTMLDivElement | null>; siteOrigin: string; children: React.ReactNode }) {
  return <div data-embed-root ref={rootRef}>
    {children}
    <p className="mt-2 text-center text-xs text-muted"><a href={siteOrigin} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:underline">Powered by NIHO Travel</a></p>
  </div>;
}

/** The widget's message when the experience cannot be booked: 200 inside the frame, never a 404 page there. */
export function EmbedBookingUnavailable({ siteOrigin }: { siteOrigin: string }) {
  const root = useRef<HTMLDivElement>(null);
  useEmbedFrame(root, true);
  return <EmbedRoot rootRef={root} siteOrigin={siteOrigin}><p role="status" className={UNAVAILABLE}>Online booking is temporarily unavailable for this experience.</p></EmbedRoot>;
}

/** The mark sent with checkout: what this visit captured, over the widget's default; nothing at all with Do Not Track. */
function attributionForCheckout(defaultAttribution: BookingAttribution | undefined): BookingAttribution {
  return attributionWithDefault(defaultAttribution, readBookingAttribution(navigator.doNotTrack), navigator.doNotTrack);
}

function guestCountLabel(adults: number, children: number, locale: "en" | "ja"): string {
  if (locale === "ja") return [`大人${adults}名`, children > 0 ? `子ども${children}名` : ""].filter(Boolean).join("・");
  return [`${adults} ${adults === 1 ? "adult" : "adults"}`, children > 0 ? `${children} ${children === 1 ? "child" : "children"}` : ""].filter(Boolean).join(", ");
}

function formatDurationLabel(minutes: number, locale: "en" | "ja" = "en"): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return [hours ? `${hours}${locale === "ja" ? "時間" : " hr"}` : "", rest ? `${rest}${locale === "ja" ? "分" : " min"}` : ""].filter(Boolean).join(" ");
}

function QuestionField({ question, value, onChange, locale = "en" }: { question: SitePublicOffer["bookingQuestions"][number]; value: string | string[] | undefined; onChange: (value: string | string[]) => void; locale?: "en" | "ja" }) {
  const label = `${question.prompt}${question.required ? " *" : locale === "ja" ? "（任意）" : " (optional)"}`;
  if (question.inputType === "SINGLE_SELECT") return <label className={FIELD_LABEL}>{label}<select required={question.required} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)} className={FIELD_SELECT}><option value="">{locale === "ja" ? "回答を選択" : "Choose an answer"}</option>{question.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select>{question.description ? <small className="font-normal text-muted">{question.description}</small> : null}</label>;
  if (question.inputType === "MULTI_SELECT") return <fieldset className="grid min-w-0 grid-cols-1 gap-2 text-sm"><legend className="font-extrabold">{label}</legend>{question.options.map((option) => <label key={option.id} className="flex items-center gap-2"><input type="checkbox" checked={Array.isArray(value) && value.includes(option.id)} onChange={(event) => { const selected = new Set(Array.isArray(value) ? value : []); if (event.target.checked) selected.add(option.id); else selected.delete(option.id); onChange([...selected]); }} />{option.label}</label>)}{question.description ? <small className="text-muted">{question.description}</small> : null}</fieldset>;
  const textValue = typeof value === "string" ? value : "";
  return <label className={FIELD_LABEL}>{label}{question.inputType === "LONG_TEXT" ? <textarea required={question.required} maxLength={2000} value={textValue} onChange={(event) => onChange(event.target.value)} className={FIELD_TEXTAREA} /> : <input required={question.required} maxLength={500} value={textValue} onChange={(event) => onChange(event.target.value)} className={FIELD_INPUT} />}{question.description ? <small className="font-normal text-muted">{question.description}</small> : null}</label>;
}
