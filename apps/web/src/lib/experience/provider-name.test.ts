import { describe, expect, it } from "vitest";
import { sitePublicationCard } from "./site-card-model";
import { providerKindFor, providerNameFor } from "./provider-name";
import type { SitePublicExperience } from "./site-publications";

/** 提供者の英語の公開名 (#587): the English pages use it, the Japanese pages do not. Synthetic data only. */
describe("providerNameFor", () => {
  it("is the English name on an English page when there is one, else the Japanese name; always the Japanese name on a Japanese page", () => {
    const both = { providerPublicName: "志龍", providerPublicNameEn: "Shiryu" };
    expect(providerNameFor(both, "en")).toBe("Shiryu");
    expect(providerNameFor(both, "ja")).toBe("志龍");
    for (const empty of [null, undefined, "", "  "]) expect(providerNameFor({ providerPublicName: "志龍", providerPublicNameEn: empty }, "en")).toBe("志龍");
    expect(providerNameFor({ providerPublicName: null, providerPublicNameEn: "Shiryu" }, "ja")).toBeNull();
    expect(providerNameFor({}, "en")).toBeNull();
  });

  it("falls back to the host's registered name when there is no public profile, in both languages, and never to the seller name (#691)", () => {
    const registered = { providerPublicName: null, providerRegisteredName: " NIHO kamakura ", sellerDisplayName: "NIHO kamakura (Panasonic Holdings Corporation)" };
    expect(providerNameFor(registered, "ja")).toBe("NIHO kamakura");
    expect(providerNameFor(registered, "en")).toBe("NIHO kamakura");
    expect(providerNameFor({ ...registered, providerPublicName: "志龍", providerPublicNameEn: "Shiryu" }, "en")).toBe("Shiryu");
    expect(providerNameFor({ ...registered, providerPublicName: "志龍" }, "ja")).toBe("志龍");
    expect(providerNameFor({ providerRegisteredName: "  " }, "ja")).toBeNull();
  });
});

describe("providerKindFor", () => {
  it("uses the public profile's kind when there is a profile, else the seller's kind, else null (#691)", () => {
    expect(providerKindFor({ providerPublicName: "志龍", providerKind: "PERSON" }, "BUSINESS")).toBe("PERSON");
    expect(providerKindFor({ providerPublicName: "志龍", providerKind: null }, "BUSINESS")).toBeNull();
    expect(providerKindFor({ providerPublicName: null }, "BUSINESS")).toBe("BUSINESS");
    expect(providerKindFor({ providerPublicName: null }, null)).toBeNull();
    expect(providerKindFor({}, undefined)).toBeNull();
  });
});

describe("the English card", () => {
  const item = (english: string | null) => ({
    sellerDisclosure: null, hostBio: null,
    publication: {
      slug: "s", publicTitle: "Synthetic", sellerDisplayName: "Seller", providerPublicName: "志龍", providerPublicNameEn: english, providerKind: "PERSON",
      content: { lead: "Lead", description: "", facts: { language: "English" }, highlights: [], included: [], notIncluded: [], knowBeforeYouGo: [], notSuitableFor: [], timeline: [], faq: [] },
      photos: [], providerPhoto: null, businessLogo: null, meetingOverview: null, meetingPointDisclosure: "AFTER_BOOKING", meetingPoint: null, japaneseOnly: false, publishedAtUtc: "2026-11-04T00:00:00.000Z", unitAmount: 5000, currency: "JPY",
    },
    saleTerms: { offers: [] },
  }) as unknown as SitePublicExperience;

  it("says it is with the English name, or the Japanese one without it", () => {
    expect(sitePublicationCard(item("Shiryu")).withLabel).toBe("with Shiryu");
    expect(sitePublicationCard(item(null)).withLabel).toBe("with 志龍");
  });
});
