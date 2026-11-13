import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { travelerAccounts } from "@/lib/experience/store-server";
import { hostCookieOptions } from "@/lib/host/session";
import { MOCK_TRAVELER_SESSION, TRAVELER_LOGIN_HINT_COOKIE, TRAVELER_SESSION_COOKIE, TRAVELER_SESSION_COOKIE_PATH } from "./session";

/** The traveler's own session token: 32 random bytes in base64url, as the host accounts' are. */
const OPAQUE_SECRET = /^[A-Za-z0-9_-]{43}$/;
export const isTravelerSessionToken = (value: unknown): value is string => typeof value === "string" && OPAQUE_SECRET.test(value);

export interface TravelerSessionView {
  /** The preview's synthetic traveler. */
  readonly mock: boolean;
  /** Not a secret: names this session. */
  readonly sessionRef: string | null;
}

/**
 * The signed-in traveler for this request, or null (not signed in, the flag is off, a malformed or ended session). Read once per
 * request. A store failure throws: the request fails instead of reading as signed out.
 */
export const readTravelerSession = cache(async (): Promise<TravelerSessionView | null> => {
  if (!config.travelerAccountsEnabled) return null;
  const token = (await cookies()).get(TRAVELER_SESSION_COOKIE)?.value;
  if (config.apiMode !== "http") return token === MOCK_TRAVELER_SESSION ? { mock: true, sessionRef: null } : null;
  if (!isTravelerSessionToken(token)) return null;
  const store = travelerAccounts();
  if (!store) return null;
  const session = await store.readSession({ sessionToken: token, nowUtc: new Date().toISOString() });
  return session ? { mock: false, sessionRef: session.sessionRef } : null;
});

/** The session cookie: the opaque token, HttpOnly, Secure, SameSite=Lax, Path=/, living no longer than the session. */
export function setTravelerSessionCookie(response: NextResponse, sessionToken: string, absoluteExpiresAtUtc: string, now = Date.now()) {
  const maxAge = Math.max(0, Math.floor((Date.parse(absoluteExpiresAtUtc) - now) / 1000));
  response.cookies.set(TRAVELER_SESSION_COOKIE, sessionToken, hostCookieOptions(TRAVELER_SESSION_COOKIE_PATH, maxAge));
}

export function clearTravelerSessionCookie(response: NextResponse) {
  response.cookies.set(TRAVELER_SESSION_COOKIE, "", hostCookieOptions(TRAVELER_SESSION_COOKIE_PATH, 0));
}

/** See TRAVELER_LOGIN_HINT_COOKIE: on the auth path, for the 10 minutes of the round trip. */
export function setTravelerLoginHint(response: NextResponse) {
  response.cookies.set(TRAVELER_LOGIN_HINT_COOKIE, "1", hostCookieOptions("/host/auth", 10 * 60));
}

export function clearTravelerLoginHint(response: NextResponse) {
  response.cookies.set(TRAVELER_LOGIN_HINT_COOKIE, "", hostCookieOptions("/host/auth", 0));
}
