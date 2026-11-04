export type CancellationWindowUnit = "MINUTES" | "HOURS" | "DAYS";

export type PublicationTermsForm = {
  offerPrices: readonly { offerId: string; adultPriceYen: string }[];
  childPricingEnabled: boolean;
  childPriceYen: string;
  childMinAge: string;
  childMaxAge: string;
  childAdultRequired: boolean;
  minimumParticipants: string;
  minimumChargeableParticipants: string;
  maxPartySize: string;
  minimumAttendance: string;
  cancellationPolicy: "" | "CUSTOM" | "NONE" | "FREE_UNTIL_24H" | "FREE_UNTIL_48H";
  cancellationWindowValue: string;
  cancellationWindowUnit: CancellationWindowUnit;
  cancellationRefundPercent: string;
};

export type PublicationOffer = { readonly id: string };

export type ExistingPublicationTerms = {
  offerPrices?: readonly { offerId: string; adultPriceYen: number }[] | null;
  childPricing: { priceYen: number; minAge: number; maxAge: number; adultRequired: boolean } | null;
  minimumParticipants: number;
  minimumChargeableParticipants: number;
  maxPartySize: number;
  minimumAttendance: number | null;
  cancellationPolicy: "CUSTOM" | "NONE" | "FREE_UNTIL_24H" | "FREE_UNTIL_48H";
  cancellationWindowMinutesBeforeStart: number | null;
  cancellationRefundBasisPoints: number;
  bookingQuestions: readonly unknown[];
  conditionsVersion: string | null;
} | null;

function asNumber(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** ¥0 is an explicit free price. Stripe-backed paid prices start at ¥50. */
export function asPublicationPrice(value: string): number | null {
  const parsed = asNumber(value);
  return parsed !== null && (parsed === 0 || parsed >= 50) ? parsed : null;
}

function refundBasisPoints(value: string): number | null {
  if (!/^(?:0|[1-9]\d{0,2})(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const basisPoints = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(basisPoints) && basisPoints <= 10_000 ? basisPoints : null;
}

function cancellationMinutes(value: string, unit: CancellationWindowUnit): number | null {
  const parsed = asNumber(value);
  if (parsed === null) return null;
  const multiplier = unit === "DAYS" ? 1_440 : unit === "HOURS" ? 60 : 1;
  const minutes = parsed * multiplier;
  return Number.isSafeInteger(minutes) && minutes <= 2_147_483_647 ? minutes : null;
}

function cancellationWindowForm(minutes: number | null): { value: string; unit: CancellationWindowUnit } {
  if (minutes === null) return { value: "", unit: "HOURS" };
  if (minutes > 0 && minutes % 1_440 === 0) return { value: String(minutes / 1_440), unit: "DAYS" };
  if (minutes > 0 && minutes % 60 === 0) return { value: String(minutes / 60), unit: "HOURS" };
  return { value: String(minutes), unit: "MINUTES" };
}

export function publicationTermsForm(existing: ExistingPublicationTerms, offers: readonly PublicationOffer[]): PublicationTermsForm {
  const cancellation = cancellationWindowForm(existing?.cancellationWindowMinutesBeforeStart ?? null);
  const prices = new Map((existing?.offerPrices ?? []).map((price) => [price.offerId, price.adultPriceYen]));
  return {
    offerPrices: offers.map((offer) => ({ offerId: offer.id, adultPriceYen: prices.has(offer.id) ? String(prices.get(offer.id)) : "" })),
    childPricingEnabled: existing?.childPricing !== null && existing?.childPricing !== undefined,
    childPriceYen: existing?.childPricing ? String(existing.childPricing.priceYen) : "",
    childMinAge: existing?.childPricing ? String(existing.childPricing.minAge) : "",
    childMaxAge: existing?.childPricing ? String(existing.childPricing.maxAge) : "",
    childAdultRequired: existing?.childPricing?.adultRequired ?? true,
    minimumParticipants: existing ? String(existing.minimumParticipants) : "",
    minimumChargeableParticipants: existing ? String(existing.minimumChargeableParticipants) : "",
    maxPartySize: existing ? String(existing.maxPartySize) : "",
    minimumAttendance: existing?.minimumAttendance === null || existing?.minimumAttendance === undefined ? "" : String(existing.minimumAttendance),
    cancellationPolicy: existing?.cancellationPolicy ?? "",
    cancellationWindowValue: cancellation.value,
    cancellationWindowUnit: cancellation.unit,
    cancellationRefundPercent: existing ? String(existing.cancellationRefundBasisPoints / 100) : "",
  };
}

/** Build explicit host inputs while carrying forward fields this form does not edit. */
export function publicationTermsPayload(value: PublicationTermsForm, existing: ExistingPublicationTerms): Record<string, unknown> | null {
  const minimumParticipants = asNumber(value.minimumParticipants);
  const minimumChargeableParticipants = asNumber(value.minimumChargeableParticipants);
  const maxPartySize = asNumber(value.maxPartySize);
  const minimumAttendance = value.minimumAttendance === "" ? null : asNumber(value.minimumAttendance);
  if (minimumParticipants === null || minimumChargeableParticipants === null || maxPartySize === null
    || value.cancellationPolicy === "" || (value.minimumAttendance !== "" && minimumAttendance === null)) return null;

  const enteredOfferPrices = value.offerPrices.filter((price) => price.adultPriceYen !== "");
  if (enteredOfferPrices.length > 0 && enteredOfferPrices.length !== value.offerPrices.length) return null;
  const offerPrices = enteredOfferPrices.map((price) => ({ offerId: price.offerId, adultPriceYen: asPublicationPrice(price.adultPriceYen) }));
  if (offerPrices.some((price) => price.adultPriceYen === null)) return null;

  let childPricing = null;
  if (value.childPricingEnabled) {
    const priceYen = asPublicationPrice(value.childPriceYen);
    const minAge = asNumber(value.childMinAge);
    const maxAge = asNumber(value.childMaxAge);
    if (priceYen === null || minAge === null || maxAge === null) return null;
    childPricing = { priceYen, minAge, maxAge, adultRequired: value.childAdultRequired };
  }

  const payload: Record<string, unknown> = {
    ...(offerPrices.length > 0 ? { offerPrices } : {}),
    childPricing,
    minimumParticipants,
    minimumChargeableParticipants,
    maxPartySize,
    minimumAttendance,
    cancellationPolicy: value.cancellationPolicy,
    bookingQuestions: existing?.bookingQuestions ?? [],
    conditionsVersion: existing?.conditionsVersion ?? null,
  };
  if (value.cancellationPolicy === "CUSTOM") {
    const minutes = cancellationMinutes(value.cancellationWindowValue, value.cancellationWindowUnit);
    const refund = refundBasisPoints(value.cancellationRefundPercent);
    if (minutes === null || refund === null) return null;
    payload.cancellationWindowMinutesBeforeStart = minutes;
    payload.cancellationRefundBasisPoints = refund;
  }
  return payload;
}
