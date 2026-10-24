import "server-only";

import { normalizeOrigin, type FetchLike } from "../client.ts";
import { decodeExperienceFeeSummaryResponse, isExperienceFeeSummaryBookingId } from "./schema.ts";
import type { ExperienceFeeSummaryResponse } from "./types.ts";

export type ExperienceFeeSummaryAudience = "admin" | "host";
export interface ExperienceFeeSummaryApiClientOptions {
  nihoWebOrigin: string;
  idToken: string;
  audience: ExperienceFeeSummaryAudience;
  fetch?: FetchLike;
  timeoutMs?: number;
}
export type ExperienceFeeSummaryFailure =
  | { ok: false; kind: "invalid_request" }
  | { ok: false; kind: "rejected"; status: 401 | 403 }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "network_error" }
  | { ok: false; kind: "unexpected_response"; status: number };
export type ExperienceFeeSummaryResult = { ok: true; data: ExperienceFeeSummaryResponse } | ExperienceFeeSummaryFailure;
export interface ExperienceFeeSummaryApiClient { read(bookingId: string): Promise<ExperienceFeeSummaryResult> }

const TOKEN = /^[\x21-\x7e]{1,8192}$/;

export function createExperienceFeeSummaryApiClient(input: ExperienceFeeSummaryApiClientOptions): ExperienceFeeSummaryApiClient {
  const origin = normalizeOrigin(input.nihoWebOrigin);
  if (!TOKEN.test(input.idToken)) throw new Error("Fee summary idToken contains characters that cannot be sent in Authorization");
  const request = input.fetch ?? fetch;
  const timeoutMs = input.timeoutMs ?? 10_000;
  const base = input.audience === "admin"
    ? "/api/admin/experience-bookings/"
    : "/api/experience-providers/management/bookings/";

  return {
    async read(bookingId) {
      if (!isExperienceFeeSummaryBookingId(bookingId)) return { ok: false, kind: "invalid_request" };
      let response: Response;
      try {
        response = await request(new URL(`${base}${encodeURIComponent(bookingId)}/fee-summary`, origin).href, {
          method: "GET",
          headers: { accept: "application/json", authorization: `Bearer ${input.idToken}` },
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
        return { ok: false, kind: "unexpected_response", status: response.status };
      }
      let value: unknown;
      try { value = await response.json() as unknown; } catch { return { ok: false, kind: "unexpected_response", status: response.status }; }
      const data = decodeExperienceFeeSummaryResponse(value);
      if (!data || data.feeSummary.bookingRequestId !== bookingId) return { ok: false, kind: "unexpected_response", status: response.status };
      return { ok: true, data };
    },
  };
}

