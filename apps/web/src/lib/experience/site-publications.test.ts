import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: { apiMode: "http" as "http" | "mock", experiencePublicationsEnabled: true, guestBookingEnabled: true },
  publications: {
    getPublicBySlug: vi.fn(),
    claimsSlug: vi.fn(),
    listPublic: vi.fn(),
    listClaimedSlugs: vi.fn(),
  },
  bookings: { publicBookingTerms: vi.fn() },
  disclosures: { getPublicBySlug: vi.fn() },
  hostBios: { getPublicBySlug: vi.fn() },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: mocks.config }));
vi.mock("@/lib/experience/store-server", () => ({
  experiencePublicationRepository: () => mocks.publications,
  guestBookingRepository: () => mocks.bookings,
  providerSellerDisclosureRepository: () => mocks.disclosures,
  providerHostBioRepository: () => mocks.hostBios,
}));

import { getSitePublicExperience, publicExperienceRouteAllowedForSlug, listSitePublicExperiences } from "./site-publications";

const publication = {
  slug: "local-seller-experience",
  publicTitle: "A local experience",
  content: { lead: "Synthetic lead", description: "Synthetic description", facts: { language: "English" }, highlights: [], included: [], notIncluded: [], knowBeforeYouGo: [], notSuitableFor: [], timeline: [] },
  currency: "JPY",
  unitAmount: 4_000,
  sellerDisplayName: "Synthetic seller",
  meetingOverview: null,
  meetingPointDisclosure: "AFTER_BOOKING",
  meetingPoint: null,
  photos: [],
  publishedAtUtc: "2026-11-04T00:00:00.000Z",
};
const terms = {
  providerId: "internal-provider",
  productId: "internal-product",
  title: "A local experience",
  currency: "JPY",
  sellerDisplayName: "Synthetic seller",
  offers: [{ id: "offer-one", cancellationPolicy: { code: "CUSTOM", freeCancellationHoursBefore: null }, minimumChargeableParticipants: 2 }],
  conditionsVersion: null,
};

