import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { NextResponse } from "next/server";
import { GoogleAuth } from "google-auth-library";
import { createExperienceHostApiClient as createLegacyExperienceHostApiClient, type ExperienceHostApiClient } from "@niho-experience/api-client/legacy-host";
import { createExperienceHostApiClient as createSelectedExperienceHostApiClient, type ExperienceHostApiClient as SelectedExperienceHostApiClient } from "@niho-experience/api-client/host";
import { createMockExperienceHostFetch, MOCK_EXPERIENCE_HOST_SERVICE_TOKEN } from "@niho-experience/api-client/host/mock";
import { config } from "@/lib/config";
import { cookieSealer } from "./cookie-seal";
import { createMockHostFetch, MOCK_ACCESS_TOKEN_PREFIX, mockToken } from "./mock-niho";
import { refreshConnection, type NihoAuthDeps } from "./niho-auth";
import { usableProviders, type HostProvider } from "./providers";
import { listExperienceHostProviders, readExperienceHostSession } from "./accounts";
import {
  ACCOUNT_SESSION_COOKIE,
  decodeSession,
  encodeLoginState,
  encodeSession,
  hostCookieOptions,
  accessTokenUsable,
  LOGIN_COOKIE,
  LOGIN_COOKIE_PATH,
  LOGIN_MAX_AGE_SECONDS,
  LEGACY_SESSION_COOKIE_PATH,
  SESSION_COOKIE,
  SESSION_COOKIE_PATH,
  sessionMaxAgeSeconds,
  startSession,
  type HostLoginState,
  type HostSession,
  type NihoHostSession,
} from "./session";
import { experiencePublicationRepository } from "@/lib/experience/store-server";
import { parseBearerToken } from "./bearer-token";

const serviceAuth = new GoogleAuth();

export const isHostMock = () => config.apiMode === "mock";
export const siteOrigin = () => new URL(config.siteUrl).origin;
export const sessionSealer = () => cookieSealer(config.hostSessionSecret, "session");
export const loginSealer = () => cookieSealer(config.hostSessionSecret, "login");

/** Every host route and page is a 404 until HOST_CONSOLE_ENABLED=true. */
export function requireHostConsole() {
  if (!config.hostConsoleEnabled) notFound();
}

/**
 * The signed-in host/writer for this request, or null. Read once per request. With Experience host accounts
 * (EXPERIENCE_HOST_ACCOUNTS_ENABLED) only their session cookie counts, read from the experience DB (a store failure
 * throws); otherwise only the NIHO login's sealed cookie.
 */
export const readHostSession = cache(async (): Promise<HostSession | null> => {
  if (!config.hostConsoleEnabled) return null;
  const jar = await cookies();
  if (config.hostAccountsEnabled) return readExperienceHostSession(jar.get(ACCOUNT_SESSION_COOKIE)?.value);
  return decodeSession(sessionSealer(), jar.get(SESSION_COOKIE)?.value, Date.now());
});

/** 「メールでログイン」 with Experience host accounts, 「NIHO でログイン」 otherwise: the console's sign-in buttons. */
export function hostLoginLabel(): string {
  return config.hostAccountsEnabled ? "メールでログイン" : "NIHO でログイン";
}

export function nihoAuthDeps(): NihoAuthDeps {
  return { fetch, nihoOrigin: config.nihoWebOrigin };
}

/** NIHO request transport: the real origin in http mode, the synthetic one in mock mode. */
export function nihoApiFetch(session: NihoHostSession): typeof fetch {
  return isHostMock() ? createMockHostFetch(session.mockScenario ?? "default") : fetch;
}

/** Fixed-audience Google identity for the Experience BFF; never contains a host's NIHO access token. */
export async function experienceHostServiceIdToken(): Promise<string> {
  if (isHostMock()) return MOCK_EXPERIENCE_HOST_SERVICE_TOKEN;
  const client = await serviceAuth.getIdTokenClient(config.nihoExperienceHostCommonContractAudience);
  const headers = await client.getRequestHeaders();
  const token = parseBearerToken(headers.authorization ?? headers.Authorization);
  if (token === null) throw new Error("Experience service identity is unavailable");
  return token;
}

