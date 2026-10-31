import type { BookingQuestion, ExperienceOffer } from "@niho-experience/api-client";
import type { PublicBookingTerms } from "@niho-experience/experience-store";
import type { ExperienceDetailForSite } from "./experience-types";

/**
 * What defines the sale of an experience sold on this site (#285, docs/guest-booking.md), in the shapes the
 * detail page and the booking form already read: the offers (IDs, times, duration, capacity, party limits,
 * prices with the child price, booking questions and their fingerprint, cancellation policy) and the booking
 * terms. The detail page lays it over NIHO's detail; `GET /api/public/experiences/{slug}/booking-terms` returns
 * it for the form's refresh. NIHO keeps the content (text, photos, hosts, meeting point), the seller's legal
 * notice and the legal documents (NIHO's platform terms) until the editor moves (#89).
 */
export type SiteSaleTerms = {
  offers: ExperienceOffer[];
  booking: { consentVersion: string; checkoutAvailable: true; currency: "JPY"; timeZone: "Asia/Tokyo" };
  sellerDisplayName: string;
};

/**
 * The store's terms in NIHO's public shapes, field by field: the provider and product IDs (server-only) never
 * reach a page. `consentVersion` is the version the checkout route compares (EXPERIENCE_BOOKING_CONSENT_VERSION).
 */
export function siteSaleTerms(terms: PublicBookingTerms, consentVersion: string): SiteSaleTerms {
  return {
    offers: terms.offers.map((offer) => ({
      id: offer.id,
      name: offer.name,
      shortDescription: offer.shortDescription,
      pricing: {
        currency: offer.pricing.currency,
        taxIncluded: offer.pricing.taxIncluded,
        adultPriceYen: offer.pricing.adultPriceYen,
        child: offer.pricing.child === null ? null : {
          priceYen: offer.pricing.child.priceYen,
          minAge: offer.pricing.child.minAge,
          maxAge: offer.pricing.child.maxAge,
          adultRequired: offer.pricing.child.adultRequired,
        },
      },
      capacity: offer.capacity,
      maxPartySize: offer.maxPartySize,
      minimumParticipants: offer.minimumParticipants,
      durationMinutes: offer.durationMinutes,
      startTime: offer.startTime,
      weekdays: [...offer.weekdays],
      cancellationPolicy: { code: offer.cancellationPolicy.code, freeCancellationHoursBefore: offer.cancellationPolicy.freeCancellationHoursBefore },
      acceptanceMode: offer.acceptanceMode,
      bookingQuestions: offer.bookingQuestions.map((question) => ({
        id: question.id,
        prompt: question.prompt,
        description: question.description,
        inputType: question.inputType,
        required: question.required,
        options: question.options.map((option) => ({ id: option.id, label: option.label })),
      })),
      bookingQuestionsFingerprint: offer.bookingQuestionsFingerprint,
    })),
    booking: { consentVersion, checkoutAvailable: true, currency: "JPY", timeZone: "Asia/Tokyo" },
    sellerDisplayName: terms.sellerDisplayName,
  };
}

/** NIHO's detail with this site's sale: its offers, consent version and seller name. Everything else stays NIHO's. */
export function withSiteSaleTerms<T extends ExperienceDetailForSite>(detail: T, sale: SiteSaleTerms): T {
  return {
    ...detail,
    offers: sale.offers,
    booking: { ...detail.booking, ...sale.booking },
    seller: { ...detail.seller, displayName: sale.sellerDisplayName },
  };
}

/* ---------- reading the route's answer in the browser ---------- */

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const hasKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const isCount = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && (value as number) >= min;
const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.length >= 1 && value.length <= max;

function isChildPricing(value: unknown): boolean {
  return value === null || (isObject(value) && hasKeys(value, ["priceYen", "minAge", "maxAge", "adultRequired"])
    && isCount(value.priceYen) && isCount(value.minAge) && isCount(value.maxAge) && typeof value.adultRequired === "boolean");
}

function isQuestion(value: unknown): value is BookingQuestion {
  return isObject(value) && hasKeys(value, ["id", "prompt", "description", "inputType", "required", "options"])
    && isText(value.id, 40) && isText(value.prompt, 120) && (value.description === null || isText(value.description, 300))
    && ["SHORT_TEXT", "LONG_TEXT", "SINGLE_SELECT", "MULTI_SELECT"].includes(value.inputType as string) && typeof value.required === "boolean"
    && Array.isArray(value.options) && value.options.length <= 8
    && value.options.every((option) => isObject(option) && hasKeys(option, ["id", "label"]) && isText(option.id, 40) && isText(option.label, 80));
}

const OFFER_KEYS = [
  "id", "name", "shortDescription", "pricing", "capacity", "maxPartySize", "minimumParticipants", "durationMinutes", "startTime",
  "weekdays", "cancellationPolicy", "acceptanceMode", "bookingQuestions", "bookingQuestionsFingerprint",
] as const;

function isOffer(value: unknown): value is ExperienceOffer {
  if (!isObject(value) || !hasKeys(value, OFFER_KEYS)) return false;
  const { pricing, cancellationPolicy: policy } = value;
  return isText(value.id, 64) && isText(value.name, 200) && (value.shortDescription === null || typeof value.shortDescription === "string")
    && isObject(pricing) && hasKeys(pricing, ["currency", "taxIncluded", "adultPriceYen", "child"])
    && pricing.currency === "JPY" && pricing.taxIncluded === true && isCount(pricing.adultPriceYen) && isChildPricing(pricing.child)
    && isCount(value.capacity, 1) && isCount(value.maxPartySize, 1) && isCount(value.minimumParticipants, 1) && isCount(value.durationMinutes, 1)
    && typeof value.startTime === "string" && /^\d{2}:\d{2}$/.test(value.startTime)
    && Array.isArray(value.weekdays) && value.weekdays.every((day) => isCount(day) && day <= 6)
    && isObject(policy) && hasKeys(policy, ["code", "freeCancellationHoursBefore"])
    && ["FREE_UNTIL_24H", "FREE_UNTIL_48H", "NONE"].includes(policy.code as string) && [24, 48, null].includes(policy.freeCancellationHoursBefore as number | null)
    && (value.acceptanceMode === "INSTANT" || value.acceptanceMode === "APPROVAL")
    && Array.isArray(value.bookingQuestions) && value.bookingQuestions.length <= 5 && value.bookingQuestions.every(isQuestion)
    && typeof value.bookingQuestionsFingerprint === "string" && /^[0-9a-f]{64}$/.test(value.bookingQuestionsFingerprint);
}

/** The route's answer, read as closed shapes (the browser trusts no response shape). Anything else is null. */
export function parseSiteSaleTerms(value: unknown): SiteSaleTerms | null {
  if (!isObject(value) || !hasKeys(value, ["offers", "booking", "sellerDisplayName"])) return null;
  const booking = value.booking;
  const valid = Array.isArray(value.offers) && value.offers.length <= 50 && value.offers.every(isOffer)
    && isObject(booking) && hasKeys(booking, ["consentVersion", "checkoutAvailable", "currency", "timeZone"])
    && isText(booking.consentVersion, 100) && booking.checkoutAvailable === true && booking.currency === "JPY" && booking.timeZone === "Asia/Tokyo"
    && isText(value.sellerDisplayName, 300);
  return valid ? value as SiteSaleTerms : null;
}
