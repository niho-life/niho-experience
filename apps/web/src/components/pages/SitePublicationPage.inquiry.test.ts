import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SAMPLE_TERMS } from "@/lib/testing/guest-booking-fixtures";
import type { SitePublicExperience } from "@/lib/experience/site-publications";

const state = vi.hoisted(() => ({ config: { siteUrl: "https://experience.example.test", indexingAllowed: true, japaneseSiteEnabled: true, bookingsEnabled: true, guestBookingEnabled: true, groupInquiryEnabled: true } as Record<string, unknown> }));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/lib/journey", () => ({ getLiveReviews: vi.fn(async () => null) }));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));
vi.mock("@/components/Analytics", () => ({ TrackView: () => createElement("span") }));

import { SitePublicationPage } from "./SitePublicationPage";

/** 団体・個別の相談 (#532): the experience page's links to the inquiry form carry the experience and its host. */
const item = {
  sellerDisclosure: { method: "EXTERNAL", sellerKind: "BUSINESS", sellerDisplayName: "Synthetic Seller", externalUrl: "https://seller.example.test/legal" },
  publication: {
    slug: "synthetic-tea", publicTitle: "Synthetic tea", providerPublicName: "Sample Sato",
    content: { lead: "Lead", description: "Description", facts: { language: "English" }, highlights: [], included: [], notIncluded: [], knowBeforeYouGo: [], notSuitableFor: [], timeline: [], faq: [] },
    japanese: { title: "合成茶道体験", lead: "紹介", description: "説明", language: "日本語", highlights: [], included: [], notIncluded: [], knowBeforeYouGo: [], notSuitableFor: [], timeline: [], faq: [] },
    photos: [{ src: "/p.jpg", alt: "alt", altJa: "写真", publicCredit: null }], providerPhoto: null, businessLogo: null, sellerDisplayName: "Synthetic Seller",
    meetingOverview: "overview", meetingPointDisclosure: "AFTER_BOOKING", meetingPoint: null, publishedAtUtc: "2026-11-04T00:00:00.000Z",
  },
  saleTerms: { title: SAMPLE_TERMS.title, currency: SAMPLE_TERMS.currency, sellerDisplayName: SAMPLE_TERMS.sellerDisplayName, offers: SAMPLE_TERMS.offers, conditionsVersion: SAMPLE_TERMS.conditionsVersion },
  hostBio: null,
} as unknown as SitePublicExperience;

const hrefs = (html: string) => [...html.matchAll(/href="(\/(?:ja\/)?inquiry[^"]*)"/g)].map((match) => decodeURIComponent(match[1]!.replaceAll("&amp;", "&").replaceAll("+", " ")));

beforeEach(() => { state.config = { ...state.config, groupInquiryEnabled: true }; });

describe("the experience page's inquiry links", () => {
  it("offer a question about the experience in Japanese, with the context in the link, and none to the host: a person is written to from their own page (#589)", async () => {
    const html = renderToStaticMarkup(await SitePublicationPage({ item, locale: "ja" }));
    const links = hrefs(html);
    expect(links).toHaveLength(1);
    expect(links.some((href) => href.includes("from=experience") && href.includes("experience=synthetic-tea") && href.includes("title=合成茶道体験") && href.includes("host=Sample Sato"))).toBe(true);
    expect(links.some((href) => href.includes("from=provider"))).toBe(false);
    expect(html).not.toContain("Sample Satoさんに相談する");
    expect(html).toContain("この体験について相談する");
  });

  it("keeps the English page's question to the host as it was", async () => {
    const links = hrefs(renderToStaticMarkup(await SitePublicationPage({ item, locale: "en" })));
    expect(links).toHaveLength(2);
    expect(links.some((href) => href.includes("from=provider") && href.includes("host=Sample Sato") && !href.includes("experience="))).toBe(true);
  });

  it("go to the English form on the English page, and show nothing while the feature is off", async () => {
    expect(hrefs(renderToStaticMarkup(await SitePublicationPage({ item, locale: "en" }))).every((href) => href.startsWith("/inquiry?"))).toBe(true);
    state.config = { ...state.config, groupInquiryEnabled: false };
    expect(hrefs(renderToStaticMarkup(await SitePublicationPage({ item, locale: "ja" })))).toEqual([]);
  });
});

describe("the provider's English public name (#587)", () => {
  const named = (english: string | null) => ({ ...item, publication: { ...item.publication, providerPublicName: "志龍", providerPublicNameEn: english, providerKind: "PERSON" } }) as unknown as SitePublicExperience;

  it("is the name on the English page (host line, 「Ask …」 and the form's link), and no kanji of the provider is left", async () => {
    const html = renderToStaticMarkup(await SitePublicationPage({ item: named("Shiryu"), locale: "en" }));
    expect(html).toContain("Ask Shiryu");
    expect(html).toContain("Shiryu");
    expect(html).not.toContain("志龍");
    expect(hrefs(html).some((href) => href.includes("host=Shiryu"))).toBe(true);
    // The JSON-LD says the same.
    expect(html).toContain('"provider":{"@type":"Person","name":"Shiryu"}');
  });

  it("falls back to the Japanese public name when there is no English one, and the Japanese page never uses it", async () => {
    expect(renderToStaticMarkup(await SitePublicationPage({ item: named(null), locale: "en" }))).toContain("志龍");
    expect(renderToStaticMarkup(await SitePublicationPage({ item: named(""), locale: "en" }))).toContain("志龍");
    const ja = renderToStaticMarkup(await SitePublicationPage({ item: named("Shiryu"), locale: "ja" }));
    expect(ja).toContain("志龍");
    expect(ja).not.toContain("Shiryu");
  });
});
