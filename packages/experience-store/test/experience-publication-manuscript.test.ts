import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StoreValidationError } from "../src/errors.ts";
import { ExperiencePublicationRepository, publicationManuscriptReview } from "../src/experience-publication.ts";
import {
  EXPERIENCE_PUBLICATION_FAQ_LIMITS,
  publicationFaqIssue,
  publicationManuscriptFingerprint,
  validPublicationLocaleManuscript,
} from "../src/experience-publication-manuscript.ts";
import { projectPublicExperiencePublication, projectPublicExperiencePublicationContent } from "../src/experience-publication-projection.ts";

// Synthetic manuscripts written before FAQ existed (no `faq` key).
const japanese = {
  title: "合成の茶道体験", lead: "合成の紹介文", description: "合成の説明", language: "英語",
  highlights: ["合成の特徴"], included: ["抹茶"], notIncluded: [], knowBeforeYouGo: ["靴を脱ぎます"], notSuitableFor: [],
  timeline: [{ time: "10:00", title: "集合", text: "合成の集合", photoIndex: null }],
};
const englishContent = {
  lead: "Synthetic lead", description: "Synthetic description", facts: { language: "English" },
  highlights: ["Synthetic highlight"], included: ["Matcha"], notIncluded: [], knowBeforeYouGo: ["Shoes off"], notSuitableFor: [],
  timeline: [{ time: "10:00", title: "Meet", text: "Synthetic meeting", photoIndex: null }],
  meetingOverview: null, meetingPointDisclosure: "AFTER_BOOKING", meetingPoint: null,
};
const TITLE = "Synthetic tea ceremony";
// sha256 of the pre-FAQ canonical JSON, computed with the canonicalJson implementation before this change.
const PRE_FAQ_JAPANESE_FINGERPRINT = "5442b33f888e07549ab55d08dbadcef5ffb86ea5c44c0ed6095e5fac7e6dc4b0";
const PRE_FAQ_ENGLISH_FINGERPRINT = "724444c5bdabbc3caa5182c09dda4ccd8c59bc433ba11d178741620075baf8a1";

const confirmed = (content: Record<string, unknown>, ja: Record<string, unknown>, jaFingerprint: string, enFingerprint: string) => ({
  ...content, ja, translation: { sourceFingerprint: jaFingerprint, confirmedSourceFingerprint: jaFingerprint, confirmedEnglishFingerprint: enFingerprint },
});
const faq = [{ question: "Can children join?", answer: "Yes, from age 6." }, { question: "Is it held in rain?", answer: "Yes, indoors." }];
const faqJa = [{ question: "子どもも参加できますか？", answer: "6歳から参加できます。" }, { question: "雨でも開催しますか？", answer: "屋内で開催します。" }];

const publicRow = (content: Record<string, unknown>) => ({
  slug: "synthetic-tea", public_title: TITLE, content, currency: "JPY", unit_amount: 4000, seller_display_name: "Synthetic Seller",
  photos: [], provider_media: [], published_at: "2026-11-06T00:00:00.000Z",
});

