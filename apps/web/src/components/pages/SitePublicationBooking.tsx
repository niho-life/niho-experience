"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ExperienceApiClient, ExperienceCheckoutRequest, Occurrence } from "@niho-experience/api-client";
import { createClientRequestKey } from "@niho-experience/api-client";
import { getSiteBookingApi } from "@/lib/browser-api";
import { formatYen } from "@/lib/format";
import { cancellationSummary, scheduleDescription } from "@/lib/experience/site-card-model";
import { readBookingAttribution } from "@/lib/booking-attribution";
import { expectedSiteBookingTotalYen } from "@/lib/experience/site-booking-rules";
import { answersForCheckout } from "@/lib/experience/site-booking-answers";
import type { SitePublicExperience, SitePublicOffer } from "@/lib/experience/site-publications";
import { siteSellerDisplayName, siteSellerInformationHref } from "@/lib/experience/site-seller-information";

type QuestionAnswers = Record<string, string | string[]>;
const FIELD_LABEL = "grid min-w-0 grid-cols-1 gap-2 text-sm font-extrabold";
const FIELD_INPUT = "min-h-12 w-full min-w-0 rounded-xl border border-line-strong px-3 text-base font-normal";
const FIELD_SELECT = `${FIELD_INPUT} truncate`;
const FIELD_TEXTAREA = "min-h-24 w-full min-w-0 rounded-xl border border-line-strong p-3 text-base font-normal";

