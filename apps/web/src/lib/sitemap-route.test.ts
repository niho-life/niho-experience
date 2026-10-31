import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  config: { siteUrl: "https://experience.example.com", indexingAllowed: true, apiMode: "http" as "http" | "mock" },
  release: null as null | { pages: unknown[]; experiences: ReadonlyMap<string, unknown> },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: state.config }));
vi.mock("@/lib/api", () => ({
  listExperiencesForSite: async () => ({ ok: true as const, data: { experiences: [{ slug: "tea-ceremony", updatedAt: "2026-10-20T00:00:00Z" }] } }),
}));
vi.mock("@/lib/guide-registry", () => ({ indexableGuides: async () => [{ slug: "rainy-day", updatedAt: "2026-10-25" }] }));
vi.mock("@/lib/localized-content", async () => {
  const { JapaneseReleaseUnavailable } = await vi.importActual<typeof import("./localized-release")>("./localized-release");
  return {
    getPreparedJapaneseStaticRelease: async () => {
      if (!state.release) throw new JapaneseReleaseUnavailable("disabled");
      return state.release;
    },
  };
});

import sitemap from "@/app/sitemap";
import { mapJapaneseExperiences } from "./localized-mapping";

const SITE = "https://experience.example.com";

beforeEach(() => {
  state.config.indexingAllowed = true;
  state.config.apiMode = "http";
  state.release = null;
});

describe("sitemap route", () => {
  it("serves the English-only sitemap (static pages including /privacy, details, guides), field for field, while the Japanese site is off", async () => {
    await expect(sitemap()).resolves.toStrictEqual([
      { url: `${SITE}/` },
      { url: `${SITE}/experiences` },
      { url: `${SITE}/host` },
      { url: `${SITE}/privacy` },
      { url: `${SITE}/experiences/tea-ceremony`, lastModified: "2026-10-20T00:00:00Z" },
      { url: `${SITE}/guides`, lastModified: "2026-10-25" },
      { url: `${SITE}/guides/rainy-day`, lastModified: "2026-10-25" },
    ]);
  });

  it("stays empty while indexing is off or the data is synthetic", async () => {
    state.release = { pages: [], experiences: new Map() };
    state.config.indexingAllowed = false;
    await expect(sitemap()).resolves.toEqual([]);
    state.config.indexingAllowed = true;
    state.config.apiMode = "mock";
    await expect(sitemap()).resolves.toEqual([]);
  });

  it("adds the paired Japanese detail once the release is prepared", async () => {
    state.release = { pages: [], experiences: mapJapaneseExperiences("release-1", { releaseId: "release-1", experiences: [{ slug: "tea-ceremony" }] }) };
    const entries = await sitemap();
    expect(entries.at(-1)).toStrictEqual({
      url: `${SITE}/ja/experiences/tea-ceremony`,
      alternates: { languages: { en: `${SITE}/experiences/tea-ceremony`, ja: `${SITE}/ja/experiences/tea-ceremony`, "x-default": `${SITE}/experiences/tea-ceremony` } },
    });
  });
});
