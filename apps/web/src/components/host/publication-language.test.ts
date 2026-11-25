import { describe, expect, it } from "vitest";
import {
  BLANK_JAPANESE_MANUSCRIPT, fillUnlistedAlt, languageSyncFollower, languageSyncOutOfSync, publicationEnglishTitle, publicationListing, readLanguageSync, savedLanguageSync, withLanguageSync, withPublicationListing,
  manuscriptHasContent, publicationLanguageOutOfSync, readEnglishSourceFingerprint, savedEnglishSourceFingerprint, withEnglishSourceFingerprint, withoutEmptyRows,
} from "./publication-language";

describe("readEnglishSourceFingerprint", () => {
  it("reads the remembered fingerprint", () => {
    expect(readEnglishSourceFingerprint({ languageSync: { englishSourceFingerprint: "abc" }, translation: { sourceFingerprint: "x", confirmedSourceFingerprint: "x" } })).toBe("abc");
  });

  it("falls back to a confirmed translation's source, or to nothing", () => {
    expect(readEnglishSourceFingerprint({ translation: { sourceFingerprint: "x", confirmedSourceFingerprint: "x" } })).toBe("x");
    expect(readEnglishSourceFingerprint({ translation: { sourceFingerprint: "x", confirmedSourceFingerprint: null } })).toBe("");
    expect(readEnglishSourceFingerprint({ translation: { sourceFingerprint: null, confirmedSourceFingerprint: null } })).toBe("");
    expect(readEnglishSourceFingerprint({})).toBe("");
  });

  it("does not take a malformed value", () => {
    expect(readEnglishSourceFingerprint({ languageSync: { englishSourceFingerprint: 3 } })).toBe("");
  });
});

describe("withEnglishSourceFingerprint", () => {
  it("sets the remembered fingerprint and keeps the rest", () => {
    expect(withEnglishSourceFingerprint({ lead: "a" }, "f")).toEqual({ lead: "a", languageSync: { englishSourceFingerprint: "f" } });
  });
});

describe("manuscriptHasContent", () => {
  it("is true when any of title, lead or description is written", () => {
    expect(manuscriptHasContent({ title: "", lead: " ", description: "" })).toBe(false);
    expect(manuscriptHasContent({ title: "", lead: "x", description: "" })).toBe(true);
    expect(manuscriptHasContent({})).toBe(false);
  });
});

describe("publicationLanguageOutOfSync", () => {
  const level = { japaneseOnly: false, japaneseWritten: true, englishWritten: true, remembered: "a", current: "a" };
  it("is quiet while level, while computing, and for a Japanese-only page", () => {
    expect(publicationLanguageOutOfSync(level)).toBe(false);
    expect(publicationLanguageOutOfSync({ ...level, current: null })).toBe(false);
    expect(publicationLanguageOutOfSync({ ...level, current: "b", japaneseOnly: true })).toBe(false);
  });

  it("needs both languages written", () => {
    expect(publicationLanguageOutOfSync({ ...level, current: "b", englishWritten: false })).toBe(false);
    expect(publicationLanguageOutOfSync({ ...level, current: "b", japaneseWritten: false })).toBe(false);
  });

  it("tells when the Japanese moved on, including a draft that never remembered one", () => {
    expect(publicationLanguageOutOfSync({ ...level, current: "b" })).toBe(true);
    expect(publicationLanguageOutOfSync({ ...level, remembered: "", current: "b" })).toBe(true);
  });
});

describe("savedEnglishSourceFingerprint", () => {
  it("follows the Japanese when level and keeps the remembered value when out of step", () => {
    expect(savedEnglishSourceFingerprint({ outOfSync: false, remembered: "a", current: "b" })).toBe("b");
    expect(savedEnglishSourceFingerprint({ outOfSync: true, remembered: "a", current: "b" })).toBe("a");
  });

  it("keeps a draft with no key and an unconfirmed translation out of step after saving", () => {
    const before: Record<string, unknown> = { translation: { sourceFingerprint: null, confirmedSourceFingerprint: null } };
    const input = { japaneseOnly: false, japaneseWritten: true, englishWritten: true, current: "b" };
    const remembered = readEnglishSourceFingerprint(before);
    const outOfSync = publicationLanguageOutOfSync({ ...input, remembered });
    expect(outOfSync).toBe(true);
    // Saving confirms the translation (its source is the current Japanese) and always writes the key: "" here.
    const saved = withEnglishSourceFingerprint({ translation: { sourceFingerprint: "b", confirmedSourceFingerprint: "b" } }, savedEnglishSourceFingerprint({ outOfSync, remembered, current: "b" }));
    expect(readEnglishSourceFingerprint(saved)).toBe("");
    expect(publicationLanguageOutOfSync({ ...input, remembered: readEnglishSourceFingerprint(saved) })).toBe(true);
  });

  it("is level after 「このままでよい」 put the current value in", () => {
    const kept = withEnglishSourceFingerprint({}, "b");
    const remembered = readEnglishSourceFingerprint(kept);
    const outOfSync = publicationLanguageOutOfSync({ japaneseOnly: false, japaneseWritten: true, englishWritten: true, remembered, current: "b" });
    expect(outOfSync).toBe(false);
    expect(readEnglishSourceFingerprint(withEnglishSourceFingerprint(kept, savedEnglishSourceFingerprint({ outOfSync, remembered, current: "b" })))).toBe("b");
  });
});

