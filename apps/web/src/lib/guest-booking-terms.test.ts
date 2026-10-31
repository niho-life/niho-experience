import { describe, expect, it } from "vitest";
import { buildFixtureExperiences } from "@niho-experience/api-client/mock";
import { parseSiteSaleTerms, siteSaleTerms, withSiteSaleTerms } from "./guest-booking-terms";
import { SAMPLE_TERMS } from "./testing/guest-booking-fixtures";

describe("the sale of an experience sold here (#285)", () => {
  it("maps the store's terms to NIHO's offer shape, without the server-only IDs", () => {
    const sale = siteSaleTerms(SAMPLE_TERMS, "sample-terms-2026-10");
    expect(sale.booking).toEqual({ consentVersion: "sample-terms-2026-10", checkoutAvailable: true, currency: "JPY", timeZone: "Asia/Tokyo" });
    expect(sale.sellerDisplayName).toBe("Sample Seller");
    expect(sale.offers).toEqual(SAMPLE_TERMS.offers);
    expect(JSON.stringify(sale)).not.toMatch(/provider-sample|"productId"|"providerId"|conditionsVersion/);
    // Copies, not the store's readonly arrays.
    expect(sale.offers[0]!.weekdays).not.toBe(SAMPLE_TERMS.offers[0]!.weekdays);
    expect(sale.offers[0]!.bookingQuestions[0]!.options).not.toBe(SAMPLE_TERMS.offers[0]!.bookingQuestions[0]!.options);
  });

  it("lays the sale over NIHO's detail and keeps NIHO's content, legal documents and seller notice", () => {
    const detail = buildFixtureExperiences()[0]!;
    const notSelling = { ...detail, booking: { ...detail.booking, checkoutAvailable: false, consentVersion: "niho-terms" } };
    const shown = withSiteSaleTerms(notSelling, siteSaleTerms(SAMPLE_TERMS, "sample-terms-2026-10"));
    expect(shown.offers.map((offer) => offer.id)).toEqual(["sample-am", "sample-pm"]);
    expect(shown.booking).toEqual({ ...detail.booking, checkoutAvailable: true, consentVersion: "sample-terms-2026-10" });
    expect(shown.booking.legalDocuments).toEqual(detail.booking.legalDocuments);
    expect(shown.seller).toEqual({ displayName: "Sample Seller", legalNoticeUrl: detail.seller.legalNoticeUrl });
    // Nothing else changes.
    expect({ ...shown, offers: detail.offers, booking: detail.booking, seller: detail.seller }).toEqual(detail);
  });

  it("reads the route's answer back as closed shapes", () => {
    const sale = siteSaleTerms(SAMPLE_TERMS, "sample-terms-2026-10");
    const wire = JSON.parse(JSON.stringify(sale)) as unknown;
    expect(parseSiteSaleTerms(wire)).toEqual(sale);
    const changed = (change: (value: ReturnType<typeof siteSaleTerms>) => void) => {
      const copy = JSON.parse(JSON.stringify(sale)) as ReturnType<typeof siteSaleTerms>;
      change(copy);
      return parseSiteSaleTerms(copy);
    };
    expect(changed((value) => { (value as Record<string, unknown>).providerId = "provider-sample"; })).toBeNull();
    expect(changed((value) => { (value.booking as Record<string, unknown>).checkoutAvailable = false; })).toBeNull();
    expect(changed((value) => { value.booking.consentVersion = ""; })).toBeNull();
    expect(changed((value) => { (value.offers[0]!.pricing as Record<string, unknown>).currency = "USD"; })).toBeNull();
    expect(changed((value) => { value.offers[0]!.bookingQuestionsFingerprint = "not-a-digest"; })).toBeNull();
    expect(changed((value) => { (value.offers[0]!.bookingQuestions[0] as Record<string, unknown>).extra = true; })).toBeNull();
    expect(changed((value) => { value.offers[1]!.weekdays = [7]; })).toBeNull();
    expect(parseSiteSaleTerms(null)).toBeNull();
    expect(parseSiteSaleTerms([])).toBeNull();
  });
});
