import { publicationFaqProblem, publicationFaqRows } from "./publication-faq";

type Manuscripts = {
  readonly japanese: Readonly<Record<string, unknown>>;
  readonly english: Readonly<Record<string, unknown>>;
};

export function canonicalPublicationJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalPublicationJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalPublicationJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function englishPublicationManuscript(title: string, content: Record<string, unknown>): Record<string, unknown> {
  const facts = content.facts !== null && typeof content.facts === "object" ? content.facts as Record<string, unknown> : null;
  return {
    title, lead: content.lead, description: content.description, language: facts?.language ?? null,
    highlights: content.highlights, included: content.included, notIncluded: content.notIncluded,
    knowBeforeYouGo: content.knowBeforeYouGo, notSuitableFor: content.notSuitableFor, timeline: content.timeline,
    // Same rule as the server: an absent or empty FAQ is not part of the manuscript fingerprint.
    ...(content.faq === undefined || isEmptyList(content.faq) ? {} : { faq: content.faq }),
  };
}

const isEmptyList = (value: unknown): boolean => Array.isArray(value) && value.length === 0;

/** Drops an empty `faq` so a manuscript written before FAQ existed keeps its exact fingerprint. */
export function fingerprintablePublicationManuscript(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!Object.hasOwn(record, "faq") || !isEmptyList(record.faq)) return value;
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== "faq"));
}

async function fingerprint(value: unknown): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalPublicationJson(fingerprintablePublicationManuscript(value))));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The OWNER confirms the current copy, whether entered manually or produced by translation. */
export async function confirmPublicationEnglish(readCurrent: () => Manuscripts) {
  const manuscripts = readCurrent();
  for (const manuscript of [manuscripts.japanese, manuscripts.english]) {
    if (["title", "lead", "description", "language"].some((key) => typeof manuscript[key] !== "string" || !manuscript[key].trim())) {
      throw new Error("日本語と英語の商品名・紹介文・説明・当日の言語を入力してから確認してください。");
    }
  }
  const faqProblem = publicationFaqProblem(publicationFaqRows(manuscripts.japanese.faq), "日本語")
    ?? publicationFaqProblem(publicationFaqRows(manuscripts.english.faq), "英語");
  if (faqProblem) throw new Error(faqProblem);
  const snapshot = canonicalPublicationJson(manuscripts);
  const [sourceFingerprint, confirmedEnglishFingerprint] = await Promise.all([
    fingerprint(manuscripts.japanese), fingerprint(manuscripts.english),
  ]);
  if (canonicalPublicationJson(readCurrent()) !== snapshot) {
    throw new Error("確認中に原稿が変更されました。日英の内容を照合し、もう一度確認してください。");
  }
  return { sourceFingerprint, confirmedSourceFingerprint: sourceFingerprint, confirmedEnglishFingerprint };
}
