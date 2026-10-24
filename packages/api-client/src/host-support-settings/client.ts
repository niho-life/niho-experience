import { normalizeOrigin, type FetchLike } from "../client.ts";
import {
  decodeExperienceHostSupportSettingsHostListResponse,
  decodeExperienceHostSupportSettingsPutRequest,
  decodeExperienceHostSupportSettingsStateResponse,
  isExperienceHostSupportSettingsHostKind,
  isExperienceHostSupportSettingsPathId,
} from "./schema.ts";
import type {
  ExperienceHostSupportSettingsHostKind,
  ExperienceHostSupportSettingsHostListResponse,
  ExperienceHostSupportSettingsPutRequest,
  ExperienceHostSupportSettingsStateResponse,
} from "./types.ts";

export interface ExperienceHostSupportSettingsApiClientOptions { nihoWebOrigin: string; idToken: string; fetch?: FetchLike; timeoutMs?: number }
export type ExperienceHostSupportSettingsFailure =
  | { ok: false; kind: "invalid_request" }
  | { ok: false; kind: "rejected"; status: 401 | 403 }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "conflict" }
  | { ok: false; kind: "unavailable"; status: 503 }
  | { ok: false; kind: "network_error" }
  | { ok: false; kind: "unexpected_response"; status: number };
export type ExperienceHostSupportSettingsResult<T> = { ok: true; data: T } | ExperienceHostSupportSettingsFailure;
export interface ExperienceHostSupportSettingsApiClient {
  list(): Promise<ExperienceHostSupportSettingsResult<ExperienceHostSupportSettingsHostListResponse>>;
  get(kind: ExperienceHostSupportSettingsHostKind, id: string): Promise<ExperienceHostSupportSettingsResult<ExperienceHostSupportSettingsStateResponse>>;
  put(kind: ExperienceHostSupportSettingsHostKind, id: string, command: ExperienceHostSupportSettingsPutRequest): Promise<ExperienceHostSupportSettingsResult<ExperienceHostSupportSettingsStateResponse>>;
}

const TOKEN = /^[\x21-\x7e]{1,8192}$/;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
// A full 100-host page may contain 200 Unicode scalar IDs whose UTF-8 form alone
// exceeds 64 KiB. Keep the response bounded while accepting that valid page.
const MAX_RESPONSE_BYTES = 256 * 1024;

async function boundedJson(response: Response): Promise<unknown> {
  if (!JSON_TYPE.test(response.headers.get("content-type") ?? "")) throw new Error("unexpected media type");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("response too large");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function createExperienceHostSupportSettingsApiClient(input: ExperienceHostSupportSettingsApiClientOptions): ExperienceHostSupportSettingsApiClient {
  const origin = normalizeOrigin(input.nihoWebOrigin);
  if (!TOKEN.test(input.idToken)) throw new Error("Host idToken contains characters that cannot be sent in Authorization");
  const request = input.fetch ?? fetch;
  const timeoutMs = input.timeoutMs ?? 10_000;
  const headers = { accept: "application/json", authorization: `Bearer ${input.idToken}` };

  async function json<T>(path: string, init: RequestInit, decode: (value: unknown) => T | null, accepted: readonly number[]): Promise<ExperienceHostSupportSettingsResult<T>> {
    let response: Response;
    try {
      response = await request(new URL(path, origin).href, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) }, cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    } catch { return { ok: false, kind: "network_error" }; }
    if (!accepted.includes(response.status)) {
      if (response.status === 401 || response.status === 403) return { ok: false, kind: "rejected", status: response.status };
      if (response.status === 404) return { ok: false, kind: "not_found" };
      if (response.status === 409) return { ok: false, kind: "conflict" };
      if (response.status === 503) return { ok: false, kind: "unavailable", status: 503 };
      return { ok: false, kind: "unexpected_response", status: response.status };
    }
    let value: unknown;
    try { value = await boundedJson(response); } catch { return { ok: false, kind: "unexpected_response", status: response.status }; }
    const data = decode(value);
    return data ? { ok: true, data } : { ok: false, kind: "unexpected_response", status: response.status };
  }

  const targetPath = (kind: unknown, id: unknown) => isExperienceHostSupportSettingsHostKind(kind) && isExperienceHostSupportSettingsPathId(id)
    ? `/api/experience-providers/management/niho-support/${kind}/${encodeURIComponent(id)}`
    : null;
  const matches = (data: ExperienceHostSupportSettingsStateResponse, kind: ExperienceHostSupportSettingsHostKind, id: string) => data.host.kind === kind && data.host.id === id;

  return {
    list: () => json("/api/experience-providers/management/niho-support-hosts", { method: "GET" }, decodeExperienceHostSupportSettingsHostListResponse, [200]),
    async get(kind, id) {
      const path = targetPath(kind, id);
      if (!path) return { ok: false, kind: "invalid_request" };
      const result = await json(path, { method: "GET" }, decodeExperienceHostSupportSettingsStateResponse, [200]);
      return result.ok && !matches(result.data, kind, id) ? { ok: false, kind: "unexpected_response", status: 200 } : result;
    },
    async put(kind, id, command) {
      const path = targetPath(kind, id);
      const normalized = decodeExperienceHostSupportSettingsPutRequest(command);
      if (!path || !normalized) return { ok: false, kind: "invalid_request" };
      const result = await json(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(normalized) }, decodeExperienceHostSupportSettingsStateResponse, [200, 201]);
      return result.ok && !matches(result.data, kind, id) ? { ok: false, kind: "unexpected_response", status: 200 } : result;
    },
  };
}
