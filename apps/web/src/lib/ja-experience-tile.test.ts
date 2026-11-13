import { describe, expect, it } from "vitest";
import type { SitePublicExperience } from "@/lib/experience/site-publications";
import { japaneseTileFacts } from "./ja-experience-tile";

const item = (offers: { adult?: number; minutes?: number }[], base = 3000): SitePublicExperience => ({
  publication: { slug: "tea", publicTitle: "Tea", unitAmount: base, japanese: { title: "お茶の体験" }, photos: [{ src: "/p.jpg", alt: "a", altJa: "写真", publicCredit: null }] },
  saleTerms: { offers: offers.map((offer) => ({ pricing: { adultPriceYen: offer.adult }, durationMinutes: offer.minutes })) },
  sellerDisclosure: null, hostBio: null,
} as unknown as SitePublicExperience);

describe("the Japanese experience tile", () => {
  it("shows the price a guest pays now (the sale terms), not the manuscript's base price", () => {
    expect(japaneseTileFacts(item([{ adult: 5000, minutes: 90 }], 3000))).toMatchObject({ title: "お茶の体験", price: "1名 5,000円", duration: "1時間30分", cover: { url: "/p.jpg", alt: "写真" } });
  });

  it("shows the lowest price with 〜 when the offers differ, and a time only when they all take the same", () => {
    expect(japaneseTileFacts(item([{ adult: 6000, minutes: 120 }, { adult: 4500, minutes: 90 }]))).toMatchObject({ price: "1名 4,500円〜", duration: null });
    expect(japaneseTileFacts(item([{ adult: 4500, minutes: 120 }, { adult: 4500, minutes: 120 }]))).toMatchObject({ price: "1名 4,500円", duration: "2時間" });
  });

  it("falls back to the manuscript's price without sale terms, and to the English title without a Japanese one", () => {
    const bare = { publication: { slug: "x", publicTitle: "Plain", unitAmount: 2000, japanese: null, photos: [] }, saleTerms: null, sellerDisclosure: null, hostBio: null } as unknown as SitePublicExperience;
    expect(japaneseTileFacts(bare)).toMatchObject({ title: "Plain", price: "1名 2,000円", duration: null, cover: null });
  });
});