describe("withoutEmptyRows", () => {
  it("drops empty and blank rows only", () => {
    expect(withoutEmptyRows(["a", "", "  ", " b "])).toEqual(["a", " b "]);
  });
});

describe("publication listing", () => {
  const ja = { title: "合成の商品", lead: "紹介", description: "説明", language: "日本語", highlights: ["a"], included: [], notIncluded: [], knowBeforeYouGo: [], notSuitableFor: [], timeline: [] };
  const both = { lead: "Lead", description: "Description", facts: { language: "English" }, ja, translation: { sourceFingerprint: "x", confirmedSourceFingerprint: "x" } };
  const BOTH = { en: true, ja: true };

  it("reads the listing from the markers", () => {
    expect(publicationListing(both)).toEqual(BOTH);
    expect(publicationListing({ ...both, japaneseOnly: true })).toEqual({ en: false, ja: true });
    expect(publicationListing({ ...both, englishOnly: true })).toEqual({ en: true, ja: false });
  });

  it("both to English-only keeps the Japanese as a draft and empties content.ja", () => {
    const result = withPublicationListing({ content: both, title: "Synthetic" }, { en: true, ja: false });
    expect(result.title).toBe("Synthetic");
    expect(result.content.englishOnly).toBe(true);
    expect(result.content.ja).toEqual(BLANK_JAPANESE_MANUSCRIPT);
    expect(result.content.jaDraft).toEqual(ja);
    expect(result.content.lead).toBe("Lead");
    expect(publicationListing(result.content)).toEqual({ en: true, ja: false });
  });

  it("English-only back to both puts the draft back and removes both markers", () => {
    const englishOnly = withPublicationListing({ content: both, title: "Synthetic" }, { en: true, ja: false });
    const back = withPublicationListing(englishOnly, BOTH);
    expect(back.content.ja).toEqual(ja);
    expect("jaDraft" in back.content).toBe(false);
    expect("englishOnly" in back.content).toBe(false);
    expect(back.title).toBe("Synthetic");
  });

  it("both to Japanese-only keeps the English title as a draft and the Japanese title becomes the public one", () => {
    const result = withPublicationListing({ content: both, title: "Synthetic" }, { en: false, ja: true });
    expect(result.content.japaneseOnly).toBe(true);
    expect(result.content.enTitleDraft).toBe("Synthetic");
    expect(result.title).toBe("合成の商品");
    expect(result.content.lead).toBe("Lead");
    expect(publicationEnglishTitle(result.content, result.title)).toBe("Synthetic");
  });

  it("Japanese-only back to both restores the English title and removes both markers", () => {
    const japaneseOnly = withPublicationListing({ content: both, title: "Synthetic" }, { en: false, ja: true });
    const back = withPublicationListing(japaneseOnly, BOTH);
    expect(back.title).toBe("Synthetic");
    expect("enTitleDraft" in back.content).toBe(false);
    expect("japaneseOnly" in back.content).toBe(false);
    expect(publicationListing(back.content)).toEqual(BOTH);
  });

  it("goes between English-only and Japanese-only without losing either draft", () => {
    const englishOnly = withPublicationListing({ content: both, title: "Synthetic" }, { en: true, ja: false });
    const japaneseOnly = withPublicationListing(englishOnly, { en: false, ja: true });
    expect(japaneseOnly.content.ja).toEqual(ja);
    expect(japaneseOnly.content.enTitleDraft).toBe("Synthetic");
    expect("englishOnly" in japaneseOnly.content).toBe(false);
    const again = withPublicationListing(japaneseOnly, { en: true, ja: false });
    expect(again.title).toBe("Synthetic");
    expect(again.content.jaDraft).toEqual(ja);
  });

  it("does not let the last language go", () => {
    const input = { content: both, title: "Synthetic" };
    expect(withPublicationListing(input, { en: false, ja: false })).toBe(input);
  });
});

