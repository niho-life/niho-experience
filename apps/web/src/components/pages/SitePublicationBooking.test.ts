import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/browser-api", () => ({ getSiteBookingApi: () => ({ getAvailability: vi.fn(), startCheckout: vi.fn() }) }));

import { EmbedBookingUnavailable, SitePublicationBooking } from "./SitePublicationBooking";

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

  // 無料（0円）の予約は決済に進まない：支払い前提の文言を出さない（#59）。
  it.each([
    ["en", "Book for free", "No payment is needed.", "Continue to secure checkout", "Stripe Checkout"],
    ["ja", "無料で予約する", "お支払いは不要です。", "安全な決済へ進む", "Stripe Checkout"],
  ] as const)("says a free booking is booked, not paid, in %s", (locale, button, note, checkout, stripe) => {
    const free = { ...offer, pricing: { ...offer.pricing, adultPriceYen: 0 } };
    const html = renderToStaticMarkup(createElement(SitePublicationBooking, {
      item: { publication: { slug: "free-one", publicTitle: "Free one", japanese: { title: "無料の体験" }, sellerDisplayName: "NIHO" }, saleTerms: { sellerDisplayName: "NIHO", offers: [free] }, sellerDisclosure: null } as never,
      siteOrigin: "https://experience.example.test", consentVersion: "terms-v1", bookingsEnabled: true, locale,
    }));
    expect(html).toContain(button);
    expect(html).toContain(note);
    expect(html).not.toContain(checkout);
    expect(html).not.toContain(stripe);
  });

  it("keeps the checkout wording for a paid booking", () => {
    const html = renderToStaticMarkup(createElement(SitePublicationBooking, {
      item: { publication: { slug: "paid-one", publicTitle: "Paid one", sellerDisplayName: "NIHO" }, saleTerms: { sellerDisplayName: "NIHO", offers: [offer] }, sellerDisclosure: null } as never,
      siteOrigin: "https://experience.example.test", consentVersion: "terms-v1", bookingsEnabled: true,
    }));
    expect(html).toContain("Continue to secure checkout");
    expect(html).toContain("Stripe Checkout");
  });

  // ホストのサイトへの埋め込み (#638): the page keeps its one screen; only the date became a calendar.
  it("keeps every field of the booking page on one screen, with a calendar for the date", () => {
    const html = renderToStaticMarkup(createElement(SitePublicationBooking, {
      item: { publication: { slug: "paid-one", publicTitle: "Paid one", sellerDisplayName: "NIHO" }, saleTerms: { sellerDisplayName: "NIHO", offers: [offer] }, sellerDisclosure: null } as never,
      siteOrigin: "https://experience.example.test", consentVersion: "terms-v1", bookingsEnabled: true,
    }));
    for (const field of ["Adults", "Full name", "Email", "Note", "Total", 'type="checkbox"', 'type="submit"', "Continue to secure checkout"]) expect(html, field).toContain(field);
    expect(html).not.toContain("<select");
    expect(html).toMatch(/<div role="group" aria-labelledby="([^"]+)"[^>]*><p id="\1">Date<\/p>/);
    expect(html).toContain("Loading dates…");
    expect(html).not.toContain("data-embed-root");
    expect(html).not.toContain("Powered by NIHO Experience");
    expect(html).not.toContain('aria-current="step"');
  });

  it("starts the embedded widget at the date step, without the contact fields", () => {
    const html = renderToStaticMarkup(createElement(SitePublicationBooking, {
      item: { publication: { slug: "paid-one", publicTitle: "Paid one", sellerDisplayName: "NIHO" }, saleTerms: { sellerDisplayName: "NIHO", offers: [offer] }, sellerDisclosure: null } as never,
      siteOrigin: "https://experience.example.test", consentVersion: "terms-v1", bookingsEnabled: true, layout: "embed",
    }));
    expect(html).toContain("data-embed-root");
    expect(html).toContain("Book Paid one");
    expect(html).toContain('<li aria-current="step"');
    expect(html).toContain("1 Date");
    expect(html).toContain("2 Details");
    expect(html).toContain("3 Pay");
    expect(html).toMatch(/<button type="button" disabled=""[^>]*>Continue<\/button>/);
    expect(html).not.toContain("Full name");
    expect(html).not.toContain('type="email"');
    expect(html).not.toContain('type="submit"');
    expect(html).toContain('href="https://experience.example.test" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain("Powered by NIHO Experience");
    expect(html).not.toContain("Preview. Booking is turned off here.");
  });

  it("names the last step Done when nothing is paid in the widget", () => {
    const html = renderToStaticMarkup(createElement(SitePublicationBooking, {
      item: { publication: { slug: "request-one", publicTitle: "Request one", sellerDisplayName: "NIHO" }, saleTerms: { sellerDisplayName: "NIHO", offers: [{ ...offer, acceptanceMode: "APPROVAL" }] }, sellerDisclosure: null } as never,
      siteOrigin: "https://experience.example.test", consentVersion: "terms-v1", bookingsEnabled: true, layout: "embed",
    }));
    expect(html).toContain("3 Done");
    expect(html).not.toContain("3 Pay");
  });

  it("turns booking off in the host's preview of the widget", () => {
    const html = renderToStaticMarkup(createElement(SitePublicationBooking, {
      item: { publication: { slug: "paid-one", publicTitle: "Paid one", sellerDisplayName: "NIHO" }, saleTerms: { sellerDisplayName: "NIHO", offers: [offer] }, sellerDisclosure: null } as never,
      siteOrigin: "https://experience.example.test", consentVersion: "terms-v1", bookingsEnabled: true, layout: "embed", preview: true,
    }));
    expect(html).toContain("Preview. Booking is turned off here.");
    expect(html.indexOf("Preview. Booking is turned off here.")).toBeLessThan(html.indexOf(">Continue</button>"));
    expect(html).toMatch(/<button type="button" disabled=""[^>]*>Continue<\/button>/);
  });

  it("says the widget cannot book, inside its frame, when booking is off", () => {
    const html = renderToStaticMarkup(createElement(SitePublicationBooking, {
      item: { publication: { slug: "paid-one", publicTitle: "Paid one", sellerDisplayName: "NIHO" }, saleTerms: { sellerDisplayName: "NIHO", offers: [offer] }, sellerDisclosure: null } as never,
      siteOrigin: "https://experience.example.test", consentVersion: "terms-v1", bookingsEnabled: false, layout: "embed",
    }));
    expect(html).toContain("data-embed-root");
    expect(html).toContain('<p role="status" class="rounded-2xl bg-sand p-5 text-ink-soft">Online booking is temporarily unavailable for this experience.</p>');
    expect(renderToStaticMarkup(createElement(EmbedBookingUnavailable, { siteOrigin: "https://experience.example.test" }))).toContain('<p role="status" class="rounded-2xl bg-sand p-5 text-ink-soft">Online booking is temporarily unavailable for this experience.</p>');
  });
});
