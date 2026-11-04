import { describe, expect, it } from "vitest";
import {
  asPublicationPrice,
  publicationTermsForm,
  publicationTermsPayload,
  type ExistingPublicationTerms,
  type PublicationTermsForm,
} from "./publication-terms";

const existing: NonNullable<ExistingPublicationTerms> = {
  offerPrices: [{ offerId: "dinner-evening", adultPriceYen: 3_500 }],
  childPricing: { priceYen: 1_200, minAge: 4, maxAge: 12, adultRequired: true },
  minimumParticipants: 2,
  minimumChargeableParticipants: 1,
  maxPartySize: 6,
  minimumAttendance: null,
  cancellationPolicy: "CUSTOM",
  cancellationWindowMinutesBeforeStart: 180,
  cancellationRefundBasisPoints: 3_750,
  bookingQuestions: [{ id: "diet", prompt: "食べられないものはありますか？" }],
  conditionsVersion: "conditions-v3",
};

const form: PublicationTermsForm = publicationTermsForm(existing, [{ id: "dinner-evening" }]);

describe("publication sale terms form payload", () => {
  it("edits offer and child prices and converts human cancellation units without losing stored values", () => {
    expect(form).toMatchObject({
      offerPrices: [{ offerId: "dinner-evening", adultPriceYen: "3500" }],
      childPricingEnabled: true,
      childPriceYen: "1200",
      cancellationWindowValue: "3",
      cancellationWindowUnit: "HOURS",
      cancellationRefundPercent: "37.5",
    });
    expect(publicationTermsPayload(form, existing)).toMatchObject({
      offerPrices: [{ offerId: "dinner-evening", adultPriceYen: 3_500 }],
      childPricing: existing.childPricing,
      bookingQuestions: existing.bookingQuestions,
      conditionsVersion: "conditions-v3",
      cancellationWindowMinutesBeforeStart: 180,
      cancellationRefundBasisPoints: 3_750,
    });
  });

  it("uses the explicit base price fallback when no offer-specific amount is entered", () => {
    const blank = publicationTermsForm(null, [{ id: "new-offer" }]);
    const payload = publicationTermsPayload({
      ...blank,
      minimumParticipants: "1",
      minimumChargeableParticipants: "1",
      maxPartySize: "8",
      cancellationPolicy: "NONE",
    }, null);
    expect(payload).toHaveProperty("offerPrices", []);
    expect(payload).toMatchObject({ childPricing: null, bookingQuestions: [], conditionsVersion: null });
  });

  it("explicitly clears saved offer prices when every amount is removed", () => {
    const saved = { ...existing, offerPrices: [{ offerId: "dinner-evening", adultPriceYen: 5_000 }] };
    const edited = publicationTermsForm(saved, [{ id: "dinner-evening" }]);
    expect(publicationTermsPayload({
      ...edited, offerPrices: [{ offerId: "dinner-evening", adultPriceYen: "" }],
    }, saved)).toHaveProperty("offerPrices", []);
  });

  it("accepts explicit free prices and rejects every ¥1–49 price", () => {
    expect(asPublicationPrice("0")).toBe(0);
    expect(asPublicationPrice("50")).toBe(50);
    for (const price of ["1", "25", "49"]) expect(asPublicationPrice(price)).toBeNull();

    expect(publicationTermsPayload({ ...form, offerPrices: [{ offerId: "dinner-evening", adultPriceYen: "0" }] }, existing)).not.toBeNull();
    expect(publicationTermsPayload({ ...form, childPriceYen: "49" }, existing)).toBeNull();
  });

  it("requires every active offer price when any offer-specific price is entered", () => {
    expect(publicationTermsPayload({
      ...form,
      offerPrices: [{ offerId: "morning", adultPriceYen: "3000" }, { offerId: "evening", adultPriceYen: "" }],
    }, existing)).toBeNull();
  });
});
