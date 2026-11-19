import "server-only";
import { normalizeOrigin, type FetchLike } from "../client.ts";

export const NIHO_ACCOUNT_STATUS_PATH = "/api/experience-host/account-statuses";
export const NIHO_ACCOUNT_STATUS_BATCH_LIMIT = 100;

export type NihoAccountStatusEntry =
  | { readonly nihoUserId: string; readonly status: "active" | "inactive" | "unknown"; readonly currentUserId: null }
  | { readonly nihoUserId: string; readonly status: "merged"; readonly currentUserId: string };

export type NihoAccountStatusResult =
  | { readonly ok: true; readonly results: readonly NihoAccountStatusEntry[] }
  | { readonly ok: false; readonly kind: "invalid_request" | "unavailable" | "unexpected_response"; readonly status?: number };

type Options = { readonly nihoWebOrigin: string; readonly serviceIdToken: string; readonly fetch?: FetchLike; readonly timeoutMs?: number };
const TOKEN = /^[\x21-\x7e]{1,8192}$/;
const USER_ID = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]{1,256}$/u;
const DEFAULT_TIMEOUT_MS = 5_000;
const isNihoUserId = (value: unknown): value is string =>
  typeof value === "string" && USER_ID.test(value) && !/^(?:hst|sel|trv)_/.test(value);

function decode(value: unknown, requested: readonly string[]): readonly NihoAccountStatusEntry[] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 1) return null;
  const results = (value as { results?: unknown }).results;
  if (!Array.isArray(results) || results.length !== requested.length) return null;
  const parsedResults: NihoAccountStatusEntry[] = [];
  const found = new Set<string>();
  for (const [index, item] of results.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    if (!isNihoUserId(row.nihoUserId) || found.has(row.nihoUserId)) return null;
    if (row.nihoUserId !== requested[index]) return null;
    let parsed: NihoAccountStatusEntry;
    if (row.status === "active" || row.status === "inactive" || row.status === "unknown") {
      if (Object.keys(row).length !== 3 || row.currentUserId !== null) return null;
      parsed = { nihoUserId: row.nihoUserId, status: row.status, currentUserId: null };
    } else if (row.status === "merged" && isNihoUserId(row.currentUserId) && row.currentUserId !== row.nihoUserId && Object.keys(row).length === 3) {
      parsed = { nihoUserId: row.nihoUserId, status: "merged", currentUserId: row.currentUserId };
    } else return null;
    found.add(parsed.nihoUserId);
    parsedResults.push(parsed);
  }
  return parsedResults;
}

/** NIHO account status is read server-to-server with Experience's fixed-audience identity, never a user bearer. */
export function createNihoAccountStatusClient(options: Options) {
  const origin = normalizeOrigin(options.nihoWebOrigin);
  if (!TOKEN.test(options.serviceIdToken)) throw new Error("NIHO account status service identity is invalid");
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async getStatuses(nihoUserIds: readonly string[]): Promise<NihoAccountStatusResult> {
      if (!Array.isArray(nihoUserIds) || nihoUserIds.length < 1 || nihoUserIds.length > NIHO_ACCOUNT_STATUS_BATCH_LIMIT
        || nihoUserIds.some((id) => !isNihoUserId(id))
        || new Set(nihoUserIds).size !== nihoUserIds.length) return { ok: false, kind: "invalid_request" };
      let response: Response;
      try {
        response = await send(new URL(NIHO_ACCOUNT_STATUS_PATH, origin).href, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-niho-experience-service-id-token": options.serviceIdToken,
          },
          body: JSON.stringify({ nihoUserIds }),
          cache: "no-store",
          credentials: "omit",
          redirect: "manual",
          referrerPolicy: "no-referrer",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch { return { ok: false, kind: "unavailable" }; }
      if (!response.ok) return { ok: false, kind: "unavailable", status: response.status };
      let value: unknown;
      try { value = await response.json() as unknown; }
      catch { return { ok: false, kind: "unexpected_response", status: response.status }; }
      const results = decode(value, nihoUserIds);
      return results === null
        ? { ok: false, kind: "unexpected_response", status: response.status }
        : { ok: true, results };
    },
  };
}

export type NihoAccountStatusClient = ReturnType<typeof createNihoAccountStatusClient>;
