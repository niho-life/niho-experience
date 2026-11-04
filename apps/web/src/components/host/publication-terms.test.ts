import { describe, expect, it } from "vitest";
import { publicationTermsPayload, type PublicationTermsForm } from "./publication-terms";

const form: PublicationTermsForm = {
  minimumParticipants: "2", minimumChargeableParticipants: "1", maxPartySize: "6", minimumAttendance: "",
  cancellationPolicy: "CUSTOM", cancellationWindowMinutesBeforeStart: "180", cancellationRefundBasisPoints: "5000",
};

describe("publication sale terms form payload", () => {
  it("preserves child pricing, booking questions, and conditions version while editing cancellation terms", () => {
    const existing = {
      childPricing: { priceYen: 1200, minAge: 4, maxAge: 12, adultRequired: true },
      bookingQuestions: [{ id: "diet", prompt: "食べられないものはありますか？" }],
      conditionsVersion: "conditions-v3",
    };
    expect(publicationTermsPayload(form, existing)).toMatchObject({
      childPricing: existing.childPricing,
      bookingQuestions: existing.bookingQuestions,
      conditionsVersion: "conditions-v3",
      minimumParticipants: 2,
      cancellationPolicy: "CUSTOM",
      cancellationWindowMinutesBeforeStart: 180,
      cancellationRefundBasisPoints: 5000,
    });
  });

  it("uses empty values only when no existing terms exist", () => {
    expect(publicationTermsPayload(form, null)).toMatchObject({ childPricing: null, bookingQuestions: [], conditionsVersion: null });
  });
});
