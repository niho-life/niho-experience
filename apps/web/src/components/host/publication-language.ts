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

/* ── 掲載言語 (英語／日本語、1つ以上) ── */
export type PublicationListing = { readonly en: boolean; readonly ja: boolean };

/** A manuscript with nothing written: what `content.ja` is while the page is English-only. */
export const BLANK_JAPANESE_MANUSCRIPT = {
  title: "", lead: "", description: "", language: "", highlights: [], included: [], notIncluded: [], knowBeforeYouGo: [], notSuitableFor: [], timeline: [],
} as const;

/** The languages a draft is published in: `japaneseOnly` is Japanese only, `englishOnly` English only, neither is both. */
export function publicationListing(content: Record<string, unknown>): PublicationListing {
  if (content.japaneseOnly === true) return { en: false, ja: true };
  if (content.englishOnly === true) return { en: true, ja: false };
  return { en: true, ja: true };
}

/** The English title the editor shows: kept in `enTitleDraft` while the page is Japanese-only (its public title is the Japanese one). */
export function publicationEnglishTitle(content: Record<string, unknown>, title: string): string {
  return content.japaneseOnly === true ? (typeof content.enTitleDraft === "string" ? content.enTitleDraft : "") : title;
}

function without(content: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(content).filter(([key]) => !keys.includes(key)));
}

const NO_CONFIRMATION = { sourceFingerprint: null, confirmedSourceFingerprint: null };

/** Back to both languages: nothing is lost, the unlisted language's draft returns to its place. */
function toBoth(content: Record<string, unknown>, title: string): { content: Record<string, unknown>; title: string } {
  if (content.englishOnly === true) {
    const draft = content.jaDraft;
    const ja = typeof draft === "object" && draft !== null && !Array.isArray(draft) ? draft : content.ja;
    return { content: { ...without(content, "englishOnly", "jaDraft"), ja, translation: NO_CONFIRMATION }, title };
  }
  if (content.japaneseOnly === true) {
    const restored = typeof content.enTitleDraft === "string" && content.enTitleDraft.trim() ? content.enTitleDraft : title;
    return { content: { ...without(content, "japaneseOnly", "enTitleDraft"), translation: NO_CONFIRMATION }, title: restored };
  }
  return { content, title };
}

/**
 * Changes the listing without deleting anything: the language that is no longer published keeps its draft
 * (`jaDraft` while English-only, the English body and `enTitleDraft` while Japanese-only). Choosing no language changes nothing.
 */
export function withPublicationListing(input: { content: Record<string, unknown>; title: string }, next: PublicationListing): { content: Record<string, unknown>; title: string } {
  if (!next.en && !next.ja) return input;
  const both = toBoth(input.content, input.title);
  if (next.en && next.ja) return both;
  const { content, title } = both;
  if (next.en) {
    const ja = typeof content.ja === "object" && content.ja !== null && !Array.isArray(content.ja) ? content.ja : BLANK_JAPANESE_MANUSCRIPT;
    return { content: { ...content, jaDraft: ja, ja: BLANK_JAPANESE_MANUSCRIPT, englishOnly: true, translation: NO_CONFIRMATION }, title };
  }
  const ja = content.ja as { title?: unknown } | undefined;
  return { content: { ...content, japaneseOnly: true, enTitleDraft: title, translation: NO_CONFIRMATION }, title: typeof ja?.title === "string" && ja.title ? ja.title : title };
}

/* ── ずれの知らせ (英語と日本語の両方を掲載するとき) ── */
export type LanguageSyncSource = "ja" | "en";

/**
 * The language the other one follows ("もと") and the fingerprint of it the other was last made level with.
 * `{ japaneseSourceFingerprint }` means the English is the source; `{ englishSourceFingerprint }`, or no key
 * (then the confirmed translation's source, or ""), means the Japanese is.
 */
export function readLanguageSync(content: Record<string, unknown>): { source: LanguageSyncSource; remembered: string; hasKey: boolean } {
  const sync = content.languageSync;
  if (isRecord(sync) && typeof sync.japaneseSourceFingerprint === "string") return { source: "en", remembered: sync.japaneseSourceFingerprint, hasKey: true };
  if (isRecord(sync) && typeof sync.englishSourceFingerprint === "string") return { source: "ja", remembered: sync.englishSourceFingerprint, hasKey: true };
  return { source: "ja", remembered: readEnglishSourceFingerprint(content), hasKey: false };
}

/** The draft remembers exactly one of the two keys. */
export function withLanguageSync<T extends Record<string, unknown>>(content: T, source: LanguageSyncSource, fingerprint: string): T {
  return { ...content, languageSync: source === "ja" ? { englishSourceFingerprint: fingerprint } : { japaneseSourceFingerprint: fingerprint } };
}

/** The language whose tab is told that it did not follow a change in the source. */
export const languageSyncFollower = (source: LanguageSyncSource): "en" | "ja" => (source === "ja" ? "en" : "ja");

/** Out of step: both languages are published and written, and the source is not the version the other was made level with. */
export function languageSyncOutOfSync(input: {
  readonly listing: PublicationListing;
  readonly japaneseWritten: boolean;
  readonly englishWritten: boolean;
  readonly remembered: string;
  /** The source language's fingerprint now; null while it is being computed. */
  readonly current: string | null;
}): boolean {
  return publicationLanguageOutOfSync({ japaneseOnly: !(input.listing.en && input.listing.ja), japaneseWritten: input.japaneseWritten, englishWritten: input.englishWritten, remembered: input.remembered, current: input.current });
}

/**
 * The `languageSync` a save writes (both languages published only). The source stays the one the draft names; a draft with no key
 * and no Japanese but an English draft takes the English as the source. Level now: the source's current fingerprint; out of step: what it held.
 */
export function savedLanguageSync(input: {
  readonly content: Record<string, unknown>;
  readonly japaneseWritten: boolean;
  readonly englishWritten: boolean;
  readonly japaneseFingerprint: string;
  readonly englishFingerprint: string;
}): { source: LanguageSyncSource; fingerprint: string } {
  const read = readLanguageSync(input.content);
  const source: LanguageSyncSource = !read.hasKey && !input.japaneseWritten && input.englishWritten ? "en" : read.source;
  const current = source === "ja" ? input.japaneseFingerprint : input.englishFingerprint;
  const outOfSync = languageSyncOutOfSync({ listing: { en: true, ja: true }, japaneseWritten: input.japaneseWritten, englishWritten: input.englishWritten, remembered: read.remembered, current });
  return { source, fingerprint: savedEnglishSourceFingerprint({ outOfSync, remembered: read.remembered, current }) };
}

type AltItem = { readonly altText: string; readonly altTextJa: string };

/** A language that is not published may have no photo description: it takes the published language's, so the upload API's both-required rule holds. Same array when nothing changes. */
export function fillUnlistedAlt<T extends AltItem>(items: readonly T[], listing: PublicationListing): readonly T[] {
  if (listing.en && listing.ja) return items;
  const needs = items.some((item) => (listing.en ? !item.altTextJa.trim() && item.altText.trim() : !item.altText.trim() && item.altTextJa.trim()));
  if (!needs) return items;
  return items.map((item) => {
    if (listing.en && !item.altTextJa.trim() && item.altText.trim()) return { ...item, altTextJa: item.altText };
    if (listing.ja && !item.altText.trim() && item.altTextJa.trim()) return { ...item, altText: item.altTextJa };
    return item;
  });
}
