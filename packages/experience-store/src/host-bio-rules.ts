import { StoreValidationError } from "./errors.ts";

/*
 * ホスト紹介文 (bio, #146) rules shared by the DB CHECK (migration 0062), the Store, the host API,
 * the translation route and the host form. This module has no Node or database dependency, so the
 * browser form can import it through the `@niho-experience/experience-store/host-bio-rules` subpath.
 */

/** Characters (Unicode code points, as PostgreSQL char_length counts them). */
export const HOST_BIO_LIMITS = Object.freeze({ ja: 600, en: 1500 });
/** The wording the OWNER agrees to on the host form. A new wording needs a new version. */
export const HOST_BIO_CONSENT_VERSION = "host-bio-consent-v1";

/** Control characters other than LF (normalization turns CR into LF first). C1 controls are rejected too. */
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/;

/** Unicode code points, matching PostgreSQL char_length. */
export function hostBioLength(value: string): number {
  return [...value].length;
}

/** CRLF/CR → LF, surrounding whitespace removed, and at most two consecutive line breaks (one blank line). */
export function normalizeHostBioText(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim().replace(/\n{3,}/g, "\n\n");
}

export type HostBioTextIssue = "EMPTY" | "TOO_LONG" | "CONTROL";

/** Why a (normalized) bio text cannot be saved, or null when it can. */
export function hostBioTextIssue(normalized: string, locale: "ja" | "en"): HostBioTextIssue | null {
  if (normalized.length === 0) return "EMPTY";
  if (CONTROL.test(normalized)) return "CONTROL";
  if (hostBioLength(normalized) > HOST_BIO_LIMITS[locale]) return "TOO_LONG";
  return null;
}

/** Normalize and validate one bio text. Never fills in or shortens a value. */
export function validateHostBioText(value: unknown, locale: "ja" | "en"): string {
  if (typeof value !== "string") throw new StoreValidationError(`bio_${locale} must be text.`);
  const normalized = normalizeHostBioText(value);
  const issue = hostBioTextIssue(normalized, locale);
  if (issue) throw new StoreValidationError(`bio_${locale} is invalid (${issue}).`);
  return normalized;
}

export type HostBioInput = {
  readonly bioJa: string;
  /** null means no English is published (not confirmed, or never written). */
  readonly bioEn: string | null;
  readonly consentVersion: string;
};

/** Store-level validation of one save. The English source fingerprint is computed by the Store, never accepted. */
export function validateHostBioInput(input: HostBioInput): HostBioInput {
  if (input.consentVersion !== HOST_BIO_CONSENT_VERSION) throw new StoreValidationError("consentVersion is not the current host bio consent.");
  const bioJa = validateHostBioText(input.bioJa, "ja");
  const bioEn = input.bioEn === null ? null : validateHostBioText(input.bioEn, "en");
  return { bioJa, bioEn, consentVersion: input.consentVersion };
}
