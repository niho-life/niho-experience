import "server-only";

/** Server-only consumer of niho-app's dedicated Experience editor connect v1 contract. */
export const EXPERIENCE_EDITOR_CLIENT_ID = "niho-experience-editor";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TOKEN_LENGTH = 8192;

export type ExperienceEditorAuthFailure = "rejected" | "unavailable";
export type ExperienceEditorAuthResult<T> = { ok: true; data: T } | { ok: false; kind: ExperienceEditorAuthFailure };

export interface ExperienceEditorExchange {
  customToken: string;
  refreshToken: string;
  connectionId: string;
  connectionExpiresAt: number;
}

export interface ExperienceEditorRefresh {
  customToken: string;
  refreshToken: string;
  connectionExpiresAt: number;
}

export interface ExperienceEditorVerifiedSession {
  actor: { id: string };
  connection: { id: string; expiresAt: number };
  account: { active: boolean };
}

export interface ExperienceEditorAuthClientOptions {
  nihoWebOrigin: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface ExperienceEditorAuthClient {
  exchangeCode(input: { code: string; codeVerifier: string }): Promise<ExperienceEditorAuthResult<ExperienceEditorExchange>>;
  refreshConnection(refreshToken: string): Promise<ExperienceEditorAuthResult<ExperienceEditorRefresh>>;
  verifySession(idToken: string): Promise<ExperienceEditorAuthResult<ExperienceEditorVerifiedSession>>;
  revokeConnection(refreshToken: string): Promise<boolean>;
}

const isText = (value: unknown, max = MAX_TOKEN_LENGTH): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

function parseTime(value: unknown): number | null {
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) && time > 0 ? time : null;
}

function failureForStatus(status: number): ExperienceEditorAuthFailure {
  return status >= 400 && status < 500 && status !== 408 && status !== 429 ? "rejected" : "unavailable";
}

function safeOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Origin must not contain credentials, path, query or fragment");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Origin must use HTTPS, except loopback HTTP");
  }
  return url.origin;
}

type RequestOptions = Required<Pick<ExperienceEditorAuthClientOptions, "fetch" | "timeoutMs">> & { nihoWebOrigin: string };

async function requestJson(options: RequestOptions, path: string, init: RequestInit): Promise<ExperienceEditorAuthResult<unknown>> {
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

export function experienceEditorConnectUrl(
  nihoWebOrigin: string,
  input: { challenge: string; state: string },
): string {
  const url = new URL("/connect/niho-experience-editor", safeOrigin(nihoWebOrigin));
  url.search = new URLSearchParams({
    v: "1",
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    state: input.state,
  }).toString();
  return url.href;
}

export function createExperienceEditorAuthClient(input: ExperienceEditorAuthClientOptions): ExperienceEditorAuthClient {
  const options: RequestOptions = {
    nihoWebOrigin: safeOrigin(input.nihoWebOrigin),
    fetch: input.fetch ?? fetch,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };

  return {
    async exchangeCode({ code, codeVerifier }) {
      const result = await requestJson(options, "/api/auth/experience-editor-connect/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: EXPERIENCE_EDITOR_CLIENT_ID, code, codeVerifier }),
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
      const result = await requestJson(options, "/api/auth/experience-editor-connect/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: EXPERIENCE_EDITOR_CLIENT_ID, refreshToken }),
      });
      if (!result.ok) return result;
      const body = result.data as Record<string, unknown> | null;
      const connectionExpiresAt = parseTime(body?.connectionExpiresAt);
      if (!isText(body?.customToken) || !isText(body?.refreshToken, 1024) || !connectionExpiresAt) {
        return { ok: false, kind: "unavailable" };
      }
      return { ok: true, data: { customToken: body.customToken, refreshToken: body.refreshToken, connectionExpiresAt } };
    },

    async verifySession(idToken) {
      const result = await requestJson(options, "/api/auth/experience-editor-connect/session", {
        method: "GET",
        headers: { authorization: `Bearer ${idToken}` },
      });
      if (!result.ok) return result;
      const body = result.data as Record<string, unknown> | null;
      const actor = body?.actor as Record<string, unknown> | null;
      const connection = body?.connection as Record<string, unknown> | null;
      const account = body?.account as Record<string, unknown> | null;
      const expiresAt = parseTime(connection?.expiresAt);
      if (!isText(actor?.id, 256) || !isText(connection?.id, 256) || !expiresAt || typeof account?.active !== "boolean") {
        return { ok: false, kind: "unavailable" };
      }
      return {
        ok: true,
        data: { actor: { id: actor.id }, connection: { id: connection.id, expiresAt }, account: { active: account.active } },
      };
    },

    async revokeConnection(refreshToken) {
      try {
        const response = await options.fetch(new URL("/api/auth/experience-editor-connect/revoke", options.nihoWebOrigin), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientId: EXPERIENCE_EDITOR_CLIENT_ID, refreshToken }),
          cache: "no-store",
          redirect: "manual",
          signal: AbortSignal.timeout(options.timeoutMs),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
  };
}