describe("publication FAQ authoring validation", () => {
  it("accepts complete question/answer pairs up to the limits", () => {
    assert.equal(publicationFaqIssue([]), null);
    assert.equal(publicationFaqIssue(faq), null);
    assert.equal(publicationFaqIssue(Array.from({ length: EXPERIENCE_PUBLICATION_FAQ_LIMITS.maxItems }, (_, index) => ({ question: `Q${index}?`, answer: "A" }))), null);
    assert.equal(publicationFaqIssue([{ question: "q".repeat(200), answer: "a".repeat(1200) }]), null);
  });

  for (const [name, value] of [
    ["a non-array", { question: "Q", answer: "A" }],
    ["null", null],
    ["a non-object row", ["Q"]],
    ["a non-string answer", [{ question: "Q", answer: 3 }]],
    ["an extra key", [{ question: "Q", answer: "A", private: "x" }]],
    ["a missing answer", [{ question: "Q" }]],
    ["a blank question", [{ question: "   ", answer: "A" }]],
    ["a blank answer", [{ question: "Q", answer: "\n" }]],
    ["a question over 200 characters", [{ question: "q".repeat(201), answer: "A" }]],
    ["an answer over 1200 characters", [{ question: "Q", answer: "a".repeat(1201) }]],
    ["more than 30 rows", Array.from({ length: 31 }, (_, index) => ({ question: `Q${index}`, answer: "A" }))],
    ["the same trimmed question twice", [{ question: "Is it held in rain?", answer: "A" }, { question: "  is it held in RAIN? ", answer: "B" }]],
  ] as const) {
    it(`rejects ${name} instead of dropping it`, () => assert.notEqual(publicationFaqIssue(value), null));
  }

  it("rejects an invalid FAQ in either manuscript before touching PostgreSQL, and accepts an absent or valid one", async () => {
    const repository = new ExperiencePublicationRepository({
      connect: () => { throw new Error("database reached"); },
      query: () => { throw new Error("database reached"); },
    } as never);
    const actor = { providerId: "provider-synthetic", nihoUserId: "owner-synthetic" } as const;
    const draft = (content: Record<string, unknown>) => ({ slug: "synthetic-tea", publicTitle: TITLE, content: content as never, currency: "JPY", unitAmount: 4000 });
    const blank = [{ question: "Q", answer: " " }];
    await assert.rejects(repository.createDraft(actor, draft({ ...englishContent, faq: blank })), StoreValidationError);
    await assert.rejects(repository.createDraft(actor, draft({ ...englishContent, ja: { ...japanese, faq: blank } })), StoreValidationError);
    await assert.rejects(repository.createDraft(actor, draft({ ...englishContent, faq: [...faq, faq[0]] })), StoreValidationError);
    for (const content of [englishContent, { ...englishContent, faq: [] }, { ...englishContent, faq, ja: { ...japanese, faq: faqJa } }]) {
      await assert.rejects(repository.createDraft(actor, draft(content)), (error: unknown) => !(error instanceof StoreValidationError) && error instanceof Error && error.message === "database reached");
    }
  });
});

