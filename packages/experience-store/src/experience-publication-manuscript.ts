import { createHash } from "node:crypto";

/**
 * The bilingual host manuscript rules shared by draft validation, OWNER/Admin
 * fingerprint review and the public projection.
 *
 * `faq` is the only optional manuscript key. A manuscript without it, or with an
 * empty list, is the same manuscript: the empty list never enters a fingerprint,
 * so confirmations recorded before FAQ existed keep their exact bytes.
 */

/** Same values as `EXPERIENCE_FAQ_LIMITS` in `@niho-experience/api-client` (the public renderer's limits). */
export const EXPERIENCE_PUBLICATION_FAQ_LIMITS = { maxItems: 30, questionMaxLength: 200, answerMaxLength: 1200 } as const;

export interface ExperiencePublicationFaqItem {
  readonly question: string;
  readonly answer: string;
}

export const PUBLICATION_MANUSCRIPT_LOCALE_KEYS = [
  "title", "lead", "description", "language", "highlights", "included", "notIncluded", "knowBeforeYouGo", "notSuitableFor", "timeline",
] as const;
export const PUBLICATION_MANUSCRIPT_OPTIONAL_KEYS = ["faq"] as const;

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Strict authoring rule for one FAQ list. Returns why it is unusable, or null.
 * Nothing is dropped silently: a blank, oversized, malformed or repeated row
 * (trimmed, case-insensitive, the same key the public renderer de-duplicates by)
 * rejects the whole list.
 */
export function publicationFaqIssue(value: unknown): string | null {
  if (!Array.isArray(value)) return "faq must be an array.";
  if (value.length > EXPERIENCE_PUBLICATION_FAQ_LIMITS.maxItems) return `faq must have at most ${EXPERIENCE_PUBLICATION_FAQ_LIMITS.maxItems} items.`;
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (!isRecord(item) || Object.keys(item).length !== 2 || !Object.hasOwn(item, "question") || !Object.hasOwn(item, "answer")) {
      return `faq[${index}] must contain only question and answer.`;
    }
    if (typeof item.question !== "string" || typeof item.answer !== "string") return `faq[${index}] question and answer must be strings.`;
    const question = item.question.trim();
    if (!question || !item.answer.trim()) return `faq[${index}] question and answer must not be empty.`;
    if (item.question.length > EXPERIENCE_PUBLICATION_FAQ_LIMITS.questionMaxLength) return `faq[${index}].question is too long.`;
    if (item.answer.length > EXPERIENCE_PUBLICATION_FAQ_LIMITS.answerMaxLength) return `faq[${index}].answer is too long.`;
    const key = question.toLowerCase();
    if (seen.has(key)) return `faq[${index}].question repeats an earlier question.`;
    seen.add(key);
  }
  return null;
}

/** Public copy of a valid FAQ: absent and empty are both no FAQ; a malformed list fails closed (null). */
export function projectPublicationFaq(value: unknown): readonly ExperiencePublicationFaqItem[] | null {
  if (value === undefined) return [];
  if (publicationFaqIssue(value) !== null) return null;
  return (value as readonly { question: string; answer: string }[]).map((item) => ({ question: item.question.trim(), answer: item.answer.trim() }));
}

const emptyList = (value: unknown): boolean => Array.isArray(value) && value.length === 0;

/** Exactly the required locale keys plus, optionally, `faq`. Anything else stays rejected. */
export function hasPublicationManuscriptKeys(value: UnknownRecord): boolean {
  const allowed: readonly string[] = [...PUBLICATION_MANUSCRIPT_LOCALE_KEYS, ...PUBLICATION_MANUSCRIPT_OPTIONAL_KEYS];
  return Object.keys(value).every((key) => allowed.includes(key))
    && PUBLICATION_MANUSCRIPT_LOCALE_KEYS.every((key) => Object.hasOwn(value, key));
}

export function validPublicationLocaleManuscript(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !hasPublicationManuscriptKeys(value)) return false;
  for (const key of ["title", "lead", "description", "language"] as const) {
    const text = value[key];
    if (typeof text !== "string" || text.length > (key === "description" ? 8_000 : 1_000)) return false;
  }
  for (const key of ["highlights", "included", "notIncluded", "knowBeforeYouGo", "notSuitableFor"] as const) {
    const list = value[key];
    if (!Array.isArray(list) || list.length > 30 || list.some((item) => typeof item !== "string" || item.length > 1_000)) return false;
  }
  const timeline = value.timeline;
  if (!Array.isArray(timeline) || timeline.length > 20 || timeline.some((item) => !isRecord(item)
    || Object.keys(item).length !== 4 || !["time", "title", "text", "photoIndex"].every((key) => Object.hasOwn(item, key))
    || typeof item.time !== "string" || item.time.length > 80
    || typeof item.title !== "string" || item.title.length > 200
    || typeof item.text !== "string" || item.text.length > 1_000
    || (item.photoIndex !== null && (!Number.isSafeInteger(item.photoIndex) || Number(item.photoIndex) < 0)))) return false;
  return value.faq === undefined || publicationFaqIssue(value.faq) === null;
}

/**
 * The English manuscript as fingerprinted: the public title plus top-level
 * content. `faq` is added only when it is present and not an empty list, so a
 * pre-FAQ manuscript produces exactly the same object as before.
 */
export function englishPublicationManuscriptOf(title: unknown, content: UnknownRecord): Record<string, unknown> {
  return {
    title,
    lead: content.lead,
    description: content.description,
    language: isRecord(content.facts) ? content.facts.language ?? null : null,
    highlights: content.highlights,
    included: content.included,
    notIncluded: content.notIncluded,
    knowBeforeYouGo: content.knowBeforeYouGo,
    notSuitableFor: content.notSuitableFor,
    timeline: content.timeline,
    ...(content.faq === undefined || emptyList(content.faq) ? {} : { faq: content.faq }),
  };
}

/** A locale manuscript without an empty `faq`, the form every fingerprint is computed over. */
export function fingerprintablePublicationManuscript(value: unknown): unknown {
  if (!isRecord(value) || !Object.hasOwn(value, "faq") || !emptyList(value.faq)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "faq"));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** sha256 of the canonical JSON of a whole stored content snapshot, without any normalisation. */
export function publicationContentFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** sha256 of the canonical JSON of a locale manuscript, with an empty `faq` treated as absent. */
export function publicationManuscriptFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(fingerprintablePublicationManuscript(value)), "utf8").digest("hex");
}
