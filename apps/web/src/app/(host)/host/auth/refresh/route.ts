import type { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { HOST_APP_SIGN_IN_REQUIRED, HOST_DISPLAY_HEADER, HOST_DISPLAY_STANDALONE } from "@/lib/host/display";
import { mutationFromSameOrigin } from "@/lib/host/relay";
import { clearSessionCookie, hostNotFound, noStoreJson, renewSession, sessionSealer, setSessionCookie, siteOrigin } from "@/lib/host/server";
import { decodeSession, SESSION_COOKIE, shouldRefresh } from "@/lib/host/session";

/**
 * The only place a refresh token is spent. The browser calls this inside a Web
 * Lock shared by all tabs (HostSessionKeeper), because NIHO ends the connection
 * when an old refresh token is reused more than 10 minutes after rotation.
 */
export async function POST(request: NextRequest) {
  if (!config.hostConsoleEnabled) return hostNotFound();
  if (!mutationFromSameOrigin("POST", request.headers, siteOrigin())) return noStoreJson({ error: "cross_site_request" }, 403);

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
  if (!shouldRefresh(session, now)) return noStoreJson({ refreshed: false, idTokenExpiresAt: session.idTokenExpiresAt });

  const renewal = await renewSession(session);
  if (renewal.outcome === "rejected") {
    const response = noStoreJson({ error: "session_expired" }, 401);
    clearSessionCookie(response);
    return response;
  }
  const response = renewal.outcome === "refreshed"
    ? noStoreJson({ refreshed: true, idTokenExpiresAt: renewal.session.idTokenExpiresAt })
    : noStoreJson({ error: "niho_unavailable" }, 503);
  // Saved even when unavailable: NIHO may already have rotated the refresh token.
  setSessionCookie(response, renewal.session, Date.now());
  return response;
}
