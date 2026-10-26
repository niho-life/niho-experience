import { cleanDisplayName, cleanIconUrl } from "./session";

/**
 * NIHO app-connect (NIHO spec §16) as used by this site's server. Tokens and
 * codes only travel between this server, NIHO and Firebase; nothing here logs them.
 */
export const NIHO_CLIENT_ID = "niho-experience";
const FIREBASE_SIGN_IN_URL = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface NihoAuthDeps {
  fetch: typeof fetch;
  nihoOrigin: string;
  firebaseWebApiKey: string;
  timeoutMs?: number;
}

/** `rejected`: NIHO or Firebase said no (expired code, revoked connection). `unavailable`: try again later. */
export type NihoAuthFailure = "rejected" | "unavailable";
export type NihoAuthResult<T> = { ok: true; value: T } | { ok: false; reason: NihoAuthFailure };

export interface ExchangeResult {
  nihoUserId: string;
  customToken: string;
  refreshToken: string;
  connectionId: string;
  connectionExpiresAt: number;
  displayName: string;
  iconUrl: string | null;
}

export interface RefreshResult {
  customToken: string;
  refreshToken: string;
  connectionExpiresAt: number;
}

export interface IdTokenResult {
  idToken: string;
  idTokenExpiresAt: number;
}

/** NIHO's confirmation page for this site. */
export function nihoConnectUrl(nihoOrigin: string, params: { challenge: string; state: string; origin: string }): string {
  const url = new URL("/connect/niho-experience", nihoOrigin);
  url.search = new URLSearchParams({ v: "1", challenge: params.challenge, state: params.state, origin: params.origin }).toString();
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
  const result = await postJson(deps, new URL("/api/auth/app-connect/exchange", deps.nihoOrigin).href, { clientId: NIHO_CLIENT_ID, code: input.code, codeVerifier: input.codeVerifier });
  if (!result.ok) return result;
  const body = result.value as Record<string, unknown> | null;
  const user = (body?.user ?? {}) as Record<string, unknown>;
  const connectionExpiresAt = parseTime(body?.connectionExpiresAt);
  if (!isText(body?.customToken) || !isText(body?.refreshToken, 1024) || !isText(body?.connectionId, 256) || !isText(user.id, 128) || !connectionExpiresAt) return { ok: false, reason: "unavailable" };
  return {
    ok: true,
    value: {
      nihoUserId: user.id,
      customToken: body.customToken,
      refreshToken: body.refreshToken,
      connectionId: body.connectionId,
      connectionExpiresAt,
      displayName: cleanDisplayName(user.displayName) || cleanDisplayName(user.handle),
      iconUrl: cleanIconUrl(user.iconImage),
    },
  };
}

/** The refresh token rotates on every call; the caller must store the new one. */
export async function refreshConnection(deps: NihoAuthDeps, refreshToken: string): Promise<NihoAuthResult<RefreshResult>> {
  const result = await postJson(deps, new URL("/api/auth/app-connect/refresh", deps.nihoOrigin).href, { clientId: NIHO_CLIENT_ID, refreshToken });
  if (!result.ok) return result;
  const body = result.value as Record<string, unknown> | null;
  const connectionExpiresAt = parseTime(body?.connectionExpiresAt);
  if (!isText(body?.customToken) || !isText(body?.refreshToken, 1024) || !connectionExpiresAt) return { ok: false, reason: "unavailable" };
  return { ok: true, value: { customToken: body.customToken, refreshToken: body.refreshToken, connectionExpiresAt } };
}

/** Firebase custom token → ID token (1 hour). Firebase's own refresh token is discarded. */
export async function signInWithCustomToken(deps: NihoAuthDeps, customToken: string, now: number): Promise<NihoAuthResult<IdTokenResult>> {
  const url = `${FIREBASE_SIGN_IN_URL}?key=${encodeURIComponent(deps.firebaseWebApiKey)}`;
  const result = await postJson(deps, url, { token: customToken, returnSecureToken: true });
  if (!result.ok) return result;
  const body = result.value as Record<string, unknown> | null;
  const expiresIn = Number(body?.expiresIn);
  if (!isText(body?.idToken) || !Number.isFinite(expiresIn) || expiresIn <= 0) return { ok: false, reason: "unavailable" };
  return { ok: true, value: { idToken: body.idToken, idTokenExpiresAt: now + expiresIn * 1000 } };
}

/** Ends the connection on NIHO (logout). Best effort: the caller clears the cookie either way. */
export async function deleteConnection(deps: NihoAuthDeps, connectionId: string, idToken: string): Promise<boolean> {
  const url = new URL(`/api/auth/app-connections/${encodeURIComponent(connectionId)}`, deps.nihoOrigin);
  url.searchParams.set("reason", "logout");
  try {
    const response = await deps.fetch(url.href, {
      method: "DELETE",
      headers: { authorization: `Bearer ${idToken}` },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}
