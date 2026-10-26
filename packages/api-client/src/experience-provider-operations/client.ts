import "server-only";
import { normalizeOrigin, type FetchLike } from "../client.ts";
import {
  decodeExperienceProviderCancelBookingInput,
  decodeExperienceProviderMessageInput,
  decodeExperienceProviderPutMemberInput,
  decodeExperienceProviderResolveMemberInput,
  isExperienceProviderBookingCursor,
  isExperienceProviderOperationPathId,
  isExperienceProviderOperationsSchema,
} from "./schema.ts";
import { EXPERIENCE_PROVIDER_BOOKING_STATUSES, type ExperienceProviderBookingDetailResponse, type ExperienceProviderBookingListQuery, type ExperienceProviderBookingListResponse, type ExperienceProviderBookingStatusResponse, type ExperienceProviderCancelBookingInput, type ExperienceProviderCancelBookingResponse, type ExperienceProviderMemberListResponse, type ExperienceProviderMemberResponse, type ExperienceProviderMessageInput, type ExperienceProviderMessageResponse, type ExperienceProviderOperationsResult, type ExperienceProviderPutMemberInput, type ExperienceProviderResolveMemberInput, type ExperienceProviderResolveMemberResponse } from "./types.ts";

type Decoder<T> = (value: unknown) => T | null;
type BaseOptions = { nihoWebOrigin: string; idToken: string; fetch?: FetchLike; timeoutMs?: number };
const TOKEN = /^[\x21-\x7e]{1,8192}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_TIMEOUT_MS = 10_000;
const schema = <T>(name: string): Decoder<T> => (value) => isExperienceProviderOperationsSchema<T>(name, value) ? value : null;
const empty: Decoder<void> = (value) => value === null ? undefined : null;

function pathId(value: string): string | null {
  return isExperienceProviderOperationPathId(value) ? encodeURIComponent(value) : null;
}

function queryString(query: ExperienceProviderBookingListQuery): string | null {
  if (Object.keys(query).some((key) => !["cursor", "pageId", "fromDate", "toDate", "status"].includes(key))) return null;
  if (query.cursor !== undefined && !isExperienceProviderBookingCursor(query.cursor)) return null;
  if (query.pageId !== undefined && !isExperienceProviderOperationPathId(query.pageId)) return null;
  if (query.fromDate !== undefined && !DATE.test(query.fromDate)) return null;
  if (query.toDate !== undefined && !DATE.test(query.toDate)) return null;
  if (query.status !== undefined && !EXPERIENCE_PROVIDER_BOOKING_STATUSES.includes(query.status)) return null;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, value);
  const value = params.toString();
  return value ? `?${value}` : "";
}

export function createExperienceProviderOperationsClient(options: BaseOptions) {
  const origin = normalizeOrigin(options.nihoWebOrigin);
  if (!TOKEN.test(options.idToken)) throw new Error("Experience provider operations token is invalid");
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  async function request<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, status: number, decode: Decoder<T>, body?: unknown): Promise<ExperienceProviderOperationsResult<T>> {
    let response: Response;
    try {
      response = await send(new URL(path, origin).href, {
        method,
        headers: { accept: "application/json", authorization: `Bearer ${options.idToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
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
  const bookingPath = (providerId: string, requestId: string) => `${root(providerId)}/bookings/${encodeURIComponent(requestId)}`;
  const bookingAction = (providerId: string, pageId: string, requestId: string, action: string) => `${root(providerId)}/pages/${encodeURIComponent(pageId)}/bookings/${encodeURIComponent(requestId)}/${action}`;
  const ids = (...values: string[]) => values.every((value) => pathId(value) !== null);
  const invalid = <T>(): Promise<ExperienceProviderOperationsResult<T>> => Promise.resolve({ ok: false, kind: "invalid_request" });
  return {
    listMembers(providerId: string) { return ids(providerId) ? request("GET", `${root(providerId)}/members`, 200, schema<ExperienceProviderMemberListResponse>("MemberListResponse")) : invalid<ExperienceProviderMemberListResponse>(); },
    resolveMember(providerId: string, body: ExperienceProviderResolveMemberInput) { const valid = decodeExperienceProviderResolveMemberInput(body); return ids(providerId) && valid ? request("POST", `${root(providerId)}/members/resolve`, 200, schema<ExperienceProviderResolveMemberResponse>("ResolveMemberResponse"), valid) : invalid<ExperienceProviderResolveMemberResponse>(); },
    putCohost(providerId: string, userId: string, body: ExperienceProviderPutMemberInput) { const valid = decodeExperienceProviderPutMemberInput(body); return ids(providerId, userId) && valid ? request("PUT", `${root(providerId)}/members/${encodeURIComponent(userId)}`, 200, schema<ExperienceProviderMemberResponse>("MemberResponse"), valid) : invalid<ExperienceProviderMemberResponse>(); },
    deleteCohost(providerId: string, userId: string) { return ids(providerId, userId) ? request("DELETE", `${root(providerId)}/members/${encodeURIComponent(userId)}`, 204, empty) : invalid<void>(); },
    listBookings(providerId: string, query: ExperienceProviderBookingListQuery = {}) { const search = queryString(query); return ids(providerId) && search !== null ? request("GET", `${root(providerId)}/bookings${search}`, 200, schema<ExperienceProviderBookingListResponse>("BookingListResponse")) : invalid<ExperienceProviderBookingListResponse>(); },
    getBooking(providerId: string, requestId: string) { return ids(providerId, requestId) ? request("GET", bookingPath(providerId, requestId), 200, schema<ExperienceProviderBookingDetailResponse>("BookingDetailResponse")) : invalid<ExperienceProviderBookingDetailResponse>(); },
    approveBooking(providerId: string, pageId: string, requestId: string) { return ids(providerId, pageId, requestId) ? request("POST", bookingAction(providerId, pageId, requestId, "approve"), 200, schema<ExperienceProviderBookingStatusResponse>("BookingStatusResponse")) : invalid<ExperienceProviderBookingStatusResponse>(); },
    declineBooking(providerId: string, pageId: string, requestId: string) { return ids(providerId, pageId, requestId) ? request("POST", bookingAction(providerId, pageId, requestId, "decline"), 200, schema<ExperienceProviderBookingStatusResponse>("BookingStatusResponse")) : invalid<ExperienceProviderBookingStatusResponse>(); },
    cancelBooking(providerId: string, pageId: string, requestId: string, body: ExperienceProviderCancelBookingInput) { const valid = decodeExperienceProviderCancelBookingInput(body); return ids(providerId, pageId, requestId) && valid ? request("POST", bookingAction(providerId, pageId, requestId, "cancel"), 200, schema<ExperienceProviderCancelBookingResponse>("CancelBookingResponse"), valid) : invalid<ExperienceProviderCancelBookingResponse>(); },
    messageGuest(providerId: string, pageId: string, requestId: string, body: ExperienceProviderMessageInput) { const valid = decodeExperienceProviderMessageInput(body); return ids(providerId, pageId, requestId) && valid ? request("POST", bookingAction(providerId, pageId, requestId, "message"), 201, schema<ExperienceProviderMessageResponse>("MessageResponse"), valid) : invalid<ExperienceProviderMessageResponse>(); },
  };
}

export type ExperienceProviderOperationsClient = ReturnType<typeof createExperienceProviderOperationsClient>;
