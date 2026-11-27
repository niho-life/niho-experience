import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ isExperienceStaging: false, siteCatalogUnavailable: false }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: { apiMode: "http", publicApiVersion: "1.2", siteUrl: "https://experience.example.test" }, isPreview: false, isPilotPreview: false, get isExperienceStaging() { return state.isExperienceStaging; } }));
vi.mock("@niho/experience-presentation/v1", () => ({ EN_STATIC_COPY_V1: { text: (key: string) => key } }));
vi.mock("@/components/Analytics", () => ({ TrackView: () => null }));
vi.mock("@/components/ExperienceList", () => ({ ExperienceList: vi.fn(() => null) }));
vi.mock("@/components/States", () => ({ EmptyResults: () => null, ErrorState: () => null, StagingUnavailableState: () => createElement("div", null, "stg unavailable notice") }));
vi.mock("@/components/GuideBlocks", () => ({ GuideTeasers: () => null }));
vi.mock("@/components/BookingAssurance", () => ({ BookingAssurance: () => createElement("p", null, "booking assurance") }));
vi.mock("@/lib/api", () => ({ getApi: async () => ({}), listExperiencesForSite: async () => ({ ok: true, data: { experiences: [{ slug: "native-card" }] } }) }));
vi.mock("@/lib/catalog", () => ({ loadDetails: async () => new Map() }));
vi.mock("@/lib/card-model", () => ({ buildCardModels: () => [] }));
vi.mock("@/lib/journey", () => ({ getReviewSummaries: async () => new Map() }));
vi.mock("@/lib/guide-registry", () => ({ guideCatalogForSite: async () => ({ guides: [] }) }));
vi.mock("@/lib/experience-categories-server", () => ({ loadCategoryBySlug: async () => null }));
vi.mock("@/lib/locale-metadata", () => ({ englishAlternates: async () => ({}) }));
vi.mock("@/lib/guest-booking-source", () => ({ guestBookingSources: async () => ({ nihoWebOrigin: "https://niho.example.test", siteOrigin: "https://experience.example.test", siteSlugs: ["native-card"], closedSlugs: [] }) }));
vi.mock("@/lib/experience/site-publications", () => ({ listSitePublicExperiences: async () => {
  if (state.siteCatalogUnavailable) throw new Error("Cloud SQL unavailable");
  return { claimedSlugs: ["native-card"], experiences: [{ publication: { slug: "native-card", publicTitle: "Native experience", content: { lead: "Public manuscript" }, sellerDisplayName: "Synthetic seller" }, saleTerms: { offers: [{}] }, sellerDisclosure: null }] };
} }));
vi.mock("@/lib/experience/site-card-model", () => ({ sitePublicationCard: (item: { publication: { slug: string; publicTitle: string } }) => ({ slug: item.publication.slug, title: item.publication.publicTitle }) }));

import { ExperienceList } from "@/components/ExperienceList";
import { SEARCH_DAYS, windowDayKeys } from "@/lib/date-filter";
import ExperiencesPage from "./page";

beforeEach(() => {
  vi.clearAllMocks();
  state.isExperienceStaging = false;
  state.siteCatalogUnavailable = false;
});

it("keeps native products visible for a former theme URL and does not offer an unsupported theme filter", async () => {
  renderToStaticMarkup(await ExperiencesPage({ searchParams: Promise.resolve({ theme: "CULTURE", date: "2026-11-10" }) }));
  const props = vi.mocked(ExperienceList).mock.calls[0]?.[0];
  expect(props?.cards.map((card) => card.slug)).toEqual(["native-card"]);
  expect(props?.browseContext?.theme).toBeUndefined();
  // Native catalogs are not filtered by date server-side; keep the existing availability check active.
  expect(props?.catalogDateFiltered).toBe(false);
  // The search bar offers the same SEARCH_DAYS days that the `date` query accepts, and there is no theme filter any more.
  expect(windowDayKeys(props!.windowStart, props!.windowEnd)).toHaveLength(SEARCH_DAYS);
  expect(props?.heading).toBe("All experiences");
  expect(props?.note).toBe("Prices in yen, tax included · Times in Japan time");
});

it("shows the staging pause notice when the public catalog database is unavailable", async () => {
  state.isExperienceStaging = true;
  state.siteCatalogUnavailable = true;

  const html = renderToStaticMarkup(await ExperiencesPage({ searchParams: Promise.resolve({}) }));

  expect(html).toContain("stg unavailable notice");
});

it("does not replace the production error path with the staging notice", async () => {
  state.siteCatalogUnavailable = true;

  await expect(ExperiencesPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("Cloud SQL unavailable");
});
