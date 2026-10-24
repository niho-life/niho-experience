"use client";

import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { useRouter } from "next/navigation";
import { NO_JOURNEY_EXTRAS, computeExpectedTotalYen, conditionConsentTexts, createClientRequestKey, isValidGuestPhone, normalizeGuestPhone, usableConditions, type CheckoutAnswer, type ExperienceApiClient, type ExperienceConditions, type ExperienceCheckoutJourneyFields, type ExperienceCheckoutRequest, type ExperienceOffer, type JourneyDetailExtras } from "@niho-experience/api-client";
import { hostNames } from "@/lib/card-model";
import { JOURNEY_PROBLEMS, askHostTarget, freeCancellationDeadline } from "@/lib/journey-ui";
import { dayOption } from "@/lib/date-filter";
import { formatDuration, formatYen } from "@/lib/format";
import { formatClock } from "@/lib/schedule";
import { safeHttpsUrl } from "@/lib/safe-url";
import { track } from "@/lib/analytics";
import { readBookingAttribution } from "@/lib/booking-attribution";
import type { ExperienceDetailForSite } from "@/lib/experience-types";
import { policyTitle } from "./Policy";
import type { BookingSelection } from "./SlotPicker";
import { BookingCheckoutViewV1, type BookingCheckoutViewModelV1 } from "@niho/experience-presentation/v1";
import { PRESENTATION_PRIMITIVES_V1 } from "./PresentationV1";
import { useSiteCopy, useSiteLocale } from "./SiteLocale";
import { readAvailabilityFromApi } from "@/lib/browser-availability";
import { checkoutProblem, fullNameValidationMessage, retryUnit } from "@/lib/booking-messages";

export type BookingDraft = { guestName: string; guestEmail: string; guestPhone?: string; note: string; answerSets: Record<string, Record<string, string | string[]>> };
export type CheckoutAttempt = { signature: string; key: string };

