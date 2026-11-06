import { EXPERIENCE_FAQ_LIMITS } from "@niho-experience/api-client";

/**
 * Editor helpers for the optional publication FAQ (#146). The stored manuscript keeps rows exactly as typed;
 * the server rejects (never drops) a blank, oversized or repeated row, so the editor names the problem first.
 */
export type PublicationFaqRow = { question: string; answer: string };

export const PUBLICATION_FAQ_LIMITS = EXPERIENCE_FAQ_LIMITS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rows to edit. A stored row that is not a question/answer pair is shown as text so nothing disappears on load. */
export function publicationFaqRows(value: unknown): PublicationFaqRow[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => isRecord(item)
    ? { question: typeof item.question === "string" ? item.question : "", answer: typeof item.answer === "string" ? item.answer : "" }
    : { question: "", answer: "" });
}

/** The record with `faq` set to the rows, or without the key when there are none (an empty FAQ is never stored). */
export function withPublicationFaq<T extends Record<string, unknown>>(record: T, rows: readonly PublicationFaqRow[]): T {
  if (rows.length) return { ...record, faq: rows.map((row) => ({ question: row.question, answer: row.answer })) };
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== "faq")) as T;
}

/** The first problem the server would reject, in the console's words, or null. `label` names the manuscript (日本語/英語). */
export function publicationFaqProblem(rows: readonly PublicationFaqRow[], label: string): string | null {
  if (rows.length > PUBLICATION_FAQ_LIMITS.maxItems) return `${label}のよくある質問は${PUBLICATION_FAQ_LIMITS.maxItems}件までです。`;
  const seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const at = `${label}のよくある質問${index + 1}件目`;
    const question = row.question.trim();
    if (!question || !row.answer.trim()) return `${at}の質問と答えを入力するか、行を削除してください。`;
    if (row.question.length > PUBLICATION_FAQ_LIMITS.questionMaxLength) return `${at}の質問は${PUBLICATION_FAQ_LIMITS.questionMaxLength}文字以内にしてください。`;
    if (row.answer.length > PUBLICATION_FAQ_LIMITS.answerMaxLength) return `${at}の答えは${PUBLICATION_FAQ_LIMITS.answerMaxLength}文字以内にしてください。`;
    const key = question.toLowerCase();
    if (seen.has(key)) return `${at}の質問が前の質問と同じです。`;
    seen.add(key);
  }
  return null;
}

/** Problems in both manuscripts of a draft content object (Japanese first, as the host writes it first). */
export function publicationContentFaqProblem(content: Record<string, unknown>): string | null {
  const japanese = isRecord(content.ja) ? content.ja.faq : undefined;
  return publicationFaqProblem(publicationFaqRows(japanese), "日本語")
    ?? publicationFaqProblem(publicationFaqRows(content.faq), "英語");
}
