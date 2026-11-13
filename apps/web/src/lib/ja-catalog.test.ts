import { describe, expect, it } from "vitest";
import type { SitePublicExperience } from "./experience/site-publications";
import { filterJaCards, jaCapacity, jaCardOf, jaCategoryCounts, jaDuration, jaListHref, jaQueryHasFilter, jaYen, parseJaListQuery, type JaCard } from "./ja-catalog";

/** 日本語サイトの一覧とカード (#529): the card from a publication, the query, the filters. Synthetic data only. */
const DAYS = [{ key: "2026-11-15" }, { key: "2026-11-16" }, { key: "2026-11-17" }];

function item(over: { slug?: string; providerPublicName?: string | null; providerKind?: "PERSON" | "BUSINESS" | null; japanese?: object | null; offers?: object[] } = {}): SitePublicExperience {
  return {
    publication: {
      slug: over.slug ?? "synthetic-walk",
      publicTitle: "English title",
      japanese: over.japanese === undefined ? { title: "合成の山道", lead: "山道を歩きます。" } : over.japanese,
      photos: [{ src: "/media/1.jpg", alt: "english", altJa: "山道の写真", publicCredit: null }],
      providerPhoto: { src: "/media/p.jpg", alt: "", altJa: "", publicCredit: null },
      providerPublicName: over.providerPublicName === undefined ? "まさと" : over.providerPublicName,
      providerKind: over.providerKind === undefined ? "PERSON" : over.providerKind,
      sellerDisplayName: "NIHO 販売",
    },
    saleTerms: { offers: over.offers ?? [
      { durationMinutes: 180, minimumParticipants: 2, maxPartySize: 8, weekdays: [0, 6], pricing: { adultPriceYen: 5500 } },
      { durationMinutes: 240, minimumParticipants: 1, maxPartySize: 6, weekdays: [3], pricing: { adultPriceYen: 6500 } },
    ] },
    sellerDisclosure: null, hostBio: null,
  } as unknown as SitePublicExperience;
}
const card = (over: Partial<JaCard> = {}): JaCard => ({ ...jaCardOf(item(), { category: "walk", area: "kita", companions: ["friends"], occasions: ["rain"] })!, ...over });

describe("jaCardOf", () => {
  it("is the photo, who the day is with, the title, the lead, time, party size and the lowest price; never the seller", () => {
    const value = card();
    expect(value).toMatchObject({
      slug: "synthetic-walk", title: "合成の山道", lead: "山道を歩きます。", withLine: "まさとさんと", durationMinutes: 180,
      capacity: { min: 1, max: 8 }, priceFromYen: 5500, cover: { url: "/media/1.jpg", alt: "山道の写真" }, face: { url: "/media/p.jpg", alt: "" },
    });
    expect(JSON.stringify(value)).not.toContain("NIHO 販売");
  });

  it("says 「が案内」 for a business, and nothing when no public name is confirmed (the seller is not the person)", () => {
    expect(jaCardOf(item({ providerKind: "BUSINESS", providerPublicName: "鎌倉の会社" }), undefined)?.withLine).toBe("鎌倉の会社が案内");
    expect(jaCardOf(item({ providerPublicName: null }), undefined)?.withLine).toBeNull();
  });

  it("is not a card without Japanese text or a sale, and an unclassified product has the empty classification", () => {
    expect(jaCardOf(item({ japanese: null }), undefined)).toBeNull();
    expect(jaCardOf(item({ offers: [] }), undefined)).toBeNull();
    expect(jaCardOf(item(), undefined)?.classification).toEqual({ category: null, area: null, companions: [], occasions: [] });
  });
});

describe("words", () => {
  it("writes time, party size and price the way the site does", () => {
    expect([jaDuration(45), jaDuration(180), jaDuration(90)]).toEqual(["45分", "3時間", "1時間30分"]);
    expect([jaCapacity({ min: 2, max: 8 }), jaCapacity({ min: 4, max: 4 })]).toEqual(["2〜8名", "4名"]);
    expect(jaYen(12000)).toBe("¥12,000");
  });
});

describe("query", () => {
  it("keeps only known values, and a date only when it is one of the offered days", () => {
    expect(parseJaListQuery({ category: "walk", area: "kita", with: "friends", occasion: "rain", guests: "4", date: "2026-11-16" }, DAYS))
      .toEqual({ category: "walk", area: "kita", companion: "friends", occasion: "rain", guests: 4, date: "2026-11-16" });
    expect(parseJaListQuery({ category: "cooking", area: ["kita"], with: "rain", occasion: "friends", guests: "7", date: "2026-12-31" }, DAYS))
      .toEqual({ category: null, area: null, companion: null, occasion: null, guests: null, date: null });
    expect(parseJaListQuery({}, DAYS)).toEqual({ category: null, area: null, companion: null, occasion: null, guests: null, date: null });
  });

  it("writes the list's address in one order, and says which queries are only the category", () => {
    const q = parseJaListQuery({ category: "sea", area: "zai", date: "2026-11-15" }, DAYS);
    expect(jaListHref(q)).toBe("/ja/experiences?category=sea&date=2026-11-15&area=zai");
    expect(jaListHref(q, { category: null, date: null })).toBe("/ja/experiences?area=zai");
    expect(jaListHref(parseJaListQuery({}, DAYS))).toBe("/ja/experiences");
    expect(jaQueryHasFilter(parseJaListQuery({ category: "sea" }, DAYS))).toBe(false);
    expect(jaQueryHasFilter(q)).toBe(true);
  });
});

describe("filterJaCards", () => {
  const cards = [
    card({ slug: "a" }),
    card({ slug: "b", classification: { category: "sea", area: "zai", companions: ["family", "date"], occasions: ["anniv"] }, offers: [{ minimumParticipants: 1, maxPartySize: 2, weekdays: [1] }] }),
    card({ slug: "c", classification: { category: null, area: null, companions: [], occasions: [] } }),
  ];
  const q = (params: Record<string, string>) => parseJaListQuery(params, DAYS);
  const slugs = (params: Record<string, string>) => filterJaCards(cards, q(params)).map((value) => value.slug);

  it("is every card without conditions, and an unclassified one only there", () => {
    expect(slugs({})).toEqual(["a", "b", "c"]);
    expect(slugs({ category: "walk" })).toEqual(["a"]);
    expect(slugs({ category: "sea" })).toEqual(["b"]);
  });

  it("treats だれと and こんな日に as separate conditions that both must hold", () => {
    expect(slugs({ with: "family" })).toEqual(["b"]);
    expect(slugs({ occasion: "rain" })).toEqual(["a"]);
    expect(slugs({ with: "family", occasion: "rain" })).toEqual([]);
    expect(slugs({ area: "zai", with: "date", occasion: "anniv" })).toEqual(["b"]);
  });

  it("keeps cards that have an offer for the party, and leaves a day to the booking store's availability (not the weekday)", () => {
    expect(slugs({ guests: "1" })).toEqual(["a", "b", "c"]);
    expect(slugs({ guests: "20" })).toEqual([]);
    // A rescheduled occurrence can fall on a weekday the offer does not repeat on: no card is dropped here for its weekday.
    expect(slugs({ date: "2026-11-15" })).toEqual(["a", "b", "c"]);
    expect(slugs({ date: "2026-11-16", guests: "1" })).toEqual(["a", "b", "c"]);
  });

  it("counts a category only for classified cards", () => {
    expect([...jaCategoryCounts(cards)]).toEqual([["walk", 1], ["sea", 1]]);
  });
});
