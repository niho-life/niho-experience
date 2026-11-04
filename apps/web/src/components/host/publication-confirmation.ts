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
  };
}

async function fingerprint(value: unknown): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalPublicationJson(value)));
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
  const snapshot = canonicalPublicationJson(manuscripts);
  const [sourceFingerprint, confirmedEnglishFingerprint] = await Promise.all([
    fingerprint(manuscripts.japanese), fingerprint(manuscripts.english),
  ]);
  if (canonicalPublicationJson(readCurrent()) !== snapshot) {
    throw new Error("確認中に原稿が変更されました。日英の内容を照合し、もう一度確認してください。");
  }
  return { sourceFingerprint, confirmedSourceFingerprint: sourceFingerprint, confirmedEnglishFingerprint };
}
