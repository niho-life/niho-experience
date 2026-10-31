import "server-only";
import type {
  CheckoutErrorCode,
  ExperienceCheckoutError,
  ExperienceCheckoutErrorResponse,
  ExperienceCheckoutJourneyFields,
  ExperienceCheckoutRequest,
} from "@niho-experience/api-client";
import type { GuestBookingAnswer, GuestCheckoutError, StartGuestBookingInput } from "@niho-experience/experience-store";
import { publicJson, readPublicJsonObject, retryAfterHeader } from "@/lib/experience/public-http";

/*
 * The public checkout of 旅行者の予約 (#285, docs/guest-booking.md) answers with NIHO's contract
 * (docs/api-contract.md §7): the statuses per code and the closed `{ error }` body of eight fields. The
 * request carries the guest's name, address, phone, note and answers: none of it is logged or echoed.
 */

/** Every checkout body fits in this many bytes. */
export const GUEST_CHECKOUT_BODY_LIMIT = 16 * 1024;

const STATUS: Record<CheckoutErrorCode, number> = {
  VALIDATION_ERROR: 400,
  INPUT_INVALID: 422,
  ANSWERS_INVALID: 422,
  CONSENT_OUTDATED: 422,
  OCCURRENCE_INVALID: 422,
  UNAVAILABLE: 409,
  FULL: 409,
  HOLD_LIMIT: 409,
  QUESTIONS_CHANGED: 409,
  PRICE_CHANGED: 409,
  REQUEST_MISMATCH: 409,
  RATE_LIMITED: 429,
  CHECKOUT_UNAVAILABLE: 503,
};

/** For developers (the page words its message from the code). Never what the guest sent. */
const MESSAGES: Record<CheckoutErrorCode, string> = {
  VALIDATION_ERROR: "The request could not be read.",
  INPUT_INVALID: "A field is invalid.",
  ANSWERS_INVALID: "An answer is invalid.",
  CONSENT_OUTDATED: "The agreed version is not the current one.",
  OCCURRENCE_INVALID: "This occurrence cannot be booked.",
  UNAVAILABLE: "This experience is not taking bookings now.",
  FULL: "Not enough seats are left.",
  HOLD_LIMIT: "Too many bookings are waiting for payment.",
  QUESTIONS_CHANGED: "The booking questions changed.",
  PRICE_CHANGED: "The total changed.",
  REQUEST_MISMATCH: "This request key was used with other content.",
  RATE_LIMITED: "Too many bookings. Please wait before trying again.",
  CHECKOUT_UNAVAILABLE: "The payment page could not be prepared. Please try again with the same request.",
};

type ErrorDetails = Partial<Pick<ExperienceCheckoutError, "field" | "questionId" | "seatsLeft" | "currentTotalYen" | "occurrenceReason">> & {
  readonly retryAfterSeconds?: number | null;
  /** Overrides the code's own status (413 for a body that is too large). */
  readonly status?: number;
};

/** NIHO's closed error body. As NIHO, only RATE_LIMITED and CHECKOUT_UNAVAILABLE may be sent again unchanged. */
export function checkoutError(code: CheckoutErrorCode, details: ErrorDetails = {}): Response {
  const error: ExperienceCheckoutError = {
    code,
    message: MESSAGES[code],
    retryable: code === "RATE_LIMITED" || code === "CHECKOUT_UNAVAILABLE",
    field: details.field ?? null,
    questionId: details.questionId ?? null,
    seatsLeft: details.seatsLeft ?? null,
    currentTotalYen: details.currentTotalYen ?? null,
    occurrenceReason: details.occurrenceReason ?? null,
  };
  return publicJson(details.status ?? STATUS[code], { error } satisfies ExperienceCheckoutErrorResponse, retryAfterHeader(details.retryAfterSeconds));
}

/** The store's refusal, which carries NIHO's fields, as NIHO's answer (Retry-After on RATE_LIMITED). */
export function storeCheckoutError(error: GuestCheckoutError): Response {
  return checkoutError(error.code, {
    field: error.field,
    questionId: error.questionId,
    seatsLeft: error.seatsLeft,
    currentTotalYen: error.currentTotalYen,
    occurrenceReason: error.occurrenceReason,
    retryAfterSeconds: error.retryAfterSeconds,
  });
}

type CheckoutBody = ExperienceCheckoutRequest & ExperienceCheckoutJourneyFields;

