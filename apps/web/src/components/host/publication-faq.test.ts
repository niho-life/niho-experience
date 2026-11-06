import { describe, expect, it } from "vitest";
import { EXPERIENCE_FAQ_LIMITS } from "@niho-experience/api-client";
import { EXPERIENCE_PUBLICATION_FAQ_LIMITS, publicationFaqIssue } from "@niho-experience/experience-store";
import { PUBLICATION_FAQ_LIMITS, publicationContentFaqProblem, publicationFaqProblem, publicationFaqRows, withPublicationFaq } from "./publication-faq";

const row = (question: string, answer = "Answer.") => ({ question, answer });

describe("publication FAQ editor helpers", () => {
  it("uses the public renderer's limits, which are also the store's authoring limits", () => {
    expect(PUBLICATION_FAQ_LIMITS).toEqual(EXPERIENCE_FAQ_LIMITS);
    expect(EXPERIENCE_PUBLICATION_FAQ_LIMITS).toEqual(EXPERIENCE_FAQ_LIMITS);
  });

  it("reads stored rows for editing without losing a row, and nothing from a non-list", () => {
    expect(publicationFaqRows(undefined)).toEqual([]);
    expect(publicationFaqRows("Q: A")).toEqual([]);
    expect(publicationFaqRows([row("Q1", "A1"), { question: 3 }, null])).toEqual([row("Q1", "A1"), row("", ""), row("", "")]);
  });

  it("stores rows as the faq key and removes the key entirely when the last row is deleted", () => {
    const manuscript = { title: "合成", highlights: [] as string[] };
    expect(withPublicationFaq(manuscript, [row("Q")])).toEqual({ ...manuscript, faq: [row("Q")] });
    const removed = withPublicationFaq({ ...manuscript, faq: [row("Q")] }, []);
    expect(removed).toEqual(manuscript);
    expect(Object.hasOwn(removed, "faq")).toBe(false);
  });

  it("names the same problems the server rejects, so a save never fails silently", () => {
    const cases = [
      [[row("Q", " ")], "1件目の質問と答えを入力するか"],
      [[row("  ")], "1件目の質問と答えを入力するか"],
      [[row("q".repeat(201))], "質問は200文字以内"],
      [[row("Q", "a".repeat(1201))], "答えは1200文字以内"],
      [[row("Is it held in rain?"), row(" is it held in RAIN?")], "2件目の質問が前の質問と同じ"],
      [Array.from({ length: 31 }, (_, index) => row(`Q${index}`)), "30件まで"],
    ] as const;
    for (const [rows, message] of cases) {
      expect(publicationFaqProblem(rows, "日本語")).toContain(message);
      expect(publicationFaqIssue(rows)).not.toBeNull();
    }
    const valid = [row("Q1"), row("q".repeat(200), "a".repeat(1200))];
    expect(publicationFaqProblem(valid, "英語")).toBeNull();
    expect(publicationFaqIssue(valid)).toBeNull();
    expect(publicationFaqProblem([], "英語")).toBeNull();
  });

  it("checks the Japanese FAQ first, then the English one", () => {
    expect(publicationContentFaqProblem({})).toBeNull();
    expect(publicationContentFaqProblem({ faq: [row("")], ja: { faq: [row("")] } })).toMatch(/^日本語/);
    expect(publicationContentFaqProblem({ faq: [row("")], ja: { faq: [row("質問")] } })).toMatch(/^英語/);
  });
});
