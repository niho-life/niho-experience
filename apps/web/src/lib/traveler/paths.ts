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
 * The ways in the entrance offers, in the order NIHO uses for travelers (Google, Apple, LINE). Apple has no web sign-in at NIHO
 * yet (niho-coliving/niho-app#20307): pressing it would drop the traveler into NIHO's usual screen, which is what the entrance
 * is there to avoid, so it is not offered until NIHO has it. `method=apple` is still understood end to end.
 */
export const TRAVELER_OFFERED_METHODS = ["google", "line"] as const satisfies readonly NihoConnectMethod[];

export function travelerMethodOrNull(value: unknown): NihoConnectMethod | null {
  return typeof value === "string" && (NIHO_CONNECT_METHODS as readonly string[]).includes(value) ? value as NihoConnectMethod : null;
}

/** Why the login did not finish, as the entrance tells it (`?error=`): never a NIHO name or an account. */
export const TRAVELER_LOGIN_ERRORS = ["expired", "denied", "unavailable", "suspended"] as const;
export type TravelerLoginError = (typeof TRAVELER_LOGIN_ERRORS)[number];

export function travelerLoginErrorOrNull(value: unknown): TravelerLoginError | null {
  return typeof value === "string" && (TRAVELER_LOGIN_ERRORS as readonly string[]).includes(value) ? value as TravelerLoginError : null;
}
