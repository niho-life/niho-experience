import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EXPERIENCE_AREAS, EXPERIENCE_CATEGORIES, experienceAreaLabel, experienceCategoryLabel, parseExperienceClassification } from "../src/classification.ts";

describe("experience classification (#529)", () => {
  it("has the eight categories and nine areas the Japanese site shows", () => {
    assert.deepEqual(EXPERIENCE_CATEGORIES.map((item) => item.label), ["歩く", "つくる・食べる", "手を動かす", "禅と寺", "朝と夜", "海", "人に会う", "団体・チームで"]);
    assert.equal(EXPERIENCE_AREAS.length, 9);
    assert.equal(experienceCategoryLabel("zen"), "禅と寺");
    assert.equal(experienceAreaLabel("zai"), "材木座");
    assert.equal(experienceCategoryLabel("nope"), null);
  });

  it("accepts a whole value, in the lists' order, and nothing else", () => {
    assert.deepEqual(parseExperienceClassification({ category: "sea", area: "zushi", companions: ["family", "solo"], occasions: ["anniv", "rain"] }),
      { category: "sea", area: "zushi", companions: ["solo", "family"], occasions: ["rain", "anniv"] });
    assert.deepEqual(parseExperienceClassification({ category: null, area: null, companions: [], occasions: [] }), { category: null, area: null, companions: [], occasions: [] });
    for (const bad of [
      null, [], "walk", {}, { category: "walk" },
      { category: "cooking", area: null, companions: [], occasions: [] }, { category: null, area: "tokyo", companions: [], occasions: [] },
      { category: null, area: null, companions: ["solo", "solo"], occasions: [] }, { category: null, area: null, companions: ["rain"], occasions: [] },
      { category: null, area: null, companions: [], occasions: ["solo"] }, { category: null, area: null, companions: "solo", occasions: [] },
      { category: null, area: null, companions: [], occasions: [], note: "x" }, { category: undefined, area: null, companions: [], occasions: [] },
    ]) assert.equal(parseExperienceClassification(bad), null);
  });
});
