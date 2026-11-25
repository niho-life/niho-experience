import { describe, expect, it } from "vitest";
import { publicationSlugFromTitle, publicationSlugRetry } from "./publication-slug";

const fixed = (value: number) => () => value;

describe("publication slug", () => {
  it("lower-cases the title and joins its words with hyphens", () => {
    expect(publicationSlugFromTitle("Cook and Share: A Community Dinner!")).toBe("cook-and-share-a-community-dinner");
  });

  it("stops at a word boundary within 36 characters", () => {
    const slug = publicationSlugFromTitle("Cook and Share a Community Dinner with Kamakura Locals");
    expect(slug.length).toBeLessThanOrEqual(36);
    expect(slug).toBe("cook-and-share-a-community-dinner");
  });

  it("drops connecting words left at the end", () => {
    expect(publicationSlugFromTitle("Morning walk in the")).toBe("morning-walk");
    expect(publicationSlugFromTitle("Tea ceremony for 2 of the")).toBe("tea-ceremony-for-2");
  });

  it("falls back to a random id under three characters", () => {
    expect(publicationSlugFromTitle("鎌倉を歩く", fixed(0))).toBe("experience-aaaaaa");
    expect(publicationSlugFromTitle("A", fixed(0.999))).toBe("experience-999999");
    expect(publicationSlugFromTitle("", () => 0.5)).toMatch(/^experience-[a-z0-9]{6}$/);
  });

  it("cuts a single over-long word", () => {
    expect(publicationSlugFromTitle("x".repeat(60))).toBe("x".repeat(36));
  });

  it("adds four digits for a retry", () => {
    expect(publicationSlugRetry("tea-ceremony", fixed(0.5))).toBe("tea-ceremony-5555");
    expect(publicationSlugRetry("tea", () => 0.123)).toMatch(/^tea-\d{4}$/);
  });
});