describe("Experience site publication selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mocks.config, { apiMode: "http", experiencePublicationsEnabled: true, guestBookingEnabled: true });
    mocks.publications.getPublicBySlug.mockResolvedValue(publication);
    mocks.publications.claimsSlug.mockResolvedValue(false);
    mocks.publications.listPublic.mockResolvedValue([publication]);
    mocks.publications.listClaimedSlugs.mockResolvedValue([publication.slug, "stopped-experience"]);
    mocks.bookings.publicBookingTerms.mockResolvedValue(terms);
    mocks.disclosures.getPublicBySlug.mockResolvedValue({ method: "EXTERNAL", sellerKind: "BUSINESS", sellerDisplayName: "Synthetic seller", externalUrl: "https://seller.example.test/legal" });
    mocks.hostBios.getPublicBySlug.mockResolvedValue({ ja: "合成の紹介文", en: "Synthetic bio" });
  });

  it("projects native sale terms without Experience IDs and keeps stopped slugs reserved", async () => {
    const published = await getSitePublicExperience(publication.slug);
    expect(published).toEqual({ kind: "published", item: {
      publication,
      saleTerms: expect.objectContaining({ sellerDisplayName: "Synthetic seller", offers: terms.offers }),
      sellerDisclosure: { method: "EXTERNAL", sellerKind: "BUSINESS", sellerDisplayName: "Synthetic seller", externalUrl: "https://seller.example.test/legal" },
      hostBio: { ja: "合成の紹介文", en: "Synthetic bio" },
    } });
    expect(mocks.hostBios.getPublicBySlug).toHaveBeenCalledWith(publication.slug);
    expect(published?.kind === "published" ? published.item.saleTerms : null).not.toHaveProperty("providerId");
    expect(published?.kind === "published" ? published.item.saleTerms : null).not.toHaveProperty("productId");

    mocks.publications.getPublicBySlug.mockResolvedValue(null);
    mocks.publications.claimsSlug.mockResolvedValue(true);
    expect(await getSitePublicExperience("stopped-experience")).toEqual({ kind: "reserved" });
    expect(mocks.bookings.publicBookingTerms).toHaveBeenCalledTimes(1);
  });

  it("shows the page without a host bio when the bio read fails", async () => {
    mocks.hostBios.getPublicBySlug.mockRejectedValueOnce(new Error("bio store down"));
    const published = await getSitePublicExperience(publication.slug);
    expect(published?.kind).toBe("published");
    expect(published?.kind === "published" ? published.item.hostBio : undefined).toBeNull();
  });

  it("does not read host bios for catalog cards", async () => {
    const result = await listSitePublicExperiences();
    expect(result.experiences[0]?.hostBio).toBeNull();
    expect(mocks.hostBios.getPublicBySlug).not.toHaveBeenCalled();
  });

  it("omits a disclosure when current sale terms name another seller", async () => {
    mocks.bookings.publicBookingTerms.mockResolvedValue({ ...terms, sellerDisplayName: "Different seller" });
    const published = await getSitePublicExperience(publication.slug);
    expect(published?.kind === "published" ? published.item.sellerDisclosure : undefined).toBeNull();
  });

  it("merges published items while returning claimed slugs only for server-side shadowing", async () => {
    const result = await listSitePublicExperiences();
    expect(result.experiences).toHaveLength(1);
    expect(result.experiences[0]?.saleTerms).not.toHaveProperty("providerId");
    expect(result.claimedSlugs).toEqual([publication.slug, "stopped-experience"]);
  });

  // 日本語を原文にした商品（#59）：英語側には出さず、日本語側にだけ出す。
  describe("Japanese-only publication", () => {
    const japaneseOnly = { ...publication, slug: "ja-first", japanese: { title: "合成の体験" }, japaneseOnly: true };
    const translated = { ...publication, slug: "translated", japanese: { title: "合成の訳" }, japaneseOnly: false };

    it("is reserved (a 404 page) in English and published in Japanese", async () => {
      mocks.publications.getPublicBySlug.mockResolvedValue(japaneseOnly);
      expect(await getSitePublicExperience("ja-first")).toEqual({ kind: "reserved" });
      expect(await getSitePublicExperience("ja-first", "en")).toEqual({ kind: "reserved" });
      expect((await getSitePublicExperience("ja-first", "ja"))?.kind).toBe("published");
      // Sale endpoints (availability, checkout) keep working: the Japanese booking uses them.
      expect(await publicExperienceRouteAllowedForSlug("ja-first")).toBe(true);
    });

    it("is out of the English catalog but in the Japanese one, and its slug stays claimed", async () => {
      mocks.publications.listPublic.mockResolvedValue([japaneseOnly, translated]);
      mocks.publications.listClaimedSlugs.mockResolvedValue(["ja-first", "translated"]);
      const english = await listSitePublicExperiences();
      expect(english.experiences.map((item) => item.publication.slug)).toEqual(["translated"]);
      expect(english.claimedSlugs).toEqual(["ja-first", "translated"]);
      const japanese = await listSitePublicExperiences("ja");
      expect(japanese.experiences.map((item) => item.publication.slug)).toEqual(["ja-first", "translated"]);
    });

    it("a published English-only experience is not shown in Japanese", async () => {
      mocks.publications.getPublicBySlug.mockResolvedValue({ ...publication, japanese: null, japaneseOnly: false });
      expect(await getSitePublicExperience(publication.slug, "ja")).toEqual({ kind: "reserved" });
    });
  });

  it("keeps unpublished participation-condition text out of checkout", async () => {
    mocks.bookings.publicBookingTerms.mockResolvedValue({ ...terms, conditionsVersion: "c0".repeat(32) });
    const result = await getSitePublicExperience(publication.slug);
    expect(result?.kind === "published" ? result.item.saleTerms : undefined).toBeNull();
    expect(await publicExperienceRouteAllowedForSlug(publication.slug)).toBe(false);
  });

  it("does not consult Experience in mock or disabled publication mode", async () => {
    mocks.config.apiMode = "mock";
    expect(await getSitePublicExperience(publication.slug)).toBeNull();
    expect(await listSitePublicExperiences()).toEqual({ experiences: [], claimedSlugs: [] });
    expect(mocks.publications.getPublicBySlug).not.toHaveBeenCalled();
  });

  it("keeps every HTTP slug closed while public publication is off", async () => {
    mocks.config.experiencePublicationsEnabled = false;
    mocks.publications.getPublicBySlug.mockResolvedValueOnce(null);
    expect(await getSitePublicExperience("stopped-experience")).toEqual({ kind: "reserved" });
    expect((await listSitePublicExperiences()).experiences).toHaveLength(0);
    mocks.publications.getPublicBySlug.mockResolvedValueOnce(null);
    expect(await publicExperienceRouteAllowedForSlug("sample-tea")).toBe(false);
    expect(await publicExperienceRouteAllowedForSlug(publication.slug)).toBe(false);
  });
});

it("closes publication-off detail, catalog and sale paths without a legacy fallback", async () => {
  vi.clearAllMocks();
  mocks.config.experiencePublicationsEnabled = false;
  expect(await getSitePublicExperience(publication.slug)).toEqual({ kind: "reserved" });
  expect(await listSitePublicExperiences()).toEqual({ experiences: [], claimedSlugs: [] });
  expect(await publicExperienceRouteAllowedForSlug(publication.slug)).toBe(false);
  expect(mocks.publications.getPublicBySlug).not.toHaveBeenCalled();
  expect(mocks.publications.listPublic).not.toHaveBeenCalled();
  expect(mocks.bookings.publicBookingTerms).not.toHaveBeenCalled();
});
