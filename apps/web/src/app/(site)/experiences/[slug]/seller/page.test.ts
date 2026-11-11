import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/experience/site-publications", () => ({ getSitePublicExperience: mocks.get }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("not found"); } }));

import SellerInformationPage from "./page";
import JapaneseSellerInformationPage from "../../../../(ja)/ja/experiences/[slug]/seller/page";

const offer = {
  id: "synthetic-offer", name: "Synthetic morning", shortDescription: null,
  pricing: { currency: "JPY" as const, taxIncluded: true as const, adultPriceYen: 5000, child: { priceYen: 2000, minAge: 0, maxAge: 17, adultRequired: true } },
  capacity: 6, maxPartySize: 6, minimumParticipants: 1, minimumChargeableParticipants: 1,
  durationMinutes: 90, startTime: "10:00", weekdays: [6],
  cancellationPolicy: { code: "CUSTOM" as const, freeCancellationHoursBefore: null },
  cancellationTerms: { cancellationWindowMinutesBeforeStart: 1440, refundBasisPoints: 5000 },
  acceptanceMode: "INSTANT" as const, bookingQuestions: [], bookingQuestionsFingerprint: "0".repeat(64),
};

describe("public native seller page", () => {
  const props = { params: Promise.resolve({ slug: "synthetic-experience" }) };

  beforeEach(() => {
    mocks.get.mockReset().mockResolvedValue({ kind: "published", item: {
      publication: { slug: "synthetic-experience", publicTitle: "Synthetic experience", japanese: { title: "体験サンプル" }, unitAmount: 5000 },
      saleTerms: { title: "Synthetic experience", currency: "JPY", sellerDisplayName: "Synthetic Legal Seller", offers: [offer], conditionsVersion: null },
      sellerDisclosure: {
        method: "NATIVE", sellerKind: "PERSON", sellerDisplayName: "Synthetic Legal Seller", representativeName: null,
        publicAddress: "Synthetic public address", publicPhone: "046-000-0000", publicEmail: "public@example.test",
      },
    } });
  });

  it("shows public contact details with the current price, schedule, and cancellation/refund terms", async () => {
    const html = renderToStaticMarkup(await SellerInformationPage(props));
    expect(html).toContain("Synthetic Legal Seller");
    expect(html).toContain("Synthetic public address");
    expect(html).toContain("¥5,000");
    expect(html).toContain("¥2,000 per child (ages 0–17) · An adult must accompany children");
    expect(html).toContain("pay by card through Stripe Checkout when you book.");
    expect(html).toContain("Sat");
    expect(html).toContain("50% refund");
    expect(html).not.toMatch(/providerId|stripeConnectAccountRef|nihoUserId/);
  });

  it("renders Japanese terms and links back to the Japanese experience", async () => {
    const html = renderToStaticMarkup(await JapaneseSellerInformationPage(props));
    expect(html).toContain('href="/ja/experiences/synthetic-experience"');
    expect(html).toContain("特定商取引法に基づく表記");
    expect(html).toContain("予約時にStripe Checkoutでカード決済します。");
    expect(html).toContain("開始24時間前までのキャンセルで50%返金");
  });

  it("does not serve a native page for an external disclosure", async () => {
    mocks.get.mockResolvedValueOnce({ kind: "published", item: {
      sellerDisclosure: { method: "EXTERNAL", externalUrl: "https://seller.example.test/legal" },
    } });
    await expect(SellerInformationPage(props)).rejects.toThrow("not found");
  });
});
