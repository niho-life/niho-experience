import type { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { hostAccounts } from "@/lib/experience/store-server";
import { clearAccountSessionCookie, clearLinkBindingCookie, isOpaqueSecret, nowUtc } from "@/lib/host/accounts";
import { deleteConnection } from "@/lib/host/niho-auth";
import { forgetHostPushConnection } from "@/lib/host/push/server";
import { mutationFromSameOrigin } from "@/lib/host/relay";
import { HOST_INTRO_PATH, HOST_LAUNCH_PATH } from "@/lib/host/routes";
import { clearLoginCookie, clearSessionCookie, hostNotFound, isHostMock, nihoAuthDeps, noStoreJson, renewSession, seeOther, sessionSealer, siteOrigin } from "@/lib/host/server";
import { accessTokenUsable, ACCOUNT_SESSION_COOKIE, decodeSession, SESSION_COOKIE } from "@/lib/host/session";

/**
 * Experience host accounts (ADR 0003): the session ends in the experience DB and its devices stop receiving push. Best
 * effort like NIHO's: the cookie goes whatever the DB answers. The cookie does not say whether it was the installed
 * app's, so with the app on the host goes to its start page, which signs in from a browser too.
 */
async function logoutExperienceSession(request: NextRequest) {
  const token = request.cookies.get(ACCOUNT_SESSION_COOKIE)?.value;
  const store = hostAccounts();
  if (store && isOpaqueSecret(token)) {
    try {
      const at = nowUtc();
      const session = await store.readSession({ sessionToken: token, nowUtc: at });
      await store.revokeSession({ sessionToken: token, nowUtc: at });
      if (session) await forgetHostPushConnection(session.sessionRef);
    } catch {
      // The cookie is cleared below; an unreachable DB leaves a session nobody holds, which ends on its own.
    }
  }
  const response = seeOther(config.hostPwaEnabled ? HOST_LAUNCH_PATH : HOST_INTRO_PATH);
  clearAccountSessionCookie(response);
  clearLinkBindingCookie(response);
  clearLoginCookie(response);
  // A NIHO login's cookies from before the switch go too.
  clearSessionCookie(response);
  return response;
}

/** Ends the NIHO connection (best effort) and always clears this site's cookies. */
export async function POST(request: NextRequest) {
  if (!config.hostConsoleEnabled) return hostNotFound();
  if (!mutationFromSameOrigin("POST", request.headers, siteOrigin())) return noStoreJson({ error: "cross_site_request" }, 403);
  if (config.hostAccountsEnabled) return logoutExperienceSession(request);

  const session = decodeSession(sessionSealer(), request.cookies.get(SESSION_COOKIE)?.value, Date.now());
  if (session && !isHostMock()) {
    let accessToken: string | null = accessTokenUsable(session, Date.now()) ? session.accessToken : null;
    if (!accessToken) {
      // The connection is being ended, so a refresh here cannot cost a live session.
      const renewal = await renewSession(session);
      if (renewal.outcome === "refreshed") accessToken = renewal.session.accessToken;
    }
    if (accessToken) await deleteConnection(nihoAuthDeps(), session.connectionId, accessToken);
  }
  // The connection's devices stop receiving push (#177 P2). Best effort, like the call above.
  if (session) await forgetHostPushConnection(session.connectionId);

  // The installed app stays inside its own pages (#177).
  const response = seeOther(session?.surface === "app" ? HOST_LAUNCH_PATH : HOST_INTRO_PATH);
  clearLoginCookie(response);
  clearSessionCookie(response);
  return response;
}
