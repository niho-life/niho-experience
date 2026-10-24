import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import {
  createExperienceAdminAuthClient,
  type ExperienceAdminVerifiedSession,
} from "@niho-experience/api-client/admin-auth";
import {
  createExperienceAdminReadApiClient,
  type ExperienceAdminReadApiClient,
  type ExperienceAdminReadFailure,
} from "@niho-experience/api-client/admin-read";
import { cookieSealer } from "@/lib/host/cookie-seal";
import { signInWithCustomToken } from "@/lib/host/niho-auth";
import { ID_TOKEN_MIN_REMAINING_MS, REFRESH_WINDOW_MS } from "@/lib/host/timing";
import { mutationFromSameOrigin } from "@/lib/host/relay";
import { ADMIN_SESSION_COOKIE, ADMIN_SESSION_MAX_AGE_SECONDS, adminCookieOptions, decodeAdminSession, encodeAdminSession, type AdminSession } from "@/admin/session";
import {
  ADMIN_HTTP_LOGIN_COOKIE,
  ADMIN_HTTP_LOGIN_MAX_AGE_SECONDS,
  ADMIN_HTTP_LOGIN_PATH,
  ADMIN_HTTP_SESSION_COOKIE,
  ADMIN_HTTP_SESSION_PATH,
  adminHttpCookieOptions,
  adminHttpSessionMaxAgeSeconds,
  decodeAdminHttpSession,
  encodeAdminHttpLogin,
  encodeAdminHttpSession,
  startAdminHttpSession,
  type AdminHttpLoginState,
  type AdminHttpSession,
} from "./http-session";

export const isAdminPreview = () => config.apiMode === "mock" && config.adminSupportConsoleEnabled;
export const isAdminHttp = () => config.apiMode === "http" && config.adminSupportConsoleEnabled;
export const isAdminHttpRead = () => isAdminHttp() && config.adminSupportReadApiEnabled;
export const isAdminReadPreview = () => isAdminPreview() && config.adminSupportReadPreviewEnabled;

export function requireAdminConsole() {
  if (!config.adminSupportConsoleEnabled) notFound();
}

const adminSealer = () => cookieSealer(config.hostSessionSecret, "admin-preview-session");
export const adminHttpSessionSealer = () => cookieSealer(config.adminSessionSecret, "admin-http-session");
export const adminHttpLoginSealer = () => cookieSealer(config.adminSessionSecret, "admin-http-login");

export function adminAuthClient() {
  return createExperienceAdminAuthClient({ nihoWebOrigin: config.nihoWebOrigin, fetch });
}

export function adminReadApiClient(session: AdminHttpSession): ExperienceAdminReadApiClient {
  return createExperienceAdminReadApiClient({ nihoWebOrigin: config.nihoWebOrigin, idToken: session.idToken, fetch });
}

export function adminReadFailureJson(failure: ExperienceAdminReadFailure): NextResponse {
  if (failure.kind === "rejected") {
    const response = adminJson({ error: "signed_out" }, 401);
    clearAdminHttpSessionCookie(response);
    return response;
  }
  if (failure.kind === "not_found") return adminJson({ error: "not_found" }, 404);
  if (failure.kind === "invalid_request") return adminJson({ error: "invalid_input" }, 400);
  return adminJson({ error: "unavailable" }, 503);
}

export async function loadAdminReadClient(): Promise<{ ok: true; client: ExperienceAdminReadApiClient } | { ok: false; response: NextResponse }> {
  if (!isAdminHttpRead()) return { ok: false, response: adminJson({ error: "not_found" }, 404) };
  const load = await loadAdminHttpSession();
  if (load.status === "ok") return { ok: true, client: adminReadApiClient(load.session) };
  if (load.status === "error") return { ok: false, response: adminJson({ error: "unavailable" }, 503) };
  const response = adminJson({ error: load.status === "refresh" ? "refresh_required" : "signed_out" }, 401);
  if (load.status === "rejected") clearAdminHttpSessionCookie(response);
  return { ok: false, response };
}

export const readAdminSession = cache(async (): Promise<AdminSession | null> => {
  // A sealed preview cookie is never treated as evidence of a production admin role.
  if (!isAdminPreview()) return null;
  const jar = await cookies();
  return decodeAdminSession(adminSealer(), jar.get(ADMIN_SESSION_COOKIE)?.value, Date.now());
});

export function setAdminSessionCookie(response: NextResponse, session: AdminSession) {
  response.cookies.set(ADMIN_SESSION_COOKIE, encodeAdminSession(adminSealer(), session), adminCookieOptions(ADMIN_SESSION_MAX_AGE_SECONDS));
}

export function clearAdminSessionCookie(response: NextResponse) {
  response.cookies.set(ADMIN_SESSION_COOKIE, "", adminCookieOptions(0));
}

export const readAdminHttpSession = cache(async (): Promise<AdminHttpSession | null> => {
  if (!isAdminHttp()) return null;
  const jar = await cookies();
  return decodeAdminHttpSession(adminHttpSessionSealer(), jar.get(ADMIN_HTTP_SESSION_COOKIE)?.value, Date.now());
});