export type ProvidersLoad =
  /**
   * `nihoUserId` is the identity the experience DB's `*_niho_user_id` columns hold for this person: the NIHO user ID
   * with the NIHO login, the Experience host account ID (`hst_` + 32 hex) with host accounts (ADR 0003).
   */
  | { status: "ok"; nihoUserId: string; providers: HostProvider[] }
  | { status: "signed-out" }
  /** The NIHO Web access token is (nearly) expired: the browser refreshes, then reloads. */
  | { status: "refresh" }
  /** NIHO refused a token we thought valid (connection ended elsewhere). */
  | { status: "rejected" }
  | { status: "error" };

/** Legacy provider client for synthetic preview only; live consumers use the selected Host v1 client. */
export function hostApiClient(session: NihoHostSession): ExperienceHostApiClient {
  if (!isHostMock()) throw new Error("NIHO legacy host operations are outside contract v1.0.0");
  return createLegacyExperienceHostApiClient({
    nihoWebOrigin: config.nihoWebOrigin,
    accessToken: session.accessToken,
    fetch: nihoApiFetch(session),
  });
}

/** NIHO host common contract v1.0.0: identity and legacy Connect projection only. */
export async function selectedHostApiClient(session: NihoHostSession, options: { legacyProviderId?: string } = {}): Promise<SelectedExperienceHostApiClient> {
  const serviceIdToken = await experienceHostServiceIdToken();
  const apiFetch = isHostMock()
    ? createMockExperienceHostFetch({
      accessToken: session.accessToken,
      serviceIdToken,
      legacyProviderId: options.legacyProviderId,
      stripeAccountId: session.mockScenario === "payments-pending" ? null : undefined,
      connectReady: session.mockScenario !== "payments-pending",
      reuseConsentAccepted: session.mockScenario !== "payments-pending",
    })
    : fetch;
  return createSelectedExperienceHostApiClient({
    nihoWebOrigin: config.nihoWebOrigin,
    accessToken: session.accessToken,
    serviceIdToken,
    fetch: apiFetch,
  });
}

/**
 * Resolve the signed-in identity to local Experience seller memberships without request memoization: the NIHO identity
 * (Host v1) with the NIHO login, or the Experience host account's memberships in the experience DB, with no call to NIHO.
 */
