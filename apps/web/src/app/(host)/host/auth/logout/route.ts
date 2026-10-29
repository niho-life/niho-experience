import type { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { deleteConnection } from "@/lib/host/niho-auth";
import { forgetHostPushConnection } from "@/lib/host/push/server";
import { mutationFromSameOrigin } from "@/lib/host/relay";
import { HOST_INTRO_PATH, HOST_LAUNCH_PATH } from "@/lib/host/routes";
import { clearLoginCookie, clearSessionCookie, hostNotFound, isHostMock, nihoAuthDeps, noStoreJson, renewSession, seeOther, sessionSealer, siteOrigin } from "@/lib/host/server";
import { decodeSession, idTokenUsable, SESSION_COOKIE } from "@/lib/host/session";

/** Ends the NIHO connection (best effort) and always clears this site's cookies. */
export async function POST(request: NextRequest) {
  if (!config.hostConsoleEnabled) return hostNotFound();
  if (!mutationFromSameOrigin("POST", request.headers, siteOrigin())) return noStoreJson({ error: "cross_site_request" }, 403);

  const session = decodeSession(sessionSealer(), request.cookies.get(SESSION_COOKIE)?.value, Date.now());
  if (session && !isHostMock()) {
    let idToken: string | null = idTokenUsable(session, Date.now()) ? session.idToken : null;
    if (!idToken) {
      // The connection is being ended, so a refresh here cannot cost a live session.
      const renewal = await renewSession(session);
      if (renewal.outcome === "refreshed") idToken = renewal.session.idToken;
    }
    if (idToken) await deleteConnection(nihoAuthDeps(), session.connectionId, idToken);
  }
  // The connection's devices stop receiving push (#177 P2). Best effort, like the call above.
  if (session) await forgetHostPushConnection(session.connectionId);

  // The installed app stays inside its own pages (#177).
  const response = seeOther(session?.surface === "app" ? HOST_LAUNCH_PATH : HOST_INTRO_PATH);
  clearSessionCookie(response);
  clearLoginCookie(response);
  return response;
}