export type AdminHttpSessionLoad =
  | { status: "ok"; session: AdminHttpSession; verified: ExperienceAdminVerifiedSession }
  | { status: "signed-out" }
  | { status: "refresh"; session: AdminHttpSession }
  | { status: "rejected" }
  | { status: "error" };

/** Verify the dedicated client and current ADMIN role before exposing an actor to the UI. */
export const loadAdminHttpSession = cache(async (): Promise<AdminHttpSessionLoad> => {
  const session = await readAdminHttpSession();
  if (!session) return { status: "signed-out" };
  const now = Date.now();
  if (session.idTokenExpiresAt - now <= ID_TOKEN_MIN_REMAINING_MS) return { status: "refresh", session };
  const verified = await adminAuthClient().verifySession(session.idToken);
  if (!verified.ok) return { status: verified.kind === "rejected" ? "rejected" : "error" };
  if (
    verified.data.actor.id !== session.actorId
    || verified.data.connection.id !== session.connectionId
    || verified.data.connection.expiresAt <= now
    || verified.data.connection.expiresAt > session.connectionExpiresAt
  ) return { status: "rejected" };
  return { status: "ok", session, verified: verified.data };
});

export type AdminRenewal =
  | { outcome: "refreshed"; session: AdminHttpSession }
  | { outcome: "rejected" }
  | { outcome: "unavailable"; session: AdminHttpSession };

/** Rotate the one-time refresh token, then re-check the dedicated Admin session endpoint. */
export async function renewAdminHttpSession(session: AdminHttpSession): Promise<AdminRenewal> {
  const client = adminAuthClient();
  const refreshed = await client.refreshConnection(session.refreshToken);
  if (!refreshed.ok) return refreshed.kind === "rejected" ? { outcome: "rejected" } : { outcome: "unavailable", session };
  const rotated: AdminHttpSession = {
    ...session,
    refreshToken: refreshed.data.refreshToken,
    connectionExpiresAt: Math.min(session.connectionExpiresAt, refreshed.data.connectionExpiresAt),
  };
  const signedIn = await signInWithCustomToken(
    { fetch, nihoOrigin: config.nihoWebOrigin, firebaseWebApiKey: config.nihoFirebaseWebApiKey },
    refreshed.data.customToken,
    Date.now(),
  );
  if (!signedIn.ok) return { outcome: "unavailable", session: rotated };
  const verified = await client.verifySession(signedIn.value.idToken);
  if (!verified.ok) return verified.kind === "rejected" ? { outcome: "rejected" } : { outcome: "unavailable", session: rotated };
  if (verified.data.actor.id !== session.actorId || verified.data.connection.id !== session.connectionId) return { outcome: "rejected" };
  const renewed = startAdminHttpSession({
    refreshToken: rotated.refreshToken,
    idToken: signedIn.value.idToken,
    idTokenExpiresAt: signedIn.value.idTokenExpiresAt,
    connectionId: session.connectionId,
    exchangedConnectionExpiresAt: rotated.connectionExpiresAt,
    verifiedConnectionExpiresAt: verified.data.connection.expiresAt,
    actorId: verified.data.actor.id,
    actorName: verified.data.actor.displayName,
  }, Date.now());
  return renewed ? { outcome: "refreshed", session: renewed } : { outcome: "rejected" };
}

export function setAdminHttpSessionCookie(response: NextResponse, session: AdminHttpSession, now: number) {
  response.cookies.set(
    ADMIN_HTTP_SESSION_COOKIE,
    encodeAdminHttpSession(adminHttpSessionSealer(), session),
    adminHttpCookieOptions(ADMIN_HTTP_SESSION_PATH, adminHttpSessionMaxAgeSeconds(session, now)),
  );
}

export function clearAdminHttpSessionCookie(response: NextResponse) {
  response.cookies.set(ADMIN_HTTP_SESSION_COOKIE, "", adminHttpCookieOptions(ADMIN_HTTP_SESSION_PATH, 0));
}

export function setAdminHttpLoginCookie(response: NextResponse, login: AdminHttpLoginState) {
  response.cookies.set(
    ADMIN_HTTP_LOGIN_COOKIE,
    encodeAdminHttpLogin(adminHttpLoginSealer(), login),
    adminHttpCookieOptions(ADMIN_HTTP_LOGIN_PATH, ADMIN_HTTP_LOGIN_MAX_AGE_SECONDS),
  );
}

export function clearAdminHttpLoginCookie(response: NextResponse) {
  response.cookies.set(ADMIN_HTTP_LOGIN_COOKIE, "", adminHttpCookieOptions(ADMIN_HTTP_LOGIN_PATH, 0));
}

export function adminHttpRefreshDue(session: AdminHttpSession, now: number): boolean {
  return session.idTokenExpiresAt - now < REFRESH_WINDOW_MS;
}

export function adminMutationAllowed(request: Request): boolean {
  return mutationFromSameOrigin(request.method, request.headers, isAdminHttp() ? config.adminOrigin : new URL(config.siteUrl).origin);
}

export function adminJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "cache-control": "private, no-store" } });
}

