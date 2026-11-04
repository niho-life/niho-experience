"use client";

import type { FormEvent, ReactNode, Ref } from "react";
import { BookingBarV1, BookingStepHeadingV1, BookingSummaryV1, BOOKING_FIELD_INPUT_CLASS_V1, BOOKING_FIELD_LABEL_CLASS_V1, HandIcon, NoticeV1, RichMessageV1, buttonClassV1, type BookingSummaryModelV1 } from "./components.js";
import { EN_STATIC_COPY_V1, type StaticCopyAccessorV1 } from "./static-copy.js";
import type { HandIconName } from "./icons.js";
import type { PresentationPrimitivesV1 } from "./types.js";

const choiceCard = "relative block rounded-[18px] border border-line-strong bg-white text-left leading-tight has-[:checked]:border-ink has-[:checked]:bg-leaf-pale has-[:checked]:shadow-[inset_0_0_0_1px_var(--color-ink)] has-[:disabled]:border-line has-[:disabled]:bg-sand has-[:disabled]:text-muted has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-moss";
const hiddenRadio = "absolute inset-0 z-[1] size-full cursor-pointer appearance-none rounded-[18px] opacity-0 focus-visible:outline-none disabled:cursor-not-allowed";
// Each screen's root is a size container. From @4xl (56rem) the steps take the left column and the summary card and the
// total/action bar (as a sticky card) take a 380px right column. Grid placement keeps the DOM order summary → steps → bar.
const asideGrid = "@4xl:grid @4xl:grid-cols-[minmax(0,1fr)_380px] @4xl:grid-rows-[auto_auto_1fr] @4xl:gap-x-[72px]";
const asideMain = "min-w-0 @4xl:col-start-1 @4xl:row-span-3 @4xl:row-start-1";
const asideTop = "@4xl:col-start-2 @4xl:row-start-1";
const asideMiddle = "@4xl:col-start-2 @4xl:row-start-2";
const asideBottom = "@4xl:col-start-2 @4xl:row-start-3";

export type BookingSelectionViewModelV1 = Readonly<{
  summary: BookingSummaryModelV1;
  unavailableMessage?: string;
  offerDescription?: string;
  offers: readonly { id: string; name: string; description?: string; adultPrice: string; selected: boolean }[];
  dates: Readonly<{ state: "loading" | "error" | "empty" | "ready"; provisional: boolean; options: readonly { id: string; weekday: string; day: string; time: string; availability?: string; bookable: boolean; selected: boolean }[]; moreCount: number }>;
  counters?: readonly { id: string; label: string; note: string; value: number; maximum: number; full: boolean }[];
  guestRange?: { minimum: number; maximum: number; childrenPrice?: string };
  hint?: string;
  total: string;
  totalIsAmount: boolean;
  line: string;
  canContinue: boolean;
}>;

export type BookingSelectionCallbacksV1 = Readonly<{
  onOfferChange?: (id: string) => void;
  onDateChange?: (id: string) => void;
  onCounterChange?: (id: string, value: number) => void;
  onRetry?: () => void;
  onShowMore?: () => void;
  onContinue?: () => void;
}>;

