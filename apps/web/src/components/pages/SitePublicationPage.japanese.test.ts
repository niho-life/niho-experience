import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SAMPLE_TERMS } from "@/lib/testing/guest-booking-fixtures";
import type { SitePublicExperience } from "@/lib/experience/site-publications";
import { getLiveReviews } from "@/lib/journey";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/lib/journey", () => ({ getLiveReviews: vi.fn(async () => null) }));
vi.mock("@/lib/config", () => ({ config: { siteUrl: "https://experience.example.test", indexingAllowed: true, japaneseSiteEnabled: true, bookingsEnabled: true, guestBookingEnabled: true } }));
vi.mock("@/components/Analytics", () => ({ TrackView: () => createElement("span", { "data-testid": "analytics-event" }) }));

import { SitePublicationPage, sitePublicationMetadata } from "./SitePublicationPage";
import { SitePublicationBooking } from "./SitePublicationBooking";

const item = {
  sellerDisclosure: { method: "EXTERNAL", sellerKind: "BUSINESS", sellerDisplayName: "Synthetic Seller", externalUrl: "https://seller.example.test/legal" },
  publication: {
    slug: "synthetic-tea",
    publicTitle: "Synthetic English title",
    content: { lead: "English lead", description: "English description", facts: { language: "English" }, highlights: [], included: ["English materials"], notIncluded: [], knowBeforeYouGo: [], notSuitableFor: [], timeline: [], faq: [{ question: "English FAQ question", answer: "English FAQ answer" }] },
    japanese: { title: "合成茶道体験", lead: "日本語の紹介", description: "日本語の説明", language: "日本語", highlights: [], included: ["日本語の材料"], notIncluded: [], knowBeforeYouGo: [], notSuitableFor: [], timeline: [], faq: [] },
    photos: [{ src: "/synthetic-photo.jpg", alt: "English photo alt", altJa: "日本語の写真", publicCredit: null }],
    providerPhoto: null,
    businessLogo: null,
    sellerDisplayName: "Synthetic Seller",
    meetingOverview: "English meeting overview",
    meetingPointDisclosure: "AFTER_BOOKING",
    meetingPoint: null,
    publishedAtUtc: "2026-11-04T00:00:00.000Z",
  },
  saleTerms: { title: SAMPLE_TERMS.title, currency: SAMPLE_TERMS.currency, sellerDisplayName: SAMPLE_TERMS.sellerDisplayName, offers: SAMPLE_TERMS.offers, conditionsVersion: SAMPLE_TERMS.conditionsVersion },
  hostBio: null,
} as unknown as SitePublicExperience;

describe("Experience publication Japanese sale presentation", () => {
  it("uses the same Japanese page identity in review markup and visible seller information", async () => {
    vi.mocked(getLiveReviews).mockResolvedValueOnce({
      status: "ok", summary: { count: 3, average: 5, tags: [] },
      items: [{ id: "synthetic-review", rating: 5, body: "A public guest review.", tags: [], displayName: "Synthetic guest", originLabel: null, publishedAt: "2026-11-04T00:00:00.000Z", fromBooking: true, reply: { hostName: "Synthetic Seller", body: "Thank you." } }],
    });
    const html = renderToStaticMarkup(await SitePublicationPage({ item, locale: "ja" }));
    const nodes = [...html.matchAll(/<script type="application\/ld\+json">([^<]*)<\/script>/g)].map((match) => JSON.parse(match[1]!));
    expect(nodes).toHaveLength(2);
    for (const node of nodes) {
      expect(node.name).toBe("合成茶道体験");
      expect(node.url).toBe("https://experience.example.test/ja/experiences/synthetic-tea");
      expect(node.aggregateRating.reviewCount).toBe(3);
    }
    expect(nodes[0].inLanguage).toBe("ja");
    expect(html).toContain("Thank you.");
    expect(html).toContain("https://seller.example.test/legal");
    expect(html).not.toContain("English lead");
  });
  it("renders only confirmed Japanese prose and alt text with a paired canonical", async () => {
    const html = renderToStaticMarkup(await SitePublicationPage({ item, locale: "ja" }));
    expect(html).toContain("合成茶道体験");
    expect(html).toContain("日本語の紹介");
    expect(html).toContain("日本語の説明");
    expect(html).toContain("日本語の写真");
    expect(html).toContain("販売者情報");
    expect(html).toContain("開始24時間前までキャンセル無料");
    expect(html).toContain("毎日 · 10:00 JST");
    expect(html).not.toContain("English lead");
    expect(html).not.toContain("English description");
    expect(html).not.toContain("English meeting overview");
    expect(html).not.toContain("data-testid=\"analytics-event\"");
    expect(sitePublicationMetadata(item, "ja").alternates).toEqual({
      canonical: "https://experience.example.test/ja/experiences/synthetic-tea",
      languages: { en: "https://experience.example.test/experiences/synthetic-tea", ja: "https://experience.example.test/ja/experiences/synthetic-tea", "x-default": "https://experience.example.test/experiences/synthetic-tea" },
    });
    expect(sitePublicationMetadata(item, "ja").openGraph).toMatchObject({ locale: "ja_JP", title: "合成茶道体験" });
  });

  it("shows only the Japanese manuscript's FAQ: none when the Japanese FAQ is empty, never the English one", async () => {
    const empty = renderToStaticMarkup(await SitePublicationPage({ item, locale: "ja" }));
    expect(empty).not.toContain('id="faq"');
    expect(empty).not.toContain("English FAQ question");
    const withFaq = { ...item, publication: { ...item.publication, japanese: { ...item.publication.japanese!, faq: [{ question: "雨でも開催しますか？", answer: "屋内で開催します。" }] } } } as SitePublicExperience;
    const html = renderToStaticMarkup(await SitePublicationPage({ item: withFaq, locale: "ja" }));
    expect(html).toMatch(/<h2[^>]*>よくある質問<\/h2>/);
    expect(html).toContain("雨でも開催しますか？");
    expect(html).toContain("屋内で開催します。");
    expect(html).not.toContain("English FAQ question");
  });

  it("shows Japanese booking conditions, consent, total, and action labels", () => {
    const html = renderToStaticMarkup(createElement(SitePublicationBooking, { item, siteOrigin: "https://experience.example.test", consentVersion: "synthetic-consent", bookingsEnabled: true, locale: "ja" }));
    for (const phrase of ["合成茶道体験を予約", "開始24時間前までキャンセル無料", "合計", "プライバシーポリシー", "安全な決済へ進む", "日時を読み込み中"])
      expect(html).toContain(phrase);
    expect(html).not.toContain("Continue to secure checkout");
    expect(html).not.toContain("I agree to the booking");
  });
});
