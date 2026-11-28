import { StoreValidationError } from "./errors.ts";

/*
 * The name a host registering by themselves puts on their public page (Epic #700, #707). The shape is Admin's rule for a
 * provider's public name (migration 0069/0081: 1-300 characters, nothing blank at either end, no control character); on top
 * of it a name may not pose as NIHO or its staff. Admin's own path does not use the reserved words: it registers NIHO's
 * own hosts (NIHO kamakura) by hand.
 */

export const PROVIDER_PUBLIC_NAME_MAX = 300;

export type ProviderPublicNameProblem = "PUBLIC_NAME_INVALID" | "PUBLIC_NAME_RESERVED";

/** A name the page may not show; `code` lets the web layer say which, `field` which of the two names. */
export class ProviderPublicNameError extends StoreValidationError {
  readonly code: ProviderPublicNameProblem;
  readonly field: string;

  constructor(code: ProviderPublicNameProblem, field: string, message: string) {
    super(message);
    this.code = code;
    this.field = field;
  }
}

const CONTROL = /[\u0000-\u001f\u007f]/;
/** `niho` as a word: not inside a longer run of letters or digits (Nihonbashi is a place), but NIHO公式 and niho-travel are. */
const NIHO_WORD = /(?<![a-z0-9])niho(?![a-z0-9])/;
const OFFICE_WORD = "事務局";

/** The shape every public name has (Admin's rule), apart from the reserved words. */
export function isProviderPublicName(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= PROVIDER_PUBLIC_NAME_MAX && value === value.trim() && !CONTROL.test(value);
}

/** Whether the name poses as NIHO or its staff, after NFKC (full-width letters) and lower-casing. */
export function isReservedProviderPublicName(value: string): boolean {
  const folded = value.normalize("NFKC").toLowerCase();
  return NIHO_WORD.test(folded) || folded.includes(OFFICE_WORD);
}

/** The name as given, or ProviderPublicNameError. `field` names it in the error. */
export function assertSelfRegistrationPublicName(value: unknown, field: string): string {
  if (!isProviderPublicName(value)) {
    throw new ProviderPublicNameError("PUBLIC_NAME_INVALID", field, `${field} must be 1-${PROVIDER_PUBLIC_NAME_MAX} characters with no space at either end and no control character.`);
  }
  if (isReservedProviderPublicName(value)) {
    throw new ProviderPublicNameError("PUBLIC_NAME_RESERVED", field, `${field} may not use a name reserved for NIHO (NIHO, 事務局).`);
  }
  return value;
}