describe("publication manuscript fingerprints and key set", () => {
  it("keeps pre-FAQ fingerprints byte-identical; an empty FAQ equals an absent one (invariant a)", () => {
    assert.equal(publicationManuscriptFingerprint(japanese), PRE_FAQ_JAPANESE_FINGERPRINT);
    assert.equal(publicationManuscriptFingerprint({ ...japanese, faq: [] }), PRE_FAQ_JAPANESE_FINGERPRINT);
    for (const content of [englishContent, { ...englishContent, faq: [] }]) {
      for (const ja of [japanese, { ...japanese, faq: [] }]) {
        const review = publicationManuscriptReview(confirmed(content, ja, PRE_FAQ_JAPANESE_FINGERPRINT, PRE_FAQ_ENGLISH_FINGERPRINT), TITLE);
        assert.equal(review.japaneseFingerprint, PRE_FAQ_JAPANESE_FINGERPRINT);
        assert.equal(review.englishFingerprint, PRE_FAQ_ENGLISH_FINGERPRINT);
        assert.equal(review.ownerConfirmed, true);
        assert.equal(review.publicContentReady, true);
      }
    }
  });

  it("keeps a pre-FAQ OWNER-confirmed publication projecting exactly as before, with an empty FAQ", () => {
    const projected = projectPublicExperiencePublication(publicRow(confirmed(englishContent, japanese, PRE_FAQ_JAPANESE_FINGERPRINT, PRE_FAQ_ENGLISH_FINGERPRINT)));
    assert.deepEqual(projected?.content.faq, []);
    assert.equal(projected?.japanese?.title, japanese.title);
    assert.deepEqual(projected?.japanese?.faq, []);
  });

  it("includes a written FAQ in both fingerprints, so editing it makes the confirmation stale (invariant b)", () => {
    const withFaq = { ...englishContent, faq };
    const jaWithFaq = { ...japanese, faq: faqJa };
    const review = publicationManuscriptReview(confirmed(withFaq, jaWithFaq, "0".repeat(64), "0".repeat(64)), TITLE);
    assert.notEqual(review.japaneseFingerprint, PRE_FAQ_JAPANESE_FINGERPRINT);
    assert.notEqual(review.englishFingerprint, PRE_FAQ_ENGLISH_FINGERPRINT);
    assert.equal(review.ownerConfirmed, false);
    const reconfirmed = publicationManuscriptReview(confirmed(withFaq, jaWithFaq, review.japaneseFingerprint!, review.englishFingerprint!), TITLE);
    assert.equal(reconfirmed.ownerConfirmed, true);
    assert.equal(reconfirmed.publicContentReady, true);

    // A confirmation made before the FAQ was added no longer matches either manuscript.
    const stale = publicationManuscriptReview(confirmed(withFaq, jaWithFaq, PRE_FAQ_JAPANESE_FINGERPRINT, PRE_FAQ_ENGLISH_FINGERPRINT), TITLE);
    assert.equal(stale.ownerConfirmed, false);
    const editedAnswer = publicationManuscriptReview(confirmed({ ...withFaq, faq: [{ ...faq[0]!, answer: "From age 8." }, faq[1]!] }, jaWithFaq, review.japaneseFingerprint!, review.englishFingerprint!), TITLE);
    assert.equal(editedAnswer.ownerConfirmed, false);
    assert.equal(projectPublicExperiencePublication(publicRow(confirmed({ ...withFaq, faq: [faq[1]!, faq[0]!] }, jaWithFaq, review.japaneseFingerprint!, review.englishFingerprint!)))?.japanese, null);
  });

  it("rejects every unknown manuscript key other than the optional faq exactly as before (invariant c)", () => {
    assert.equal(validPublicationLocaleManuscript(japanese), true);
    assert.equal(validPublicationLocaleManuscript({ ...japanese, faq: faqJa }), true);
    assert.equal(validPublicationLocaleManuscript({ ...japanese, faqs: faqJa }), false);
    assert.equal(validPublicationLocaleManuscript({ ...japanese, private: "x" }), false);
    const missingRequired = Object.fromEntries(Object.entries(japanese).filter(([key]) => key !== "highlights"));
    assert.equal(validPublicationLocaleManuscript(missingRequired), false);
    assert.equal(validPublicationLocaleManuscript({ ...japanese, faq: [{ question: "Q", answer: "" }] }), false);
    const review = publicationManuscriptReview(confirmed(englishContent, { ...japanese, notes: "x" }, PRE_FAQ_JAPANESE_FINGERPRINT, PRE_FAQ_ENGLISH_FINGERPRINT), TITLE);
    assert.equal(review.japaneseFingerprint, null);
    assert.equal(review.publicContentReady, false);
    assert.equal(projectPublicExperiencePublication(publicRow(confirmed(englishContent, { ...japanese, notes: "x" }, PRE_FAQ_JAPANESE_FINGERPRINT, PRE_FAQ_ENGLISH_FINGERPRINT)))?.japanese, null);
  });
});

describe("publication FAQ public projection", () => {
  it("projects both manuscripts' FAQ in order, trimmed, and treats absent the same as empty", () => {
    const withFaq = { ...englishContent, faq: [{ question: "  Can children join? ", answer: "Yes, from age 6.\nAn adult joins too.  " }, faq[1]!] };
    const jaWithFaq = { ...japanese, faq: faqJa };
    const review = publicationManuscriptReview(confirmed(withFaq, jaWithFaq, "0".repeat(64), "0".repeat(64)), TITLE);
    const projected = projectPublicExperiencePublication(publicRow(confirmed(withFaq, jaWithFaq, review.japaneseFingerprint!, review.englishFingerprint!)));
    assert.deepEqual(projected?.content.faq, [{ question: "Can children join?", answer: "Yes, from age 6.\nAn adult joins too." }, faq[1]]);
    assert.deepEqual(projected?.japanese?.faq, faqJa);
    assert.deepEqual(projectPublicExperiencePublicationContent(englishContent)?.faq, []);
    assert.deepEqual(projectPublicExperiencePublicationContent({ ...englishContent, faq: [] })?.faq, []);
  });

  it("fails closed on a malformed stored FAQ and never exposes unknown row keys", () => {
    assert.equal(projectPublicExperiencePublicationContent({ ...englishContent, faq: "not-a-list" }), null);
    assert.equal(projectPublicExperiencePublicationContent({ ...englishContent, faq: [{ question: "Q", answer: "A", private: "x" }] }), null);
    assert.equal(projectPublicExperiencePublication(publicRow({ ...englishContent, faq: [{ question: "Q", answer: "" }] })), null);
  });
});

