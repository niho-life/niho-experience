import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/experience/site-publications", () => ({ getSitePublicExperience: mocks.get }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("not found"); } }));

import SellerInformationPage from "./page";

const offer = {
  id: "synthetic-offer", name: "Synthetic morning", shortDescription: null,
  pricing: { currency: "JPY" as const, taxIncluded: true as const, adultPriceYen: 5000, child: null },
  capacity: 6, maxPartySize: 6, minimumParticipants: 1, minimumChargeableParticipants: 1,
  durationMinutes: 90, startTime: "10:00", weekdays: [6],
  cancellationPolicy: { code: "CUSTOM" as const, freeCancellationHoursBefore: null },
  cancellationTerms: { cancellationWindowMinutesBeforeStart: 1440, refundBasisPoints: 5000 },
  acceptanceMode: "INSTANT" as const, bookingQuestions: [], bookingQuestionsFingerprint: "0".repeat(64),
};

describe("public native seller page", () => {
  beforeEach(() => {
    mocks.get.mockReset().mockResolvedValue({ kind: "published", item: {
      publication: { slug: "synthetic-experience", publicTitle: "Synthetic experience", unitAmount: 5000 },
      saleTerms: { title: "Synthetic experience", currency: "JPY", sellerDisplayName: "Synthetic Legal Seller", offers: [offer], conditionsVersion: null },
      sellerDisclosure: {
        method: "NATIVE", sellerKind: "PERSON", sellerDisplayName: "Synthetic Legal Seller", representativeName: null,
        publicAddress: "Synthetic public address", publicPhone: "046-000-0000", publicEmail: "public@example.test",
      },
    } });
  });

  it("shows public contact details with the current price, schedule, and cancellation/refund terms", async () => {
    const html = renderToStaticMarkup(await SellerInformationPage({ params: Promise.resolve({ slug: "synthetic-experience" }) }));
    expect(html).toContain("Synthetic Legal Seller");
    expect(html).toContain("Synthetic public address");
    expect(html).toContain("¥5,000");
    expect(html).toContain("Sat");
    expect(html).toContain("50% refund");
    expect(html).not.toMatch(/providerId|stripeConnectAccountRef|nihoUserId/);
  });
});
