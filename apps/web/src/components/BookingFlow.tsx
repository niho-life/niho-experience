"use client";
import { useEffect, useRef, useState } from "react";
import { NO_JOURNEY_EXTRAS, type ExperienceApiClient, type ExperienceConditions, type JourneyDetailExtras } from "@niho-experience/api-client";
import type { ExperienceDetailForSite } from "@/lib/experience-types";
import { getBookingApi } from "@/lib/browser-api";
import type { BookingSource } from "@/lib/booking-source";
import { BookingForm, type BookingDraft, type CheckoutAttempt } from "./BookingForm";
import { SlotPicker, type BookingSelection } from "./SlotPicker";

/** Two screens on one page: date and party size (SlotPicker), then details and checkout (BookingForm). `titleAs="p"` when a published document supplies the page heading. */
export function BookingFlow({ experience, preview, availabilityIsProvisional, bookingSource, attributionEnabled, publicApiVersion = "1.1", journey = NO_JOURNEY_EXTRAS, initialOfferId, initialDate, initialAdultCount, titleAs = "h1" }: { experience: ExperienceDetailForSite; preview: boolean; availabilityIsProvisional: boolean; bookingSource: BookingSource; attributionEnabled: boolean; publicApiVersion?: "1.0" | "1.1" | "1.2"; journey?: JourneyDetailExtras; initialOfferId?: string; initialDate?: string; initialAdultCount?: number; titleAs?: "h1" | "p" }) {
  const [freshExperience, setFreshExperience] = useState<{ source: ExperienceDetailForSite; value: ExperienceDetailForSite } | null>(null);
  const currentExperience = freshExperience?.source === experience ? freshExperience.value : experience;
  // The participation conditions come with the detail (v1.4). A reload after "the points changed" replaces them together with the experience.
  const [freshConditions, setFreshConditions] = useState<{ source: JourneyDetailExtras; value: ExperienceConditions | null } | null>(null);
  const currentConditions = freshConditions?.source === journey ? freshConditions.value : journey.conditions;
  const currentJourney: JourneyDetailExtras = currentConditions === journey.conditions ? journey : { ...journey, conditions: currentConditions };
  const [api, setApi] = useState<ExperienceApiClient | null>(null);
  const [apiUnavailable, setApiUnavailable] = useState(false);
  useEffect(() => {
    let active = true;
    // NIHO's API, or this site's routes for an experience sold here (#285): availability, checkout and the refresh below.
    getBookingApi(preview, bookingSource).then((client) => { if (active) setApi(client); }).catch(() => { if (active) setApiUnavailable(true); });
    return () => { active = false; };
  }, [preview, bookingSource]);
  const [selection, setSelection] = useState<BookingSelection | null>(null);
  const [lastSelection, setLastSelection] = useState<BookingSelection | null>(null);
  // Contact data stays in this page's memory only; answers belong to one offer and question fingerprint.
  const [draft, setDraft] = useState<BookingDraft>({ guestName: "", guestEmail: "", guestPhone: "", note: "", answerSets: {} });
  const attemptRef = useRef<CheckoutAttempt | null>(null);
  const offer = currentExperience.offers.find((item) => item.id === selection?.offerId);
  function continueBooking(next: BookingSelection) {
    setLastSelection(next);
    setSelection(next);
  }
  // Switching screens keeps the page's scroll position by default, which can land mid-form. Bring the booking area's top into view and move focus there.
  const top = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    top.current?.scrollIntoView({ block: "start" });
    top.current?.focus({ preventScroll: true });
  }, [selection]);
  const formKey = bookingFormKey(currentExperience, selection, offer, currentConditions);
  function acceptFreshExperience(updated: ExperienceDetailForSite, updatedConditions?: ExperienceConditions | null) {
    const updatedOffer = updated.offers.find((item) => item.id === selection?.offerId);
    const conditions = updatedConditions === undefined ? currentConditions : updatedConditions;
    if (bookingFormKey(updated, selection, updatedOffer, conditions) === formKey) return false;
    setFreshExperience({ source: experience, value: updated });
    if (updatedConditions !== undefined) setFreshConditions({ source: journey, value: updatedConditions });
    return true;
  }
  return <div ref={top} tabIndex={-1} className="scroll-mt-20 outline-none">{selection && offer ? <BookingForm key={formKey} api={api} apiUnavailable={apiUnavailable} experience={currentExperience} offer={offer} selection={selection} preview={preview} attributionEnabled={attributionEnabled} publicApiVersion={publicApiVersion} journey={currentJourney} onExperienceRefresh={acceptFreshExperience} bookingSource={bookingSource} draft={draft} onDraftChange={setDraft} attemptRef={attemptRef} onBack={() => setSelection(null)} titleAs={titleAs} /> : <SlotPicker experience={currentExperience} titleAs={titleAs} slug={currentExperience.slug} offers={currentExperience.offers} preview={preview} availabilityIsProvisional={availabilityIsProvisional} bookingSource={bookingSource} onContinue={continueBooking} initialOfferId={lastSelection?.offerId ?? initialOfferId} initialDate={lastSelection?.date ?? initialDate} initialAdultCount={lastSelection?.adultCount ?? initialAdultCount} initialChildCount={lastSelection?.childCount} />}</div>;
}

function bookingFormKey(experience: ExperienceDetailForSite, selection: BookingSelection | null, offer: ExperienceDetailForSite["offers"][number] | undefined, conditions: ExperienceConditions | null) {
  return offer && selection ? JSON.stringify([selection, offer.bookingQuestionsFingerprint, offer.pricing, offer.minimumParticipants, offer.maxPartySize, offer.cancellationPolicy, offer.acceptanceMode, experience.seller, experience.booking.consentVersion, experience.booking.legalDocuments, conditions?.version ?? null]) : "";
}
