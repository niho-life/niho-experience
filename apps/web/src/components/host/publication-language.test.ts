import { describe, expect, it } from "vitest";
import {
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
