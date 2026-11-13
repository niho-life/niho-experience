import { cleanDisplayName, cleanIconUrl } from "./session";

/** NIHO app-connect Web flow. API tokens and refresh tokens stay on this server. */
export const NIHO_CLIENT_ID = "niho-experience";
const FIREBASE_SIGN_IN_URL = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface NihoAuthDeps {
  fetch: typeof fetch;
  nihoOrigin: string;
  firebaseWebApiKey?: string;
  timeoutMs?: number;
  /**
   * Experience's service ID token (Google OIDC, the same one the server-to-server contract carries), or null when it cannot be
   * issued. It goes in `X-NIHO-Experience-Service-Id-Token` on the code exchange and the connection's end, so NIHO counts these
   * calls against the Experience service instead of the one IP they all come from (niho-coliving/niho-app#20336). It is
   * never an authorization: a call without it (or with one NIHO cannot verify) is simply counted by IP, as before.
   */
  serviceIdToken?: () => Promise<string | null>;
}

/** The header NIHO reads the service ID token from (the host `identity` call sends the same one). */
export const NIHO_SERVICE_ID_TOKEN_HEADER = "x-niho-experience-service-id-token";

/** The service ID token header for a call, or none: a token that cannot be issued never stops a log in. */
async function serviceIdTokenHeader(deps: NihoAuthDeps): Promise<Record<string, string>> {
  try {
    const token = await deps.serviceIdToken?.();
    return token ? { [NIHO_SERVICE_ID_TOKEN_HEADER]: token } : {};
  } catch {
    return {};
  }
}

/** `rejected`: NIHO or Firebase said no (expired code, revoked connection). `unavailable`: try again later. */
export type NihoAuthFailure = "rejected" | "unavailable";
export type NihoAuthResult<T> = { ok: true; value: T } | { ok: false; reason: NihoAuthFailure };

export interface ExchangeResult {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  connectionId: string;
  connectionExpiresAt: number;
  displayName: string;
  iconUrl: string | null;
  /**
   * When the person signed in at NIHO to start this connection (`authTime` of the exchange answer, a canonical UTC instant;
   * niho-coliving/niho-app#20305), or null when NIHO did not say (a NIHO without that field). The judgment of a recent sign-in
   * is Experience's, made from this and not from the `max_age` that went through the browser in the URL.
   */
  authTimeUtc: string | null;
}

export interface RefreshResult {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  connectionExpiresAt: number;
}

/** Firebase ID token used by the separate Experience Admin console, not by the host console. */
export interface IdTokenResult {
  idToken: string;
  idTokenExpiresAt: number;
}

/**
 * Who the connection page is for (niho-coliving/niho-app#20306: NIHO orders its login methods by it; the host order puts
 * LINE first). The parameter's name and values are NIHO's contract and are not final until that issue closes: change them
 * here and nowhere else.
 */
export const NIHO_CONNECT_AUDIENCE_PARAM = "audience";
export type NihoConnectAudience = "host" | "guest";

/**
 * A traveler's way in (niho-coliving/niho-app#20307): with `audience=guest` and one of these, NIHO goes straight to that
 * provider's own screen, without its login page and without its name in front. Apple has no web sign-in at NIHO yet (the
 * traveler is shown NIHO's usual screen), so the entrance does not offer it (traveler/methods.ts).
 */
export const NIHO_CONNECT_METHODS = ["google", "apple", "line"] as const;
export type NihoConnectMethod = (typeof NIHO_CONNECT_METHODS)[number];

/**
 * How recent a sign-in a step-up asks NIHO for (`max_age`, in seconds; NIHO accepts 60 to 86400): a re-login for a sensitive
 * change, and the binding of a NIHO account. It only makes NIHO ask the person to sign in again when theirs is older: the
 * judgment of "recent" is Experience's, made from the `authTime` the exchange returns (HOST_ACCOUNT_LIMITS.recentAuthenticationMinutes,
 * 30 minutes), since a value in a URL can be changed by the browser's owner. Five minutes leaves most of that window to
 * use once the person is back, where the full 30 would hand them a sign-in that is about to be too old.
 */
export const NIHO_REAUTHENTICATION_MAX_AGE_SECONDS = 300;

/**
 * NIHO's confirmation page for this site. `maxAgeSeconds` asks NIHO to sign the person in again when their last sign-in
 * is older (`max_age`, 60 to 86400 seconds; niho-coliving/niho-app#20305): a sensitive change's re-authentication (#595).
 */
export function nihoConnectUrl(nihoOrigin: string, params: { challenge: string; state: string; origin: string; audience?: NihoConnectAudience; method?: NihoConnectMethod; maxAgeSeconds?: number }): string {
  const url = new URL("/connect/niho-experience", nihoOrigin);
  const search = new URLSearchParams({ v: "1", challenge: params.challenge, state: params.state, origin: params.origin });
  if (params.audience) search.set(NIHO_CONNECT_AUDIENCE_PARAM, params.audience);
  if (params.method) search.set("method", params.method);
  if (params.maxAgeSeconds !== undefined) search.set("max_age", String(params.maxAgeSeconds));
  url.search = search.toString();
  return url.href;
}

