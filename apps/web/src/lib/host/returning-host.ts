import "server-only";
import { cookies } from "next/headers";
import type { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { HOST_AUTO_LOGIN_PATH } from "./routes";
import {
  AUTO_LOGIN_COOKIE,
  AUTO_LOGIN_COOKIE_PATH,
  AUTO_LOGIN_INTERVAL_SECONDS,
  hostCookieOptions,
  RETURNING_HOST_COOKIE,
  RETURNING_HOST_COOKIE_PATH,
  RETURNING_HOST_MAX_AGE_SECONDS,
} from "./session";

/*
 * A host whose session ran out signs in again without pressing anything (#632). NIHO passes a host who is still signed in
 * there straight back (niho-coliving/niho-app#21302), so a console page opened after the session's idle or absolute expiry
 * comes back signed in. A logout clears the mark: what follows a logout is the entrance and its one button.
 */

const MARK = "1";

/** Only the NIHO account login signs a host in by itself: not the emailed link (the migration fallback), not the mock. */
const autoLoginAvailable = () => config.hostAccountsEnabled && config.hostNihoLoginEnabled && config.apiMode !== "mock";

/** A host signed in with NIHO in this browser. */
export function setReturningHostCookie(response: NextResponse) {
  response.cookies.set(RETURNING_HOST_COOKIE, MARK, hostCookieOptions(RETURNING_HOST_COOKIE_PATH, RETURNING_HOST_MAX_AGE_SECONDS));
}

/** A logout, or a NIHO sign-in that did not open a session: the next visit shows the entrance instead of going to NIHO. */
export function clearReturningHostCookie(response: NextResponse) {
  response.cookies.set(RETURNING_HOST_COOKIE, "", hostCookieOptions(RETURNING_HOST_COOKIE_PATH, 0));
}

/** Where a console page without a session sends this browser: the automatic sign-in for a returning host, otherwise null. */
export async function returningHostLoginPath(): Promise<string | null> {
  if (!autoLoginAvailable()) return null;
  const jar = await cookies();
  return jar.get(RETURNING_HOST_COOKIE)?.value === MARK ? HOST_AUTO_LOGIN_PATH : null;
}

/** No automatic sign-in started in this browser within AUTO_LOGIN_INTERVAL_SECONDS. */
export function autoLoginAllowed(request: NextRequest): boolean {
  return autoLoginAvailable() && !request.cookies.has(AUTO_LOGIN_COOKIE);
}

export function markAutoLoginStarted(response: NextResponse) {
  response.cookies.set(AUTO_LOGIN_COOKIE, MARK, hostCookieOptions(AUTO_LOGIN_COOKIE_PATH, AUTO_LOGIN_INTERVAL_SECONDS));
}
