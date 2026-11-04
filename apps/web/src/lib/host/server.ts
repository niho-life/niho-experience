import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { NextResponse } from "next/server";
import { GoogleAuth } from "google-auth-library";
import type { ExperienceHostApiClient } from "@niho-experience/api-client/legacy-host";
import { createExperienceHostApiClient as createSelectedExperienceHostApiClient, type ExperienceHostApiClient as SelectedExperienceHostApiClient } from "@niho-experience/api-client/host";
import { createMockExperienceHostFetch, MOCK_EXPERIENCE_HOST_SERVICE_TOKEN } from "@niho-experience/api-client/host/mock";
import { config } from "@/lib/config";
import { cookieSealer } from "./cookie-seal";
import { createMockHostFetch, MOCK_ACCESS_TOKEN_PREFIX, mockToken } from "./mock-niho";
import { refreshConnection, type NihoAuthDeps } from "./niho-auth";
import { usableProviders, type HostProvider } from "./providers";
import {
  decodeSession,
  encodeLoginState,
  encodeSession,
  hostCookieOptions,
  accessTokenUsable,
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
import { experiencePublicationRepository } from "@/lib/experience/store-server";

const serviceAuth = new GoogleAuth();

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
  | { status: "ok"; nihoUserId: string; providers: HostProvider[] }
  | { status: "signed-out" }
  /** The NIHO Web access token is (nearly) expired: the browser refreshes, then reloads. */
  | { status: "refresh" }
  /** NIHO refused a token we thought valid (connection ended elsewhere). */
  | { status: "rejected" }
  | { status: "error" };

/**
 * NIHO's host API for this session, typed by the host contract (#87). Server
 * only: it sends the session's NIHO-scoped Web access token. Browser code calls /host/api/* instead.
 */
export function hostApiClient(session: HostSession): ExperienceHostApiClient {
  void session;
  throw new Error("NIHO legacy host operations are outside contract v1.0.0");
}

/** NIHO host common contract v1.0.0: identity and legacy Connect projection only. */
export async function selectedHostApiClient(session: HostSession, options: { legacyProviderId?: string } = {}): Promise<SelectedExperienceHostApiClient> {
  const serviceIdToken = isHostMock()
    ? MOCK_EXPERIENCE_HOST_SERVICE_TOKEN
    : await (async () => {
      const client = await serviceAuth.getIdTokenClient(config.nihoExperienceHostCommonContractAudience);
      const headers = await client.getRequestHeaders();
      const value = headers.authorization ?? headers.Authorization;
      if (typeof value !== "string" || !/^Bearer [^\\s]+$/.test(value)) throw new Error("Experience service identity is unavailable");
      return value.slice(7);
    })();
  const apiFetch = isHostMock()
    ? createMockExperienceHostFetch({ accessToken: session.accessToken, serviceIdToken, legacyProviderId: options.legacyProviderId })
    : fetch;
  return createSelectedExperienceHostApiClient({
    nihoWebOrigin: config.nihoWebOrigin,
    accessToken: session.accessToken,
    serviceIdToken,
    fetch: apiFetch,
  });
}

/** The signed-in host's providers, fetched once per request for the frame and the page. */
export const loadHostProviders = cache(async (): Promise<ProvidersLoad> => {
  const session = await readHostSession();
  if (!session) return { status: "signed-out" };
  if (!accessTokenUsable(session, Date.now())) return { status: "refresh" };
  try {
    const identityResult = await (await selectedHostApiClient(session)).getIdentity();
    if (!identityResult.ok) {
      if (identityResult.kind === "error" && identityResult.status === 401) return { status: "rejected" };
      return { status: "error" };
    }
    if (isHostMock()) {
      const previewProviders = usableProviders([
        { id: "sample-provider-kitchen", legacyProviderId: "sample-provider-kitchen", displayName: "サンプルの台所", memberRole: "OWNER" as const },
        { id: "sample-provider-studio", legacyProviderId: "sample-provider-studio", displayName: "サンプル工房", memberRole: "EDITOR" as const },
      ]);
      return { status: "ok", nihoUserId: identityResult.data.nihoUserId, providers: previewProviders.map((provider) => ({ ...provider, nihoUserId: identityResult.data.nihoUserId })) };
    }
    const repository = experiencePublicationRepository();
    if (!repository) return { status: "error" };
    const members = await repository.listHostProviders(identityResult.data.nihoUserId);
    const providers = usableProviders(members.map((member) => ({
      id: member.providerId,
      legacyProviderId: member.legacyProviderId,
      displayName: member.providerDisplayName,
      memberRole: member.memberRole,
      nihoUserId: identityResult.data.nihoUserId,
    })));
    return { status: "ok", nihoUserId: identityResult.data.nihoUserId, providers };
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
 * Exchanges the connection's refresh token for a new one and a new NIHO Web access token.
 * Only /host/auth/refresh (serialised by the browser across tabs) and logout call this.
 */
export async function renewSession(session: HostSession): Promise<Renewal> {
  if (isHostMock()) {
    const now = Date.now();
    return { outcome: "refreshed", session: startSession({ ...session, refreshToken: mockToken("mock-refresh-token."), accessToken: mockToken(MOCK_ACCESS_TOKEN_PREFIX), accessTokenExpiresAt: now + MOCK_ACCESS_TOKEN_TTL_MS }, now) };
  }
  const deps = nihoAuthDeps();
  const refreshed = await refreshConnection(deps, session.refreshToken);
  if (!refreshed.ok) return refreshed.reason === "rejected" ? { outcome: "rejected" } : { outcome: "unavailable", session };
  const rotated: HostSession = { ...session, refreshToken: refreshed.value.refreshToken, connectionExpiresAt: refreshed.value.connectionExpiresAt };
  return { outcome: "refreshed", session: startSession({ ...rotated, accessToken: refreshed.value.accessToken, accessTokenExpiresAt: refreshed.value.accessTokenExpiresAt }, Date.now()) };
}

export const MOCK_ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;

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