describe("language sync with either language as the source", () => {
  it("reads which language is the source", () => {
    expect(readLanguageSync({ languageSync: { englishSourceFingerprint: "a" } })).toEqual({ source: "ja", remembered: "a", hasKey: true });
    expect(readLanguageSync({ languageSync: { japaneseSourceFingerprint: "b" } })).toEqual({ source: "en", remembered: "b", hasKey: true });
    expect(readLanguageSync({})).toEqual({ source: "ja", remembered: "", hasKey: false });
    expect(languageSyncFollower("ja")).toBe("en");
    expect(languageSyncFollower("en")).toBe("ja");
  });

  it("remembers exactly one key", () => {
    const changed = withLanguageSync({ languageSync: { englishSourceFingerprint: "a" } }, "en", "z");
    expect(changed.languageSync).toEqual({ japaneseSourceFingerprint: "z" });
    expect(withLanguageSync(changed, "ja", "y").languageSync).toEqual({ englishSourceFingerprint: "y" });
  });

  it("only tells when both languages are published and written", () => {
    const base = { listing: { en: true, ja: true }, japaneseWritten: true, englishWritten: true, remembered: "a", current: "b" };
    expect(languageSyncOutOfSync(base)).toBe(true);
    expect(languageSyncOutOfSync({ ...base, listing: { en: true, ja: false } })).toBe(false);
    expect(languageSyncOutOfSync({ ...base, listing: { en: false, ja: true } })).toBe(false);
    expect(languageSyncOutOfSync({ ...base, current: "a" })).toBe(false);
  });

  const input = { japaneseWritten: true, englishWritten: true, japaneseFingerprint: "J2", englishFingerprint: "E2" };
  it("saves the source's current fingerprint when level and keeps the held one when out of step", () => {
    expect(savedLanguageSync({ ...input, content: { languageSync: { englishSourceFingerprint: "J2" } } })).toEqual({ source: "ja", fingerprint: "J2" });
    expect(savedLanguageSync({ ...input, content: { languageSync: { englishSourceFingerprint: "J1" } } })).toEqual({ source: "ja", fingerprint: "J1" });
    expect(savedLanguageSync({ ...input, content: { languageSync: { japaneseSourceFingerprint: "E1" } } })).toEqual({ source: "en", fingerprint: "E1" });
    expect(savedLanguageSync({ ...input, content: { languageSync: { japaneseSourceFingerprint: "E2" } } })).toEqual({ source: "en", fingerprint: "E2" });
  });

  it("takes the English as the source when only the English is written and nothing is remembered", () => {
    expect(savedLanguageSync({ ...input, japaneseWritten: false, content: {} })).toEqual({ source: "en", fingerprint: "E2" });
    expect(savedLanguageSync({ ...input, content: {} })).toEqual({ source: "ja", fingerprint: "" });
  });

  it("an edit of the follower does not make a notice: the source's fingerprint is what is compared", () => {
    const content = { languageSync: { englishSourceFingerprint: "J2" } };
    const { source, remembered } = readLanguageSync(content);
    expect(languageSyncOutOfSync({ listing: { en: true, ja: true }, japaneseWritten: true, englishWritten: true, remembered, current: source === "ja" ? "J2" : "E-changed" })).toBe(false);
  });
});

describe("fillUnlistedAlt", () => {
  it("copies the published language's description into the unpublished one when that is empty", () => {
    const items = [{ altText: "En", altTextJa: "" }, { altText: "Both", altTextJa: "両方" }];
    expect(fillUnlistedAlt(items, { en: true, ja: false })).toEqual([{ altText: "En", altTextJa: "En" }, items[1]]);
    const ja = [{ altText: "", altTextJa: "日" }];
    expect(fillUnlistedAlt(ja, { en: false, ja: true })).toEqual([{ altText: "日", altTextJa: "日" }]);
  });

  it("returns the same array when there is nothing to copy or both are published", () => {
    const items = [{ altText: "En", altTextJa: "" }];
    expect(fillUnlistedAlt(items, { en: true, ja: true })).toBe(items);
    const full = [{ altText: "En", altTextJa: "日" }];
    expect(fillUnlistedAlt(full, { en: true, ja: false })).toBe(full);
  });
});
