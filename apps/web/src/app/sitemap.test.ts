import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  config: { indexingAllowed: true, apiMode: "http", experiencePublicationsEnabled: true, japaneseSiteEnabled: true, siteUrl: "https://experience.example.test" },
  publicationRows: [] as Array<{ slug: string; japanese: unknown; publishedAtUtc: string }>,
  claimedSlugs: [] as string[],
  staticReady: true,
  people: [] as Array<{ slug: string }>,
  jaGuides: [] as Array<{ slug: string; updatedAt: string }>,
  cards: [] as Array<{ classification: { category: string | null } }>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));
vi.mock("@/lib/api", () => ({ listExperiencesForSite: async () => ({ ok: true, data: { experiences: [{ slug: "synthetic-dinner", updatedAt: "2026-11-04T00:00:00.000Z" }] } }) }));
vi.mock("@/lib/guide-registry", () => ({ indexableGuides: async () => [] }));
vi.mock("@/lib/ja-people", () => ({ loadPeople: async () => state.people }));
vi.mock("@/lib/ja-guides", () => ({ loadJapaneseGuides: async () => state.jaGuides }));
vi.mock("@/lib/ja-catalog-server", () => ({ loadJaCards: async () => state.cards }));
vi.mock("@/lib/localized-content", async () => {
  const { mapPublicationJapaneseExperiences } = await import("@/lib/localized-mapping");
  return {
    getPreparedJapaneseStaticRelease: async () => {
      if (!state.staticReady) throw new Error("no static Japanese shell release");
      return { pages: [], experiences: mapPublicationJapaneseExperiences(state.publicationRows.map((publication) => ({ publication, saleTerms: { offers: [{}] } })), true) };
    },
  };
});
vi.mock("@/lib/experience/site-publications", () => ({
  listSitePublicExperiences: async () => ({
    claimedSlugs: state.claimedSlugs,
    experiences: state.publicationRows.map((publication) => ({
      publication,
      saleTerms: { offers: [{}] },
    })),
  }),
}));

import sitemap from "./sitemap";

beforeEach(() => {
  state.config = { indexingAllowed: true, apiMode: "http", experiencePublicationsEnabled: true, japaneseSiteEnabled: true, siteUrl: "https://experience.example.test" };
  state.publicationRows = [{ slug: "synthetic-dinner", japanese: { title: "合成ディナー" }, publishedAtUtc: "2026-11-04T00:00:00.000Z" }];
  state.claimedSlugs = ["synthetic-dinner"];
  state.staticReady = true;
  state.people = []; state.jaGuides = []; state.cards = [];
});

it("adds Japanese publication details with matching locale alternates to the sitemap", async () => {
  const entries = await sitemap();
  const english = entries.find((entry) => entry.url === "https://experience.example.test/experiences/synthetic-dinner");
  const japanese = entries.find((entry) => entry.url === "https://experience.example.test/ja/experiences/synthetic-dinner");
  expect(english?.alternates?.languages).toEqual({
    en: "https://experience.example.test/experiences/synthetic-dinner",
    ja: "https://experience.example.test/ja/experiences/synthetic-dinner",
    "x-default": "https://experience.example.test/experiences/synthetic-dinner",
  });
  expect(japanese?.alternates?.languages).toEqual(english?.alternates?.languages);
});

it("does not index Japanese product pages without confirmed translated copy", async () => {
  state.publicationRows = [{ slug: "synthetic-dinner", japanese: null, publishedAtUtc: "2026-11-04T00:00:00.000Z" }];
  const entries = await sitemap();
  expect(entries.some((entry) => entry.url === "https://experience.example.test/ja/experiences/synthetic-dinner")).toBe(false);
});

it("does not index a Japanese product while its common Japanese shell is unavailable", async () => {
  state.staticReady = false;
  const entries = await sitemap();
  expect(entries.some((entry) => entry.url === "https://experience.example.test/ja/experiences/synthetic-dinner")).toBe(false);
});

it("lists the Japanese service pages, and 街の人, 読みもの and categories only when they have something (#561)", async () => {
  const base = "https://experience.example.test";
  let urls = (await sitemap()).map((entry) => entry.url);
  expect(urls).toContain(`${base}/ja/usage`);
  for (const path of ["/ja/people", "/ja/guides"]) expect(urls).not.toContain(`${base}${path}`);
  expect(urls.some((url) => url.includes("category="))).toBe(false);
  state.people = [{ slug: "masato" }];
  state.jaGuides = [{ slug: "rain-walk", updatedAt: "2026-11-10" }];
  state.cards = [{ classification: { category: "zen" } }, { classification: { category: null } }];
  urls = (await sitemap()).map((entry) => entry.url);
  for (const path of ["/ja/people", "/ja/people/masato", "/ja/guides", "/ja/guides/rain-walk", "/ja/experiences?category=zen"]) expect(urls).toContain(`${base}${path}`);
  state.staticReady = false;
  expect((await sitemap()).some((entry) => entry.url.includes("/ja/"))).toBe(false);
});