export function BookingSelectionViewV1({ model, callbacks = {}, titleAs = "h1", primitives, copy = EN_STATIC_COPY_V1 }: { model: BookingSelectionViewModelV1; callbacks?: BookingSelectionCallbacksV1; titleAs?: "h1" | "p"; primitives?: Partial<PresentationPrimitivesV1>; copy?: StaticCopyAccessorV1 }) {
  if (model.unavailableMessage) return <div data-booking-screen="selection" className="@container"><div className={asideGrid}><BookingSummaryV1 model={model.summary} titleAs={titleAs} primitives={primitives} aside className={asideTop} /><div className={asideMain}><p className="mt-6 text-ink-soft">{model.unavailableMessage}</p></div></div></div>;
  return <div data-booking-screen="selection" className="@container"><div className={asideGrid}><BookingSummaryV1 model={model.summary} titleAs={titleAs} primitives={primitives} aside className={asideTop} />
    {model.offerDescription ? <p className={`mt-2.5 text-sm text-muted ${asideMiddle}`}>{model.offerDescription}</p> : null}
    <div className={asideMain}>
    {model.offers.length > 1 ? <section className="mt-6" aria-labelledby="offer-heading-v1"><h2 id="offer-heading-v1" className="mb-2.5 font-sans text-sm font-extrabold tracking-normal text-muted">{copy.text("booking.option")}</h2><div role="radiogroup" aria-labelledby="offer-heading-v1" className="grid gap-2.5">{model.offers.map((offer) => <label key={offer.id} className={`${choiceCard} bg-sand px-4 py-3.5`}><input type="radio" name="offer" value={offer.id} checked={offer.selected} onChange={() => callbacks.onOfferChange?.(offer.id)} className={hiddenRadio} /><span className="flex items-baseline justify-between gap-3"><b className="font-extrabold">{offer.name}</b><span className="shrink-0 text-sm text-ink-soft"><RichMessageV1 segments={copy.rich("booking.optionPriceRich", { price: offer.adultPrice })} emphasisClassName="font-extrabold text-ink" /></span></span>{offer.description ? <span className="mt-1 block text-sm text-muted">{offer.description}</span> : null}</label>)}</div></section> : null}
    <section aria-labelledby="date-heading-v1"><BookingStepHeadingV1 id="date-heading-v1" step={1} label={copy.text("booking.step")}>{copy.text("booking.chooseDate")}</BookingStepHeadingV1><p className="-mt-1.5 mb-3 text-sm text-muted">{copy.text(model.dates.provisional ? "booking.jstSampleNote" : "booking.jstNote")}</p>
      {model.dates.state === "loading" ? <p role="status" className="text-muted">{copy.text("booking.checkingDates")}</p> : model.dates.state === "error" ? <div role="alert" className="space-y-2"><p>{copy.text("booking.datesLoadError")}</p><button type="button" className="font-bold text-moss underline" onClick={callbacks.onRetry}>{copy.text("common.tryAgain")}</button></div> : model.dates.state === "empty" ? <p className="text-muted">{copy.text("booking.noDates")}</p> : <><div role="radiogroup" aria-labelledby="date-heading-v1" className="grid grid-cols-2 gap-2.5 @4xl:grid-cols-3">{model.dates.options.map((date) => <label key={date.id} className={`${choiceCard} px-3.5 py-3`}><input type="radio" name="occurrence" value={date.id} checked={date.selected} disabled={!date.bookable} onChange={() => callbacks.onDateChange?.(date.id)} className={hiddenRadio} /><small className="block text-[0.78125rem] font-extrabold text-muted">{date.weekday}</small><b className="block text-[1.0625rem] font-extrabold">{date.day}</b><span className="mt-0.5 block text-[0.8125rem] text-ink-soft">{date.time}<span className="sr-only"> {copy.text("common.jst")}</span></span>{date.availability ? <span className={`mt-1 block text-xs ${date.bookable ? "text-muted" : "font-extrabold"}`}>{date.availability}</span> : null}</label>)}</div>{model.dates.moreCount > 0 ? <button type="button" onClick={callbacks.onShowMore} className="link-leaf mt-3.5 text-sm">{copy.text("booking.showMoreDates", { count: model.dates.moreCount, noun: model.dates.moreCount === 1 ? "date" : "dates" })}</button> : null}</>}
    </section>
    {model.counters?.length ? <section aria-labelledby="guests-heading-v1"><BookingStepHeadingV1 id="guests-heading-v1" step={2} label={copy.text("booking.step")}>{copy.text("booking.whoComing")}</BookingStepHeadingV1>{model.counters.map((counter) => <BookingCounterV1 key={counter.id} model={counter} onChange={(value) => callbacks.onCounterChange?.(counter.id, value)} copy={copy} />)}{model.guestRange ? <p className="mt-3 text-sm text-muted">{copy.text("booking.guestRange", { minimum: model.guestRange.minimum, maximum: model.guestRange.maximum })} {model.guestRange.childrenPrice ? copy.text("booking.childrenEach", { price: model.guestRange.childrenPrice }) : copy.text("booking.adultsOnly")} {copy.text("booking.availabilityCheckout")}</p> : null}</section> : null}
    {model.hint ? <p aria-live="polite" className="mt-4 flex items-start gap-2 rounded-2xl bg-sand p-3.5 text-sm text-ink-soft"><HandIcon name="cal" className="size-5 shrink-0 text-moss" />{model.hint}</p> : null}
    </div>
    <BookingBarV1 aside className={asideBottom} total={model.totalIsAmount ? <RichMessageV1 segments={copy.rich("booking.totalRich", { total: model.total })} emphasisClassName="text-lg font-extrabold text-ink @4xl:text-[1.625rem]" /> : <b className="font-extrabold text-ink">{model.total}</b>} line={model.line} action={<button type="button" disabled={!model.canContinue} onClick={callbacks.onContinue} className={buttonClassV1("primary", "min-h-[46px] shrink-0 px-6 @4xl:min-h-12 @4xl:w-full")}>{copy.text("booking.continue")}</button>} />
  </div></div>;
}

