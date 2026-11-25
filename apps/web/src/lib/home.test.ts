import { describe, expect, it } from "vitest";
import { pickHomeExperiences } from "./home";

describe("shared home experience selection", () => {
  const items = ["a", "b", "c", "d", "e"].map((slug) => ({ slug }));

  it("puts editor picks first, skips missing or repeated slugs and fills up to the limit", () => {
    expect(pickHomeExperiences(items, ["c", "x", "a"], 4).map((item) => item.slug)).toEqual(["c", "a", "b", "d"]);
    expect(pickHomeExperiences(items, [], 3).map((item) => item.slug)).toEqual(["a", "b", "c"]);
    expect(pickHomeExperiences(items, ["c", "c"], 2).map((item) => item.slug)).toEqual(["c", "a"]);
    expect(pickHomeExperiences([], ["a"], 6)).toEqual([]);
  });
});