export async function loadHostProvidersFresh(): Promise<ProvidersLoad> {
  let session: HostSession | null;
  try { session = await readHostSession(); }
  catch { return { status: "error" }; }
  if (!session) return { status: "signed-out" };
  if (session.kind === "experience") {
    try {
      const providers = await listExperienceHostProviders(session);
      return providers ? { status: "ok", nihoUserId: session.hostAccountId, providers } : { status: "error" };
    } catch {
      return { status: "error" };
    }
  }
  if (!accessTokenUsable(session, Date.now())) return { status: "refresh" };
  try {
    const identityResult = await (await selectedHostApiClient(session)).getIdentity();
    if (!identityResult.ok) {
      if (identityResult.kind === "error" && identityResult.status === 401) return { status: "rejected" };
      return { status: "error" };
    }
    if (isHostMock()) {
      // Keep the existing synthetic scenarios (empty, payments-pending, cohost, etc.) in
      // preview without reopening the legacy provider directory in the live HTTP contract.
      const legacyMock = createLegacyExperienceHostApiClient({
        nihoWebOrigin: config.nihoWebOrigin,
        accessToken: session.accessToken,
        fetch: nihoApiFetch(session),
      });
      const preview = await legacyMock.listExperienceProviders();
      if (!preview.ok) {
        if (preview.kind === "error" && preview.status === 401) return { status: "rejected" };
        return { status: "error" };
      }
      const providers = usableProviders(preview.data.providers.map((provider) => ({
        id: provider.id,
        legacyProviderId: provider.id,
        displayName: provider.displayName,
        memberRole: session.mockScenario === "cohost" && provider.id === "sample-provider-kitchen" ? "COHOST" as const : provider.memberRole,
        nihoUserId: identityResult.data.nihoUserId,
        kind: provider.kind,
        bio: provider.bio,
        sellerDisclosureUrl: provider.sellerDisclosureUrl,
        reviewStatus: provider.reviewStatus,
        consentVersion: provider.consentVersion,
        paymentReuseSourceSpotId: provider.paymentReuseSourceSpotId,
      })));
      return { status: "ok", nihoUserId: identityResult.data.nihoUserId, providers };
    }
    const repository = experiencePublicationRepository();
    if (!repository) return { status: "error" };
    const nihoUserId = identityResult.data.nihoUserId;
    let members = await repository.listHostProviders(nihoUserId);
    if (members.length === 0 && config.experienceHostPublicationApiEnabled) {
      // The console must bind a pre-provisioned seller before its first product page can
      // render. Waiting for a product API call strands that seller on the register prompt.
      const binding = await repository.ensureMappedOwnerMembership(nihoUserId);
      if (binding.kind === "ambiguous" || binding.kind === "membership-conflict") return { status: "error" };
      if (binding.kind === "linked" || binding.kind === "already-owner") members = await repository.listHostProviders(nihoUserId);
    }
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
}

/** Normal host reads share one identity and membership projection within a request. */
export const loadHostProviders = cache(loadHostProvidersFresh);

export type Renewal =
  | { outcome: "refreshed"; session: NihoHostSession }
  /** NIHO ended the connection (expired, revoked, or an old refresh token): sign in again. */
  | { outcome: "rejected" }
  /** Try again later. Store `session`: NIHO may already have rotated the refresh token. */
  | { outcome: "unavailable"; session: NihoHostSession };

/**
 * Exchanges the connection's refresh token for a new one and a new NIHO Web access token.
 * Only /host/auth/refresh (serialised by the browser across tabs) and logout call this.
 */
export async function renewSession(session: NihoHostSession): Promise<Renewal> {
  if (isHostMock()) {
    const now = Date.now();
    return { outcome: "refreshed", session: startSession({ ...session, refreshToken: mockToken("mock-refresh-token."), accessToken: mockToken(MOCK_ACCESS_TOKEN_PREFIX), accessTokenExpiresAt: now + MOCK_ACCESS_TOKEN_TTL_MS }, now) };
  }
  const deps = nihoAuthDeps();
  const refreshed = await refreshConnection(deps, session.refreshToken);
  if (!refreshed.ok) return refreshed.reason === "rejected" ? { outcome: "rejected" } : { outcome: "unavailable", session };
  const rotated: NihoHostSession = { ...session, refreshToken: refreshed.value.refreshToken, connectionExpiresAt: refreshed.value.connectionExpiresAt };
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

export function setSessionCookie(response: NextResponse, session: NihoHostSession, now: number) {
  // ResponseCookies keys by name and cannot retain two paths for one name.
  // Serialize the root cookie on a temporary response, then append both raw
  // headers. The sole live cookie stays last for simple cookie parsers.
  const serialized = new NextResponse();
  serialized.cookies.set(SESSION_COOKIE, encodeSession(sessionSealer(), session), hostCookieOptions(SESSION_COOKIE_PATH, sessionMaxAgeSeconds(session, now)));
  response.headers.append("set-cookie", `${SESSION_COOKIE}=; Path=${LEGACY_SESSION_COOKIE_PATH}; Max-Age=0; Secure; HttpOnly; SameSite=Lax`);
  response.headers.append("set-cookie", serialized.headers.get("set-cookie")!);
}

export function clearSessionCookie(response: NextResponse) {
  // Deleting a __Secure- cookie needs the same Secure attribute and path. Clear
  // both the current scope and the one issued before /write shared the login.
  const serialized = new NextResponse();
  serialized.cookies.set(SESSION_COOKIE, "", hostCookieOptions(SESSION_COOKIE_PATH, 0));
  response.headers.append("set-cookie", `${SESSION_COOKIE}=; Path=${LEGACY_SESSION_COOKIE_PATH}; Max-Age=0; Secure; HttpOnly; SameSite=Lax`);
  response.headers.append("set-cookie", serialized.headers.get("set-cookie")!);
}

export function setLoginCookie(response: NextResponse, login: HostLoginState) {
  response.cookies.set(LOGIN_COOKIE, encodeLoginState(loginSealer(), login), hostCookieOptions(LOGIN_COOKIE_PATH, LOGIN_MAX_AGE_SECONDS));
}

export function clearLoginCookie(response: NextResponse) {
  response.cookies.set(LOGIN_COOKIE, "", hostCookieOptions(LOGIN_COOKIE_PATH, 0));
}