function BookingCounterV1({ model, onChange, copy }: { model: NonNullable<BookingSelectionViewModelV1["counters"]>[number]; onChange: (value: number) => void; copy: StaticCopyAccessorV1 }) {
  const step = "grid size-[34px] shrink-0 place-items-center rounded-full border border-line-strong bg-white disabled:cursor-not-allowed disabled:opacity-35";
  const noun = model.label.toLowerCase();
  return <div className="flex items-center justify-between gap-3 border-b border-line py-3.5 last-of-type:border-b-0"><div className="min-w-0"><label htmlFor={model.id} className="block font-extrabold">{model.label}</label><small id={`${model.id}-note`} className="block text-[0.8125rem] font-bold text-muted">{model.note}</small></div><div className="flex shrink-0 items-center gap-1.5"><button type="button" aria-label={copy.text("booking.fewer", { noun })} aria-controls={model.id} disabled={model.value <= 0} onClick={() => onChange(Math.max(0, model.value - 1))} className={step}><HandIcon name="minus" className="size-4 [stroke-width:2.2]" /></button><input id={model.id} type="number" inputMode="numeric" min={0} max={model.maximum} value={model.value} aria-describedby={`${model.id}-note`} onChange={(event) => onChange(Number(event.target.value))} className="w-10 rounded-lg bg-transparent py-1 text-center text-[1.0625rem] font-extrabold [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" /><button type="button" aria-label={copy.text("booking.more", { noun })} aria-controls={model.id} disabled={model.full || model.value >= model.maximum} onClick={() => onChange(Math.min(model.maximum, model.value + 1))} className={step}><HandIcon name="plus" className="size-4 [stroke-width:2.2]" /></button></div></div>;
}

