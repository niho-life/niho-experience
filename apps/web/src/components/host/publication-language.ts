import { englishIsConfirmed } from "./publication-confirmation";

/**
 * 英語と日本語のずれ: the draft remembers the Japanese manuscript the English was last made level with
 * (`content.languageSync.englishSourceFingerprint`). When the Japanese moves on, the host is told; publishing is not held back.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The remembered Japanese fingerprint. A draft without it counts the confirmed translation's source, or nothing (""). Reading never changes the draft. */
export function readEnglishSourceFingerprint(content: Record<string, unknown>): string {
  const sync = content.languageSync;
  if (isRecord(sync) && typeof sync.englishSourceFingerprint === "string") return sync.englishSourceFingerprint;
  const translation = content.translation;
  return isRecord(translation) && englishIsConfirmed(translation) && typeof translation.sourceFingerprint === "string" ? translation.sourceFingerprint : "";
}

export function withEnglishSourceFingerprint<T extends Record<string, unknown>>(content: T, fingerprint: string): T {
  return { ...content, languageSync: { englishSourceFingerprint: fingerprint } };
}

/** Whether a manuscript has anything written (title, lead or description). */
export function manuscriptHasContent(manuscript: { readonly title?: unknown; readonly lead?: unknown; readonly description?: unknown }): boolean {
  return [manuscript.title, manuscript.lead, manuscript.description].some((value) => typeof value === "string" && value.trim().length > 0);
}

/** The English no longer follows the Japanese: both are written and the remembered fingerprint is not the Japanese one now. */
export function publicationLanguageOutOfSync(input: {
  readonly japaneseOnly: boolean;
  readonly japaneseWritten: boolean;
  readonly englishWritten: boolean;
  readonly remembered: string;
  /** null while the current fingerprint is still being computed: nothing is said yet. */
  readonly current: string | null;
}): boolean {
  return !input.japaneseOnly && input.japaneseWritten && input.englishWritten && input.current !== null && input.remembered !== input.current;
}

/** What the saved draft remembers (always written): level now, so the current Japanese; out of step, so what it held before (possibly ""). */
export function savedEnglishSourceFingerprint(input: { readonly outOfSync: boolean; readonly remembered: string; readonly current: string }): string {
  return input.outOfSync ? input.remembered : input.current;
}

/** Rows saved as the host typed them, without the empty ones. */
export function withoutEmptyRows(rows: readonly string[]): string[] {
  return rows.filter((row) => row.trim().length > 0);
}
