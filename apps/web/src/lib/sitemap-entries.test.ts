import { describe, expect, it } from "vitest";
import { mapJapaneseExperiences } from "./localized-mapping";
import { sitemapEntries, type JapaneseSitemapRelease } from "./sitemap-entries";

const SITE = "https://experience.example.com";
const experiences = [
  { slug: "tea-ceremony", updatedAt: "2026-10-20T00:00:00Z" },
  { slug: "zen-walk", updatedAt: "2026-10-21T00:00:00Z" },
];
const guides = [
  { slug: "rainy-day", updatedAt: "2026-10-25" },
  { slug: "first-visit", updatedAt: "2026-10-01" },
];
const page = (sourcePath: string, path: string, indexable: boolean) => ({ route: { sourcePath, path, indexable }, seo: { indexable } });
const pages = [page("/", "/ja", true), page("/experiences", "/ja/experiences", true), page("/host", "/ja/host", true), page("/help", "/ja/help", false)];
const release = (catalogRelease: string, ...slugs: string[]): JapaneseSitemapRelease => ({
  pages,
  experiences: mapJapaneseExperiences("release-1", { releaseId: catalogRelease, experiences: slugs.map((slug) => ({ slug })) }),
});
const languages = (english: string, japanese: string) => ({ languages: { en: `${SITE}${english}`, ja: `${SITE}${japanese}`, "x-default": `${SITE}${english}` } });

describe("sitemap entries", () => {
  it("is exactly the English-and-guides sitemap while no Japanese release is prepared", () => {
    expect(sitemapEntries({ siteUrl: SITE, experiences, guides, japanese: null })).toStrictEqual([
      { url: `${SITE}/` },
      { url: `${SITE}/experiences` },
      { url: `${SITE}/host` },
      { url: `${SITE}/experiences/tea-ceremony`, lastModified: "2026-10-20T00:00:00Z" },
      { url: `${SITE}/experiences/zen-walk`, lastModified: "2026-10-21T00:00:00Z" },
      { url: `${SITE}/guides`, lastModified: "2026-10-25" },
      { url: `${SITE}/guides/rainy-day`, lastModified: "2026-10-25" },
      { url: `${SITE}/guides/first-visit`, lastModified: "2026-10-01" },
    ]);
    expect(sitemapEntries({ siteUrl: SITE, experiences: [], guides: [], japanese: null })).toStrictEqual([
      { url: `${SITE}/` }, { url: `${SITE}/experiences` }, { url: `${SITE}/host` },
    ]);
  });

  it("pairs static pages and paired details with en/ja/x-default, and lists the indexable Japanese pages", () => {
    expect(sitemapEntries({ siteUrl: SITE, experiences, guides: [], japanese: release("release-1", "tea-ceremony") })).toStrictEqual([
      { url: `${SITE}/`, alternates: languages("/", "/ja") },
      { url: `${SITE}/experiences`, alternates: languages("/experiences", "/ja/experiences") },
      { url: `${SITE}/host`, alternates: languages("/host", "/ja/host") },
      { url: `${SITE}/experiences/tea-ceremony`, lastModified: "2026-10-20T00:00:00Z", alternates: languages("/experiences/tea-ceremony", "/ja/experiences/tea-ceremony") },
      { url: `${SITE}/experiences/zen-walk`, lastModified: "2026-10-21T00:00:00Z" },
      { url: `${SITE}/ja`, alternates: languages("/", "/ja") },
      { url: `${SITE}/ja/experiences`, alternates: languages("/experiences", "/ja/experiences") },
      { url: `${SITE}/ja/host`, alternates: languages("/host", "/ja/host") },
      { url: `${SITE}/ja/experiences/tea-ceremony`, alternates: languages("/experiences/tea-ceremony", "/ja/experiences/tea-ceremony") },
    ]);
  });

  it("never lists a Japanese detail without its English page, nor one from another release", () => {
    const urls = (japanese: JapaneseSitemapRelease) => sitemapEntries({ siteUrl: SITE, experiences, guides: [], japanese }).map((entry) => entry.url);
    expect(urls(release("release-1", "japanese-only"))).not.toContain(`${SITE}/ja/experiences/japanese-only`);
    expect(urls(release("release-2", "tea-ceremony"))).not.toContain(`${SITE}/ja/experiences/tea-ceremony`);
  });

  it("leaves out Japanese static pages that are not indexable, and pairs a page only when both sides are indexed", () => {
    const japanese: JapaneseSitemapRelease = { pages: [page("/", "/ja", true), page("/experiences", "/ja/experiences", false), page("/host", "/ja/host", true), page("/help", "/ja/help", true)], experiences: new Map() };
    const entries = sitemapEntries({ siteUrl: SITE, experiences: [], guides: [], japanese });
    expect(entries.map((entry) => entry.url)).toEqual([`${SITE}/`, `${SITE}/experiences`, `${SITE}/host`, `${SITE}/ja`, `${SITE}/ja/host`, `${SITE}/ja/help`]);
    expect(entries.find((entry) => entry.url === `${SITE}/experiences`)).toStrictEqual({ url: `${SITE}/experiences` });
    // English /help is noindex and not in the sitemap, so the Japanese help page points nowhere.
    expect(entries.find((entry) => entry.url === `${SITE}/ja/help`)).toStrictEqual({ url: `${SITE}/ja/help` });
  });
});