const isText = (value: unknown, max = 8192): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

function parseTime(value: unknown): number | null {
  const time = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) && time > 0 ? time : null;
}

async function postJson(deps: NihoAuthDeps, url: string, body: unknown, init: RequestInit = {}): Promise<NihoAuthResult<unknown>> {
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: "POST",
      ...init,
      headers: { "content-type": "application/json", accept: "application/json", ...(init.headers as Record<string, string> | undefined) },
      body: JSON.stringify(body),
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  // Timeouts and rate limits are temporary; other 4xx mean the code or connection is no longer valid.
  if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) return { ok: false, reason: "rejected" };
  if (!response.ok) return { ok: false, reason: "unavailable" };
  try {
    return { ok: true, value: (await response.json()) as unknown };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

export async function exchangeCode(deps: NihoAuthDeps, input: { code: string; codeVerifier: string }): Promise<NihoAuthResult<ExchangeResult>> {
  const result = await postJson(deps, new URL("/api/auth/app-connect/exchange", deps.nihoOrigin).href, { clientId: NIHO_CLIENT_ID, code: input.code, codeVerifier: input.codeVerifier }, { headers: await serviceIdTokenHeader(deps) });
  if (!result.ok) return result;
  const body = result.value as Record<string, unknown> | null;
  const user = (body?.user ?? {}) as Record<string, unknown>;
  const accessTokenExpiresAt = parseTime(body?.expiresAt);
  const connectionExpiresAt = parseTime(body?.connectionExpiresAt);
  if (!isText(body?.accessToken) || !accessTokenExpiresAt || !isText(body?.refreshToken, 1024) || !isText(body?.connectionId, 256) || !connectionExpiresAt) return { ok: false, reason: "unavailable" };
  const authTime = parseTime(body?.authTime);
  return {
    ok: true,
    value: {
      authTimeUtc: authTime ? new Date(authTime).toISOString() : null,
      accessToken: body.accessToken,
      accessTokenExpiresAt,
      refreshToken: body.refreshToken,
      connectionId: body.connectionId,
      connectionExpiresAt,
      displayName: cleanDisplayName(user.displayName),
      iconUrl: cleanIconUrl(user.iconImage),
    },
  };
}

/** The refresh token rotates on every call; the caller must store the new one. */
export async function refreshConnection(deps: NihoAuthDeps, refreshToken: string): Promise<NihoAuthResult<RefreshResult>> {
  const result = await postJson(deps, new URL("/api/auth/app-connect/refresh", deps.nihoOrigin).href, { clientId: NIHO_CLIENT_ID, refreshToken });
  if (!result.ok) return result;
  const body = result.value as Record<string, unknown> | null;
  const accessTokenExpiresAt = parseTime(body?.expiresAt);
  const connectionExpiresAt = parseTime(body?.connectionExpiresAt);
  if (!isText(body?.accessToken) || !accessTokenExpiresAt || !isText(body?.refreshToken, 1024) || !connectionExpiresAt) return { ok: false, reason: "unavailable" };
  return { ok: true, value: { accessToken: body.accessToken, accessTokenExpiresAt, refreshToken: body.refreshToken, connectionExpiresAt } };
}

/** Admin-only legacy exchange; the NIHO Experience host uses the scoped Web access token above. */
export async function signInWithCustomToken(deps: NihoAuthDeps, customToken: string, now: number): Promise<NihoAuthResult<IdTokenResult>> {
  if (!deps.firebaseWebApiKey) return { ok: false, reason: "unavailable" };
  const url = `${FIREBASE_SIGN_IN_URL}?key=${encodeURIComponent(deps.firebaseWebApiKey)}`;
  const result = await postJson(deps, url, { token: customToken, returnSecureToken: true });
  if (!result.ok) return result;
  const body = result.value as Record<string, unknown> | null;
  const expiresIn = Number(body?.expiresIn);
  if (!isText(body?.idToken) || !Number.isFinite(expiresIn) || expiresIn <= 0) return { ok: false, reason: "unavailable" };
  return { ok: true, value: { idToken: body.idToken, idTokenExpiresAt: now + expiresIn * 1000 } };
}

/**
 * Ends the connection on NIHO. Best effort: the caller clears the cookie either way. A logout says so (`reason=logout`);
 * the sign-in that only proves who the person is ends its connection with no reason at all (`reason: null`), the plain
 * `DELETE /api/auth/app-connections/{id}` NIHO's identity-only scope allows.
 */
export async function deleteConnection(deps: NihoAuthDeps, connectionId: string, accessToken: string, options: { reason?: "logout" | null } = {}): Promise<boolean> {
  const url = new URL(`/api/auth/app-connections/${encodeURIComponent(connectionId)}`, deps.nihoOrigin);
  if (options.reason !== null) url.searchParams.set("reason", "logout");
  try {
    const response = await deps.fetch(url.href, {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}`, ...await serviceIdTokenHeader(deps) },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}
