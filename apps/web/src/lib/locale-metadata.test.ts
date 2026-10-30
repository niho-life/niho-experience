import { beforeEach, describe, expect, it, vi } from "vitest";
import { mapJapaneseExperiences } from "./localized-mapping";
import { sitemapEntries } from "./sitemap-entries";

const japanese = vi.hoisted(() => ({
  staticRelease: "release-1" as string | null,
  catalogRelease: "release-1",
  detailRelease: "release-1",
  english: ["translated-experience", "english-only"] as string[] | null,
}));
const READY = { termsFingerprint: `sha256:${"a".repeat(64)}`, bookingReady: true, unavailableCopyKey: null };

vi.mock("server-only", () => ({}));
vi.mock("./config", () => ({ config: { siteUrl: "https://experience.example.com", indexingAllowed: true } }));
vi.mock("./api", () => ({
  listExperiencesForSite: async () => japanese.english
    ? { ok: true as const, data: { experiences: japanese.english.map((slug) => ({ slug })) } }
    : { ok: false as const, kind: "network_error" as const },
}));
vi.mock("./localized-content", () => ({
  getJapaneseCatalog: async () => ({ releaseId: japanese.catalogRelease, experiences: [{ slug: "translated-experience" }, { slug: "japanese-only" }] }),
  getJapaneseDetail: async (slug: string) => {
    if (slug !== "translated-experience" && slug !== "japanese-only") throw new Error("missing");
    return { releaseId: japanese.detailRelease, experience: { slug }, localization: READY };
  },
  getPreparedJapaneseStaticRelease: async () => {
    if (!japanese.staticRelease) throw new Error("incomplete static shell");
    return { releaseId: japanese.staticRelease };
  },
}));

import { experienceAlternates, japaneseExperienceAlternates } from "./locale-metadata";

const SITE = "https://experience.example.com";
const EN = `${SITE}/experiences`;
const JA = `${SITE}/ja/experiences`;
const englishOnly = (url: string) => ({ canonical: url, languages: { en: url, "x-default": url } });

beforeEach(() => {
  japanese.staticRelease = "release-1";
  japanese.catalogRelease = "release-1";
  japanese.detailRelease = "release-1";
  japanese.english = ["translated-experience", "english-only"];
});

describe("experience hreflang", () => {
  it("links the Japanese page next to the English one and x-default when it would render", async () => {
    await expect(experienceAlternates("translated-experience", `${EN}/translated-experience`)).resolves.toEqual({
      canonical: `${EN}/translated-experience`,
      languages: { en: `${EN}/translated-experience`, ja: `${JA}/translated-experience`, "x-default": `${EN}/translated-experience` },
    });
  });

  it("never points at a Japanese page that does not exist", async () => {
    await expect(experienceAlternates("english-only", `${EN}/english-only`)).resolves.toEqual(englishOnly(`${EN}/english-only`));
  });

  it("leaves ja out while /ja shows only \"unavailable\": no static release, or a different release", async () => {
    japanese.staticRelease = null;
    await expect(experienceAlternates("translated-experience", `${EN}/translated-experience`)).resolves.toEqual(englishOnly(`${EN}/translated-experience`));
    japanese.staticRelease = "release-2";
    await expect(experienceAlternates("translated-experience", `${EN}/translated-experience`)).resolves.toEqual(englishOnly(`${EN}/translated-experience`));
  });

  it("leaves ja out when the catalog or the detail is from another release", async () => {
    japanese.catalogRelease = "release-2";
    await expect(experienceAlternates("translated-experience", `${EN}/translated-experience`)).resolves.toEqual(englishOnly(`${EN}/translated-experience`));
    japanese.catalogRelease = "release-1";
    japanese.detailRelease = "release-2";
    await expect(experienceAlternates("translated-experience", `${EN}/translated-experience`)).resolves.toEqual(englishOnly(`${EN}/translated-experience`));
  });
});

describe("Japanese experience hreflang", () => {
  it("points back at the English page and x-default while the English page is published", async () => {
    await expect(japaneseExperienceAlternates("translated-experience", `${JA}/translated-experience`)).resolves.toEqual({
      canonical: `${JA}/translated-experience`,
      languages: { en: `${EN}/translated-experience`, ja: `${JA}/translated-experience`, "x-default": `${EN}/translated-experience` },
    });
  });

  it("writes no hreflang when the English page is not published or cannot be confirmed", async () => {
    await expect(japaneseExperienceAlternates("japanese-only", `${JA}/japanese-only`)).resolves.toEqual({ canonical: `${JA}/japanese-only` });
    japanese.english = null;
    await expect(japaneseExperienceAlternates("translated-experience", `${JA}/translated-experience`)).resolves.toEqual({ canonical: `${JA}/translated-experience` });
  });

  it("writes no hreflang when the release does not line up", async () => {
    japanese.detailRelease = "release-2";
    await expect(japaneseExperienceAlternates("translated-experience", `${JA}/translated-experience`)).resolves.toEqual({ canonical: `${JA}/translated-experience` });
  });

  it("agrees with the sitemap entries of both pages", async () => {
    const english = await experienceAlternates("translated-experience", `${EN}/translated-experience`);
    const japanesePage = await japaneseExperienceAlternates("translated-experience", `${JA}/translated-experience`);
    const entries = sitemapEntries({
      siteUrl: SITE,
      experiences: [{ slug: "translated-experience", updatedAt: "2026-10-20T00:00:00Z" }, { slug: "english-only", updatedAt: "2026-10-20T00:00:00Z" }],
      guides: [],
      japanese: { pages: [], experiences: mapJapaneseExperiences("release-1", { releaseId: "release-1", experiences: [{ slug: "translated-experience" }, { slug: "japanese-only" }] }) },
    });
    const languagesOf = (url: string) => entries.find((entry) => entry.url === url)?.alternates?.languages;
    expect(languagesOf(`${EN}/translated-experience`)).toEqual(english?.languages);
    expect(languagesOf(`${JA}/translated-experience`)).toEqual(japanesePage?.languages);
    expect(languagesOf(`${EN}/english-only`)).toBeUndefined();
    expect(entries.map((entry) => entry.url)).not.toContain(`${JA}/japanese-only`);
  });
});
