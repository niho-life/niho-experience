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
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: mocks.config }));
vi.mock("@/lib/experience/store-server", () => ({
  experiencePublicationRepository: () => mocks.publications,
  guestBookingRepository: () => mocks.bookings,
  providerSellerDisclosureRepository: () => mocks.disclosures,
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
  });

  it("projects native sale terms without Experience IDs and keeps stopped slugs reserved", async () => {
    const published = await getSitePublicExperience(publication.slug);
    expect(published).toEqual({ kind: "published", item: {
      publication,
      saleTerms: expect.objectContaining({ sellerDisplayName: "Synthetic seller", offers: terms.offers }),
      sellerDisclosure: { method: "EXTERNAL", sellerKind: "BUSINESS", sellerDisplayName: "Synthetic seller", externalUrl: "https://seller.example.test/legal" },
    } });
    expect(published?.kind === "published" ? published.item.saleTerms : null).not.toHaveProperty("providerId");
    expect(published?.kind === "published" ? published.item.saleTerms : null).not.toHaveProperty("productId");

    mocks.publications.getPublicBySlug.mockResolvedValue(null);
    mocks.publications.claimsSlug.mockResolvedValue(true);
    expect(await getSitePublicExperience("stopped-experience")).toEqual({ kind: "reserved" });
    expect(mocks.bookings.publicBookingTerms).toHaveBeenCalledTimes(1);
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
