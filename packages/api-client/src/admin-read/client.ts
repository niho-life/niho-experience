import { normalizeOrigin, type FetchLike } from "../client.ts";
import {
  decodeExperienceAdminBookingDetailResponse,
  decodeExperienceAdminBookingListResponse,
  decodeExperienceAdminBookingQuery,
  decodeExperienceAdminNotificationListResponse,
  decodeExperienceAdminNotificationQuery,
  decodeExperienceAdminNotificationReadRequest,
  decodeExperienceAdminNotificationReadResponse,
  isExperienceAdminOpaqueId,
} from "./schema.ts";
import type {
  ExperienceAdminBookingDetailResponse,
  ExperienceAdminBookingListResponse,
  ExperienceAdminBookingQuery,
  ExperienceAdminNotificationListResponse,
  ExperienceAdminNotificationQuery,
  ExperienceAdminNotificationReadRequest,
  ExperienceAdminNotificationReadResponse,
} from "./types.ts";

export interface ExperienceAdminReadApiClientOptions {
  nihoWebOrigin: string;
  /** Current dedicated Experience Admin ID token. Never pass it to browser code. */
  idToken: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export type ExperienceAdminReadFailure =
  | { ok: false; kind: "invalid_request" }
  | { ok: false; kind: "rejected"; status: 401 | 403 }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "network_error" }
  | { ok: false; kind: "unexpected_response"; status: number };

export type ExperienceAdminReadResult<T> = { ok: true; data: T } | ExperienceAdminReadFailure;

export interface ExperienceAdminReadApiClient {
  queryBookings(query: ExperienceAdminBookingQuery): Promise<ExperienceAdminReadResult<ExperienceAdminBookingListResponse>>;
  getBooking(bookingId: string): Promise<ExperienceAdminReadResult<ExperienceAdminBookingDetailResponse>>;
  listNotifications(query: ExperienceAdminNotificationQuery): Promise<ExperienceAdminReadResult<ExperienceAdminNotificationListResponse>>;
  markNotificationsRead(body: ExperienceAdminNotificationReadRequest): Promise<ExperienceAdminReadResult<ExperienceAdminNotificationReadResponse>>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const TOKEN = /^[\x21-\x7e]{1,8192}$/;

function failure(status: number): ExperienceAdminReadFailure {
  if (status === 401 || status === 403) return { ok: false, kind: "rejected", status };
  if (status === 404) return { ok: false, kind: "not_found" };
  return { ok: false, kind: "unexpected_response", status };
}

export function createExperienceAdminReadApiClient(input: ExperienceAdminReadApiClientOptions): ExperienceAdminReadApiClient {
  const origin = normalizeOrigin(input.nihoWebOrigin);
  if (!TOKEN.test(input.idToken)) throw new Error("Admin idToken contains characters that cannot be sent in Authorization");
  const request = input.fetch ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function requestJson<T>(path: string, init: RequestInit, decode: (value: unknown) => T | null): Promise<ExperienceAdminReadResult<T>> {
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
    if (!response.ok) return failure(response.status);
    let body: unknown;
    try {
      body = await response.json() as unknown;
    } catch {
      return { ok: false, kind: "unexpected_response", status: response.status };
    }
    const decoded = decode(body);
    return decoded ? { ok: true, data: decoded } : { ok: false, kind: "unexpected_response", status: response.status };
  }

  return {
    queryBookings(query) {
      const decoded = decodeExperienceAdminBookingQuery(query);
      if (!decoded) return Promise.resolve({ ok: false, kind: "invalid_request" });
      return requestJson("/api/admin/experience-bookings/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(decoded),
      }, decodeExperienceAdminBookingListResponse);
    },

    getBooking(bookingId) {
      if (!isExperienceAdminOpaqueId(bookingId) || bookingId === "." || bookingId === ".." || /[/\\%]/.test(bookingId)
        || Array.from(bookingId).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return Promise.resolve({ ok: false, kind: "invalid_request" });
      let segment: string;
      try { segment = encodeURIComponent(bookingId); } catch { return Promise.resolve({ ok: false, kind: "invalid_request" }); }
      return requestJson(`/api/admin/experience-bookings/${segment}`, { method: "GET" }, decodeExperienceAdminBookingDetailResponse);
    },

    listNotifications(query) {
      const decoded = decodeExperienceAdminNotificationQuery(query);
      if (!decoded) return Promise.resolve({ ok: false, kind: "invalid_request" });
      const params = new URLSearchParams();
      if (decoded.cursor) params.set("cursor", decoded.cursor);
      params.set("unread", decoded.unread ? "true" : "false");
      if (decoded.limit !== undefined) params.set("limit", String(decoded.limit));
      const suffix = params.size ? `?${params.toString()}` : "";
      return requestJson(`/api/admin/experience-support-notifications${suffix}`, { method: "GET" }, decodeExperienceAdminNotificationListResponse);
    },

    async markNotificationsRead(body) {
      const decoded = decodeExperienceAdminNotificationReadRequest(body);
      if (!decoded) return { ok: false, kind: "invalid_request" };
      const result = await requestJson("/api/admin/experience-support-notifications/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(decoded),
      }, decodeExperienceAdminNotificationReadResponse);
      if (!result.ok) return result;
      const expected = [...decoded.notificationIds].sort();
      const actual = result.data.notifications.map((item) => item.id).sort();
      if (actual.length !== expected.length || new Set(actual).size !== actual.length || actual.some((id, index) => id !== expected[index])) {
        return { ok: false, kind: "unexpected_response", status: 200 };
      }
      return result;
    },
  };
}
