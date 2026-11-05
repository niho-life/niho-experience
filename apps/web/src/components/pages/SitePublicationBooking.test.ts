import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/browser-api", () => ({ getSiteBookingApi: () => ({ getAvailability: vi.fn(), startCheckout: vi.fn() }) }));

import { SitePublicationBooking } from "./SitePublicationBooking";

const offer = {
  id: "synthetic-offer", name: "Synthetic morning", shortDescription: null,
  pricing: { currency: "JPY" as const, taxIncluded: true as const, adultPriceYen: 5000, child: null },
  capacity: 6, maxPartySize: 6, minimumParticipants: 1, minimumChargeableParticipants: 1,
  durationMinutes: 90, startTime: "10:00", weekdays: [6],
  cancellationPolicy: { code: "CUSTOM" as const, freeCancellationHoursBefore: null },
  cancellationTerms: { cancellationWindowMinutesBeforeStart: 1440, refundBasisPoints: 5000 },
  acceptanceMode: "INSTANT" as const, bookingQuestions: [], bookingQuestionsFingerprint: "0".repeat(64),
};

describe("site publication booking seller terms", () => {
  it("links the booking consent to the native seller information", () => {
    const item = {
      publication: { slug: "synthetic-experience", publicTitle: "Synthetic experience", sellerDisplayName: "Synthetic Legal Seller" },
      saleTerms: { title: "Synthetic experience", currency: "JPY" as const, sellerDisplayName: "Synthetic Legal Seller", offers: [offer], conditionsVersion: null },
      sellerDisclosure: {
        method: "NATIVE" as const, sellerKind: "PERSON" as const, sellerDisplayName: "Synthetic Legal Seller", representativeName: null,
        publicAddress: "Synthetic address", publicPhone: "046-000-0000", publicEmail: "public@example.test",
      },
    };
    const html = renderToStaticMarkup(createElement(SitePublicationBooking, {
      item: item as never, siteOrigin: "https://experience.example.test", consentVersion: "terms-v1", bookingsEnabled: true,
    }));
    expect(html).toContain("seller information for Synthetic Legal Seller");
    expect(html).toContain("/experiences/synthetic-experience/seller");
  });
});
