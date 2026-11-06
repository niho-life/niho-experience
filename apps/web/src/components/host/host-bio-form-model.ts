import {
  HOST_BIO_LIMITS,
  hostBioLength,
  hostBioTextIssue,
  normalizeHostBioText,
} from "@niho-experience/experience-store/host-bio-rules";

/* ホスト紹介 (#146) form rules, kept apart from the component so they can be tested without a browser. */

export type HostBioState = {
  readonly version: number;
  readonly bioJa: string | null;
  readonly bioEn: string | null;
  readonly englishConfirmed: boolean;
  readonly consentVersion: string | null;
  readonly updatedAtUtc: string | null;
};

export type HostBioLoad = { readonly hostBio: HostBioState; readonly consentVersion: string };

export type HostBioDraft = {
  readonly bioJa: string;
  readonly bioEn: string;
  /** 「英語を確認しました」. Only a checked, valid English text is sent and published. */
  readonly englishChecked: boolean;
};

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: JsonObject, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const nullableText = (value: unknown): value is string | null => value === null || (typeof value === "string" && value.length > 0);
const instant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export function parseHostBioState(value: unknown): HostBioState | null {
  if (!isObject(value) || !exactKeys(value, ["version", "bioJa", "bioEn", "englishConfirmed", "consentVersion", "updatedAtUtc"])) return null;
  if (!Number.isSafeInteger(value.version) || Number(value.version) < 0 || typeof value.englishConfirmed !== "boolean"
    || !nullableText(value.bioJa) || !nullableText(value.bioEn) || !nullableText(value.consentVersion)) return null;
  if (value.version === 0) {
    return value.bioJa === null && value.bioEn === null && value.englishConfirmed === false && value.consentVersion === null && value.updatedAtUtc === null
      ? value as HostBioState : null;
  }
  if (value.bioJa === null || value.consentVersion === null || !instant(value.updatedAtUtc) || (value.englishConfirmed && value.bioEn === null)) return null;
  return value as HostBioState;
}

export function parseHostBioLoad(value: unknown): HostBioLoad | null {
  if (!isObject(value) || !exactKeys(value, ["hostBio", "consentVersion"]) || typeof value.consentVersion !== "string") return null;
  const hostBio = parseHostBioState(value.hostBio);
  return hostBio ? { hostBio, consentVersion: value.consentVersion } : null;
}

/** The form's starting text: the saved bio, with the English check only while the saved English is published. */
export function draftFromState(state: HostBioState): HostBioDraft {
  return { bioJa: state.bioJa ?? "", bioEn: state.bioEn ?? "", englishChecked: state.englishConfirmed };
}

/** A changed Japanese text takes the English confirmation away: the English must be checked again. */
export function withJapanese(draft: HostBioDraft, bioJa: string): HostBioDraft {
  return bioJa === draft.bioJa ? draft : { ...draft, bioJa, englishChecked: false };
}

export type HostBioCount = { readonly length: number; readonly limit: number; readonly remaining: number; readonly over: boolean };

/** The counter counts what is saved (normalized, in code points like the database). */
export function hostBioCount(text: string, locale: "ja" | "en"): HostBioCount {
  const length = hostBioLength(normalizeHostBioText(text));
  const limit = HOST_BIO_LIMITS[locale];
  return { length, limit, remaining: limit - length, over: length > limit };
}

/** A Japanese message for a text that cannot be saved, or null. Empty is not an error until the host saves. */
export function hostBioFieldError(text: string, locale: "ja" | "en"): string | null {
  const issue = hostBioTextIssue(normalizeHostBioText(text), locale);
  if (issue === "TOO_LONG") return `${HOST_BIO_LIMITS[locale]}文字以内にしてください（現在${hostBioCount(text, locale).length}文字）。`;
  if (issue === "CONTROL") return "使えない制御文字が含まれています。文章を貼り直してください。";
  return null;
}

export const englishSendable = (draft: HostBioDraft): boolean => draft.englishChecked && hostBioTextIssue(normalizeHostBioText(draft.bioEn), "en") === null;

export function canSaveHostBio(draft: HostBioDraft, consented: boolean, locked: boolean): boolean {
  if (locked || !consented) return false;
  if (hostBioTextIssue(normalizeHostBioText(draft.bioJa), "ja") !== null) return false;
  return !draft.englishChecked || englishSendable(draft);
}

/** The PUT body. English is sent only when the host checked it; otherwise no English is published. */
export function hostBioSaveBody(draft: HostBioDraft, state: HostBioState, consentVersion: string) {
  return {
    bioJa: draft.bioJa,
    bioEn: englishSendable(draft) ? draft.bioEn : null,
    expectedVersion: state.version === 0 ? null : state.version,
    consentVersion,
  };
}

/** What the saved state publishes, in the host's words. */
export function hostBioPublicationNote(state: HostBioState): string {
  if (state.version === 0) return "ホスト紹介はまだ公開されていません。";
  if (state.englishConfirmed) return "日本語と英語のホスト紹介を公開しています。";
  if (state.bioEn !== null) return "日本語を公開しています。英語は日本語の変更後に確認されていないため、まだ公開されていません。";
  return "日本語を公開しています。英語はまだ公開されていません。";
}

export type HostBioMutationOutcome =
  | { readonly kind: "CONFIRMED"; readonly state: HostBioState }
  | { readonly kind: "AUTH_REJECTED" }
  | { readonly kind: "CONFLICT" }
  | { readonly kind: "REJECTED" }
  /** Network failure, 5xx or an unreadable body: the save may or may not have happened. */
  | { readonly kind: "UNKNOWN" };

export function hostBioMutationOutcome(status: number, value: unknown): HostBioMutationOutcome {
  if (status === 200) {
    const state = isObject(value) && exactKeys(value, ["hostBio"]) ? parseHostBioState(value.hostBio) : null;
    return state ? { kind: "CONFIRMED", state } : { kind: "UNKNOWN" };
  }
  if (status === 401 || status === 403) return { kind: "AUTH_REJECTED" };
  if (status === 409) return { kind: "CONFLICT" };
  if (status === 400 || status === 413 || status === 422) return { kind: "REJECTED" };
  return { kind: "UNKNOWN" };
}

export type HostBioTranslationOutcome =
  | { readonly kind: "DRAFT"; readonly bioEn: string }
  | { readonly kind: "AUTH_REJECTED" }
  | { readonly kind: "FAILED" };

export function hostBioTranslationOutcome(status: number, value: unknown): HostBioTranslationOutcome {
  if (status === 401 || status === 403) return { kind: "AUTH_REJECTED" };
  if (status !== 200 || !isObject(value) || !exactKeys(value, ["bioEn"]) || typeof value.bioEn !== "string") return { kind: "FAILED" };
  return hostBioTextIssue(normalizeHostBioText(value.bioEn), "en") === null ? { kind: "DRAFT", bioEn: value.bioEn } : { kind: "FAILED" };
}

/** After an unknown result, the re-read tells whether the host's text was saved. */
export function savedMatchesDraft(state: HostBioState, draft: HostBioDraft): boolean {
  if (state.bioJa !== normalizeHostBioText(draft.bioJa)) return false;
  const english = englishSendable(draft) ? normalizeHostBioText(draft.bioEn) : null;
  return english === null ? state.bioEn === null : state.englishConfirmed && state.bioEn === english;
}
