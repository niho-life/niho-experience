import type { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { HOST_AUTH_ERROR_PATH, HOST_LOGIN_PATH, hostReturnPathOrNull, withQuery } from "@/lib/host/routes";
import {
  clearSessionCookie,
  hostNotFound,
  renewSession,
  seeOther,
  sessionSealer,
  setSessionCookie,
} from "@/lib/host/server";
import { accessTokenUsable, decodeSession, SESSION_COOKIE } from "@/lib/host/session";

export const dynamic = "force-dynamic";

const DEFAULT_RETURN = "/write";

/**
 * Migrates the NIHO session formerly scoped to /host to the one same-origin
 * Path=/ cookie used by /host and /write. This is also the only navigation
 * path that refreshes before a writer page loads; writer pages never mount the
 * HostSessionKeeper and therefore cannot navigate away with unsaved text.
 */
export async function GET(request: NextRequest) {
  if (!config.hostConsoleEnabled) return hostNotFound();
  const returnPath = hostReturnPathOrNull(request.nextUrl.searchParams.get("returnTo")) ?? DEFAULT_RETURN;
  if (config.hostAccountsEnabled) {
    return seeOther(withQuery(HOST_LOGIN_PATH, { returnTo: returnPath }));
  }

  const now = Date.now();
  const session = decodeSession(sessionSealer(), request.cookies.get(SESSION_COOKIE)?.value, now);
  if (!session) {
    const response = seeOther(withQuery(HOST_LOGIN_PATH, { returnTo: returnPath }));
    clearSessionCookie(response);
    return response;
  }
  if (accessTokenUsable(session, now)) {
    const response = seeOther(returnPath);
    setSessionCookie(response, session, now);
    return response;
  }

  const renewal = await renewSession(session);
  if (renewal.outcome === "rejected") {
    const response = seeOther(withQuery(HOST_LOGIN_PATH, { returnTo: returnPath }));
    clearSessionCookie(response);
    return response;
  }
  if (renewal.outcome === "unavailable") {
    const response = seeOther(withQuery(HOST_AUTH_ERROR_PATH, { reason: "unavailable" }));
    // NIHO can rotate before a network failure is observed. Preserve only the
    // returned token pair at Path=/ and remove the legacy cookie.
    setSessionCookie(response, renewal.session, Date.now());
    return response;
  }
  const response = seeOther(returnPath);
  setSessionCookie(response, renewal.session, Date.now());
  return response;
}
