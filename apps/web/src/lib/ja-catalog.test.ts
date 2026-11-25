import { describe, expect, it } from "vitest";
import type { SitePublicExperience } from "./experience/site-publications";
import { jaCapacity, jaCardOf, jaGuideLine, jaCategoryCounts, jaDuration, jaYen, type JaCard } from "./ja-catalog";

/** 日本語サイトの一覧とカード (#529): the card from a publication and the category counts. Synthetic data only. */

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

  it("says who guides it when people on 街の人 are linked (#585), in place of the provider's name, up to three", () => {
    expect(jaCardOf(item(), undefined, [{ name: "菅 倫明" }])?.withLine).toBe("菅 倫明さんが案内");
    expect(jaCardOf(item(), undefined, [{ name: "菅 倫明" }, { name: "高浜 拓也" }])?.withLine).toBe("菅 倫明・高浜 拓也が案内");
    expect(jaGuideLine(["a", "b", "c", "d"])).toBe("a・b・cが案内");
    expect(jaGuideLine([])).toBeNull();
    expect(jaGuideLine([" ", ""])).toBeNull();
    expect(jaCardOf(item(), undefined, [])?.withLine).toBe("まさとさんと");
    // The face goes with the name: the linked person's photo, else the provider's own.
    expect(jaCardOf(item(), undefined, [{ name: "菅 倫明", photo: { src: "/p/suga.jpg" } }])?.face).toEqual({ url: "/p/suga.jpg", alt: "" });
    expect(jaCardOf(item(), undefined, [{ name: "菅 倫明" }])?.face).toEqual({ url: "/media/p.jpg", alt: "" });
    expect(jaCardOf(item(), undefined, [])?.face).toEqual({ url: "/media/p.jpg", alt: "" });
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

describe("jaCategoryCounts", () => {
  const cards = [
    card({ slug: "a" }),
    card({ slug: "b", classification: { category: "sea", area: "zai", companions: ["family", "date"], occasions: ["anniv"] }, offers: [{ minimumParticipants: 1, maxPartySize: 2, weekdays: [1] }] }),
    card({ slug: "c", classification: { category: null, area: null, companions: [], occasions: [] } }),
  ];
  it("counts a category only for classified cards", () => {
    expect([...jaCategoryCounts(cards)]).toEqual([["walk", 1], ["sea", 1]]);
  });
});