// 日本語を原文にした商品（#59）：英語の原稿・確認なしで公開でき、英語側には出ない。
describe("Japanese-only publication (#59)", () => {
  const emptyEnglish = {
    lead: "", description: "", facts: { language: "" }, highlights: [], included: [], notIncluded: [], knowBeforeYouGo: [], notSuitableFor: [], timeline: [],
    meetingOverview: null, meetingPointDisclosure: "AFTER_BOOKING", meetingPoint: null,
  };
  const jaOnly = (overrides: Record<string, unknown> = {}) => ({ ...emptyEnglish, japaneseOnly: true, ja: japanese, ...overrides });

  it("is publishable with no English and no confirmation, when the public title is the Japanese title", () => {
    const review = publicationManuscriptReview(jaOnly(), japanese.title);
    assert.equal(review.publicContentReady, true);
    assert.equal(review.ownerConfirmed, true);
    assert.equal(review.japaneseFingerprint, publicationManuscriptFingerprint(japanese));
    // The English slot of the admin review audit holds a fixed value, not a real English manuscript's fingerprint.
    assert.match(review.englishFingerprint ?? "", /^[0-9a-f]{64}$/);
    assert.notEqual(review.englishFingerprint, PRE_FAQ_ENGLISH_FINGERPRINT);
  });

  it("without the mark the same content still needs a confirmed English manuscript", () => {
    const review = publicationManuscriptReview({ ...emptyEnglish, ja: japanese }, japanese.title);
    assert.equal(review.ownerConfirmed, false);
  });

  it("is not ready when the public title differs from the Japanese title, or a required Japanese field is blank", () => {
    assert.equal(publicationManuscriptReview(jaOnly(), TITLE).publicContentReady, false);
    assert.equal(publicationManuscriptReview(jaOnly({ ja: { ...japanese, lead: "  " } }), japanese.title).publicContentReady, false);
    assert.equal(publicationManuscriptReview(jaOnly({ ja: { ...japanese, extra: 1 } }), japanese.title).publicContentReady, false);
    assert.equal(publicationManuscriptReview({ ...emptyEnglish, japaneseOnly: true }, japanese.title).publicContentReady, false);
  });

  it("projects the Japanese manuscript as the only one and marks the publication Japanese-only", () => {
    const projected = projectPublicExperiencePublication(publicRow(jaOnly()) as never);
    assert.equal(projected, null, "a public row whose title is English does not match the Japanese title");
    const row = { ...publicRow(jaOnly()), public_title: japanese.title };
    const publication = projectPublicExperiencePublication(row as never);
    assert.ok(publication);
    assert.equal(publication.japaneseOnly, true);
    assert.equal(publication.japanese?.title, japanese.title);
    assert.equal(publication.content.lead, "");
  });

  it("fails closed when the Japanese manuscript of a Japanese-only row is unreadable", () => {
    const row = { ...publicRow(jaOnly({ ja: { ...japanese, description: "" } })), public_title: japanese.title };
    assert.equal(projectPublicExperiencePublication(row as never), null);
  });

  it("keeps existing bilingual publications unchanged (japaneseOnly is false)", () => {
    const content = confirmed(englishContent, japanese, PRE_FAQ_JAPANESE_FINGERPRINT, PRE_FAQ_ENGLISH_FINGERPRINT);
    const publication = projectPublicExperiencePublication(publicRow(content) as never);
    assert.ok(publication);
    assert.equal(publication.japaneseOnly, false);
  });
});
