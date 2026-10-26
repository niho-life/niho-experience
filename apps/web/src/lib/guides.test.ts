import { describe, expect, it } from "vitest";
import { buildFixtureExperiences } from "@niho-experience/api-client/mock";
import { PUBLISHED_GUIDES, SAMPLE_GUIDES, guideRegistry, type Guide } from "@/content/guides";
import { formatGuideDate, guideAlternates, guideProblems, guideRegistryProblems, guidesForExperience, isGuideDate, listedExperienceSlugs, relatedGuidesOf, shareableGuideImage, sortGuides } from "./guides";
import { pickRelatedExperiences } from "./related-experiences";
import { guideArticleJsonLd } from "./structured-data";

const SITE = "https://experience.example.com";
const [sample] = SAMPLE_GUIDES as [Guide, ...Guide[]];

describe("registered guides", () => {
  // Every published guide (and the preview's samples) must pass: a bad article fails CI here, not on the page.
  it("published guides are valid on their own, without the samples", () => {
    expect(guideRegistryProblems(PUBLISHED_GUIDES)).toEqual([]);
  });

  it("the preview registry (published + samples) is valid", () => {
    expect(guideRegistryProblems(guideRegistry(true))).toEqual([]);
  });

  it("only the mock preview gets the samples", () => {
    expect(guideRegistry(false)).toEqual(PUBLISHED_GUIDES);
    expect(guideRegistry(true)).toEqual([...PUBLISHED_GUIDES, ...SAMPLE_GUIDES]);
  });

  it("samples are marked as samples, point at synthetic experiences, and published guides are not samples", () => {
    const synthetic = new Set(buildFixtureExperiences().map((experience) => experience.slug));
    for (const guide of SAMPLE_GUIDES) {
      expect(guide.slug).toMatch(/^sample-/);
      expect(guide.title).toMatch(/\(sample guide\)$/);
      expect(guide.author.name).toMatch(/\(sample\)$/);
      expect(guide.body).toMatch(/^\*This is a sample guide for previews\./);
      expect(guide.hero?.licensed ?? false).toBe(false);
      for (const slug of guide.relatedExperienceSlugs) expect(synthetic.has(slug), slug).toBe(true);
    }
    for (const guide of PUBLISHED_GUIDES) {
      expect(guide.slug).not.toMatch(/^sample-/);
      expect(`${guide.title} ${guide.author.name} ${guide.body}`).not.toMatch(/\(sample/i);
    }
  });
});

describe("guide validation", () => {
  const problemsOf = (change: Partial<Guide>) => guideProblems({ ...sample, ...change });

  it.each([
    [{ slug: "Bad Slug" }, /slug must be/],
    [{ slug: "double--hyphen" }, /slug must be/],
    [{ title: "" }, /title is empty/],
    [{ title: " Padded" }, /leading or trailing spaces/],
    [{ title: "x".repeat(111) }, /title is longer than 110/],
    [{ description: "x".repeat(161) }, /description is longer than 160/],
    [{ author: { name: "", role: "Editor" } }, /author.name is empty/],
    [{ author: { name: "A", role: "" } }, /author.role is empty/],
    [{ publishedAt: "2026-02-30" }, /publishedAt must be/],
    [{ updatedAt: "26-10-24" }, /updatedAt must be/],
    [{ publishedAt: "2026-10-25", updatedAt: "2026-10-24" }, /before publishedAt/],
    [{ hero: { src: "javascript:x", alt: "A", width: 10, height: 10, licensed: false } }, /hero.src/],
    [{ hero: { src: "/a.jpg", alt: "", width: 10, height: 10, licensed: false } }, /hero.alt is empty/],
    [{ hero: { src: "/a.jpg", alt: "A", width: 0, height: 10, licensed: false } }, /positive integers/],
    [{ relatedExperienceSlugs: ["only-one"] }, /needs 2–3 slugs/],
    [{ relatedExperienceSlugs: ["a", "b", "c", "d"] }, /needs 2–3 slugs/],
    [{ relatedExperienceSlugs: ["a", "a"] }, /repeats a slug/],
    [{ relatedGuideSlugs: [sample.slug] }, /points at the guide itself/],
    [{ faq: [{ question: "Q?", answer: "" }] }, /answer is empty/],
    [{ faq: [{ question: "Q?", answer: "A." }, { question: "q?", answer: "B." }] }, /repeats a question/],
    [{ body: "" }, /body is empty/],
    [{ body: "<script>alert(1)</script>" }, /body: line 1: Raw HTML/],
    [{ translations: { ja: { title: "題名", description: "説明", body: "# 見出し", faq: [] } } }, /translations.ja.body: line 1/],
  ])("refuses %j", (change, message) => {
    expect(problemsOf(change as Partial<Guide>).join("\n")).toMatch(message);
  });

  it("refuses duplicate slugs and related guides missing from the registry", () => {
    const problems = guideRegistryProblems([sample, sample]).join("\n");
    expect(problems).toMatch(/used twice/);
    expect(guideRegistryProblems([sample]).join("\n")).toMatch(/related guide "sample-rainy-day-in-kamakura" is not in this registry/);
  });

  it("checks real dates", () => {
    expect(isGuideDate("2026-10-24")).toBe(true);
    expect(isGuideDate("2026-13-01")).toBe(false);
    expect(isGuideDate("2026-10-24T00:00:00Z")).toBe(false);
    expect(formatGuideDate("2026-10-24")).toBe("24 Oct 2026");
  });
});

describe("guide selection", () => {
  it("sorts by the newest update, then the title", () => {
    expect(sortGuides(SAMPLE_GUIDES).map((guide) => guide.updatedAt)).toEqual(["2026-10-24", "2026-10-18"]);
  });

  it("finds the guides about an experience, and none for an experience no guide mentions", () => {
    expect(guidesForExperience(SAMPLE_GUIDES, "evening-pottery-session").map((guide) => guide.slug)).toEqual(["sample-first-evening-in-kamakura", "sample-rainy-day-in-kamakura"]);
    expect(guidesForExperience(SAMPLE_GUIDES, "home-cooked-dinner-with-locals").map((guide) => guide.slug)).toEqual(["sample-first-evening-in-kamakura"]);
    expect(guidesForExperience(SAMPLE_GUIDES, "seaside-cycling-and-market-breakfast")).toEqual([]);
    expect(guidesForExperience(PUBLISHED_GUIDES, "home-cooked-dinner-with-locals")).toEqual([]);
  });

  it("keeps related guides that exist and listed experiences, in the guide's order", () => {
    expect(relatedGuidesOf(SAMPLE_GUIDES, sample).map((guide) => guide.slug)).toEqual(["sample-rainy-day-in-kamakura"]);
    expect(relatedGuidesOf([sample], sample)).toEqual([]);
    expect(listedExperienceSlugs(sample, [{ slug: "evening-pottery-session" }, { slug: "home-cooked-dinner-with-locals" }])).toEqual(["home-cooked-dinner-with-locals", "evening-pottery-session"]);
    expect(listedExperienceSlugs(sample, [{ slug: "kamakura-calligraphy" }])).toEqual([]);
  });

  it("gives hreflang en and x-default, and ja only with a translation and a Japanese route", () => {
    const canonical = `${SITE}/guides/${sample.slug}`;
    expect(guideAlternates(sample, canonical, null)).toEqual({ canonical, languages: { en: canonical, "x-default": canonical } });
    expect(guideAlternates(sample, canonical, `${SITE}/ja/guides/${sample.slug}`)).toEqual({ canonical, languages: { en: canonical, "x-default": canonical } });
    const translated = { ...sample, translations: { ja: { title: "題名", description: "説明", body: "本文。", faq: [] } } };
    expect(guideProblems(translated)).toEqual([]);
    expect(guideAlternates(translated, canonical, null).languages).not.toHaveProperty("ja");
    expect(guideAlternates(translated, canonical, `${SITE}/ja/guides/${sample.slug}`).languages).toEqual({ en: canonical, ja: `${SITE}/ja/guides/${sample.slug}`, "x-default": canonical });
  });
});

describe("Article structured data", () => {
  it("says only what the page shows, with the site's publisher and no unlicensed image", () => {
    const data = guideArticleJsonLd(sample, SITE, "NIHO Experience");
    const url = `${SITE}/guides/${sample.slug}`;
    expect(data).toEqual({
      "@context": "https://schema.org",
      "@type": "Article",
      headline: sample.title,
      description: sample.description,
      url,
      mainEntityOfPage: { "@type": "WebPage", "@id": url },
      inLanguage: "en",
      author: { "@type": "Person", name: sample.author.name, jobTitle: sample.author.role },
      datePublished: sample.publishedAt,
      dateModified: sample.updatedAt,
      publisher: { "@type": "Organization", "@id": `${SITE}/#organization`, name: "NIHO Experience", url: `${SITE}/` },
    });
    expect(shareableGuideImage(sample, SITE)).toBeNull();
  });

  it("adds the hero only when it is licensed for sharing", () => {
    const licensed = { ...sample, hero: { ...sample.hero!, licensed: true } };
    expect(guideArticleJsonLd(licensed, SITE, "NIHO Experience").image).toEqual([`${SITE}/placeholders/dinner.svg`]);
    const external = { ...sample, hero: { ...sample.hero!, src: "https://images.example.com/a.jpg", licensed: true } };
    expect(guideArticleJsonLd(external, SITE, "NIHO Experience").image).toEqual(["https://images.example.com/a.jpg"]);
    const none = { ...sample, hero: undefined };
    expect(guideArticleJsonLd(none, SITE, "NIHO Experience")).not.toHaveProperty("image");
  });
});

describe("related experiences on a detail page", () => {
  const listed = [
    { slug: "dinner", themes: ["FOOD", "LOCAL_LIFE"] },
    { slug: "indigo", themes: ["CRAFT", "CULTURE"] },
    { slug: "cycling", themes: ["OUTDOORS", "FOOD"] },
    { slug: "pottery", themes: ["CRAFT", "CULTURE"] },
    { slug: "coffee", themes: ["FOOD", "CRAFT"] },
  ];

  it("never includes the current one, prefers shared themes and keeps the catalogue order for ties", () => {
    expect(pickRelatedExperiences("indigo", listed).map((item) => item.slug)).toEqual(["pottery", "coffee", "dinner"]);
    expect(pickRelatedExperiences("dinner", listed).map((item) => item.slug)).toEqual(["cycling", "coffee", "indigo"]);
    expect(pickRelatedExperiences("dinner", listed, 2)).toHaveLength(2);
  });

  it("falls back to the catalogue order without themes, and gives none when nothing else is listed", () => {
    expect(pickRelatedExperiences("b", [{ slug: "a" }, { slug: "b" }, { slug: "c" }]).map((item) => item.slug)).toEqual(["a", "c"]);
    expect(pickRelatedExperiences("a", [{ slug: "a" }])).toEqual([]);
    expect(pickRelatedExperiences("missing", [{ slug: "a" }]).map((item) => item.slug)).toEqual(["a"]);
  });
});
