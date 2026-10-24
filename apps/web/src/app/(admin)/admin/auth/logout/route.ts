import { NextResponse, type NextRequest } from "next/server";
import {
  adminAuthClient,
  adminHttpSessionSealer,
  adminJson,
  adminMutationAllowed,
  clearAdminHttpLoginCookie,
  clearAdminHttpSessionCookie,
  clearAdminSessionCookie,
  isAdminHttp,
  renewAdminHttpSession,
} from "@/lib/admin/server";
import { ADMIN_HTTP_SESSION_COOKIE, decodeAdminHttpSession } from "@/lib/admin/http-session";
import { ADMIN_ENTRY_PATH, ADMIN_LOGOUT_UNCONFIRMED_PATH } from "@/lib/admin/routes";

export async function POST(request: NextRequest) {
  if (!adminMutationAllowed(request)) return adminJson({ error: "forbidden" }, 403);
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