export function SitePublicationBooking({ item, siteOrigin, consentVersion, bookingsEnabled, locale = "en", attributionEnabled = false }: { item: SitePublicExperience; siteOrigin: string; consentVersion: string; bookingsEnabled: boolean; locale?: "en" | "ja"; attributionEnabled?: boolean }) {
  const { publication, saleTerms } = item;
  const ja = locale === "ja";
  const sellerInformationUrl = siteSellerInformationHref(item, locale);
  const sellerInformationName = siteSellerDisplayName(item, locale);
  const offers = saleTerms?.offers ?? [];
  const firstOffer = offers[0];
  const [api] = useState<ExperienceApiClient>(() => getSiteBookingApi(siteOrigin, locale));
  const [offerId, setOfferId] = useState(firstOffer?.id ?? "");
  const [availability, setAvailability] = useState<{ offerId: string; state: "loading" | "failed" | "ready"; occurrences: Occurrence[] }>({ offerId: firstOffer?.id ?? "", state: "loading", occurrences: [] });
  const loading = availability.offerId !== offerId || availability.state === "loading";
  const loadError = availability.offerId === offerId && availability.state === "failed";
  const occurrences = availability.offerId === offerId ? availability.occurrences : [];
  const [date, setDate] = useState("");
  const [adults, setAdults] = useState(1);
  const [children, setChildren] = useState(0);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [answers, setAnswers] = useState<QuestionAnswers>({});
  const [agreed, setAgreed] = useState(false);
  const [problem, setProblem] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const offer = offers.find((candidate) => candidate.id === offerId);
  const approval = offer?.acceptanceMode === "APPROVAL";
  const total = offer ? expectedSiteBookingTotalYen(offer, adults, children) : null;
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
  const selectedOccurrence = occurrences.find((occurrence) => occurrence.offerId === offerId && occurrence.date === date);
  const validAnswers = offer?.bookingQuestions.every((question) => {
    const answer = answers[question.id];
    return !question.required || (Array.isArray(answer) ? answer.length > 0 : typeof answer === "string" && answer.trim().length > 0);
  }) ?? false;

  useEffect(() => {
    if (!offerId) return;
    let active = true;
    api.getAvailability(publication.slug, { offerId }).then((result) => {
      if (!active) return;
      if (!result.ok) { setAvailability({ offerId, state: "failed", occurrences: [] }); setDate(""); return; }
      setAvailability({ offerId, state: "ready", occurrences: result.data.occurrences });
      setDate((current) => current && result.data.occurrences.some((item) => item.date === current && item.offerId === offerId && item.bookable) ? current : "");
    }).catch(() => { if (active) { setAvailability({ offerId, state: "failed", occurrences: [] }); setDate(""); } });
    return () => { active = false; };
  }, [api, publication.slug, offerId]);

  function updateAnswer(questionId: string, value: string | string[]) {
    setAnswers((current) => ({ ...current, [questionId]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!api || !offer || !selectedOccurrence?.bookable || total === null || !agreed || !validAnswers || submitting) return;
    setProblem("");
    const answersBody = answersForCheckout(offer.bookingQuestions, answers);
    const bodyWithoutKey: Omit<ExperienceCheckoutRequest, "clientRequestKey"> & { salesPlanRevision?: number } = {
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
      ...(attributionEnabled ? readBookingAttribution(navigator.doNotTrack) : {}),
    };
    const signature = JSON.stringify(bodyWithoutKey);
    if (attempt.current?.signature !== signature) attempt.current = { signature, key: createClientRequestKey() };
    const body: ExperienceCheckoutRequest & { salesPlanRevision?: number } = { ...bodyWithoutKey, clientRequestKey: attempt.current.key };
    setSubmitting(true);
    try {
      const result = await api.startCheckout(publication.slug, body);
      if (result.ok) {
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

  if (!bookingsEnabled || !saleTerms || !firstOffer) return <p role="status" className="rounded-2xl bg-sand p-5 text-ink-soft">{ja ? "現在、この体験はオンライン予約できません。" : "Online booking is temporarily unavailable for this experience."}</p>;

  const pricePerAdult = (item: SitePublicOffer) => `${formatYen(item.pricing.adultPriceYen, locale)} ${ja ? "/ 大人1名" : "per adult"}`;

  return <form onSubmit={submit} className="rounded-[var(--radius-card)] border border-line bg-white p-5 sm:p-7">
    <h1 className="text-3xl">{approval ? (ja ? `${publication.japanese!.title}の予約リクエスト` : `Request to book ${publication.publicTitle}`) : (ja ? `${publication.japanese!.title}を予約` : `Book ${publication.publicTitle}`)}</h1>
    <div className="mt-6 grid grid-cols-1 gap-5">
      {offers.length > 1 ? <label className={FIELD_LABEL}>{ja ? "プラン" : "Option"}
        <select required value={offerId} onChange={(event) => { const next = offers.find((item) => item.id === event.target.value); setOfferId(event.target.value); setDate(""); setAnswers({}); if (!next?.pricing.child) setChildren(0); }} className={FIELD_SELECT}>
          {offers.map((item) => <option key={item.id} value={item.id}>{item.name} · {pricePerAdult(item)}</option>)}
        </select>
      </label> : <div className="wrap-anywhere text-sm">
        <p className="font-extrabold">{pricePerAdult(firstOffer)}</p>
        {firstOffer.name !== publication.publicTitle ? <p className="mt-1 text-ink-soft">{firstOffer.name}</p> : null}
      </div>}
      {offer ? <>
        <p className="-mt-3 text-sm text-ink-soft">{scheduleDescription(offer, locale)} · {formatDurationLabel(offer.durationMinutes, locale)}</p>
        <p className="-mt-4 text-sm text-ink-soft">{cancellationSummary(offer, locale)}{offer.minimumChargeableParticipants > 1 ? ja ? ` · 最低請求人数は${offer.minimumChargeableParticipants}名` : ` · Minimum charge is ${offer.minimumChargeableParticipants} guests` : ""}</p>
      </> : null}
      <label className={FIELD_LABEL}>{ja ? "日にち" : "Date"}
        <select required value={date} disabled={loading || loadError} onChange={(event) => setDate(event.target.value)} className={`${FIELD_SELECT} disabled:opacity-50`}>
          <option value="">{loading ? ja ? "日時を読み込み中…" : "Loading dates…" : loadError ? ja ? "日時を確認できません" : "Dates unavailable" : ja ? "日時を選択" : "Choose a date"}</option>
          {occurrences.map((occurrence) => <option key={`${occurrence.offerId}-${occurrence.date}`} value={occurrence.date} disabled={!occurrence.bookable}>{new Intl.DateTimeFormat(ja ? "ja-JP" : "en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", timeZoneName: undefined }).format(new Date(`${occurrence.date}T12:00:00Z`))}{occurrence.bookable ? ` · ${new Intl.DateTimeFormat(ja ? "ja-JP" : "en-US", { timeZone: "Asia/Tokyo", hour: "numeric", minute: "2-digit" }).format(new Date(occurrence.startAt))} JST · ${occurrence.seatsLeft}${ja ? "席" : " places"}` : ja ? " · 予約不可" : " · Unavailable"}</option>)}
        </select>
      </label>
      {loadError ? <p role="alert" className="text-sm text-red-700">{ja ? "空き状況を確認できませんでした。ページを再読み込みしてください。" : "Dates couldn’t be checked. Retry the page or contact us before paying."}</p> : null}
      <div className="grid grid-cols-2 gap-4">
        <label className={FIELD_LABEL}>{ja ? "大人の人数" : "Adults"}
          <input type="number" min={0} max={offer?.maxPartySize ?? 1} value={adults} onChange={(event) => setAdults(Number(event.target.value))} className={FIELD_INPUT} />
        </label>
        {offer?.pricing.child ? <label className={FIELD_LABEL}>{ja ? "子どもの人数" : "Children"} ({offer.pricing.child.minAge}–{offer.pricing.child.maxAge}{ja ? "歳" : ""})
          <input type="number" min={0} max={offer.maxPartySize} value={children} onChange={(event) => setChildren(Number(event.target.value))} className={FIELD_INPUT} />
        </label> : null}
      </div>
      {offer?.bookingQuestions.map((question) => <QuestionField key={question.id} question={question} value={answers[question.id]} onChange={(value) => updateAnswer(question.id, value)} locale={locale} />)}
      <label className={FIELD_LABEL}>{ja ? "お名前" : "Full name"}
        <input required autoComplete="name" maxLength={200} value={name} onChange={(event) => setName(event.target.value)} className={FIELD_INPUT} />
      </label>
      <label className={FIELD_LABEL}>{ja ? "メールアドレス" : "Email"}
        <input type="email" required autoComplete="email" maxLength={320} value={email} onChange={(event) => setEmail(event.target.value)} className={FIELD_INPUT} />
      </label>
      <label className={FIELD_LABEL}>{ja ? "担い手に伝えておきたいこと" : "Note"} <span className="font-normal text-muted">{ja ? "（任意）" : "Optional"}</span>
        <textarea maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} className={FIELD_TEXTAREA} />
      </label>
      <div className="rounded-xl bg-sand p-4 text-sm">
        <div className="flex justify-between gap-3"><span>{ja ? "合計" : "Total"}</span><b>{total === null ? ja ? "人数を確認してください" : "Check guest counts" : formatYen(total, locale)}</b></div>
        <p className="mt-2 text-ink-soft">{ja ? "最低請求人数がある場合は合計に含まれます。席を確保する前に最終金額を再確認します。" : "The total includes the offer’s minimum chargeable guest count where one is set. The final amount is checked again before a seat is held."}</p>
      </div>
      {!sellerInformationUrl ? <p className="wrap-anywhere text-sm text-ink-soft">{ja ? `販売者：${sellerInformationName}` : `Sold by ${sellerInformationName}`}</p> : null}
      <label className="flex items-start gap-3 text-sm text-ink-soft">
        <input type="checkbox" required checked={agreed} onChange={(event) => setAgreed(event.target.checked)} className="mt-1 size-4 shrink-0" />
        <span className="min-w-0 wrap-anywhere">{ja ? "上記の予約・キャンセル条件と" : "I agree to the booking and cancellation conditions shown above and the "}<a className="font-extrabold underline" href="/privacy" target="_blank" rel="noreferrer">{ja ? "プライバシーポリシー" : "Privacy Policy"}</a>{sellerInformationUrl ? <>{ja ? "、および" : ", and "}<a className="underline underline-offset-2" href={sellerInformationUrl} target="_blank" rel="noreferrer">{ja ? `${sellerInformationName}の販売者情報` : `seller information for ${sellerInformationName}`}</a></> : null}{ja ? "に同意します。" : "."}</span>
      </label>
      {problem ? <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{problem}</p> : null}
      <button type="submit" disabled={!api || !selectedOccurrence?.bookable || total === null || !agreed || !validAnswers || submitting || loading || loadError} className="min-h-12 rounded-full bg-ink px-6 font-extrabold text-white disabled:cursor-not-allowed disabled:opacity-45">{submitLabel}</button>
      <p className="text-center text-xs text-muted">{approval
        ? (ja ? "リクエスト時のお支払いはありません。承認後、事務局からお支払いリンクをメールでお送りします。" : "No payment is taken when you request. If NIHO approves your request, we’ll email you a payment link.")
        : free
          ? (ja ? "お支払いは不要です。氏名、メールアドレス、回答は予約の作成にのみ使用します。" : "No payment is needed. Your name, email and answers are sent only to create this booking.")
          : (ja ? "お支払い情報はStripe Checkoutで入力します。氏名、メールアドレス、回答は予約の作成にのみ使用します。" : "Payment details are entered on Stripe Checkout. Your name, email and answers are sent only to create this booking.")}</p>
    </div>
  </form>;
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
