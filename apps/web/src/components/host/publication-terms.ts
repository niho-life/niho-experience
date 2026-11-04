export type PublicationTermsForm = {
  minimumParticipants: string;
  minimumChargeableParticipants: string;
  maxPartySize: string;
  minimumAttendance: string;
  cancellationPolicy: "" | "CUSTOM" | "NONE" | "FREE_UNTIL_24H" | "FREE_UNTIL_48H";
  cancellationWindowMinutesBeforeStart: string;
  cancellationRefundBasisPoints: string;
};

export type ExistingPublicationTerms = {
  childPricing: { priceYen: number; minAge: number; maxAge: number; adultRequired: boolean } | null;
  bookingQuestions: readonly unknown[];
  conditionsVersion: string | null;
} | null;

function asNumber(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Build the edited fields while carrying forward sale terms this form does not edit. */
export function publicationTermsPayload(value: PublicationTermsForm, existing: ExistingPublicationTerms): Record<string, unknown> | null {
  const minimumParticipants = asNumber(value.minimumParticipants);
  const minimumChargeableParticipants = asNumber(value.minimumChargeableParticipants);
  const maxPartySize = asNumber(value.maxPartySize);
  const minimumAttendance = value.minimumAttendance === "" ? null : asNumber(value.minimumAttendance);
  if (minimumParticipants === null || minimumChargeableParticipants === null || maxPartySize === null
    || value.cancellationPolicy === "" || (value.minimumAttendance !== "" && minimumAttendance === null)) return null;

  const payload: Record<string, unknown> = {
    childPricing: existing?.childPricing ?? null,
    minimumParticipants,
    minimumChargeableParticipants,
    maxPartySize,
    minimumAttendance,
    cancellationPolicy: value.cancellationPolicy,
    bookingQuestions: existing?.bookingQuestions ?? [],
    conditionsVersion: existing?.conditionsVersion ?? null,
  };
  if (value.cancellationPolicy === "CUSTOM") {
    const minutes = asNumber(value.cancellationWindowMinutesBeforeStart);
    const refund = asNumber(value.cancellationRefundBasisPoints);
    if (minutes === null || refund === null || refund > 10000) return null;
    payload.cancellationWindowMinutesBeforeStart = minutes;
    payload.cancellationRefundBasisPoints = refund;
  }
  return payload;
}
