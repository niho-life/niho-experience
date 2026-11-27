import { describe, expect, it } from "vitest";
import type { SitePublicExperience } from "./experience/site-publications";
import { bookableFirst, englishListCatalog, japaneseListPublication, saleablePublication } from "./experience-list-catalog";

/** The lists show a page whose bookings are not open yet, after the ones that can be booked (#706). Synthetic data only. */
const entry = (slug: string, over: { bookingAvailable?: boolean; offers?: number; japanese?: boolean } = {}) => ({
  publication: { slug, bookingAvailable: over.bookingAvailable ?? true, japanese: over.japanese === false ? null : { title: slug } },
  saleTerms: over.offers === 0 ? null : { offers: [{}] },
}) as unknown as SitePublicExperience;

describe("the list's catalog", () => {
  it("lists every public page (English), bookable or not, and knows which can be booked", () => {
    const site = { experiences: [entry("open"), entry("preparing", { bookingAvailable: false, offers: 0 }), entry("closed-but-terms", { bookingAvailable: false })], claimedSlugs: [] };
    expect(englishListCatalog([{ slug: "niho" }], site).slugs).toEqual(["niho", "open", "preparing", "closed-but-terms"]);
    expect(site.experiences.map(saleablePublication)).toEqual([true, false, false]);
  });

  it("lists a page with Japanese text on the Japanese list whether or not bookings are open", () => {
    expect(japaneseListPublication(entry("preparing", { bookingAvailable: false, offers: 0 }))).toBe(true);
    expect(japaneseListPublication(entry("english-only", { japanese: false }))).toBe(false);
  });

  it("puts the cards that cannot be booked after the ones that can, keeping each group's order", () => {
    const cards = [{ slug: "a", bookingAvailable: false }, { slug: "b" }, { slug: "c", bookingAvailable: true }, { slug: "d", bookingAvailable: false }, { slug: "e" }];
    expect(bookableFirst(cards).map((card) => card.slug)).toEqual(["b", "c", "e", "a", "d"]);
  });
});
