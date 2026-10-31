import { describe, expect, it } from "vitest";
import { LIVE_ENGLISH_FIELDS, liveEnglishState, pairsOf, readLiveEnglish } from "./live-english";

const preview = (language: "JA" | "EN" = "JA", english: Partial<Record<string, unknown>> = {}) => ({
  page: {
    language, title: "朝市と料理", titleEn: "Market and cooking",
    content: {
      lead: "朝市で野菜を選びます", leadEn: "Pick vegetables at the market", facts: { language: "日本語", languageEn: "Japanese" },
      highlights: ["旬の野菜", "一品を仕上げる"], highlightsEn: ["Seasonal vegetables", null],
      description: "朝市を歩きます", descriptionEn: "Walk the market",
      included: ["食材"], includedEn: ["Ingredients"], notIncluded: [], notIncludedEn: [], notSuitableFor: ["生ものが苦手な方"], notSuitableForEn: ["People who dislike raw food"],
      timeline: [{ time: "08:30", title: "買い物", titleEn: "Shopping", text: "野菜を選びます", textEn: "You choose vegetables", photoIndex: null }],
      knowBeforeYouGo: ["歩きやすい靴"], knowBeforeYouGoEn: ["Comfortable shoes"],
      ...english,
    },
  },
});

describe("英語（自動訳）: NIHO's English read from the preview", () => {
  it("pairs each Japanese text with NIHO's English, null where NIHO has not made it", () => {
    const english = readLiveEnglish(preview())!;
    expect(english.language).toBe("JA");
    expect(english.title).toEqual({ ja: "朝市と料理", en: "Market and cooking" });
    expect(english.highlights).toEqual([{ ja: "旬の野菜", en: "Seasonal vegetables" }, { ja: "一品を仕上げる", en: null }]);
    expect(english.timeline).toEqual([{ time: "08:30", title: { ja: "買い物", en: "Shopping" }, text: { ja: "野菜を選びます", en: "You choose vegetables" } }]);
    expect(pairsOf(english, "timeline").map((pair) => pair.en)).toEqual(["Shopping", "You choose vegetables"]);
  });

  it("says 一部のみ and which fields lack English, 未作成 with none, そろっています with all", () => {
    expect(liveEnglishState(readLiveEnglish(preview()))).toEqual({ status: "partial", missing: ["highlights"] });
    const none = readLiveEnglish(preview("JA", { leadEn: null, facts: { language: "日本語", languageEn: null }, highlightsEn: [null, null], descriptionEn: null, includedEn: [null], notSuitableForEn: [null], timeline: [{ time: "", title: "買い物", titleEn: null, text: "", textEn: null, photoIndex: null }], knowBeforeYouGoEn: [null] }));
    expect(liveEnglishState({ ...none!, title: { ja: "朝市と料理", en: null } }).status).toBe("none");
    const complete = readLiveEnglish(preview("JA", { highlightsEn: ["Seasonal vegetables", "Finish one dish"] }));
    expect(liveEnglishState(complete)).toEqual({ status: "complete", missing: [] });
  });

  it("has nothing to translate for blank Japanese, and no English to read for a page written in English", () => {
    const blank = readLiveEnglish(preview("JA", { lead: "", leadEn: null, highlights: [], highlightsEn: [], description: "", descriptionEn: null, included: [], includedEn: [], notSuitableFor: [], notSuitableForEn: [], timeline: [], knowBeforeYouGo: [], knowBeforeYouGoEn: [], facts: { language: "", languageEn: null } }));
    expect(liveEnglishState({ ...blank!, title: { ja: "", en: null } })).toEqual({ status: "none", missing: [] });
    expect(liveEnglishState(readLiveEnglish(preview("EN")))).toEqual({ status: "none", missing: [] });
    expect(liveEnglishState(null)).toEqual({ status: "none", missing: [] });
  });

  it("refuses an answer that is not the preview's shape, or whose English list does not line up with the Japanese", () => {
    expect(readLiveEnglish(null)).toBeNull();
    expect(readLiveEnglish({ page: { language: "FR" } })).toBeNull();
    expect(readLiveEnglish(preview("JA", { highlightsEn: ["only one"] }))).toBeNull();
    expect(readLiveEnglish(preview("JA", { leadEn: 3 }))).toBeNull();
    expect(readLiveEnglish(preview("JA", { timeline: [{ time: "08:30", title: "買い物", text: "x" }] }))).toBeNull();
  });

  it("lists every field the English tab shows", () => {
    expect(LIVE_ENGLISH_FIELDS).toEqual(["title", "lead", "dayLanguage", "highlights", "description", "included", "notIncluded", "notSuitableFor", "timeline", "knowBeforeYouGo"]);
  });
});
