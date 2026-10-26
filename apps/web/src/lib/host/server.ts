import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { NextResponse } from "next/server";
import { createExperienceHostApiClient, type ExperienceHostApiClient } from "@niho-experience/api-client/host";
import { config } from "@/lib/config";
import { cookieSealer } from "./cookie-seal";
import { createMockHostFetch, MOCK_ID_TOKEN_PREFIX, mockToken } from "./mock-niho";
import { refreshConnection, type NihoAuthDeps } from "./niho-auth";
import { usableProviders, type HostProvider } from "./providers";
import {
  decodeSession,
  encodeLoginState,
  encodeSession,
  hostCookieOptions,
  idTokenUsable,
  LOGIN_COOKIE,
  LOGIN_COOKIE_PATH,
  LOGIN_MAX_AGE_SECONDS,
  SESSION_COOKIE,
  SESSION_COOKIE_PATH,
  sessionMaxAgeSeconds,
  startSession,
  type HostLoginState,
  type HostSession,
} from "./session";

export const isHostMock = () => config.apiMode === "mock";
export const siteOrigin = () => new URL(config.siteUrl).origin;
export const sessionSealer = () => cookieSealer(config.hostSessionSecret, "session");
export const loginSealer = () => cookieSealer(config.hostSessionSecret, "login");

/** Every host route and page is a 404 until HOST_CONSOLE_ENABLED=true. */
export function requireHostConsole() {
  if (!config.hostConsoleEnabled) notFound();
}

/** The signed-in host for this request, or null. Read once per request. */
export const readHostSession = cache(async (): Promise<HostSession | null> => {
  if (!config.hostConsoleEnabled) return null;
  const jar = await cookies();
  return decodeSession(sessionSealer(), jar.get(SESSION_COOKIE)?.value, Date.now());
});

export function nihoAuthDeps(): NihoAuthDeps {
  return { fetch, nihoOrigin: config.nihoWebOrigin };
}

/** NIHO's API for this session: the real origin in http mode, the synthetic one in mock mode. */
export function nihoApiFetch(session: HostSession): typeof fetch {
  return isHostMock() ? createMockHostFetch(session.mockScenario ?? "default") : fetch;
}

export type ProvidersLoad =
  | { status: "ok"; providers: HostProvider[] }
  | { status: "signed-out" }
  /** The NIHO API bearer is (nearly) expired: the browser refreshes, then reloads. */
  | { status: "refresh" }
  /** NIHO refused a token we thought valid (connection ended elsewhere). */
  | { status: "rejected" }
  | { status: "error" };

/**
 * NIHO's host API for this session, typed by the host contract (#87). Server
 * only: it sends the session's API bearer. Browser code calls /host/api/* instead.
 */
export function hostApiClient(session: HostSession): ExperienceHostApiClient {
  return createExperienceHostApiClient({ nihoWebOrigin: config.nihoWebOrigin, idToken: session.idToken, fetch: nihoApiFetch(session) });
}

/** The signed-in host's providers, fetched once per request for the frame and the page. */
export const loadHostProviders = cache(async (): Promise<ProvidersLoad> => {
  const session = await readHostSession();
  if (!session) return { status: "signed-out" };
  if (!idTokenUsable(session, Date.now())) return { status: "refresh" };
  try {
    const result = await hostApiClient(session).listExperienceProviders();
    if (result.ok) return { status: "ok", providers: usableProviders(result.data.providers) };
    if (result.kind !== "network_error" && result.status === 401) return { status: "rejected" };
    return { status: "error" };
  } catch {
    // A misconfigured origin or an unusable token: show the error state, never the token.
    return { status: "error" };
  }
});

export type Renewal =
  | { outcome: "refreshed"; session: HostSession }
  /** NIHO ended the connection (expired, revoked, or an old refresh token): sign in again. */
  | { outcome: "rejected" }
  /** Try again later. Store `session`: NIHO may already have rotated the refresh token. */
  | { outcome: "unavailable"; session: HostSession };

/**
 * Exchanges the connection's refresh token for a new one and a new NIHO API token.
 * Only /host/auth/refresh (serialised by the browser across tabs) and logout call this.
 */
export async function renewSession(session: HostSession): Promise<Renewal> {
  if (isHostMock()) {
    const now = Date.now();
    return { outcome: "refreshed", session: startSession({ ...session, refreshToken: mockToken("mock-refresh-token."), idToken: mockToken(MOCK_ID_TOKEN_PREFIX), idTokenExpiresAt: now + MOCK_ID_TOKEN_TTL_MS }, now) };
  }
  const deps = nihoAuthDeps();
  const refreshed = await refreshConnection(deps, session.refreshToken);
  if (!refreshed.ok) return refreshed.reason === "rejected" ? { outcome: "rejected" } : { outcome: "unavailable", session };
  const rotated: HostSession = { ...session, refreshToken: refreshed.value.refreshToken, connectionExpiresAt: refreshed.value.connectionExpiresAt };
  const now = Date.now();
  if (refreshed.value.accessTokenExpiresAt <= now) return { outcome: "unavailable", session: rotated };
  return { outcome: "refreshed", session: startSession({ ...rotated, idToken: refreshed.value.accessToken, idTokenExpiresAt: refreshed.value.accessTokenExpiresAt }, now) };
}

export const MOCK_ID_TOKEN_TTL_MS = 60 * 60 * 1000;

const NO_STORE = "private, no-store";

export function noStoreJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "cache-control": NO_STORE, "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" } });
}

/** Host routes answer 404 while the console is off (and mock-only routes in http mode). */
export function hostNotFound(): NextResponse {
  return noStoreJson({ error: "not_found" }, 404);
}

/** 303 to a path on this site. A relative Location keeps redirects right behind any proxy. */
export function seeOther(location: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { location, "cache-control": NO_STORE } });
}

export function setSessionCookie(response: NextResponse, session: HostSession, now: number) {
  response.cookies.set(SESSION_COOKIE, encodeSession(sessionSealer(), session), hostCookieOptions(SESSION_COOKIE_PATH, sessionMaxAgeSeconds(session, now)));
}

export function clearSessionCookie(response: NextResponse) {
  // Deleting a __Secure- cookie needs the same Secure attribute and path.
  response.cookies.set(SESSION_COOKIE, "", hostCookieOptions(SESSION_COOKIE_PATH, 0));
}

export function setLoginCookie(response: NextResponse, login: HostLoginState) {
  response.cookies.set(LOGIN_COOKIE, encodeLoginState(loginSealer(), login), hostCookieOptions(LOGIN_COOKIE_PATH, LOGIN_MAX_AGE_SECONDS));
}

export function clearLoginCookie(response: NextResponse) {
  response.cookies.set(LOGIN_COOKIE, "", hostCookieOptions(LOGIN_COOKIE_PATH, 0));
}
