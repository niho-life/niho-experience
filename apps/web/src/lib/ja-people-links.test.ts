import { describe, expect, it } from "vitest";
import type { PublicPerson } from "@niho-experience/experience-store";
import { peopleByExperience } from "./ja-people-links";

const person = (slug: string, experienceSlugs: string[]): PublicPerson => ({ slug, name: slug, roleJa: "", areaJa: "", quoteJa: null, introJa: null, photo: { src: "/p.jpg", altJa: "", credit: null }, experienceSlugs, sortOrder: 1 });

describe("peopleByExperience (#585)", () => {
  it("is the same relation seen from the experience, in the order people are shown", () => {
    const map = peopleByExperience([person("suga", ["zen-karate", "own"]), person("takuya", ["dinner", "zen-karate"]), person("none", [])]);
    expect(map.get("zen-karate")?.map((entry) => entry.slug)).toEqual(["suga", "takuya"]);
    expect(map.get("own")?.map((entry) => entry.slug)).toEqual(["suga"]);
    expect(map.get("dinner")?.map((entry) => entry.slug)).toEqual(["takuya"]);
    expect(map.has("nobody")).toBe(false);
  });
});
