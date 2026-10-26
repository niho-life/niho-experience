import "server-only";
import { normalizeOrigin, type FetchLike } from "../client.ts";
import {
  decodeExperiencePreparationAcceptance,
  decodeExperiencePreparationDraft,
  decodeExperiencePreparationEditorPatch,
  decodeExperiencePreparationErrorReason,
  decodeExperiencePreparationLockedAcceptance,
  decodeExperiencePreparationUploadPolicyInput,
  isExperiencePreparationCorrection,
  isExperiencePreparationPathId,
  isExperiencePreparationSchema,
  isExperiencePreparationSearch,
} from "./schema.ts";
import type {
  ExperiencePreparationAcceptanceInput,
  ExperiencePreparationAcceptanceResponse,
  ExperiencePreparationAdminCaseDetail,
  ExperiencePreparationAdminCaseResponse,
  ExperiencePreparationAssignmentCandidatesResponse,
  ExperiencePreparationAssignmentResponse,
  ExperiencePreparationCancelledResponse,
  ExperiencePreparationCaseListResponse,
  ExperiencePreparationCorrectionResponse,
  ExperiencePreparationDraft,
  ExperiencePreparationEditorPatchInput,
  ExperiencePreparationFailure,
  ExperiencePreparationHostCaseListResponse,
  ExperiencePreparationHostCaseResponse,
  ExperiencePreparationLockedAcceptanceInput,
  ExperiencePreparationMaterializeResponse,
  ExperiencePreparationPreviewToken,
  ExperiencePreparationReadinessResponse,
  ExperiencePreparationResult,
  ExperiencePreparationReview,
  ExperiencePreparationRevokedResponse,
  ExperiencePreparationRole,
  ExperiencePreparationUploadPolicy,
  ExperiencePreparationUploadPolicyInput,
} from "./types.ts";

type JsonObject = Record<string, unknown>;
type Decoder<T> = (value: unknown) => T | null;
const API_ROOT = "/api/experience-preparations";
const TOKEN = /^[\x21-\x7e]{1,8192}$/;
const REVIEW_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_TIMEOUT_MS = 10_000;

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: JsonObject, keys: readonly string[]) => Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
const schema = <T>(name: string): Decoder<T> => (value) => isExperiencePreparationSchema<T>(name, value) ? value : null;
const wrapped = <T>(key: string, name: string): Decoder<Record<string, T>> => (value) => {
  if (!isObject(value) || !exact(value, [key]) || !isExperiencePreparationSchema<T>(name, value[key])) return null;
  return { [key]: value[key] } as Record<string, T>;
};
const listWrapped = <T>(key: string, name: string, max = 100): Decoder<Record<string, T[]>> => (value) => {
  if (!isObject(value) || !exact(value, [key]) || !Array.isArray(value[key]) || value[key].length > max) return null;
  if (!value[key].every((item) => isExperiencePreparationSchema<T>(name, item))) return null;
  return { [key]: value[key] } as Record<string, T[]>;
};

function pathId(value: string): string | null {
  if (!isExperiencePreparationPathId(value)) return null;
  try { return encodeURIComponent(value); } catch { return null; }
}

function tokenBody(token: string): { token: string } | null {
  return REVIEW_TOKEN.test(token) ? { token } : null;
}

interface BaseOptions { nihoWebOrigin: string; fetch?: FetchLike; timeoutMs?: number }
interface AuthOptions extends BaseOptions { idToken: string }

