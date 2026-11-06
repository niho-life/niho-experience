import type { NextRequest } from "next/server";
import {
  adminHttpRefreshDue,
  adminHttpSessionSealer,
  adminJson,
  adminMutationAllowed,
  clearAdminHttpSessionCookie,
  isAdminGoogleLogin,
  isAdminHttp,
  renewAdminHttpSession,
  setAdminHttpSessionCookie,
} from "@/lib/admin/server";
import { ADMIN_HTTP_SESSION_COOKIE, decodeAdminHttpSession } from "@/lib/admin/http-session";
import { ADMIN_GOOGLE_SESSION_COOKIE, clearAdminGoogleSessionCookie, loadExperienceAdminSession } from "@/lib/admin/google-login";

/**
 * With the Google login (ADR 0003) there is nothing to renew: the session lives in the experience DB until it is idle
 * or reaches its end. The client keeper still asks, so this answers as a refresh that did nothing, with the session's
 * end, or 401 once the session has ended (or its address left the allowlist).
 */
async function experienceRefresh(request: NextRequest) {
  const load = await loadExperienceAdminSession(request.cookies.get(ADMIN_GOOGLE_SESSION_COOKIE)?.value);
  if (load.status === "ok") return adminJson({ refreshed: false, idTokenExpiresAt: load.session.absoluteExpiresAt });
  if (load.status === "error") return adminJson({ error: "unavailable" }, 503);
  const response = adminJson({ error: "session_expired" }, 401);
  clearAdminGoogleSessionCookie(response);
  return response;
}

export async function POST(request: NextRequest) {
  if (!isAdminHttp()) return adminJson({ error: "not_found" }, 404);
  if (!adminMutationAllowed(request)) return adminJson({ error: "cross_site_request" }, 403);
  if (isAdminGoogleLogin()) return experienceRefresh(request);
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
