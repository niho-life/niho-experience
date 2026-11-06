import type { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { clearAccountSessionCookie, readExperienceHostSession } from "@/lib/host/accounts";
import { HOST_APP_SIGN_IN_REQUIRED, HOST_DISPLAY_HEADER, HOST_DISPLAY_STANDALONE } from "@/lib/host/display";
import { forgetHostPushConnection, touchHostPushConnection } from "@/lib/host/push/server";
import { mutationFromSameOrigin } from "@/lib/host/relay";
import { clearSessionCookie, hostNotFound, noStoreJson, renewSession, sessionSealer, setSessionCookie, siteOrigin } from "@/lib/host/server";
import { ACCOUNT_SESSION_COOKIE, decodeSession, SESSION_COOKIE, sessionKeeperExpiresAt, shouldRefresh } from "@/lib/host/session";

/**
 * Experience host accounts (ADR 0003): nothing to rotate. The session is read (which moves its idle end at most hourly)
 * and its devices count as seen; the answer tells HostSessionKeeper when to ask again (the idle end). 401 once it ended.
 */
async function keepExperienceSession(request: NextRequest) {
  let session;
  try {
    session = await readExperienceHostSession(request.cookies.get(ACCOUNT_SESSION_COOKIE)?.value);
  } catch {
    return noStoreJson({ error: "unavailable" }, 503);
  }
  if (!session) {
    const response = noStoreJson({ error: "session_expired" }, 401);
    clearAccountSessionCookie(response);
    return response;
  }
  await touchHostPushConnection(session.sessionRef);
  return noStoreJson({ refreshed: false, accessTokenExpiresAt: sessionKeeperExpiresAt(session) });
}

/**
 * The only place a refresh token is spent. The browser calls this inside a Web
 * Lock shared by all tabs (HostSessionKeeper), because NIHO ends the connection
 * when an old refresh token is reused more than 10 minutes after rotation.
 */
export async function POST(request: NextRequest) {
  if (!config.hostConsoleEnabled) return hostNotFound();
  if (!mutationFromSameOrigin("POST", request.headers, siteOrigin())) return noStoreJson({ error: "cross_site_request" }, 403);
  if (config.hostAccountsEnabled) return keepExperienceSession(request);

  const now = Date.now();
  const session = decodeSession(sessionSealer(), request.cookies.get(SESSION_COOKIE)?.value, now);
  if (!session) {
    const response = noStoreJson({ error: "session_expired" }, 401);
    clearSessionCookie(response);
    return response;
  }
  // Inside the installed app, a session signed in elsewhere is the browser's, copied in by iOS or macOS
  // Safari (#177). Its refresh token is never spent here, and the cookie is left for the app's own sign-in.
  if (request.headers.get(HOST_DISPLAY_HEADER) === HOST_DISPLAY_STANDALONE && session.surface !== "app") {
    return noStoreJson({ error: HOST_APP_SIGN_IN_REQUIRED }, 401);
  }
  // Another tab may have refreshed while this one waited for the lock.
  if (!shouldRefresh(session, now)) return noStoreJson({ refreshed: false, accessTokenExpiresAt: session.accessTokenExpiresAt });

  const renewal = await renewSession(session);
  // Push follows the connection (#177 P2): an ended one loses its devices, a refreshed one keeps them current. Never blocks.
  if (renewal.outcome === "rejected") await forgetHostPushConnection(session.connectionId);
  if (renewal.outcome === "refreshed") await touchHostPushConnection(renewal.session.connectionId);
  if (renewal.outcome === "rejected") {
    const response = noStoreJson({ error: "session_expired" }, 401);
    clearSessionCookie(response);
    return response;
  }
  const response = renewal.outcome === "refreshed"
    ? noStoreJson({ refreshed: true, accessTokenExpiresAt: renewal.session.accessTokenExpiresAt })
    : noStoreJson({ error: "niho_unavailable" }, 503);
  // Saved even when unavailable: NIHO may already have rotated the refresh token.
  setSessionCookie(response, renewal.session, Date.now());
  return response;
}
