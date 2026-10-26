import { describe, expect, it } from "vitest";
import { isIsoDate, parseFrontMatterLines, readGuideMeta, splitFrontMatter } from "./frontmatter";

const VALID: Record<string, string> = {
  title: "Kamakura After 4 PM: What to Do When the Temples Close",
  description: "Most temples close by 4:30 pm. Here is how to spend a Kamakura evening.",
  pillar: "evening",
  type: "pillar",
  author: "Sample Author",
  authorRole: "Community manager, NIHO kamakura",
  published: "2026-11-10",
  updated: "2026-11-12",
  factsChecked: "2026-11-08",
  hero: "/guides/media/dusk.jpg",
  heroAlt: "A beach at dusk",
  heroCredit: "Sample Photographer",
  experiences: "home-cooked-dinner-with-locals, evening-pottery-session",
  related: "zazen-in-kamakura",
};

const frontMatter = (values: Record<string, string | undefined>) =>
  Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${value}`).join("\n");

const read = (overrides: Record<string, string | undefined> = {}, slug = "kamakura-after-4-pm") => readGuideMeta(slug, frontMatter({ ...VALID, ...overrides }));

describe("front matter", () => {
  it("splits at the first \": \" so titles may contain a colon, and reads comma-separated lists", () => {
    const { meta, errors } = read();
    expect(errors).toEqual([]);
    expect(meta).toMatchObject({
      slug: "kamakura-after-4-pm",
      title: "Kamakura After 4 PM: What to Do When the Temples Close",
      type: "pillar",
      factsChecked: "2026-11-08",
      heroCredit: "Sample Photographer",
      experiences: ["home-cooked-dinner-with-locals", "evening-pottery-session"],
      related: ["zazen-in-kamakura"],
    });
  });

  it("defaults type to guide and leaves optional keys empty", () => {
    const { meta } = read({ type: undefined, factsChecked: undefined, heroCredit: undefined, experiences: undefined, related: "" });
    expect(meta).toMatchObject({ type: "guide", factsChecked: null, heroCredit: null, experiences: [], related: [] });
  });

  it("drops a guide's own slug from related", () => {
    expect(read({ related: "kamakura-after-4-pm, other-guide" }).meta?.related).toEqual(["other-guide"]);
  });

  it("separates the front matter from the body and counts body lines from the file start", () => {
    const parts = splitFrontMatter("﻿---\r\ntitle: A\r\n---\r\nBody\r\n");
    expect(parts).toEqual({ frontMatter: "title: A", body: "Body\n", bodyStartLine: 4 });
    expect(splitFrontMatter("title: A\n---\nBody")).toBeNull();
    expect(splitFrontMatter("---\ntitle: A\nBody")).toBeNull();
  });

  it("rejects unknown, repeated and malformed lines", () => {
    expect(parseFrontMatterLines("heroalt: x").errors).toEqual(['unknown front matter key "heroalt"']);
    expect(parseFrontMatterLines("title: a\ntitle: b").errors).toEqual(['front matter key "title" is repeated']);
    expect(parseFrontMatterLines("title:a").errors).toEqual(['front matter line 2 is not "key: value"']);
    expect(parseFrontMatterLines("heroCredit:").values.get("heroCredit")).toBe("");
  });

  it("requires every required key", () => {
    for (const key of ["title", "description", "pillar", "author", "authorRole", "published", "updated", "hero", "heroAlt"]) {
      const { meta, errors } = read({ [key]: undefined });
      expect(meta, key).toBeNull();
      expect(errors, key).toContain(`"${key}" is required`);
    }
  });

  it("checks the slug, pillar, type and lengths", () => {
    expect(read({}, "Kamakura_After").errors).toEqual(['file name "Kamakura_After.md" must be lowercase letters, digits and single hyphens']);
    expect(read({}, "double--hyphen").errors).toHaveLength(1);
    expect(read({ pillar: "food" }).errors).toEqual(['"pillar" must be one of evening, zazen, crafts, planning, hosts']);
    expect(read({ type: "column" }).errors).toEqual(['"type" must be pillar or guide']);
    expect(read({ title: "x".repeat(70) }).errors).toEqual([]);
    expect(read({ title: "x".repeat(71) }).errors).toEqual(['"title" is 71 characters (at most 70)']);
    expect(read({ description: "x".repeat(160) }).errors).toEqual([]);
    expect(read({ description: "x".repeat(161) }).errors).toEqual(['"description" is 161 characters (at most 160)']);
  });

  it("accepts only real dates and an update on or after publication", () => {
    expect(isIsoDate("2026-02-28")).toBe(true);
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("2026-1-01")).toBe(false);
    expect(read({ published: "2026-11-31" }).errors).toEqual(['"published" must be a real date written YYYY-MM-DD']);
    expect(read({ factsChecked: "Nov 8" }).errors).toEqual(['"factsChecked" must be a real date written YYYY-MM-DD']);
    expect(read({ updated: "2026-11-09" }).errors).toEqual(['"updated" must not be before "published"']);
    expect(read({ updated: "2026-11-10" }).errors).toEqual([]);
  });

  it("allows at most three experiences, all written as slugs", () => {
    expect(read({ experiences: "a, b, c, d" }).errors).toEqual(['"experiences" lists 4 experiences (at most 3)']);
    expect(read({ experiences: "Home Dinner" }).errors).toEqual(['"experiences" has "Home Dinner", which is not a slug']);
    expect(read({ related: "../secret" }).errors).toEqual(['"related" has "../secret", which is not a slug']);
  });

  it("takes a hero photo only from this site or an https URL", () => {
    expect(read({ hero: "https://images.example/dusk.jpg" }).errors).toEqual([]);
    for (const hero of ["//images.example/dusk.jpg", "/\\images.example/dusk.jpg", "http://images.example/dusk.jpg", "guides/media/dusk.jpg", "javascript:alert(1)", "data:image/png;base64,AAAA", "/guides/media/my photo.jpg"]) {
      expect(read({ hero }).errors, hero).toEqual(['"hero" must be a site path starting with "/" or an https:// URL']);
    }
  });
});
