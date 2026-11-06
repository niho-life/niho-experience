import { NextResponse, type NextRequest } from "next/server";
import {
  adminAuthClient,
  adminHttpSessionSealer,
  adminJson,
  adminMutationAllowed,
  clearAdminHttpLoginCookie,
  clearAdminHttpSessionCookie,
  clearAdminSessionCookie,
  clearNihoAdminHttpSessionCookie,
  isAdminGoogleLogin,
  isAdminHttp,
  renewAdminHttpSession,
} from "@/lib/admin/server";
import { ADMIN_HTTP_SESSION_COOKIE, decodeAdminHttpSession } from "@/lib/admin/http-session";
import {
  ADMIN_GOOGLE_SESSION_COOKIE,
  clearAdminGoogleLoginCookie,
  clearAdminGoogleSessionCookie,
  isAdminSessionToken,
  nowUtc,
} from "@/lib/admin/google-login";
import { ADMIN_ENTRY_PATH, ADMIN_LOGOUT_UNCONFIRMED_PATH } from "@/lib/admin/routes";
import { adminSessions } from "@/lib/experience/store-server";

/**
 * With the Google login (ADR 0003): the session ends in the experience DB and its cookie goes. Best effort like NIHO's:
 * the cookie goes whatever the DB answers (a session nobody holds ends when it is idle). NIHO is not called.
 */
async function logoutExperienceSession(request: NextRequest) {
  const token = request.cookies.get(ADMIN_GOOGLE_SESSION_COOKIE)?.value;
  const store = adminSessions();
  if (store && isAdminSessionToken(token)) {
    try {
      await store.revokeSession({ sessionToken: token, nowUtc: nowUtc() });
    } catch {
      // The cookie is cleared below.
    }
  }
  const response = new NextResponse(null, { status: 303, headers: { location: ADMIN_ENTRY_PATH, "cache-control": "private, no-store" } });
  clearAdminGoogleSessionCookie(response);
  clearAdminGoogleLoginCookie(response);
  // A NIHO login's cookies from before the switch go too.
  clearNihoAdminHttpSessionCookie(response);
  clearAdminHttpLoginCookie(response);
  return response;
}

export async function POST(request: NextRequest) {
  if (!adminMutationAllowed(request)) return adminJson({ error: "forbidden" }, 403);
  if (isAdminGoogleLogin()) return logoutExperienceSession(request);
  let remoteRevocationUnconfirmed = false;
  if (isAdminHttp()) {
    const session = decodeAdminHttpSession(adminHttpSessionSealer(), request.cookies.get(ADMIN_HTTP_SESSION_COOKIE)?.value, Date.now());
    if (session) {
      let current = session;
      if (current.idTokenExpiresAt <= Date.now()) {
        const renewal = await renewAdminHttpSession(current);
        if (renewal.outcome === "refreshed") current = renewal.session;
        else remoteRevocationUnconfirmed = true;
      }
      if (current.idTokenExpiresAt > Date.now()) {
        remoteRevocationUnconfirmed = !(await adminAuthClient().deleteConnection(current.connectionId, current.idToken));
      }
    }
  }
  const response = new NextResponse(null, {
    status: 303,
    headers: {
      location: remoteRevocationUnconfirmed ? ADMIN_LOGOUT_UNCONFIRMED_PATH : ADMIN_ENTRY_PATH,
      "cache-control": "private, no-store",
    },
  });
  clearAdminSessionCookie(response);
  clearAdminHttpSessionCookie(response);
  clearAdminHttpLoginCookie(response);
  return response;
}
