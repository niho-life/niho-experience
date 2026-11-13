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
  it("offer a question about the experience and one to its host, in Japanese, with the context in the link", async () => {
    const links = hrefs(renderToStaticMarkup(await SitePublicationPage({ item, locale: "ja" })));
    expect(links).toHaveLength(2);
    expect(links.some((href) => href.includes("from=experience") && href.includes("experience=synthetic-tea") && href.includes("title=合成茶道体験") && href.includes("host=Sample Sato"))).toBe(true);
    expect(links.some((href) => href.includes("from=provider") && href.includes("host=Sample Sato") && !href.includes("experience="))).toBe(true);
    const html = renderToStaticMarkup(await SitePublicationPage({ item, locale: "ja" }));
    expect(html).toContain("Sample Satoさんに相談する");
    expect(html).toContain("この体験について相談する");
  });

  it("go to the English form on the English page, and show nothing while the feature is off", async () => {
    expect(hrefs(renderToStaticMarkup(await SitePublicationPage({ item, locale: "en" }))).every((href) => href.startsWith("/inquiry?"))).toBe(true);
    state.config = { ...state.config, groupInquiryEnabled: false };
    expect(hrefs(renderToStaticMarkup(await SitePublicationPage({ item, locale: "ja" })))).toEqual([]);
  });
});