export type BookingQuestionV1 = Readonly<{ id: string; prompt: string; description?: string; required: boolean; type: "SHORT_TEXT" | "LONG_TEXT" | "SINGLE_SELECT" | "MULTI_SELECT"; value: string | readonly string[]; options: readonly { id: string; label: string }[]; invalid?: boolean }>;
export type BookingCheckoutViewModelV1 = Readonly<{
  summary: BookingSummaryModelV1;
  availability: "checking" | "ready" | "stale" | "unavailable";
  refreshing: boolean;
  refreshDisabled: boolean;
  problem?: string;
  guestName: string;
  invalidGuestName: boolean;
  guestEmail: string;
  invalidGuestEmail: boolean;
  note: string;
  invalidNote: boolean;
  questions: readonly BookingQuestionV1[];
  approval: boolean;
  actionLabel?: string;
  reviewHeading?: string;
  totalNote?: string;
  confirmationNote?: string;
  sellerNote?: string;
  paymentDisclosure?: string;
  review: readonly { label: string; value: string }[];
  total: string;
  policyTitle: string;
  sellerName: string;
  sellerLegalUrl?: string;
  legalDocuments: readonly { kind: "COMMERCIAL_TRANSACTIONS" | "PRIVACY" | "TERMS"; url: string }[];
  consentVersion: string;
  agreed: boolean;
  invalidConsent: boolean;
  preview: boolean;
  submitting: boolean;
  retryWaiting: boolean;
  actionDisabled: boolean;
  when: string;
  /**
   * Optional additions for the guest journey (Epic #103). When absent the screen is exactly as before.
   * The consumer supplies these display strings (they are not in the static copy registry, so saved localization snapshots stay complete).
   */
  /** "Before you book": participation conditions the whole group must accept. Adds one step before "Your details". */
  conditions?: Readonly<{ heading: string; agreeIntro: string; items: readonly string[]; agreed: boolean; invalid: boolean }>;
  /** Optional mobile number for the day of the experience. */
  guestPhone?: Readonly<{ label: string; hint?: string; value: string; invalid: boolean }>;
  /** Replaces "Questions from your host", e.g. "Questions from Shiryu". */
  hostQuestionsHeading?: string;
}>;

export type BookingCheckoutCallbacksV1 = Readonly<{
  onBack?: () => void;
  onRefresh?: () => void;
  onGuestNameChange?: (value: string) => void;
  onGuestEmailChange?: (value: string) => void;
  onGuestPhoneChange?: (value: string) => void;
  onNoteChange?: (value: string) => void;
  onAnswerChange?: (id: string, value: string | string[]) => void;
  onAgreementChange?: (value: boolean) => void;
  onConditionsAgreementChange?: (value: boolean) => void;
  onSubmit?: () => void;
}>;