function requester(input: BaseOptions, idToken?: string) {
  const origin = normalizeOrigin(input.nihoWebOrigin);
  if (idToken !== undefined && !TOKEN.test(idToken)) throw new Error("Experience preparation idToken cannot be sent in Authorization");
  const send = input.fetch ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async function request<T>(path: string, init: RequestInit, decode: Decoder<T>, emptyStatus?: number): Promise<ExperiencePreparationResult<T>> {
    let response: Response;
    try {
      response = await send(new URL(`${API_ROOT}${path}`, origin).href, {
        ...init,
        headers: {
          accept: "application/json",
          ...(idToken ? { authorization: `Bearer ${idToken}` } : {}),
          ...(init.headers as Record<string, string> | undefined),
        },
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
      if (response.status === 409 || response.status === 422) {
        let body: unknown = null;
        try { body = await response.json() as unknown; } catch { /* closed response */ }
        const reason = decodeExperiencePreparationErrorReason(body);
        return response.status === 409 ? { ok: false, kind: "conflict", reason } : { ok: false, kind: "unprocessable", reason };
      }
      return { ok: false, kind: "unexpected_response", status: response.status };
    }
    if (emptyStatus && response.status === emptyStatus) return { ok: true, data: undefined as T };
    let body: unknown;
    try { body = await response.json() as unknown; } catch { return { ok: false, kind: "unexpected_response", status: response.status }; }
    const decoded = decode(body);
    return decoded === null ? { ok: false, kind: "unexpected_response", status: response.status } : { ok: true, data: decoded };
  };
}

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export function createExperiencePreparationReviewApiClient(input: BaseOptions) {
  const request = requester(input);
  return {
    review(reviewToken: string): Promise<ExperiencePreparationResult<ExperiencePreparationReview>> {
      const body = tokenBody(reviewToken);
      return body ? request("/review", json("POST", body), schema("ReviewResponse")) : Promise.resolve({ ok: false, kind: "invalid_request" });
    },
    requestCorrection(reviewToken: string, message: string): Promise<ExperiencePreparationResult<ExperiencePreparationCorrectionResponse>> {
      const body = tokenBody(reviewToken);
      if (!body || !isExperiencePreparationCorrection(message)) return Promise.resolve({ ok: false, kind: "invalid_request" });
      return request("/review/correction-requests", json("POST", { token: body.token, message: message.trim() }), wrapped("request", "CorrectionCreated") as Decoder<ExperiencePreparationCorrectionResponse>);
    },
  };
}

export function createExperiencePreparationHostApiClient(input: AuthOptions) {
  const request = requester(input, input.idToken);
  return {
    listCases: () => request("/host/cases", { method: "GET" }, listWrapped("cases", "HostCase") as Decoder<ExperiencePreparationHostCaseListResponse>),
    getCase(caseId: string) {
      const id = pathId(caseId);
      return id ? request(`/host/cases/${id}`, { method: "GET" }, wrapped("case", "HostCase") as Decoder<ExperiencePreparationHostCaseResponse>) : Promise.resolve({ ok: false, kind: "invalid_request" } as const);
    },
    patchDraft(caseId: string, body: ExperiencePreparationEditorPatchInput) {
      const id = pathId(caseId);
      const decoded = decodeExperiencePreparationEditorPatch(body);
      return id && decoded ? request(`/host/cases/${id}`, json("PATCH", decoded), wrapped("case", "HostCase") as Decoder<ExperiencePreparationHostCaseResponse>) : Promise.resolve({ ok: false, kind: "invalid_request" } as const);
    },
    accept(caseId: string, body: ExperiencePreparationAcceptanceInput) {
      const id = pathId(caseId);
      const decoded = decodeExperiencePreparationAcceptance(body);
      return id && decoded ? request(`/host/cases/${id}/accept`, json("POST", decoded), wrapped("acceptance", "MyAcceptance") as Decoder<ExperiencePreparationAcceptanceResponse>) : Promise.resolve({ ok: false, kind: "invalid_request" } as const);
    },
    requestCorrection(caseId: string, message: string) {
      const id = pathId(caseId);
      return id && isExperiencePreparationCorrection(message) ? request(`/host/cases/${id}/correction-requests`, json("POST", { message: message.trim() }), wrapped("request", "CorrectionCreated") as Decoder<ExperiencePreparationCorrectionResponse>) : Promise.resolve({ ok: false, kind: "invalid_request" } as const);
    },
    revokeAcceptance(caseId: string) {
      const id = pathId(caseId);
      return id ? request(`/host/cases/${id}/revoke-acceptance`, { method: "POST" }, (value) => isObject(value) && exact(value, ["revoked"]) && value.revoked === true ? value as ExperiencePreparationRevokedResponse : null) : Promise.resolve({ ok: false, kind: "invalid_request" } as const);
    },
    readiness(caseId: string) {
      const id = pathId(caseId);
      return id ? request(`/host/cases/${id}/readiness`, { method: "GET" }, wrapped("readiness", "Readiness") as Decoder<ExperiencePreparationReadinessResponse>) : Promise.resolve({ ok: false, kind: "invalid_request" } as const);
    },
  };
}

export function createExperiencePreparationAdminApiClient(input: AuthOptions) {
  const request = requester(input, input.idToken);
  return {
    listCases: () => request("/admin/cases", { method: "GET" }, listWrapped("cases", "AdminCaseListItem") as Decoder<ExperiencePreparationCaseListResponse>),
    createCase(draft: ExperiencePreparationDraft) {
      const decoded = decodeExperiencePreparationDraft(draft);
      return decoded ? request("/admin/cases", json("POST", { draft: decoded }), wrapped("case", "AdminCase") as Decoder<ExperiencePreparationAdminCaseResponse>) : Promise.resolve({ ok: false, kind: "invalid_request" } as const);
    },
    searchAssignmentCandidates(query: string) {
      if (!isExperiencePreparationSearch(query)) return Promise.resolve({ ok: false, kind: "invalid_request" } as const);
      return request(`/admin/assignment-candidates?q=${encodeURIComponent(query.trim())}`, { method: "GET" }, listWrapped("candidates", "UserLabel", 20) as Decoder<ExperiencePreparationAssignmentCandidatesResponse>);
    },
    getCase(caseId: string) {
      const id = pathId(caseId);
      return id ? request(`/admin/cases/${id}`, { method: "GET" }, schema<ExperiencePreparationAdminCaseDetail>("AdminCaseDetailResponse")) : Promise.resolve({ ok: false, kind: "invalid_request" } as const);
    },
    patchCase(caseId: string, expectedRevision: number, draft: ExperiencePreparationDraft) {
      const id = pathId(caseId);
      const decoded = decodeExperiencePreparationDraft(draft);
      if (!id || !decoded || !Number.isInteger(expectedRevision) || expectedRevision < 1) return Promise.resolve({ ok: false, kind: "invalid_request" } as const);
      return request(`/admin/cases/${id}`, json("PATCH", { expectedRevision, draft: decoded }), wrapped("case", "AdminCase") as Decoder<ExperiencePreparationAdminCaseResponse>);
    },
    issuePreviewToken(caseId: string) {
      const id = pathId(caseId);
      return id ? request(`/admin/cases/${id}/preview-tokens`, { method: "POST" }, schema("PreviewTokenResponse") as Decoder<ExperiencePreparationPreviewToken>) : Promise.resolve({ ok: false, kind: "invalid_request" } as const);
    },
    createUploadPolicy(caseId: string, body: ExperiencePreparationUploadPolicyInput) {
      const id = pathId(caseId);
      const decoded = decodeExperiencePreparationUploadPolicyInput(body);
      return id && decoded ? request(`/admin/cases/${id}/uploads/policies`, json("POST", decoded), schema("UploadPolicyResponse") as Decoder<ExperiencePreparationUploadPolicy>) : Promise.resolve({ ok: false, kind: "invalid_request" } as const);
    },
    assign(caseId: string, userId: string, role: ExperiencePreparationRole) {
      const id = pathId(caseId); const user = pathId(userId);
      if (!id || !user || (role !== "DRAFT_EDITOR" && role !== "COORDINATOR")) return Promise.resolve({ ok: false, kind: "invalid_request" } as const);
      return request(`/admin/cases/${id}/assignments/${user}`, json("PUT", { role }), wrapped("assignment", "Assignment") as Decoder<ExperiencePreparationAssignmentResponse>);
    },
    removeAssignment(caseId: string, userId: string) {
      const id = pathId(caseId); const user = pathId(userId);
      return id && user ? request<void>(`/admin/cases/${id}/assignments/${user}`, { method: "DELETE" }, () => null, 204) : Promise.resolve({ ok: false, kind: "invalid_request" } as const);
    },
    verifyRepresentative(caseId: string, body: ExperiencePreparationLockedAcceptanceInput) {
      const id = pathId(caseId); const decoded = decodeExperiencePreparationLockedAcceptance(body);
      return id && decoded ? request(`/admin/cases/${id}/representative-verification`, json("POST", decoded), wrapped("case", "AdminCase") as Decoder<ExperiencePreparationAdminCaseResponse>) : Promise.resolve({ ok: false, kind: "invalid_request" } as const);
    },
    materialize(caseId: string, body: ExperiencePreparationLockedAcceptanceInput) {
      const id = pathId(caseId); const decoded = decodeExperiencePreparationLockedAcceptance(body);
      return id && decoded ? request(`/admin/cases/${id}/materialize`, json("POST", decoded), wrapped("materialized", "MaterializeResult") as Decoder<ExperiencePreparationMaterializeResponse>) : Promise.resolve({ ok: false, kind: "invalid_request" } as const);
    },
    cancel(caseId: string) {
      const id = pathId(caseId);
      return id ? request(`/admin/cases/${id}/cancel`, { method: "POST" }, (value) => isObject(value) && exact(value, ["cancelled", "materialized"]) && value.cancelled === true && typeof value.materialized === "boolean" ? value as ExperiencePreparationCancelledResponse : null) : Promise.resolve({ ok: false, kind: "invalid_request" } as const);
    },
    purge(caseId: string) {
      const id = pathId(caseId);
      return id ? request<void>(`/admin/cases/${id}`, { method: "DELETE" }, () => null, 204) : Promise.resolve({ ok: false, kind: "invalid_request" } as const);
    },
  };
}

export type ExperiencePreparationReviewApiClient = ReturnType<typeof createExperiencePreparationReviewApiClient>;
export type ExperiencePreparationHostApiClient = ReturnType<typeof createExperiencePreparationHostApiClient>;
export type ExperiencePreparationAdminApiClient = ReturnType<typeof createExperiencePreparationAdminApiClient>;
export type { ExperiencePreparationFailure };
