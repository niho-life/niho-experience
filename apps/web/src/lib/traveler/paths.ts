import { NIHO_CONNECT_METHODS, type NihoConnectMethod } from "@/lib/host/niho-auth";

/**
 * 旅行者のアカウント (Epic #591, #597): where a traveler logs in and where they are afterwards. The site is English (there is
 * no /en prefix); the Japanese site's entrance is not decided yet (the order of the ways in is the owner's).
 */
export const TRAVELER_SIGN_IN_PATH = "/account/sign-in";
export const TRAVELER_HOME_PATH = "/account";
/** The form of the entrance posts here (`method=google|line`, or no method for an existing NIHO account). */
export const TRAVELER_START_PATH = "/account/auth/start";
export const TRAVELER_LOGOUT_PATH = "/account/auth/logout";
/** Preview only (mock mode): a synthetic traveler signs in. */
export const TRAVELER_MOCK_LOGIN_PATH = "/account/auth/mock-login";

/**
 * The ways in the entrance always offers, in the order NIHO uses for travelers (Google, Apple, LINE). Apple has no web sign-in at
 * NIHO yet (niho-coliving/niho-app#20307): pressing it would drop the traveler into NIHO's usual screen, which is what the
 * entrance is there to avoid, so it is not offered until NIHO has it. `method=apple` is still understood end to end.
 *
 * LINE is not here: it is offered only while EXPERIENCE_TRAVELER_LINE_ENABLED is on (travelerMethodsOffered), which waits for the
 * move of NIHO's LINE provider (2027-01). Until then LINE's consent screen shows the former provider's name, and a LINE `sub`
 * belongs to its provider: accounts made now would be taken for other people once NIHO's LINE login moves to NIHO Co., Ltd.'s
 * provider (owner decision 2026-11-14, niho-coliving/niho-app#20307).
 */
export const TRAVELER_OFFERED_METHODS = ["google"] as const satisfies readonly NihoConnectMethod[];

/** The ways in the entrance offers now: Google, and LINE only once its flag is on. */
export function travelerMethodsOffered(lineEnabled: boolean): readonly NihoConnectMethod[] {
  return lineEnabled ? [...TRAVELER_OFFERED_METHODS, "line"] : TRAVELER_OFFERED_METHODS;
}

/**
 * A way in the traveler pressed, or null for one that is not known. LINE is not known while its flag is off, so a post for it
 * is refused like any other method nobody offers; Apple is understood (NIHO may offer it later) though the entrance does not.
 */
export function travelerMethodOrNull(value: unknown, lineEnabled: boolean): NihoConnectMethod | null {
  if (typeof value !== "string" || !(NIHO_CONNECT_METHODS as readonly string[]).includes(value)) return null;
  return value === "line" && !lineEnabled ? null : value as NihoConnectMethod;
}

/** Why the login did not finish, as the entrance tells it (`?error=`): never a NIHO name or an account. */
export const TRAVELER_LOGIN_ERRORS = ["expired", "denied", "unavailable", "suspended"] as const;
export type TravelerLoginError = (typeof TRAVELER_LOGIN_ERRORS)[number];

export function travelerLoginErrorOrNull(value: unknown): TravelerLoginError | null {
  return typeof value === "string" && (TRAVELER_LOGIN_ERRORS as readonly string[]).includes(value) ? value as TravelerLoginError : null;
}