export function BookingCheckoutViewV1({ model, callbacks = {}, titleAs = "h1", problemRef, primitives, copy = EN_STATIC_COPY_V1 }: { model: BookingCheckoutViewModelV1; callbacks?: BookingCheckoutCallbacksV1; titleAs?: "h1" | "p"; problemRef?: Ref<HTMLDivElement>; primitives?: Partial<PresentationPrimitivesV1>; copy?: StaticCopyAccessorV1 }) {
  const optional = <small className="font-bold text-muted">{copy.text("booking.optional")}</small>;
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); callbacks.onSubmit?.(); };
  // "Before you book" is step 3 when present; the steps after it shift by one.
  const stepOffset = model.conditions ? 1 : 0;
  return <form onSubmit={submit} data-booking-screen="checkout" className="@container"><div className={asideGrid}><BookingSummaryV1 model={model.summary} titleAs={titleAs} primitives={primitives} aside className={asideTop} /><button type="button" onClick={callbacks.onBack} className={`link-leaf mt-3 text-sm @4xl:justify-self-start ${asideMiddle}`}>{copy.text("booking.changeSelection")}</button>
    <div className={asideMain}>
    <div className="mt-5 space-y-4 empty:hidden">{model.availability === "checking" ? <p role="status">{copy.text("booking.checkingAgain")}</p> : model.availability === "stale" ? <NoticeV1 role="alert" tone="warn" title={copy.text("booking.latestTitle")}>{copy.text("booking.latestBody")} <button type="button" disabled={model.refreshDisabled} onClick={callbacks.onRefresh} className="font-bold text-moss underline">{copy.text(model.refreshing ? "booking.refreshing" : "booking.reload")}</button> {copy.text("booking.latestAfterReload")}</NoticeV1> : model.availability === "unavailable" ? <NoticeV1 role="alert" tone="warn" title={copy.text("booking.dateChangedTitle")}>{copy.text("booking.nothingCharged")} <button type="button" onClick={callbacks.onBack} className="font-bold text-moss underline">{copy.text("booking.checkDatesAgain")}</button> {copy.text("booking.availabilityAfterCheck")}</NoticeV1> : null}{model.problem ? <div id="booking-problem" ref={problemRef} tabIndex={-1} className="outline-none"><NoticeV1 role="alert" tone="danger" title={copy.text("booking.problemTitle")}>{model.problem}</NoticeV1></div> : null}</div>
    {model.conditions ? <section aria-labelledby="conditions-heading-v1"><BookingStepHeadingV1 id="conditions-heading-v1" step={3} label={copy.text("booking.step")}>{model.conditions.heading}</BookingStepHeadingV1><label className={`block rounded-[18px] border bg-white p-4 text-[0.9375rem] has-[:checked]:border-ink has-[:checked]:bg-leaf-pale has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-moss ${model.conditions.invalid ? "border-danger" : "border-line-strong"}`}><span className="flex items-start gap-3"><input id="booking-conditions" name="conditions" type="checkbox" required checked={model.conditions.agreed} aria-invalid={model.conditions.invalid || undefined} aria-describedby={model.conditions.invalid ? "booking-problem" : undefined} onChange={(event) => callbacks.onConditionsAgreementChange?.(event.target.checked)} className="mt-px size-[22px] shrink-0 accent-moss" /><b className="font-extrabold">{model.conditions.agreeIntro}</b></span><span className="mt-2.5 block space-y-1.5 pl-[34px] text-ink-soft">{model.conditions.items.map((item) => <span key={item} className="flex gap-2.5"><span aria-hidden className="mt-[0.6em] size-[6px] shrink-0 rounded-full bg-leaf" /><span>{item}</span></span>)}</span></label></section> : null}
    <section aria-labelledby="details-heading-v1"><BookingStepHeadingV1 id="details-heading-v1" step={3 + stepOffset} label={copy.text("booking.step")}>{copy.text("booking.details")}</BookingStepHeadingV1><p className="text-sm text-muted">{copy.text("booking.detailsBody")}</p><label className={BOOKING_FIELD_LABEL_CLASS_V1}>{copy.text("booking.fullName")}<input id="booking-guestName" name="guestName" aria-invalid={model.invalidGuestName || undefined} aria-describedby={model.invalidGuestName ? "booking-problem" : undefined} autoComplete="name" required maxLength={100} value={model.guestName} onChange={(event) => callbacks.onGuestNameChange?.(event.target.value)} className={BOOKING_FIELD_INPUT_CLASS_V1} /></label><label className={BOOKING_FIELD_LABEL_CLASS_V1}>{copy.text("booking.email")}<input id="booking-guestEmail" name="guestEmail" aria-invalid={model.invalidGuestEmail || undefined} aria-describedby={model.invalidGuestEmail ? "booking-problem" : undefined} type="email" inputMode="email" autoComplete="email" required maxLength={254} value={model.guestEmail} onChange={(event) => callbacks.onGuestEmailChange?.(event.target.value)} className={BOOKING_FIELD_INPUT_CLASS_V1} /></label>
      {model.guestPhone ? <label className={BOOKING_FIELD_LABEL_CLASS_V1}>{model.guestPhone.label}{model.guestPhone.hint ? <> <small className="font-bold text-muted">{model.guestPhone.hint}</small></> : null}<input id="booking-guestPhone" name="guestPhone" aria-invalid={model.guestPhone.invalid || undefined} aria-describedby={model.guestPhone.invalid ? "booking-problem" : undefined} type="tel" inputMode="tel" autoComplete="tel" maxLength={24} value={model.guestPhone.value} onChange={(event) => callbacks.onGuestPhoneChange?.(event.target.value)} className={BOOKING_FIELD_INPUT_CLASS_V1} /></label> : null}
      {model.questions.length ? <fieldset className="mt-6"><legend className="font-sans text-sm font-extrabold tracking-[0.02em] text-muted">{model.hostQuestionsHeading ?? copy.text("booking.hostQuestions")}</legend>{model.questions.map((question) => <BookingQuestionFieldV1 key={question.id} question={question} onChange={(value) => callbacks.onAnswerChange?.(question.id, value)} copy={copy} optional={optional} />)}</fieldset> : null}
      <label className={BOOKING_FIELD_LABEL_CLASS_V1}>{copy.text("booking.note")} {optional}<textarea id="booking-note" name="note" aria-invalid={model.invalidNote || undefined} aria-describedby={model.invalidNote ? "booking-problem" : undefined} rows={3} maxLength={500} value={model.note} onChange={(event) => callbacks.onNoteChange?.(event.target.value)} className={`${BOOKING_FIELD_INPUT_CLASS_V1} min-h-[84px] resize-y`} /></label>
    </section>
    <section aria-labelledby="check-heading-v1"><BookingStepHeadingV1 id="check-heading-v1" step={4 + stepOffset} label={copy.text("booking.step")}>{model.reviewHeading ?? copy.text(model.approval ? "booking.checkSend" : "booking.checkPay")}</BookingStepHeadingV1><dl className="rounded-[22px] bg-sand px-[18px] py-4 text-[0.9375rem]">{model.review.map((row) => <ReviewRowV1 key={row.label} {...row} />)}<div className="mt-2 flex items-baseline justify-between gap-3 border-t border-line-strong pt-3"><dt className="text-ink-soft">{copy.text("booking.total")}<small className="block text-[0.78125rem] font-bold text-muted">{model.totalNote ?? copy.text("booking.totalNote")}</small></dt><dd className="text-xl font-extrabold">{model.total}</dd></div></dl>
      <BookingNoteV1 icon="umbrella" id="terms"><RichMessageV1 segments={copy.rich("booking.policyRich", { policy: model.policyTitle })} emphasisClassName="font-extrabold text-ink" /></BookingNoteV1><BookingNoteV1 icon={model.approval ? "people" : "check"}>{model.confirmationNote ?? copy.text(model.approval ? "booking.approvalNote" : "booking.instantNote")}</BookingNoteV1><BookingNoteV1 icon="card">{model.sellerNote ?? <RichMessageV1 segments={copy.rich("booking.secureSellerRich", { seller: model.sellerName })} emphasisClassName="font-extrabold text-ink" />}{model.sellerLegalUrl ? <> <a href={model.sellerLegalUrl} className="font-extrabold text-ink underline" rel="noopener noreferrer">{copy.text("booking.commercialTransactions")}</a></> : null}</BookingNoteV1>
      <div className="mt-5 border-t border-line pt-4"><p className="text-sm text-ink-soft">{copy.text("booking.terms")} {model.legalDocuments.map((doc, index) => <span key={doc.kind}>{index ? " · " : null}<a href={doc.url} target="_blank" rel="noopener noreferrer" className="font-extrabold text-ink underline">{copy.text(doc.kind === "COMMERCIAL_TRANSACTIONS" ? "booking.commercialTransactions" : doc.kind === "PRIVACY" ? "booking.privacy" : "booking.serviceTerms")}</a></span>)}</p><label className={`mt-3.5 flex items-start gap-3 text-[0.90625rem] ${model.invalidConsent ? "text-danger" : "text-ink-soft"}`}><input id="booking-consent" type="checkbox" aria-describedby={model.invalidConsent ? "booking-problem" : undefined} checked={model.agreed} onChange={(event) => callbacks.onAgreementChange?.(event.target.checked)} required aria-invalid={model.invalidConsent || undefined} className="mt-px size-[22px] shrink-0 accent-moss" /><span>{copy.text("booking.agree", { version: model.consentVersion })}</span></label></div>
    </section><p className="mt-6 text-center text-sm text-muted @4xl:text-left">{model.paymentDisclosure ?? copy.text(model.preview ? "booking.previewNoPayment" : "booking.publicNoCharge")}</p>
    </div>
    <BookingBarV1 stack aside className={asideBottom} total={<RichMessageV1 segments={copy.rich("booking.totalRich", { total: model.total })} emphasisClassName="text-lg font-extrabold text-ink @4xl:text-[1.625rem]" />} line={model.when} action={<button type="submit" disabled={model.actionDisabled} aria-busy={model.submitting} className={buttonClassV1("primary", "min-h-[46px] w-full shrink-0 px-6 min-[30rem]:@max-4xl:w-auto @4xl:min-h-12")}>{model.retryWaiting ? copy.text("booking.pleaseWait") : model.submitting ? copy.text("booking.preparing") : model.actionLabel ?? copy.text(model.approval ? "booking.request" : model.preview ? "booking.mockPayment" : "booking.pay")}</button>} />
  </div></form>;
}

