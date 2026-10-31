import type { PublicBookingTerms } from "@niho-experience/experience-store";

/** Synthetic only. What the experience DB sells for a synthetic tea ceremony (#285): two offers, a child price, one question. */
export const SAMPLE_TERMS: PublicBookingTerms = {
  providerId: "provider-sample",
  productId: "tea",
  title: "Synthetic tea ceremony",
  currency: "JPY",
  sellerDisplayName: "Sample Seller",
  conditionsVersion: null,
  offers: [
    {
      id: "sample-am",
      name: "Synthetic tea ceremony",
      shortDescription: null,
      pricing: { currency: "JPY", taxIncluded: true, adultPriceYen: 4000, child: { priceYen: 2000, minAge: 6, maxAge: 12, adultRequired: true } },
      capacity: 6,
      maxPartySize: 6,
      minimumParticipants: 1,
      durationMinutes: 90,
      startTime: "10:00",
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      cancellationPolicy: { code: "FREE_UNTIL_24H", freeCancellationHoursBefore: 24 },
      acceptanceMode: "INSTANT",
      bookingQuestions: [
        { id: "diet", prompt: "Food needs", description: null, inputType: "SINGLE_SELECT", required: true, options: [{ id: "veg", label: "Vegetarian" }, { id: "none", label: "No restrictions" }] },
      ],
      bookingQuestionsFingerprint: "b".repeat(64),
    },
    {
      id: "sample-pm",
      name: "Synthetic tea ceremony",
      shortDescription: null,
      pricing: { currency: "JPY", taxIncluded: true, adultPriceYen: 4500, child: null },
      capacity: 4,
      maxPartySize: 4,
      minimumParticipants: 2,
      durationMinutes: 120,
      startTime: "14:30",
      weekdays: [1, 5],
      cancellationPolicy: { code: "NONE", freeCancellationHoursBefore: null },
      acceptanceMode: "INSTANT",
      bookingQuestions: [],
      bookingQuestionsFingerprint: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    },
  ],
};
