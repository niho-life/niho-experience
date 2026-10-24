export const EXPERIENCE_ADMIN_CLIENT_ID = "niho-experience-admin";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TOKEN_LENGTH = 8192;

export type ExperienceAdminAuthFailure = "rejected" | "unavailable";
export type ExperienceAdminAuthResult<T> = { ok: true; data: T } | { ok: false; kind: ExperienceAdminAuthFailure };

export interface ExperienceAdminExchange {
  customToken: string;
  refreshToken: string;
  connectionId: string;
  connectionExpiresAt: number;
}

export interface ExperienceAdminRefresh {
  customToken: string;
  refreshToken: string;
  connectionExpiresAt: number;
}

export interface ExperienceAdminActor {
  id: string;
  displayName: string | null;
}

export interface ExperienceAdminConnection {
  id: string;
  expiresAt: number;
}

export interface ExperienceAdminVerifiedSession {
  actor: ExperienceAdminActor;
  connection: ExperienceAdminConnection;
}

export interface ExperienceAdminAuthClientOptions {
  nihoWebOrigin: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface ExperienceAdminAuthClient {
  exchangeCode(input: { code: string; codeVerifier: string }): Promise<ExperienceAdminAuthResult<ExperienceAdminExchange>>;
  refreshConnection(refreshToken: string): Promise<ExperienceAdminAuthResult<ExperienceAdminRefresh>>;
  verifySession(idToken: string): Promise<ExperienceAdminAuthResult<ExperienceAdminVerifiedSession>>;
  deleteConnection(connectionId: string, idToken: string): Promise<boolean>;
}

const isText = (value: unknown, max = MAX_TOKEN_LENGTH): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

function parseTime(value: unknown): number | null {
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) && time > 0 ? time : null;
}

function failureForStatus(status: number): ExperienceAdminAuthFailure {
  return status >= 400 && status < 500 && status !== 408 && status !== 429 ? "rejected" : "unavailable";
}

function safeOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Origin must not contain credentials, path, query or fragment");
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("Origin must use HTTPS, except loopback HTTP");
  return url.origin;
}

async function requestJson(options: Required<Pick<ExperienceAdminAuthClientOptions, "fetch" | "timeoutMs">> & { nihoWebOrigin: string }, path: string, init: RequestInit): Promise<ExperienceAdminAuthResult<unknown>> {
  try {
    const response = await options.fetch(new URL(path, options.nihoWebOrigin), {
      ...init,
      headers: { accept: "application/json", ...(init.headers as Record<string, string> | undefined) },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) return { ok: false, kind: failureForStatus(response.status) };
    return { ok: true, data: await response.json() as unknown };
  } catch {
    return { ok: false, kind: "unavailable" };
  }
}

export function experienceAdminConnectUrl(nihoWebOrigin: string, input: { challenge: string; state: string; redirectOrigin: string }): string {
  const url = new URL("/connect/niho-experience-admin", safeOrigin(nihoWebOrigin));
  url.search = new URLSearchParams({
    v: "1",
    challenge: input.challenge,
    state: input.state,
    origin: safeOrigin(input.redirectOrigin),
  }).toString();
  return url.href;
}

export function createExperienceAdminAuthClient(input: ExperienceAdminAuthClientOptions): ExperienceAdminAuthClient {
  const options = {
    nihoWebOrigin: safeOrigin(input.nihoWebOrigin),
    fetch: input.fetch ?? fetch,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };

  return {
    async exchangeCode({ code, codeVerifier }) {
      const result = await requestJson(options, "/api/auth/app-connect/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: EXPERIENCE_ADMIN_CLIENT_ID, code, codeVerifier }),
      });
      if (!result.ok) return result;
      const body = result.data as Record<string, unknown> | null;
      const connectionExpiresAt = parseTime(body?.connectionExpiresAt);
      if (!isText(body?.customToken) || !isText(body?.refreshToken, 1024) || !isText(body?.connectionId, 256) || !connectionExpiresAt) {
        return { ok: false, kind: "unavailable" };
      }
      return { ok: true, data: { customToken: body.customToken, refreshToken: body.refreshToken, connectionId: body.connectionId, connectionExpiresAt } };
    },

    async refreshConnection(refreshToken) {
      const result = await requestJson(options, "/api/auth/app-connect/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: EXPERIENCE_ADMIN_CLIENT_ID, refreshToken }),
      });
      if (!result.ok) return result;
      const body = result.data as Record<string, unknown> | null;
      const connectionExpiresAt = parseTime(body?.connectionExpiresAt);
      if (!isText(body?.customToken) || !isText(body?.refreshToken, 1024) || !connectionExpiresAt) return { ok: false, kind: "unavailable" };
      return { ok: true, data: { customToken: body.customToken, refreshToken: body.refreshToken, connectionExpiresAt } };
    },

    async verifySession(idToken) {
      const result = await requestJson(options, "/api/auth/app-connect/experience-admin/session", {
        method: "GET",
        headers: { authorization: `Bearer ${idToken}` },
      });
      if (!result.ok) return result;
      const body = result.data as Record<string, unknown> | null;
      const actor = body?.actor as Record<string, unknown> | null;
      const connection = body?.connection as Record<string, unknown> | null;
      const expiresAt = parseTime(connection?.expiresAt);
      if (!isText(actor?.id, 256) || !(actor.displayName === null || typeof actor.displayName === "string") || !isText(connection?.id, 256) || !expiresAt) {
        return { ok: false, kind: "unavailable" };
      }
      const displayName = typeof actor.displayName === "string" ? actor.displayName.replace(/\s+/g, " ").trim().slice(0, 80) || null : null;
      return { ok: true, data: { actor: { id: actor.id, displayName }, connection: { id: connection.id, expiresAt } } };
    },

    async deleteConnection(connectionId, idToken) {
      const url = new URL(`/api/auth/app-connections/${encodeURIComponent(connectionId)}`, options.nihoWebOrigin);
      url.searchParams.set("reason", "logout");
      try {
        const response = await options.fetch(url, {
          method: "DELETE",
          headers: { authorization: `Bearer ${idToken}` },
          cache: "no-store",
          redirect: "manual",
          signal: AbortSignal.timeout(options.timeoutMs),
        });
        // 404 means the connection is already gone. A 401 can also be an expired
        // ID token while the remote connection remains, so it is not confirmation.
        return response.ok || response.status === 404;
      } catch {
        return false;
      }
    },
  };
}
