import { describe, expect, it } from "vitest";
import type { SitePublicOffer } from "./site-publications";
import { expectedSiteBookingTotalYen } from "./site-booking-rules";

const offer: SitePublicOffer = {
  id: "synthetic-rule",
  name: "Synthetic session",
  shortDescription: null,
  pricing: { currency: "JPY", taxIncluded: true, adultPriceYen: 4_000, child: null },
  capacity: 6,
  maxPartySize: 6,
  minimumParticipants: 1,
  minimumChargeableParticipants: 2,
  durationMinutes: 90,
  startTime: "10:00",
  weekdays: [6],
  cancellationPolicy: { code: "CUSTOM", freeCancellationHoursBefore: null },
  cancellationTerms: { cancellationWindowMinutesBeforeStart: 90, refundBasisPoints: 3_750 },
  acceptanceMode: "INSTANT",
  bookingQuestions: [],
  bookingQuestionsFingerprint: "a".repeat(64),
};

describe("Experience public booking amount", () => {
  it("uses the same adult-price minimum-charge floor as the hold transaction", () => {
    expect(expectedSiteBookingTotalYen(offer, 1, 0)).toBe(8_000);
    expect(expectedSiteBookingTotalYen(offer, 2, 0)).toBe(8_000);
  });

  it("prices children separately before applying the minimum-charge floor", () => {
    const withChildren = { ...offer, pricing: { ...offer.pricing, child: { priceYen: 1_000, minAge: 0, maxAge: 12, adultRequired: true } } };
    expect(expectedSiteBookingTotalYen(withChildren, 1, 1)).toBe(8_000);
    expect(expectedSiteBookingTotalYen(withChildren, 2, 1)).toBe(9_000);
    expect(expectedSiteBookingTotalYen(withChildren, 0, 1)).toBeNull();
  });

  it("closes invalid counts instead of displaying a guessed amount", () => {
    expect(expectedSiteBookingTotalYen(offer, 0, 0)).toBeNull();
    expect(expectedSiteBookingTotalYen(offer, 7, 0)).toBeNull();
    expect(expectedSiteBookingTotalYen(offer, 1.5, 0)).toBeNull();
    expect(expectedSiteBookingTotalYen(offer, 1, 1)).toBeNull();
  });
});
