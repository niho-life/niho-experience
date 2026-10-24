import type { NextRequest } from "next/server";
import {
  adminHttpRefreshDue,
  adminHttpSessionSealer,
  adminJson,
  adminMutationAllowed,
  clearAdminHttpSessionCookie,
  isAdminHttp,
  renewAdminHttpSession,
  setAdminHttpSessionCookie,
} from "@/lib/admin/server";
import { ADMIN_HTTP_SESSION_COOKIE, decodeAdminHttpSession } from "@/lib/admin/http-session";

export async function POST(request: NextRequest) {
  if (!isAdminHttp()) return adminJson({ error: "not_found" }, 404);
  if (!adminMutationAllowed(request)) return adminJson({ error: "cross_site_request" }, 403);
  const now = Date.now();
  const session = decodeAdminHttpSession(adminHttpSessionSealer(), request.cookies.get(ADMIN_HTTP_SESSION_COOKIE)?.value, now);
  if (!session) {
    const response = adminJson({ error: "session_expired" }, 401);
    clearAdminHttpSessionCookie(response);
    return response;
  }
  if (!adminHttpRefreshDue(session, now)) return adminJson({ refreshed: false, idTokenExpiresAt: session.idTokenExpiresAt });

  const renewal = await renewAdminHttpSession(session);
  if (renewal.outcome === "rejected") {
    const response = adminJson({ error: "session_expired" }, 401);
    clearAdminHttpSessionCookie(response);
    return response;
  }
  const response = renewal.outcome === "refreshed"
    ? adminJson({ refreshed: true, idTokenExpiresAt: renewal.session.idTokenExpiresAt })
    : adminJson({ error: "niho_unavailable" }, 503);
  setAdminHttpSessionCookie(response, renewal.session, Date.now());
  return response;
}
