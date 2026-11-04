import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  config: { indexingAllowed: true, apiMode: "http", experiencePublicationsEnabled: true, japaneseSiteEnabled: true, siteUrl: "https://experience.example.test" },
  publicationRows: [] as Array<{ slug: string; japanese: unknown; publishedAtUtc: string }>,
  claimedSlugs: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));
vi.mock("@/lib/api", () => ({ listExperiencesForSite: async () => ({ ok: true, data: { experiences: [{ slug: "synthetic-dinner", updatedAt: "2026-11-04T00:00:00.000Z" }] } }) }));
vi.mock("@/lib/guide-registry", () => ({ indexableGuides: async () => [] }));
vi.mock("@/lib/localized-content", () => ({
  getPreparedJapaneseStaticRelease: async () => { throw new Error("no static Japanese shell release"); },
  getJapaneseCopy: async () => ({ releaseId: "copy-synthetic" }),
}));
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