function BookingQuestionFieldV1({ question, onChange, copy, optional }: { question: BookingQuestionV1; onChange: (value: string | string[]) => void; copy: StaticCopyAccessorV1; optional: ReactNode }) {
  const id = `question-${question.id}`;
  const descriptionId = `${id}-description`;
  const invalid = question.invalid || false;
  const describedBy = [question.description ? descriptionId : null, invalid ? "booking-problem" : null].filter(Boolean).join(" ") || undefined;
  const label = <>{question.prompt}{question.required ? <> *<span className="sr-only"> ({copy.text("booking.required")})</span></> : <> {optional}</>}</>;
  const description = question.description ? <p id={descriptionId} className="mt-0.5 text-[0.8125rem] text-muted">{question.description}</p> : null;
  if (question.type === "MULTI_SELECT") {
    const selected = Array.isArray(question.value) ? question.value : [];
    return <fieldset id={id} tabIndex={-1} aria-invalid={invalid || undefined} aria-describedby={describedBy} className="min-w-0">
      <legend className={BOOKING_FIELD_LABEL_CLASS_V1}>{label}</legend>{description}
      <div className="mt-2 space-y-2">{question.options.map((option) => <label key={option.id} className="flex min-h-11 items-center gap-2.5"><input type="checkbox" checked={selected.includes(option.id)} onChange={(event) => onChange(event.target.checked ? [...selected, option.id] : selected.filter((id) => id !== option.id))} className="size-5 accent-moss" />{option.label}</label>)}</div>
    </fieldset>;
  }
  return <div><label htmlFor={id} className={BOOKING_FIELD_LABEL_CLASS_V1}>{label}</label>{description}<BookingQuestionInputV1 question={question} id={id} describedBy={describedBy} onChange={onChange} copy={copy} /></div>;
}

