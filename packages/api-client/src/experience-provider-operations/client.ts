import "server-only";
import { normalizeOrigin, type FetchLike } from "../client.ts";
import {
  decodeExperienceProviderPutMemberInput,
  decodeExperienceProviderResolveMemberInput,
  isExperienceProviderOperationPathId,
  isExperienceProviderOperationsSchema,
} from "./schema.ts";
import type { ExperienceProviderMemberListResponse, ExperienceProviderMemberResponse, ExperienceProviderOperationsResult, ExperienceProviderPutMemberInput, ExperienceProviderResolveMemberInput, ExperienceProviderResolveMemberResponse } from "./types.ts";

type Decoder<T> = (value: unknown) => T | null;
type BaseOptions = { nihoWebOrigin: string; accessToken: string; fetch?: FetchLike; timeoutMs?: number };
const TOKEN = /^[\x21-\x7e]{1,8192}$/;
const DEFAULT_TIMEOUT_MS = 10_000;
const schema = <T>(name: string): Decoder<T> => (value) => isExperienceProviderOperationsSchema<T>(name, value) ? value : null;
const empty: Decoder<void> = (value) => value === null ? undefined : null;

function pathId(value: string): string | null {
  return isExperienceProviderOperationPathId(value) ? encodeURIComponent(value) : null;
}

export function createExperienceProviderOperationsClient(options: BaseOptions) {
  const origin = normalizeOrigin(options.nihoWebOrigin);
  if (!TOKEN.test(options.accessToken)) throw new Error("Experience provider operations token is invalid");
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  async function request<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, status: number, decode: Decoder<T>, body?: unknown): Promise<ExperienceProviderOperationsResult<T>> {
    let response: Response;
    try {
      response = await send(new URL(path, origin).href, {
        method,
        headers: { accept: "application/json", authorization: `Bearer ${options.accessToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        cache: "no-store",
        credentials: "omit",
        redirect: "manual",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { return { ok: false, kind: "network_error" }; }
    if (response.status === 401 || response.status === 403) return { ok: false, kind: "rejected", status: response.status };
    if (response.status === 404) return { ok: false, kind: "not_found" };
    if (response.status === 409) return { ok: false, kind: "conflict" };
    if (response.status !== status) return { ok: false, kind: "unexpected_response", status: response.status };
    let value: unknown = null;
    if (status !== 204) try { value = await response.json() as unknown; } catch { return { ok: false, kind: "unexpected_response", status }; }
    const decoded = decode(value);
    return decoded === null ? { ok: false, kind: "unexpected_response", status } : { ok: true, data: decoded };
  }
  const root = (providerId: string) => `/api/experience-providers/${encodeURIComponent(providerId)}`;
  const ids = (...values: string[]) => values.every((value) => pathId(value) !== null);
  const invalid = <T>(): Promise<ExperienceProviderOperationsResult<T>> => Promise.resolve({ ok: false, kind: "invalid_request" });
  return {
    listMembers(providerId: string) { return ids(providerId) ? request("GET", `${root(providerId)}/members`, 200, schema<ExperienceProviderMemberListResponse>("MemberListResponse")) : invalid<ExperienceProviderMemberListResponse>(); },
    resolveMember(providerId: string, body: ExperienceProviderResolveMemberInput) { const valid = decodeExperienceProviderResolveMemberInput(body); return ids(providerId) && valid ? request("POST", `${root(providerId)}/members/resolve`, 200, schema<ExperienceProviderResolveMemberResponse>("ResolveMemberResponse"), valid) : invalid<ExperienceProviderResolveMemberResponse>(); },
    putCohost(providerId: string, userId: string, body: ExperienceProviderPutMemberInput) { const valid = decodeExperienceProviderPutMemberInput(body); return ids(providerId, userId) && valid ? request("PUT", `${root(providerId)}/members/${encodeURIComponent(userId)}`, 200, schema<ExperienceProviderMemberResponse>("MemberResponse"), valid) : invalid<ExperienceProviderMemberResponse>(); },
    deleteCohost(providerId: string, userId: string) { return ids(providerId, userId) ? request("DELETE", `${root(providerId)}/members/${encodeURIComponent(userId)}`, 204, empty) : invalid<void>(); },
  };
}

export type ExperienceProviderOperationsClient = ReturnType<typeof createExperienceProviderOperationsClient>;
