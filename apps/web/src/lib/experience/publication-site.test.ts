import { beforeEach, describe, expect, it, vi } from "vitest";
import { SAMPLE_TERMS } from "@/lib/testing/guest-booking-fixtures";

const state = vi.hoisted(() => ({
  config: { guestBookingEnabled: true, guestBookingConsentVersion: "consent-synthetic-v1", siteUrl: "https://experience.example.test" },
  publications: { getPublicBySlug: vi.fn(), listPublic: vi.fn() },
  bookings: { publicBookingTerms: vi.fn() },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));
vi.mock("./store-server", () => ({
  experiencePublicationRepository: () => state.publications,
  guestBookingRepository: () => state.bookings,
}));

import { getPublicationDetail, listPublicationSummaries } from "./publication-site";

const publication = {
  slug: "synthetic-dinner",
  publicTitle: "Synthetic dinner",
  content: {
    lead: "A synthetic lead.", description: "A synthetic description.", facts: { language: "Japanese and English" },
    highlights: ["A synthetic highlight."], included: ["Materials"], notIncluded: [], knowBeforeYouGo: ["Synthetic guidance."],
    notSuitableFor: [], timeline: [{ time: "18:00", title: "Welcome", text: "Meet the host.", photoIndex: 0 }],
  },
  currency: "JPY",
  unitAmount: 30000,
  sellerDisplayName: "Panasonic",
  meetingOverview: "At the synthetic station.",
  meetingPointDisclosure: "AFTER_BOOKING" as const,
  meetingPoint: null,
  photos: [{ src: "/api/public/experience-media/synthetic-photo", alt: "Synthetic meal", altJa: "合成料理", publicCredit: null }],
  providerPhoto: { src: "/api/public/experience-media/synthetic-host", alt: "Synthetic provider", altJa: "合成提供者" },
  businessLogo: { src: "/api/public/experience-media/synthetic-logo", alt: "Synthetic business logo", altJa: "合成事業者ロゴ" },
  japanese: {
    title: "合成ディナー", lead: "合成の紹介です。", description: "合成の説明です。", language: "日本語と英語",
    highlights: ["合成の特徴"], included: ["材料"], notIncluded: [], knowBeforeYouGo: ["合成の注意"], notSuitableFor: [],
    timeline: [{ time: "18:00", title: "歓迎", text: "提供者と会います。", photoIndex: 0 }],
  },
  publishedAtUtc: "2026-11-04T00:00:00.000Z",
};

describe("Experience public site DTO", () => {
  beforeEach(() => {
    state.config = { guestBookingEnabled: true, guestBookingConsentVersion: "consent-synthetic-v1", siteUrl: "https://experience.example.test" };
    state.publications.getPublicBySlug.mockReset().mockResolvedValue(publication);
    state.publications.listPublic.mockReset().mockResolvedValue([publication]);
    state.bookings.publicBookingTerms.mockReset().mockResolvedValue(SAMPLE_TERMS);
  });

  it("serves the publication's seller, localized manuscript, timeline, and photo alts without private IDs", async () => {
    const customTerms = {
      ...SAMPLE_TERMS,
      offers: SAMPLE_TERMS.offers.map((offer, index) => index === 0 ? {
        ...offer,
        cancellationPolicy: { code: "CUSTOM" as const, freeCancellationHoursBefore: null },
        cancellationTerms: { cancellationWindowMinutesBeforeStart: 90, refundBasisPoints: 3750 },
      } : offer),
    };
    state.bookings.publicBookingTerms.mockResolvedValue(customTerms);
    const english = await getPublicationDetail(publication.slug, "en");
    const japanese = await getPublicationDetail(publication.slug, "ja");
    expect(english).toMatchObject({
      canonicalUrl: "https://experience.example.test/experiences/synthetic-dinner",
      seller: { displayName: "Panasonic" }, provider: { name: "Panasonic", logo: { alt: "Synthetic business logo" } },
      hosts: [{ displayName: "Panasonic", avatar: { alt: "Synthetic provider" } }],
      photos: [{ alt: "Synthetic meal" }], timeline: [{ title: "Welcome", photoIndex: 0 }],
    });
    expect(japanese).toMatchObject({
      canonicalUrl: "https://experience.example.test/ja/experiences/synthetic-dinner",
      title: "合成ディナー", photos: [{ alt: "合成料理" }], provider: { logo: { alt: "合成事業者ロゴ" } },
      timeline: [{ title: "歓迎", photoIndex: 0 }],
      offers: expect.arrayContaining([expect.objectContaining({
        saleCancellation: { policyCode: "CUSTOM", cancellationWindowMinutesBeforeStart: 90, refundBasisPoints: 3750 },
      })]),
    });
    expect(JSON.stringify({ english, japanese })).not.toMatch(/providerId|stripeConnectAccountRef|sellerNihoAccountRef/);
  });

  it("lists only published summaries and exposes Japanese copy only after its source is confirmed", async () => {
    expect(await listPublicationSummaries("kamakura", "ja")).toMatchObject([{ slug: publication.slug, title: "合成ディナー", contentLanguage: "JA" }]);
    state.publications.listPublic.mockResolvedValueOnce([{ ...publication, japanese: null }]);
    expect(await listPublicationSummaries("kamakura", "ja")).toEqual([]);
  });
});
