import { describe, expect, it } from "vitest";
import { languageSwitchTarget } from "./locale-links";
import { experienceCounterparts, mapJapaneseExperiences, pairLanguages, staticPair } from "./localized-mapping";

const catalog = (releaseId: string, ...slugs: string[]) => ({ releaseId, experiences: slugs.map((slug) => ({ slug })) });
const detail = (slug: string, releaseId: string, bookingReady: boolean) => ({
  releaseId,
  experience: { slug },
  localization: { termsFingerprint: `sha256:${"a".repeat(64)}`, bookingReady, unavailableCopyKey: bookingReady ? null : "booking.unavailableJa" as const },
});
const page = (sourcePath: string, path: string, indexable = true, seoIndexable = indexable) => ({ route: { sourcePath, path, indexable }, seo: { indexable: seoIndexable } });

describe("experience mapping (owner decision 2026-10-31)", () => {
  it("pairs each slug of the same release's Japanese catalog with /ja/experiences/{slug}", () => {
    expect([...mapJapaneseExperiences("release-1", catalog("release-1", "tea-ceremony", "zen-walk")).values()]).toEqual([
      { slug: "tea-ceremony", englishPath: "/experiences/tea-ceremony", japanesePath: "/ja/experiences/tea-ceremony", bookingReady: false },
      { slug: "zen-walk", englishPath: "/experiences/zen-walk", japanesePath: "/ja/experiences/zen-walk", bookingReady: false },
    ]);
  });

  it("pairs nothing without that release's catalog", () => {
    expect(mapJapaneseExperiences("release-1", null).size).toBe(0);
    expect(mapJapaneseExperiences("release-1", catalog("release-2", "tea-ceremony")).size).toBe(0);
  });

  it("does not guess: a slug outside the catalog, or not a contract slug, stays unpaired", () => {
    const mapping = mapJapaneseExperiences("release-1", catalog("release-1", "tea-ceremony", "../host", "Tea_Ceremony", "a--b"));
    expect([...mapping.keys()]).toEqual(["tea-ceremony"]);
    expect(mapping.get("zen-walk")).toBeUndefined();
  });

  it("drops a slug whose detail is from another release, and ignores details outside the catalog", () => {
    const mapping = mapJapaneseExperiences("release-1", catalog("release-1", "tea-ceremony", "zen-walk"), [detail("tea-ceremony", "release-2", true), detail("english-only", "release-1", true)]);
    expect([...mapping.keys()]).toEqual(["zen-walk"]);
  });

  it("opens the booking pair only when a detail of the release says Japanese booking is ready", () => {
    const mapping = mapJapaneseExperiences("release-1", catalog("release-1", "tea-ceremony", "zen-walk", "pottery"), [detail("tea-ceremony", "release-1", true), detail("zen-walk", "release-1", false)]);
    expect(experienceCounterparts(mapping)).toEqual({
      "/experiences/tea-ceremony": "/ja/experiences/tea-ceremony",
      "/experiences/tea-ceremony/book": "/ja/experiences/tea-ceremony/book",
      "/experiences/zen-walk": "/ja/experiences/zen-walk",
      "/experiences/pottery": "/ja/experiences/pottery",
    });
  });
});

describe("language switch on experience pages", () => {
  const statics = { "/": "/ja", "/experiences": "/ja/experiences", "/host": "/ja/host", "/help": "/ja/help" };
  const counterparts = { ...statics, ...experienceCounterparts(mapJapaneseExperiences("release-1", catalog("release-1", "tea-ceremony"))) };

  it("switches a paired detail both ways, keeping only browse-safe query fields", () => {
    expect(languageSwitchTarget("/experiences/tea-ceremony", "date=2026-11-03&guests=2&token=secret", counterparts)).toBe("/ja/experiences/tea-ceremony?date=2026-11-03&guests=2");
    expect(languageSwitchTarget("/ja/experiences/tea-ceremony", "offer=offer-1&contact=private", counterparts)).toBe("/experiences/tea-ceremony?offer=offer-1");
  });

  it("shows no switch for an unpaired detail or a booking page whose Japanese booking is not known open", () => {
    expect(languageSwitchTarget("/experiences/english-only", "", counterparts)).toBeNull();
    expect(languageSwitchTarget("/experiences/tea-ceremony/book", "date=2026-11-03", counterparts)).toBeNull();
    expect(languageSwitchTarget("/ja/experiences/tea-ceremony/book", "", counterparts)).toBeNull();
  });

  it("shows no experience switch at all without a paired release", () => {
    expect(languageSwitchTarget("/experiences/tea-ceremony", "", { ...statics, ...experienceCounterparts(mapJapaneseExperiences("release-1", catalog("release-2", "tea-ceremony"))) })).toBeNull();
  });
});

describe("static pairs and hreflang", () => {
  it("pairs a static page only when the Japanese page is indexable and the English page is indexed", () => {
    expect(staticPair(page("/", "/ja"))).toEqual({ englishPath: "/", japanesePath: "/ja" });
    expect(staticPair(page("/host", "/ja/host", true, false))).toBeNull();
    expect(staticPair(page("/experiences", "/ja/experiences", false, true))).toBeNull();
    // English /help is noindex, so even an indexable Japanese help page has no pair.
    expect(staticPair(page("/help", "/ja/help"))).toBeNull();
  });

  it("builds the one en/ja/x-default set, x-default being the English original", () => {
    expect(pairLanguages("https://e.example/experiences/tea", "https://e.example/ja/experiences/tea")).toEqual({
      en: "https://e.example/experiences/tea", ja: "https://e.example/ja/experiences/tea", "x-default": "https://e.example/experiences/tea",
    });
  });
});
