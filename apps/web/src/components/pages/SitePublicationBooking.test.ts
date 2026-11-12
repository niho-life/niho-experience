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
  it.each([
    ["en", "Panasonic Holdings Corporation", "seller information for Panasonic Holdings Corporation"],
    ["ja", "パナソニックホールディングス株式会社", "パナソニックホールディングス株式会社の販売者情報"],
  ] as const)("shows the official seller name once in the %s consent before submission", (locale, seller, link) => {
    const html = renderToStaticMarkup(createElement(SitePublicationBooking, {
      item: {
        publication: { slug: "synthetic-experience", publicTitle: "Synthetic experience", japanese: { title: "体験サンプル" } },
        saleTerms: { sellerDisplayName: "パナソニックホールディングス株式会社", sellerDisclosureUrl: "https://seller.example.test/legal", offers: [offer] },
        sellerDisclosure: null,
      } as never,
      siteOrigin: "https://experience.example.test", consentVersion: "terms-v1", bookingsEnabled: true, locale,
    }));
    expect(html).toContain(link);
    expect(html.split(seller)).toHaveLength(2);
    expect(html.indexOf(link)).toBeGreaterThan(html.indexOf('type="checkbox"'));
    expect(html.indexOf(link)).toBeLessThan(html.indexOf('type="submit"'));
  });

  it("shows a request form without promising immediate checkout for managed approval", () => {
    const html = renderToStaticMarkup(createElement(SitePublicationBooking, {
      item: {
        publication: { slug: "synthetic-experience", publicTitle: "Synthetic experience", sellerDisplayName: "NIHO" },
        saleTerms: { sellerDisplayName: "NIHO", offers: [{ ...offer, acceptanceMode: "APPROVAL" }] },
        sellerDisclosure: null,
      } as never,
      siteOrigin: "https://experience.example.test", consentVersion: "terms-v1", bookingsEnabled: true,
    }));
    expect(html).toContain("Send booking request");
    expect(html).toContain("No payment is taken when you request");
    expect(html).not.toContain("Continue to secure checkout");
    expect(html).toContain("Sold by NIHO");
    expect(html.indexOf("Sold by NIHO")).toBeGreaterThan(html.indexOf("Total"));
    expect(html.indexOf("Sold by NIHO")).toBeLessThan(html.indexOf('type="submit"'));
  });

  it.each([
    ["en", "seller information for Synthetic Legal Seller", "/experiences/synthetic-experience/seller"],
    ["ja", "Synthetic Legal Sellerの販売者情報", "/ja/experiences/synthetic-experience/seller"],
  ] as const)("links booking consent to the native seller information in %s", (locale, label, href) => {
    const item = {
      publication: { slug: "synthetic-experience", publicTitle: "Synthetic experience", japanese: { title: "体験サンプル" }, sellerDisplayName: "Synthetic Legal Seller" },
      saleTerms: { title: "Synthetic experience", currency: "JPY" as const, sellerDisplayName: "Synthetic Legal Seller", offers: [offer], conditionsVersion: null },
      sellerDisclosure: {
        method: "NATIVE" as const, sellerKind: "PERSON" as const, sellerDisplayName: "Synthetic Legal Seller", representativeName: null,
        publicAddress: "Synthetic address", publicPhone: "046-000-0000", publicEmail: "public@example.test",
      },
    };
    const html = renderToStaticMarkup(createElement(SitePublicationBooking, {
      item: item as never, siteOrigin: "https://experience.example.test", consentVersion: "terms-v1", bookingsEnabled: true, locale,
    }));
    expect(html).toContain(`href="${href}"`);
    expect(html).toContain(label);
  });
});
