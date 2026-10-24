import { normalizeOrigin, type FetchLike } from "../client.ts";
import {
  decodeExperienceAdminSupportAdminListResponse,
  decodeExperienceAdminSupportCaseConflictReason,
  decodeExperienceAdminSupportCasePatchRequest,
  decodeExperienceAdminSupportCasePatchResponse,
  decodeExperienceAdminSupportCaseReadResponse,
  isExperienceAdminSupportCasePathId,
} from "./schema.ts";
import type {
  ExperienceAdminSupportAdminListResponse,
  ExperienceAdminSupportCaseConflictReason,
  ExperienceAdminSupportCasePatchRequest,
  ExperienceAdminSupportCasePatchResponse,
  ExperienceAdminSupportCaseReadResponse,
} from "./types.ts";

export interface ExperienceAdminSupportCaseApiClientOptions {
  nihoWebOrigin: string;
  /** Current dedicated Experience Admin ID token. Never pass it to browser code. */
  idToken: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export type ExperienceAdminSupportCaseFailure =
  | { ok: false; kind: "invalid_request" }
  | { ok: false; kind: "rejected"; status: 401 | 403 }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "conflict"; reason: ExperienceAdminSupportCaseConflictReason }
  | { ok: false; kind: "network_error" }
  | { ok: false; kind: "unexpected_response"; status: number };

export type ExperienceAdminSupportCaseResult<T> = { ok: true; data: T } | ExperienceAdminSupportCaseFailure;

export interface ExperienceAdminSupportCaseApiClient {
  getSupportCase(requestId: string): Promise<ExperienceAdminSupportCaseResult<ExperienceAdminSupportCaseReadResponse>>;
  patchSupportCase(requestId: string, body: ExperienceAdminSupportCasePatchRequest): Promise<ExperienceAdminSupportCaseResult<ExperienceAdminSupportCasePatchResponse>>;
  listSupportAdmins(): Promise<ExperienceAdminSupportCaseResult<ExperienceAdminSupportAdminListResponse>>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const TOKEN = /^[\x21-\x7e]{1,8192}$/;

function fixedRequestPath(requestId: string): string | null {
  if (!isExperienceAdminSupportCasePathId(requestId)) return null;
  try {
    return `/api/admin/experience-bookings/${encodeURIComponent(requestId)}/support-case`;
  } catch {
    return null;
  }
}

export function createExperienceAdminSupportCaseApiClient(input: ExperienceAdminSupportCaseApiClientOptions): ExperienceAdminSupportCaseApiClient {
  const origin = normalizeOrigin(input.nihoWebOrigin);
  if (!TOKEN.test(input.idToken)) throw new Error("Admin idToken contains characters that cannot be sent in Authorization");
  const request = input.fetch ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function requestJson<T>(path: string, init: RequestInit, decode: (value: unknown) => T | null): Promise<ExperienceAdminSupportCaseResult<T>> {
    let response: Response;
    try {
      response = await request(new URL(path, origin).href, {
        ...init,
        headers: { accept: "application/json", authorization: `Bearer ${input.idToken}`, ...(init.headers as Record<string, string> | undefined) },
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { ok: false, kind: "network_error" };
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) return { ok: false, kind: "rejected", status: response.status };
      if (response.status === 404) return { ok: false, kind: "not_found" };
      if (response.status === 409) {
        let body: unknown;
        try { body = await response.json() as unknown; } catch { return { ok: false, kind: "unexpected_response", status: 409 }; }
        const reason = decodeExperienceAdminSupportCaseConflictReason(body);
        return reason ? { ok: false, kind: "conflict", reason } : { ok: false, kind: "unexpected_response", status: 409 };
      }
      return { ok: false, kind: "unexpected_response", status: response.status };
    }
    let body: unknown;
    try { body = await response.json() as unknown; } catch { return { ok: false, kind: "unexpected_response", status: response.status }; }
    const decoded = decode(body);
    return decoded ? { ok: true, data: decoded } : { ok: false, kind: "unexpected_response", status: response.status };
  }

  function requestCase<T>(requestId: string, init: RequestInit, decode: (value: unknown) => T | null) {
    const path = fixedRequestPath(requestId);
    return path ? requestJson(path, init, decode) : Promise.resolve({ ok: false, kind: "invalid_request" } as const);
  }

  return {
    async getSupportCase(requestId) {
      const result = await requestCase(requestId, { method: "GET" }, decodeExperienceAdminSupportCaseReadResponse);
      if (result.ok && result.data.supportCase.bookingRequestId !== requestId) return { ok: false, kind: "unexpected_response", status: 200 };
      return result;
    },
    async patchSupportCase(requestId, body) {
      const decoded = decodeExperienceAdminSupportCasePatchRequest(body);
      if (!decoded) return { ok: false, kind: "invalid_request" };
      const result = await requestCase(requestId, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(decoded) }, decodeExperienceAdminSupportCasePatchResponse);
      if (result.ok && result.data.supportCase.bookingRequestId !== requestId) return { ok: false, kind: "unexpected_response", status: 200 };
      return result;
    },
    listSupportAdmins() {
      return requestJson("/api/admin/experience-support-admins", { method: "GET" }, decodeExperienceAdminSupportAdminListResponse);
    },
  };
}