const UTM_KEYS = ["utmSource", "utmMedium", "utmCampaign", "utmContent"] as const satisfies readonly (keyof CheckoutBody)[];
const REQUEST_KEYS: readonly string[] = [
  "offerId", "occurrenceDate", "adultCount", "childCount", "expectedTotalYen", "guestName", "guestEmail", "note", "answers",
  "bookingQuestionsFingerprint", "consent", "clientRequestKey", ...UTM_KEYS, "guestPhone", "conditionsConsent",
] satisfies readonly (keyof CheckoutBody)[];
const STRING_FIELDS = ["offerId", "occurrenceDate", "guestName", "guestEmail", "bookingQuestionsFingerprint", "clientRequestKey"] as const;
const NUMBER_FIELDS = ["adultCount", "childCount", "expectedTotalYen"] as const;

/** What the page decides; the route adds the slug, the language and the current terms version. */
export type GuestCheckoutFields = Omit<StartGuestBookingInput, "slug" | "guestLanguage" | "currentConsentVersion" | "holdSeconds">;

export type ParsedGuestCheckout = { ok: true; fields: GuestCheckoutFields } | { ok: false; response: Response };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

const refused = (response: Response): ParsedGuestCheckout => ({ ok: false, response });
const invalid = (field: string): ParsedGuestCheckout => refused(checkoutError("INPUT_INVALID", { field }));

/**
 * NIHO's checkout request (PublicExperienceCheckoutRequest) with the journey's guestPhone and
 * conditionsConsent, read strictly: a body that is not a small JSON object, or a key the closed shapes do
 * not have, is VALIDATION_ERROR (the page's own mistake); a value of the wrong type is INPUT_INVALID with
 * its field. The value rules (lengths, patterns, answers against the questions) are the store's, which
 * answers NIHO's codes. With `DNT: 1` the UTM fields are dropped unread, as NIHO does.
 */
export async function readGuestCheckout(request: Request): Promise<ParsedGuestCheckout> {
  const body = await readPublicJsonObject(request, GUEST_CHECKOUT_BODY_LIMIT);
  if (!body.ok) return refused(checkoutError("VALIDATION_ERROR", body.tooLarge ? { status: 413 } : {}));
  const value = body.value;
  if (!onlyKeys(value, REQUEST_KEYS)) return refused(checkoutError("VALIDATION_ERROR"));

  for (const field of STRING_FIELDS) if (typeof value[field] !== "string") return invalid(field);
  for (const field of NUMBER_FIELDS) if (typeof value[field] !== "number") return invalid(field);
  if (value.note !== undefined && value.note !== null && typeof value.note !== "string") return invalid("note");
  if (value.guestPhone !== undefined && typeof value.guestPhone !== "string") return invalid("guestPhone");

  const consent = value.consent;
  if (!isObject(consent)) return invalid("consent.agreedVersion");
  if (!onlyKeys(consent, ["agreedVersion"])) return refused(checkoutError("VALIDATION_ERROR"));
  if (typeof consent.agreedVersion !== "string") return invalid("consent.agreedVersion");

  const conditions = value.conditionsConsent;
  if (conditions !== undefined && !isObject(conditions)) return invalid("conditionsConsent");
  if (conditions !== undefined && !onlyKeys(conditions, ["version"])) return refused(checkoutError("VALIDATION_ERROR"));
  if (conditions !== undefined && typeof conditions.version !== "string") return invalid("conditionsConsent");

  // The store checks each answer against the offer's questions (ANSWERS_INVALID with its questionId).
  const answers = value.answers;
  if (answers !== undefined && !Array.isArray(answers)) return refused(checkoutError("ANSWERS_INVALID", { field: "answers" }));
  if (answers?.some((answer) => isObject(answer) && !onlyKeys(answer, ["questionId", "text", "optionIds"]))) {
    return refused(checkoutError("VALIDATION_ERROR"));
  }

  let utm: Partial<Record<(typeof UTM_KEYS)[number], string>> | undefined;
  if (request.headers.get("dnt") !== "1") {
    utm = {};
    for (const key of UTM_KEYS) {
      const item = value[key];
      if (item === undefined) continue;
      if (typeof item !== "string") return invalid(key);
      utm[key] = item;
    }
  }

  return {
    ok: true,
    fields: {
      offerId: value.offerId as string,
      occurrenceDate: value.occurrenceDate as string,
      adultCount: value.adultCount as number,
      childCount: value.childCount as number,
      expectedTotalYen: value.expectedTotalYen as number,
      bookingQuestionsFingerprint: value.bookingQuestionsFingerprint as string,
      answers: answers as readonly GuestBookingAnswer[] | undefined,
      termsConsentVersion: consent.agreedVersion,
      conditionsConsentVersion: conditions === undefined ? null : (conditions.version as string),
      guestName: value.guestName as string,
      guestEmail: value.guestEmail as string,
      guestPhone: (value.guestPhone as string | undefined) ?? null,
      note: (value.note as string | null | undefined) ?? null,
      utm,
      clientRequestKey: value.clientRequestKey as string,
    },
  };
}
