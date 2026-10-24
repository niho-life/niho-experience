import { normalizeOrigin, type FetchLike } from "../client.ts";
import { decodeExperienceAdminOperationRequest, decodeExperienceAdminSupportOperationDetailResponse, decodeExperienceAdminSupportOperationError, decodeExperienceAdminSupportOperationSnapshotResponse, isExperienceAdminOperationId, isExperienceAdminOperationsPathId } from "./schema.ts";
import type { ExperienceAdminOperationAction, ExperienceAdminOperationRequest, ExperienceAdminSupportOperationDetailResponse, ExperienceAdminSupportOperationSnapshotResponse } from "./types.ts";

export interface ExperienceAdminOperationsApiClientOptions { nihoWebOrigin: string; idToken: string; fetch?: FetchLike; timeoutMs?: number }
export type ExperienceAdminOperationsConflictReason = "REVISION_CONFLICT" | "BOOKING_SNAPSHOT_CHANGED" | "ACTION_NOT_ALLOWED" | "APPROVAL_EXPIRED" | "REFUND_SNAPSHOT_CHANGED";
export type ExperienceAdminOperationsFailure = { ok: false; kind: "invalid_request" } | { ok: false; kind: "rejected"; status: 401 | 403 } | { ok: false; kind: "not_found" } | { ok: false; kind: "conflict"; reason: ExperienceAdminOperationsConflictReason } | { ok: false; kind: "operation_id_reused" } | { ok: false; kind: "network_error" } | { ok: false; kind: "unexpected_response"; status: number };
export type ExperienceAdminOperationsResult<T> = { ok: true; data: T; status: number } | ExperienceAdminOperationsFailure;
export interface ExperienceAdminOperationsApiClient {
  getSnapshot(bookingId: string): Promise<ExperienceAdminOperationsResult<ExperienceAdminSupportOperationSnapshotResponse>>;
  getOperation(bookingId: string, operationId: string): Promise<ExperienceAdminOperationsResult<ExperienceAdminSupportOperationDetailResponse>>;
  execute(bookingId: string, action: ExperienceAdminOperationAction, body: ExperienceAdminOperationRequest): Promise<ExperienceAdminOperationsResult<ExperienceAdminSupportOperationDetailResponse>>;
}
const TOKEN = /^[\x21-\x7e]{1,8192}$/;
const PATHS: Record<ExperienceAdminOperationAction, string> = { APPROVE: "approve", DECLINE: "decline", CANCEL: "cancel", MESSAGE: "message" };

export function createExperienceAdminOperationsApiClient(input: ExperienceAdminOperationsApiClientOptions): ExperienceAdminOperationsApiClient {
  const origin = normalizeOrigin(input.nihoWebOrigin); if (!TOKEN.test(input.idToken)) throw new Error("Admin idToken contains characters that cannot be sent in Authorization");
  const request = input.fetch ?? fetch; const timeoutMs = input.timeoutMs ?? 10_000;
  async function json<T>(path: string, init: RequestInit, decode: (value: unknown) => T | null): Promise<ExperienceAdminOperationsResult<T>> {
    let response: Response; try { response = await request(new URL(path, origin).href, { ...init, headers: { accept: "application/json", authorization: `Bearer ${input.idToken}`, ...(init.headers as Record<string, string> | undefined) }, cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) }); } catch { return { ok: false, kind: "network_error" }; }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) return { ok: false, kind: "rejected", status: response.status };
      if (response.status === 404) return { ok: false, kind: "not_found" };
      if (response.status === 409) {
        let value: unknown; try { value = await response.json() as unknown; } catch { return { ok: false, kind: "unexpected_response", status: response.status }; }
        const error = decodeExperienceAdminSupportOperationError(value);
        const reason = error?.error.code === "CONFLICT" && Object.keys(error.error.details).length === 1 ? error.error.details.reason : null;
        if (reason === "OPERATION_ID_REUSED") return { ok: false, kind: "operation_id_reused" };
        if (reason === "REVISION_CONFLICT" || reason === "BOOKING_SNAPSHOT_CHANGED" || reason === "ACTION_NOT_ALLOWED" || reason === "APPROVAL_EXPIRED" || reason === "REFUND_SNAPSHOT_CHANGED") return { ok: false, kind: "conflict", reason };
      }
      return { ok: false, kind: "unexpected_response", status: response.status };
    }
    let value: unknown; try { value = await response.json() as unknown; } catch { return { ok: false, kind: "unexpected_response", status: response.status }; }
    const data = decode(value); return data ? { ok: true, data, status: response.status } : { ok: false, kind: "unexpected_response", status: response.status };
  }
  const base = (bookingId: string) => isExperienceAdminOperationsPathId(bookingId) ? `/api/admin/experience-bookings/${encodeURIComponent(bookingId)}` : null;
  return {
    async getSnapshot(bookingId) { const path = base(bookingId); const result = path ? await json(`${path}/support-operations`, { method: "GET" }, decodeExperienceAdminSupportOperationSnapshotResponse) : { ok: false, kind: "invalid_request" } as const; if (result.ok && (result.data.booking.bookingRequestId !== bookingId || result.data.operations.some((operation) => operation.bookingRequestId !== bookingId))) return { ok: false, kind: "unexpected_response", status: 200 }; return result; },
    async getOperation(bookingId, operationId) { const path = base(bookingId); if (!path || !isExperienceAdminOperationId(operationId)) return { ok: false, kind: "invalid_request" }; const result = await json(`${path}/support-operations/${operationId}`, { method: "GET" }, decodeExperienceAdminSupportOperationDetailResponse); if (result.ok && (result.data.operation.bookingRequestId !== bookingId || result.data.operation.operationId.toLowerCase() !== operationId.toLowerCase())) return { ok: false, kind: "unexpected_response", status: 200 }; return result; },
    async execute(bookingId, action, body) { const path = base(bookingId); const decoded = decodeExperienceAdminOperationRequest(action, body); if (!path || !decoded) return { ok: false, kind: "invalid_request" }; const result = await json(`${path}/${PATHS[action]}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(decoded) }, decodeExperienceAdminSupportOperationDetailResponse); if (result.ok && (result.data.operation.bookingRequestId !== bookingId || result.data.operation.operationId.toLowerCase() !== decoded.operationId.toLowerCase() || result.data.operation.action !== action)) return { ok: false, kind: "unexpected_response", status: result.status }; return result; },
  };
}