function BookingQuestionInputV1({ question, id, describedBy, onChange, copy }: { question: BookingQuestionV1; id: string; describedBy?: string; onChange: (value: string | string[]) => void; copy: StaticCopyAccessorV1 }) {
  const invalid = question.invalid || undefined;
  const inputProps = { id, "aria-invalid": invalid, "aria-describedby": describedBy, "aria-required": question.required || undefined };
  if (question.type === "LONG_TEXT") return <textarea {...inputProps} maxLength={1000} value={typeof question.value === "string" ? question.value : ""} onChange={(event) => onChange(event.target.value)} className={`${BOOKING_FIELD_INPUT_CLASS_V1} min-h-[84px] resize-y`} />;
  if (question.type === "SHORT_TEXT") return <input {...inputProps} maxLength={200} value={typeof question.value === "string" ? question.value : ""} onChange={(event) => onChange(event.target.value)} className={BOOKING_FIELD_INPUT_CLASS_V1} />;
  return <select {...inputProps} value={Array.isArray(question.value) ? question.value[0] ?? "" : ""} onChange={(event) => onChange(event.target.value ? [event.target.value] : [])} className={BOOKING_FIELD_INPUT_CLASS_V1}><option value="">{copy.text("booking.chooseAnswer")}</option>{question.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select>;
}

function ReviewRowV1({ label, value }: { label: string; value: string }) { return <div className="flex justify-between gap-3 py-[5px]"><dt className="text-ink-soft">{label}</dt><dd className="text-right font-extrabold">{value}</dd></div>; }
function BookingNoteV1({ icon, id, children }: { icon: HandIconName; id?: string; children: ReactNode }) { return <p id={id} className="mt-3.5 flex items-start gap-2.5 text-[0.90625rem] text-ink-soft"><HandIcon name={icon} className="size-[26px] shrink-0 text-moss [stroke-width:1.6]" /><span>{children}</span></p>; }