export function BookingForm({ api, apiUnavailable, experience, offer, selection, preview, attributionEnabled, publicApiVersion, journey = NO_JOURNEY_EXTRAS, onExperienceRefresh, draft, onDraftChange, attemptRef, onBack, titleAs = "h1" }: { api: ExperienceApiClient | null; apiUnavailable: boolean; experience: ExperienceDetailForSite; offer: ExperienceOffer; selection: BookingSelection; preview: boolean; attributionEnabled: boolean; publicApiVersion: "1.0" | "1.1" | "1.2"; journey?: JourneyDetailExtras; onExperienceRefresh: (experience: ExperienceDetailForSite, conditions?: ExperienceConditions | null) => boolean; draft: BookingDraft; onDraftChange: Dispatch<SetStateAction<BookingDraft>>; attemptRef: RefObject<CheckoutAttempt | null>; onBack: () => void; titleAs?: "h1" | "p" }) {
  const router = useRouter();
  const copy = useSiteCopy();
  const { locale, releaseId } = useSiteLocale();
  const { guestName, guestEmail, note } = draft;
  const questionSet = `${offer.id}:${offer.bookingQuestionsFingerprint}`;
  const answers = draft.answerSets[questionSet] ?? {};
  const [refreshing, setRefreshing] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [problem, setProblem] = useState("");
  const [invalidField, setInvalidField] = useState("");
  const [availabilityOk, setAvailabilityOk] = useState(false);
  const [checking, setChecking] = useState(true);
  const [needsFreshDetails, setNeedsFreshDetails] = useState(false);
  const [retryUntil, setRetryUntil] = useState<number | null>(null);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const viewTracked = useRef(false);
  const alertRef = useRef<HTMLDivElement>(null);
  const total = computeExpectedTotalYen(offer.pricing, selection.adultCount, selection.childCount);
  const headCount = selection.adultCount + selection.childCount;
  const selectionValid = Number.isInteger(selection.adultCount) && Number.isInteger(selection.childCount) && selection.adultCount >= 0 && selection.childCount >= 0 && headCount >= offer.minimumParticipants && headCount <= offer.maxPartySize && (selection.childCount === 0 || !!offer.pricing.child) && (!offer.pricing.child?.adultRequired || selection.childCount === 0 || selection.adultCount > 0);
  const retrySecondsRemaining = retryUntil === null ? 0 : Math.max(0, Math.ceil((retryUntil - clockNow) / 1000));
  const checkingAvailability = checking && !apiUnavailable;
  const sellerLegalUrl = safeHttpsUrl(experience.seller.legalNoticeUrl);
  const consentInvalid = invalidField === "consent" || invalidField === "consent.agreedVersion";
  // Conditions with a point that needs an OK, and the optional mobile number: English mock only until NIHO's contract (src/journey.ts).
  const conditions = locale === "en" && journey.enabled ? usableConditions(journey.conditions) : null;
  const consentTexts = conditionConsentTexts(conditions);
  const collectsPhone = locale === "en" && journey.enabled;
  const guestPhone = draft.guestPhone ?? "";
  const [conditionsAgreed, setConditionsAgreed] = useState(false);
  const [startAt, setStartAt] = useState<string | null>(null);
  const conditionsInvalid = invalidField === "conditions" || invalidField === "conditionsConsent" || invalidField === "conditionsConsent.version";

  useEffect(() => {
    if (!api) return;
    let active = true;
    readAvailabilityFromApi(api, experience.slug, locale, releaseId, offer.id).then((occurrences) => {
      if (!active) return;
      const occurrence = occurrences?.find((item) => item.offerId === offer.id && item.date === selection.date);
      setAvailabilityOk(selectionValid && !!occurrence?.bookable && occurrence.seatsLeft >= headCount);
      setStartAt(occurrence?.startAt ?? null);
      setChecking(false);
    }).catch(() => { if (active) { setAvailabilityOk(false); setStartAt(null); setChecking(false); } });
    return () => { active = false; };
  }, [api, experience.slug, offer.id, selection.date, headCount, selectionValid, locale, releaseId]);
  // The free-cancellation row follows the clock: if the deadline passes while the form is open, it turns to "Not available for this date".
  const freeHours = offer.cancellationPolicy.freeCancellationHoursBefore;
  useEffect(() => {
    if (!startAt || freeHours === null) return;
    const start = Date.parse(startAt);
    if (!Number.isFinite(start)) return;
    const wait = start - freeHours * 3_600_000 - Date.now();
    if (wait <= 0) return;
    // A timer cannot wait longer than 2^31 ms: a longer wait wakes early, updates the clock, and arms the next one here.
    const timer = window.setTimeout(() => setClockNow(Date.now()), Math.min(wait + 500, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [startAt, freeHours, clockNow]);
  useEffect(() => {
    if (!problem) return;
    const id = invalidField === "consent" || invalidField === "consent.agreedVersion" ? "booking-consent"
      : invalidField === "conditions" || invalidField === "conditionsConsent" || invalidField === "conditionsConsent.version" ? "booking-conditions"
      : ["guestName", "guestEmail", "guestPhone", "note"].includes(invalidField) ? `booking-${invalidField}`
      : offer.bookingQuestions.some((question) => question.id === invalidField) ? `question-${invalidField}` : null;
    const control = id ? document.getElementById(id) : null;
    (control ?? alertRef.current)?.focus();
  }, [problem, invalidField, offer.bookingQuestions]);
  useEffect(() => {
    if (retryUntil === null) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setClockNow(now);
      if (now >= retryUntil) setRetryUntil(null);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [retryUntil]);
  useEffect(() => {
    if (checkingAvailability || viewTracked.current) return;
    viewTracked.current = true;
    if (locale === "en") {
      if (availabilityOk && total !== null) track("booking_form_view", { experience: experience.slug, guests: headCount, total_jpy: total });
      else track("booking_unavailable", { experience: experience.slug, error_code: "unavailable" });
    }
  }, [availabilityOk, checkingAvailability, experience.slug, headCount, total, locale]);

  function updateAnswer(id: string, value: string | string[]) { onDraftChange((current) => ({ ...current, answerSets: { ...current.answerSets, [questionSet]: { ...current.answerSets[questionSet], [id]: value } } })); }
  function collectAnswers(): CheckoutAnswer[] {
    const collected: CheckoutAnswer[] = [];
    for (const question of offer.bookingQuestions) {
      const value = answers[question.id];
      if (typeof value === "string" && value.trim()) collected.push({ questionId: question.id, text: value.trim() });
      if (Array.isArray(value) && value.length) collected.push({ questionId: question.id, optionIds: value });
    }
    return collected;
  }
  async function submit() {
    if (submitting || checkingAvailability || needsFreshDetails || retrySecondsRemaining > 0 || !api || total === null || !availabilityOk) return;
    setProblem(""); setInvalidField("");
    if (consentTexts.length && !conditionsAgreed) { setProblem(JOURNEY_PROBLEMS.conditions); setInvalidField("conditions"); return; }
    if (!guestName.trim()) { setProblem(fullNameValidationMessage(locale, copy)); setInvalidField("guestName"); return; }
    if (collectsPhone && guestPhone.trim() && !isValidGuestPhone(guestPhone)) { setProblem(JOURNEY_PROBLEMS.phone); setInvalidField("guestPhone"); return; }
    const answered = collectAnswers();
    const missing = offer.bookingQuestions.find((question) => question.required && !answered.some((answer) => answer.questionId === question.id));
    if (missing) { setProblem(copy.text("booking.requiredQuestion")); setInvalidField(missing.id); return; }
    if (!agreed) { setProblem(copy.text("booking.requiredTerms")); setInvalidField("consent"); return; }
    const draft: Omit<ExperienceCheckoutRequest, "clientRequestKey"> & ExperienceCheckoutJourneyFields = {
      offerId: offer.id, occurrenceDate: selection.date, adultCount: selection.adultCount, childCount: selection.childCount,
      expectedTotalYen: total, bookingQuestionsFingerprint: offer.bookingQuestionsFingerprint,
      guestName: guestName.trim(), guestEmail: guestEmail.trim(), ...(collectsPhone && guestPhone.trim() ? { guestPhone: normalizeGuestPhone(guestPhone) } : {}), ...(note.trim() ? { note: note.trim() } : {}),
      answers: answered, consent: { agreedVersion: experience.booking.consentVersion },
      ...(conditions && consentTexts.length ? { conditionsConsent: { version: conditions.version } } : {}),
      ...(attributionEnabled ? readBookingAttribution(navigator.doNotTrack) : {}),
    };
    const signature = JSON.stringify(draft);
    if (attemptRef.current?.signature !== signature) attemptRef.current = { signature, key: createClientRequestKey() };
    const body: ExperienceCheckoutRequest & ExperienceCheckoutJourneyFields = { ...draft, clientRequestKey: attemptRef.current.key };
    setSubmitting(true);
    if (locale === "en") track("checkout_start", { experience: experience.slug, guests: headCount, total_jpy: total });
    let result: Awaited<ReturnType<ExperienceApiClient["startJapaneseCheckout"]>>;
    try { result = locale === "ja" ? await api.startJapaneseCheckout(experience.slug, body) : await api.startCheckout(experience.slug, body); }
    catch {
      setSubmitting(false);
      setProblem(copy.text("booking.checkoutError"));
      return;
    }
    setSubmitting(false);
    if (result.ok) {
      if (preview) {
        const { isMockCheckoutUrl } = await import("@niho-experience/api-client/mock");
        if (!isMockCheckoutUrl(result.checkoutUrl)) { setProblem(copy.text("booking.previewUnexpected")); return; }
        router.push("/preview/checkout");
      } else window.location.assign(result.checkoutUrl);
      return;
    }
    if (result.kind === "rejected") {
      const errorCode = result.error.code === "INPUT_INVALID" || result.error.code === "ANSWERS_INVALID" ? "invalid_contact" : result.error.code === "FULL" ? "slot_sold_out" : result.error.code === "UNAVAILABLE" ? "unavailable" : result.error.code.toLowerCase();
      if (locale === "en") track("checkout_error", { experience: experience.slug, error_code: errorCode });
      const retryAfter = result.error.code === "RATE_LIMITED" ? result.retryAfterSeconds : null;
      const now = Date.now();
      setClockNow(now);
      setRetryUntil(retryAfter ? now + retryAfter * 1000 : null);
      const conditionsField = result.error.field?.startsWith("conditionsConsent") ?? false;
      // The host changed the conditions (or added ones that need an OK) after this page loaded: the detail is read again to show them.
      const conditionsOutdated = conditionsField && result.error.code === "CONSENT_OUTDATED";
      const conditionsMissing = conditionsField && result.error.code === "INPUT_INVALID" && consentTexts.length === 0;
      setProblem(retryAfter
        ? copy.text("booking.rateLimitedCount", { seconds: retryAfter, noun: retryUnit(locale, retryAfter) })
        : result.error.field === "guestPhone" ? JOURNEY_PROBLEMS.phone
        : conditionsOutdated ? JOURNEY_PROBLEMS.conditionsChanged
        : conditionsMissing ? JOURNEY_PROBLEMS.conditionsAdded
        : conditionsField ? JOURNEY_PROBLEMS.conditions
        : checkoutProblem(result.error.code, locale, copy));
      setInvalidField(result.error.questionId ?? result.error.field ?? "");
      if (result.error.code === "REQUEST_MISMATCH") attemptRef.current = null;
      if (conditionsOutdated || conditionsMissing || (!conditionsField && ["CONSENT_OUTDATED", "QUESTIONS_CHANGED", "PRICE_CHANGED"].includes(result.error.code))) setNeedsFreshDetails(true);
      if (["OCCURRENCE_INVALID", "FULL", "UNAVAILABLE"].includes(result.error.code)) setAvailabilityOk(false);
    } else if (result.kind === "localization_outdated") {
      setNeedsFreshDetails(true);
      setProblem(result.error.message);
    } else {
      if (locale === "en") track("checkout_error", { experience: experience.slug, error_code: result.kind === "network_error" ? "unavailable" : "unexpected_response" });
      setProblem(copy.text(result.kind === "network_error" ? "booking.checkoutError" : "booking.checkoutUnexpected"));
    }
  }

  async function refreshLatestDetails() {
    if (locale === "ja") {
      // Copy, terms, and the layout must advance to the new release together.
      window.location.reload();
      return;
    }
    if (!api || refreshing) return;
    setRefreshing(true);
    setProblem("");
    setInvalidField("");
    try {
      // With the journey additions the detail is read as v1.4: the same detail plus the participation conditions to agree to again.
      let latest: ExperienceDetailForSite | null;
      let latestConditions: ExperienceConditions | null | undefined;
      if (locale === "en" && journey.enabled) {
        const result = await api.getExperienceV14(experience.slug);
        latest = result.ok ? result.data.experience : null;
        latestConditions = result.ok ? usableConditions(result.data.experience.conditions) : undefined;
      } else {
        latest = publicApiVersion === "1.0"
          ? await api.getExperience(experience.slug).then((result) => result.ok ? result.data.experience : null)
          : await api.getExperienceV11(experience.slug).then((result) => result.ok ? result.data.experience : null);
      }
      if (!latest || latest.slug !== experience.slug) {
        setProblem(copy.text("booking.latestLoadError"));
        return;
      }
      if (!onExperienceRefresh(latest, latestConditions)) {
        setProblem(copy.text("booking.latestUnavailable"));
      }
    } catch {
      setProblem(copy.text("booking.latestLoadError"));
    } finally {
      setRefreshing(false);
    }
  }

  const approval = offer.acceptanceMode === "APPROVAL";
  const day = dayOption(selection.date, locale);
  const when = `${day.label} · ${formatClock(offer.startTime, locale)}`;
  const guests = locale === "ja" ? `大人${selection.adultCount}名${selection.childCount ? `、子ども${selection.childCount}名` : ""}` : `${selection.adultCount} adult${selection.adultCount === 1 ? "" : "s"}${selection.childCount ? `, ${selection.childCount} child${selection.childCount === 1 ? "" : "ren"}` : ""}`;
  const legalDocuments = experience.booking.legalDocuments.flatMap((doc) => { const url = safeHttpsUrl(doc.url); return url ? [{ kind: doc.kind, url }] : []; });
  // "Free cancellation until Thu 12 Nov, 7:00 AM Japan time": the policy's hours counted back from the date's start (contract: FREE_UNTIL_24H / 48H).
  const freeCancellation = locale === "en" ? freeCancellationDeadline(startAt ?? "", offer.cancellationPolicy.freeCancellationHoursBefore, new Date(clockNow)) : null;
  const hostTarget = askHostTarget(hostNames(experience));
  const model: BookingCheckoutViewModelV1 = {
    summary: { title: experience.title, image: experience.cover ? { src: experience.cover.url, alt: "" } : null, summary: `${formatDuration(offer.durationMinutes, locale)} · ${formatClock(offer.startTime, locale)} JST · ${offer.name}` },
    availability: checkingAvailability ? "checking" : needsFreshDetails ? "stale" : availabilityOk ? "ready" : "unavailable",
    refreshing,
    refreshDisabled: refreshing || !api,
    problem: problem || undefined,
    guestName,
    guestEmail,
    note,
    questions: offer.bookingQuestions.map((question) => ({ id: question.id, prompt: question.prompt, description: question.description ?? undefined, required: question.required, type: question.inputType, value: answers[question.id] ?? (question.inputType === "SHORT_TEXT" || question.inputType === "LONG_TEXT" ? "" : []), options: question.options, invalid: invalidField === question.id })),
    invalidGuestName: invalidField === "guestName",
    invalidGuestEmail: invalidField === "guestEmail",
    invalidNote: invalidField === "note",
    approval,
    review: [
      { label: copy.text("booking.date"), value: `${when} JST` },
      { label: copy.text("booking.guests"), value: guests },
      { label: copy.text("booking.adults"), value: copy.text("booking.adultRow", { count: selection.adultCount, price: formatYen(offer.pricing.adultPriceYen, locale) }) },
      ...(selection.childCount && offer.pricing.child ? [{ label: copy.text("booking.children"), value: copy.text("booking.childRow", { count: selection.childCount, price: formatYen(offer.pricing.child.priceYen, locale) }) }] : []),
      ...(freeCancellation ? [{ label: "Free cancellation", value: freeCancellation.state === "until" ? `Until ${freeCancellation.label}` : "Not available for this date" }] : []),
    ],
    total: total === null ? copy.text("booking.totalUnavailable") : formatYen(total, locale),
    policyTitle: policyTitle(offer.cancellationPolicy, locale),
    sellerName: experience.seller.displayName,
    sellerLegalUrl: sellerLegalUrl ?? undefined,
    legalDocuments,
    consentVersion: experience.booking.consentVersion,
    agreed,
    invalidConsent: consentInvalid,
    preview,
    submitting,
    retryWaiting: retrySecondsRemaining > 0,
    actionDisabled: submitting || checkingAvailability || !api || !availabilityOk || needsFreshDetails || retrySecondsRemaining > 0 || total === null,
    when,
    // English-only journey additions (Epic #103). Without them the screen is the one it always was.
    ...(conditions && consentTexts.length ? { conditions: { heading: "Before you book", agreeIntro: "Everyone in my group is OK with:", items: consentTexts, agreed: conditionsAgreed, invalid: conditionsInvalid } } : {}),
    ...(collectsPhone ? { guestPhone: { label: "Mobile number", hint: "(optional, for the day)", value: guestPhone, invalid: invalidField === "guestPhone" } } : {}),
    ...(locale === "en" && hostTarget !== "the host" ? { hostQuestionsHeading: `Questions from ${hostTarget}` } : {}),
  };
  return <BookingCheckoutViewV1 model={model} titleAs={titleAs} problemRef={alertRef} primitives={PRESENTATION_PRIMITIVES_V1} copy={copy} callbacks={{ onBack, onRefresh: refreshLatestDetails, onGuestNameChange: (value) => onDraftChange((current) => ({ ...current, guestName: value })), onGuestEmailChange: (value) => onDraftChange((current) => ({ ...current, guestEmail: value })), onGuestPhoneChange: (value) => onDraftChange((current) => ({ ...current, guestPhone: value })), onNoteChange: (value) => onDraftChange((current) => ({ ...current, note: value })), onAnswerChange: updateAnswer, onAgreementChange: setAgreed, onConditionsAgreementChange: setConditionsAgreed, onSubmit: submit }} />;
}
