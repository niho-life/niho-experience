"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CheckoutAnswer, ExperienceApiClient, ExperienceCheckoutRequest, Occurrence } from "@niho-experience/api-client";
import { createClientRequestKey } from "@niho-experience/api-client";
import { getSiteBookingApi } from "@/lib/browser-api";
import { formatYen } from "@/lib/format";
import { cancellationSummary, scheduleDescription } from "@/lib/experience/site-card-model";
import { expectedSiteBookingTotalYen } from "@/lib/experience/site-booking-rules";
import type { SitePublicExperience, SitePublicOffer } from "@/lib/experience/site-publications";

type QuestionAnswers = Record<string, string | string[]>;

export function SitePublicationBooking({ item, siteOrigin, consentVersion, bookingsEnabled }: { item: SitePublicExperience; siteOrigin: string; consentVersion: string; bookingsEnabled: boolean }) {
  const { publication, saleTerms } = item;
  const offers = saleTerms?.offers ?? [];
  const [api] = useState<ExperienceApiClient>(() => getSiteBookingApi(siteOrigin));
  const [offerId, setOfferId] = useState(offers[0]?.id ?? "");
  const [availability, setAvailability] = useState<{ offerId: string; state: "loading" | "failed" | "ready"; occurrences: Occurrence[] }>({ offerId: offers[0]?.id ?? "", state: "loading", occurrences: [] });
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
  const total = offer ? expectedSiteBookingTotalYen(offer, adults, children) : null;
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
    const answersBody: CheckoutAnswer[] = offer.bookingQuestions.flatMap((question): CheckoutAnswer[] => {
      const value = answers[question.id];
      if (typeof value === "string" && value.trim()) return [{ questionId: question.id, text: value.trim() }];
      if (Array.isArray(value) && value.length) return [{ questionId: question.id, optionIds: value }];
      return [];
    });
    const bodyWithoutKey: Omit<ExperienceCheckoutRequest, "clientRequestKey"> = {
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
    };
    const signature = JSON.stringify(bodyWithoutKey);
    if (attempt.current?.signature !== signature) attempt.current = { signature, key: createClientRequestKey() };
    const body: ExperienceCheckoutRequest = { ...bodyWithoutKey, clientRequestKey: attempt.current.key };
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
          setProblem("The booking details changed. Reload this page to review the latest terms and availability.");
          return;
        }
        if (code === "FULL" || code === "OCCURRENCE_INVALID" || code === "UNAVAILABLE") {
          setProblem("That date is no longer available. Choose another date.");
          setDate("");
          return;
        }
        if (code === "RATE_LIMITED") setProblem("Too many attempts. Please wait a moment and try again.");
        else setProblem("We couldn't start checkout. Check the details and try again.");
      } else {
        setProblem("We couldn't reach checkout. You can retry this request safely.");
      }
    } catch {
      setProblem("We couldn't reach checkout. You can retry this request safely.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!bookingsEnabled || !saleTerms || !offers.length) return <p role="status" className="rounded-2xl bg-sand p-5 text-ink-soft">Online booking is temporarily unavailable for this experience.</p>;

  return <form onSubmit={submit} className="rounded-[var(--radius-card)] border border-line bg-white p-5 sm:p-7">
    <div>
      <p className="eyebrow">{publication.sellerDisplayName}</p>
      <h1 className="mt-1 text-3xl">Book {publication.publicTitle}</h1>
    </div>
    <div className="mt-6 grid gap-5">
      <label className="grid gap-2 text-sm font-extrabold">Option
        <select required value={offerId} onChange={(event) => { const next = offers.find((item) => item.id === event.target.value); setOfferId(event.target.value); setDate(""); setAnswers({}); if (!next?.pricing.child) setChildren(0); }} className="min-h-12 rounded-xl border border-line-strong px-3 font-normal">
          {offers.map((item) => <option key={item.id} value={item.id}>{item.name} · {formatYen(item.pricing.adultPriceYen, "en")} per adult</option>)}
        </select>
      </label>
      {offer ? <>
        <p className="-mt-3 text-sm text-ink-soft">{scheduleDescription(offer)} · {formatDurationLabel(offer.durationMinutes)}</p>
        <p className="-mt-4 text-sm text-ink-soft">{cancellationSummary(offer)}{offer.minimumChargeableParticipants > 1 ? ` · Minimum charge is ${offer.minimumChargeableParticipants} guests` : ""}</p>
      </> : null}
      <label className="grid gap-2 text-sm font-extrabold">Date
        <select required value={date} disabled={loading || loadError} onChange={(event) => setDate(event.target.value)} className="min-h-12 rounded-xl border border-line-strong px-3 font-normal disabled:opacity-50">
          <option value="">{loading ? "Loading dates…" : loadError ? "Dates unavailable" : "Choose a date"}</option>
          {occurrences.map((occurrence) => <option key={`${occurrence.offerId}-${occurrence.date}`} value={occurrence.date} disabled={!occurrence.bookable}>{new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", timeZoneName: undefined }).format(new Date(`${occurrence.date}T12:00:00Z`))}{occurrence.bookable ? ` · ${new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", minute: "2-digit" }).format(new Date(occurrence.startAt))} JST · ${occurrence.seatsLeft} places` : " · Unavailable"}</option>)}
        </select>
      </label>
      {loadError ? <p role="alert" className="text-sm text-red-700">Dates couldn’t be checked. Retry the page or contact us before paying.</p> : null}
      <div className="grid grid-cols-2 gap-4">
        <label className="grid gap-2 text-sm font-extrabold">Adults
          <input type="number" min={0} max={offer?.maxPartySize ?? 1} value={adults} onChange={(event) => setAdults(Number(event.target.value))} className="min-h-12 rounded-xl border border-line-strong px-3 font-normal" />
        </label>
        {offer?.pricing.child ? <label className="grid gap-2 text-sm font-extrabold">Children ({offer.pricing.child.minAge}–{offer.pricing.child.maxAge})
          <input type="number" min={0} max={offer.maxPartySize} value={children} onChange={(event) => setChildren(Number(event.target.value))} className="min-h-12 rounded-xl border border-line-strong px-3 font-normal" />
        </label> : null}
      </div>
      {offer?.bookingQuestions.map((question) => <QuestionField key={question.id} question={question} value={answers[question.id]} onChange={(value) => updateAnswer(question.id, value)} />)}
      <label className="grid gap-2 text-sm font-extrabold">Full name
        <input required autoComplete="name" maxLength={200} value={name} onChange={(event) => setName(event.target.value)} className="min-h-12 rounded-xl border border-line-strong px-3 font-normal" />
      </label>
      <label className="grid gap-2 text-sm font-extrabold">Email
        <input type="email" required autoComplete="email" maxLength={320} value={email} onChange={(event) => setEmail(event.target.value)} className="min-h-12 rounded-xl border border-line-strong px-3 font-normal" />
      </label>
      <label className="grid gap-2 text-sm font-extrabold">Note <span className="font-normal text-muted">Optional</span>
        <textarea maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} className="min-h-24 rounded-xl border border-line-strong p-3 font-normal" />
      </label>
      <div className="rounded-xl bg-sand p-4 text-sm">
        <div className="flex justify-between gap-3"><span>Total</span><b>{total === null ? "Check guest counts" : formatYen(total, "en")}</b></div>
        <p className="mt-2 text-ink-soft">The total includes the offer’s minimum chargeable guest count where one is set. The final amount is checked again before a seat is held.</p>
      </div>
      <label className="flex items-start gap-3 text-sm text-ink-soft">
        <input type="checkbox" required checked={agreed} onChange={(event) => setAgreed(event.target.checked)} className="mt-1 size-4" />
        <span>I agree to the booking and cancellation conditions shown above and the <a className="font-extrabold underline" href="/privacy" target="_blank" rel="noreferrer">Privacy Policy</a>.</span>
      </label>
      {problem ? <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{problem}</p> : null}
      <button type="submit" disabled={!api || !selectedOccurrence?.bookable || total === null || !agreed || !validAnswers || submitting || loading || loadError} className="min-h-12 rounded-full bg-ink px-6 font-extrabold text-white disabled:cursor-not-allowed disabled:opacity-45">{submitting ? "Opening secure checkout…" : "Continue to secure checkout"}</button>
      <p className="text-center text-xs text-muted">Payment details are entered on Stripe Checkout. Your name, email and answers are sent only to create this booking.</p>
    </div>
  </form>;
}

function formatDurationLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return [hours ? `${hours} hr` : "", rest ? `${rest} min` : ""].filter(Boolean).join(" ");
}

function QuestionField({ question, value, onChange }: { question: SitePublicOffer["bookingQuestions"][number]; value: string | string[] | undefined; onChange: (value: string | string[]) => void }) {
  const label = `${question.prompt}${question.required ? " *" : " (optional)"}`;
  if (question.inputType === "SINGLE_SELECT") return <label className="grid gap-2 text-sm font-extrabold">{label}<select required={question.required} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)} className="min-h-12 rounded-xl border border-line-strong px-3 font-normal"><option value="">Choose an answer</option>{question.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select>{question.description ? <small className="font-normal text-muted">{question.description}</small> : null}</label>;
  if (question.inputType === "MULTI_SELECT") return <fieldset className="grid gap-2 text-sm"><legend className="font-extrabold">{label}</legend>{question.options.map((option) => <label key={option.id} className="flex items-center gap-2"><input type="checkbox" checked={Array.isArray(value) && value.includes(option.id)} onChange={(event) => { const selected = new Set(Array.isArray(value) ? value : []); if (event.target.checked) selected.add(option.id); else selected.delete(option.id); onChange([...selected]); }} />{option.label}</label>)}{question.description ? <small className="text-muted">{question.description}</small> : null}</fieldset>;
  const textValue = typeof value === "string" ? value : "";
  return <label className="grid gap-2 text-sm font-extrabold">{label}{question.inputType === "LONG_TEXT" ? <textarea required={question.required} maxLength={2000} value={textValue} onChange={(event) => onChange(event.target.value)} className="min-h-24 rounded-xl border border-line-strong p-3 font-normal" /> : <input required={question.required} maxLength={500} value={textValue} onChange={(event) => onChange(event.target.value)} className="min-h-12 rounded-xl border border-line-strong px-3 font-normal" />}{question.description ? <small className="font-normal text-muted">{question.description}</small> : null}</label>;
}
