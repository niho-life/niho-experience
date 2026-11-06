import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publicationManuscriptFingerprint, publicationManuscriptReview } from "@niho-experience/experience-store";
import { canonicalPublicationJson, confirmPublicationEnglish, englishPublicationManuscript } from "./publication-confirmation";

const japanese = {
  title: "合成の体験", lead: "合成の紹介", description: "合成の説明", language: "英語",
  highlights: [], included: [], notIncluded: [], knowBeforeYouGo: [], notSuitableFor: [], timeline: [],
};
const english = { ...japanese, title: "Synthetic experience", lead: "Synthetic lead", description: "Synthetic description", language: "English" };
const hash = (value: unknown) => createHash("sha256").update(canonicalPublicationJson(value)).digest("hex");
afterEach(() => vi.restoreAllMocks());

describe("saved publication manuscript comparison", () => {
  const draft = {
    slug: "synthetic-experience", title: english.title, unitAmount: "5000",
    content: { ja: japanese, facts: { language: "English" }, highlights: ["First", "Second"], translation: { sourceFingerprint: "source", confirmedSourceFingerprint: "source" } },
  };
  // PostgreSQL jsonb preserves values and array order, but not object insertion order.
  const saved = { ...draft, content: {
    translation: { confirmedSourceFingerprint: "source", sourceFingerprint: "source" },
    highlights: ["First", "Second"], facts: { language: "English" },
    ja: { language: japanese.language, description: japanese.description, lead: japanese.lead, title: japanese.title, timeline: [], notSuitableFor: [], knowBeforeYouGo: [], notIncluded: [], included: [], highlights: [] },
  } };

  it("recognizes the saved manuscript when nested object keys return in a different order", () => {
    expect(JSON.stringify(saved)).not.toBe(JSON.stringify(draft));
    expect(canonicalPublicationJson(saved)).toBe(canonicalPublicationJson(draft));
  });

  it("keeps actual text changes and reordered list items unsaved", () => {
    for (const content of [
      { ...saved.content, ja: { ...saved.content.ja, lead: "変更した紹介文" } },
      { ...saved.content, highlights: ["Second", "First"] },
    ]) expect(canonicalPublicationJson({ ...saved, content })).not.toBe(canonicalPublicationJson(draft));
  });
});

describe("OWNER confirmation of manually prepared English", () => {
  it("confirms manual copy without a generated translation or external request", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("translation unavailable"));
    const { title, language, ...copy } = english;
    const prepared = englishPublicationManuscript(title, { ...copy, facts: { language }, translation: null });
    expect(await confirmPublicationEnglish(() => ({ japanese, english: prepared }))).toEqual({
      sourceFingerprint: hash(japanese), confirmedSourceFingerprint: hash(japanese), confirmedEnglishFingerprint: hash(english),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  for (const locale of ["japanese", "english"] as const) {
    it(`does not confirm an older ${locale} draft if it changes during hashing`, async () => {
      let current = { japanese, english };
      const pending = confirmPublicationEnglish(() => current);
      current = { ...current, [locale]: { ...current[locale], description: "Updated copy" } };
      await expect(pending).rejects.toThrow("確認中に原稿が変更");
      const confirmed = await confirmPublicationEnglish(() => current);
      expect(confirmed.confirmedEnglishFingerprint).toBe(hash(current.english));
      expect(confirmed.confirmedSourceFingerprint).toBe(hash(current.japanese));
    });
  }

  it("keeps incomplete copy unconfirmed", async () => {
    await expect(confirmPublicationEnglish(() => ({ japanese, english: { ...english, language: " " } })))
      .rejects.toThrow("当日の言語を入力");
  });
});

describe("optional FAQ in the OWNER confirmation", () => {
  const { title, language, ...copy } = english;
  const content = { ...copy, facts: { language } };
  const faq = [{ question: "Can children join?", answer: "Yes, from age 6." }];
  const faqJa = [{ question: "子どもも参加できますか？", answer: "6歳から参加できます。" }];

  it("fingerprints an absent and an empty FAQ exactly like a manuscript written before FAQ existed", async () => {
    const before = await confirmPublicationEnglish(() => ({ japanese, english: englishPublicationManuscript(title, content) }));
    expect(before.sourceFingerprint).toBe(hash(japanese));
    expect(before.confirmedEnglishFingerprint).toBe(hash(english));
    const empty = await confirmPublicationEnglish(() => ({ japanese: { ...japanese, faq: [] }, english: englishPublicationManuscript(title, { ...content, faq: [] }) }));
    expect(empty).toEqual(before);
    expect(englishPublicationManuscript(title, { ...content, faq: [] })).not.toHaveProperty("faq");
  });

  it("includes a written FAQ in both fingerprints and matches the server's review byte for byte", async () => {
    const confirmed = await confirmPublicationEnglish(() => ({ japanese: { ...japanese, faq: faqJa }, english: englishPublicationManuscript(title, { ...content, faq }) }));
    expect(confirmed.sourceFingerprint).not.toBe(hash(japanese));
    expect(confirmed.confirmedEnglishFingerprint).not.toBe(hash(english));
    expect(confirmed.sourceFingerprint).toBe(publicationManuscriptFingerprint({ ...japanese, faq: faqJa }));
    const review = publicationManuscriptReview({
      ...content, meetingOverview: null, meetingPointDisclosure: "AFTER_BOOKING", meetingPoint: null,
      faq, ja: { ...japanese, faq: faqJa }, translation: confirmed,
    }, title);
    expect(review).toMatchObject({ ownerConfirmed: true, japaneseFingerprint: confirmed.sourceFingerprint, englishFingerprint: confirmed.confirmedEnglishFingerprint });
  });

  it("does not confirm an incomplete FAQ row", async () => {
    await expect(confirmPublicationEnglish(() => ({ japanese: { ...japanese, faq: [{ question: "質問", answer: "" }] }, english: englishPublicationManuscript(title, content) })))
      .rejects.toThrow("日本語のよくある質問1件目");
    await expect(confirmPublicationEnglish(() => ({ japanese, english: englishPublicationManuscript(title, { ...content, faq: [...faq, faq[0]] }) })))
      .rejects.toThrow("英語のよくある質問2件目の質問が前の質問と同じ");
  });
});
