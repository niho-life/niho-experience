import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CardModel } from "@/lib/card-model";
import type { SitePublicExperience } from "./site-publications";
import { SAMPLE_TERMS } from "@/lib/testing/guest-booking-fixtures";

const state = vi.hoisted(() => ({
  catalog: { experiences: [] as unknown[], claimedSlugs: [] as string[] } as { experiences: unknown[]; claimedSlugs: string[] } | Error,
  listed: [] as { slug: string; themes?: string[] }[] | null,
}));
vi.mock("server-only", () => ({}));
vi.mock("./site-publications", () => ({
  listSitePublicExperiences: vi.fn(async () => { if (state.catalog instanceof Error) throw state.catalog; return state.catalog; }),
}));
vi.mock("@/lib/experience-cards", () => ({
  readListedExperiences: vi.fn(async () => state.listed),
  cardsFor: vi.fn(async (summaries: { slug: string }[]) => summaries.map((summary) => ({ slug: summary.slug, title: `NIHO ${summary.slug}` }) as CardModel)),
}));
vi.mock("@/lib/journey", () => ({ getReviewSummaries: vi.fn(async () => new Map()) }));

import { cardsFor } from "@/lib/experience-cards";
import { relatedSiteExperienceCards } from "./site-related";

const sale = {
  title: SAMPLE_TERMS.title, currency: SAMPLE_TERMS.currency, sellerDisplayName: SAMPLE_TERMS.sellerDisplayName,
  offers: SAMPLE_TERMS.offers, conditionsVersion: SAMPLE_TERMS.conditionsVersion,
};
const native = (slug: string, saleTerms: typeof sale | null = sale): SitePublicExperience => ({
  sellerDisclosure: null,
  hostBio: null,
  saleTerms,
  publication: {
    slug, publicTitle: `Native ${slug}`,
    content: { lead: "Lead.", description: "Description.", facts: { language: "English" }, highlights: [], included: [], notIncluded: [], knowBeforeYouGo: [], notSuitableFor: [], timeline: [], faq: [] },
    currency: "JPY", unitAmount: 4_000, sellerDisplayName: "Synthetic Host", meetingOverview: null, meetingPointDisclosure: "AFTER_BOOKING",
    meetingPoint: null, photos: [], providerPhoto: null, businessLogo: null, japanese: null, japaneseOnly: false, publishedAtUtc: "2026-11-05T00:00:00.000Z",
  },
});
const slugs = (cards: readonly CardModel[]) => cards.map((card) => card.slug);

describe("relatedSiteExperienceCards (#146)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.catalog = { experiences: [], claimedSlugs: [] };
    state.listed = [];
  });

  it("suggests up to three others in the list page's order, never the current one", async () => {
    state.catalog = { experiences: [native("here"), native("n1"), native("n2")], claimedSlugs: ["here", "n1", "n2"] };
    state.listed = [{ slug: "niho-a" }, { slug: "niho-b" }];
    expect(slugs(await relatedSiteExperienceCards("here"))).toEqual(["niho-a", "niho-b", "n1"]);
    expect(slugs(await relatedSiteExperienceCards("here", 2))).toEqual(["niho-a", "niho-b"]);
    // From a NIHO page's point of view the same set applies, so a native one can be suggested too.
    expect(slugs(await relatedSiteExperienceCards("niho-a", 5))).toEqual(["niho-b", "here", "n1", "n2"]);
  });

  it("keeps the list order when the current page is native, which has no themes to match", async () => {
    state.catalog = { experiences: [native("n1")], claimedSlugs: ["n1"] };
    state.listed = [{ slug: "plain", themes: [] }, { slug: "night", themes: ["evening", "food"] }];
    expect(slugs(await relatedSiteExperienceCards("n1"))).toEqual(["plain", "night"]);
  });

  it("leaves out an experience without a valid sale, as the list page does", async () => {
    state.catalog = { experiences: [native("no-sale", null), native("no-offers", { ...sale, offers: [] }), native("ok")], claimedSlugs: ["no-sale", "no-offers", "ok"] };
    expect(slugs(await relatedSiteExperienceCards("elsewhere"))).toEqual(["ok"]);
  });

  it("never lets a slug this site claims reveal the NIHO item with the same slug", async () => {
    state.catalog = { experiences: [native("n1")], claimedSlugs: ["n1", "stopped-here"] };
    state.listed = [{ slug: "stopped-here" }, { slug: "niho-a" }, { slug: "n1" }];
    expect(slugs(await relatedSiteExperienceCards("elsewhere", 5))).toEqual(["niho-a", "n1"]);
    // The NIHO cards are read only for the ones picked.
    expect(vi.mocked(cardsFor).mock.calls[0]![0].map((summary) => summary.slug)).toEqual(["niho-a"]);
  });

  it("suggests the experiences sold here when the NIHO catalogue cannot be read", async () => {
    state.catalog = { experiences: [native("n1"), native("n2")], claimedSlugs: ["n1", "n2"] };
    state.listed = null;
    expect(slugs(await relatedSiteExperienceCards("n1"))).toEqual(["n2"]);
  });

  it("suggests nothing when the claimed slugs cannot be read, and never throws", async () => {
    state.catalog = new Error("store unavailable");
    state.listed = [{ slug: "niho-a" }];
    expect(await relatedSiteExperienceCards("here")).toEqual([]);
    expect(cardsFor).not.toHaveBeenCalled();
  });
});
