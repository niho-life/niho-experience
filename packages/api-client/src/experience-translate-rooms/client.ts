import "server-only";
import { normalizeOrigin, type FetchLike } from "../client.ts";
import { hasSafeStandaloneTranslateInvites, isExperienceTranslateBookingId, isExperienceTranslateRoomPathId, isExperienceTranslateRoomsSchema, isStandaloneTranslateRoomId } from "./schema.ts";
import type {
  ExperienceTranslateRoomCreatedResponse,
  ExperienceTranslateRoomEndResponse,
  ExperienceTranslateRoomStatusResponse,
  ExperienceTranslateRoomsResult,
  StandaloneTranslateInviteResult,
  StandaloneTranslateLanguage,
  StandaloneTranslateRoom,
  StandaloneTranslateRoomCreated,
  StandaloneTranslateRoomCurrent,
} from "./types.ts";

/*
 * 対面通訳の部屋 (#181): the host's own ID token makes, reads and ends a room of one of the
 * provider's bookings. The same fixed transport as the provider operations client: Bearer only,
 * no cookies, no redirects, no referrer, a timeout and no retry. Responses are accepted only in
 * the pinned shape, so a relay ticket or a budget NIHO might add later never reaches a caller
 * by accident.
 */

type Decoder<T> = (value: unknown) => T | null;
type BaseOptions = { nihoWebOrigin: string; accessToken: string; fetch?: FetchLike; timeoutMs?: number };
const TOKEN = /^[\x21-\x7e]{1,8192}$/;
const DEFAULT_TIMEOUT_MS = 10_000;
const schema = <T>(name: string): Decoder<T> => (value) => isExperienceTranslateRoomsSchema<T>(name, value) ? value : null;

export function createExperienceTranslateRoomsClient(options: BaseOptions) {
  const origin = normalizeOrigin(options.nihoWebOrigin);
  if (!TOKEN.test(options.accessToken)) throw new Error("Experience translate rooms token is invalid");
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  async function request<T>(method: "GET" | "POST", path: string, status: number, decode: Decoder<T>, body?: unknown): Promise<ExperienceTranslateRoomsResult<T>> {
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
    if (response.status === 429) return { ok: false, kind: "limited" };
    if (response.status !== status) return { ok: false, kind: "unexpected_response", status: response.status };
    let value: unknown = null;
    try { value = await response.json() as unknown; } catch { return { ok: false, kind: "unexpected_response", status }; }
    const decoded = decode(value);
    return decoded === null ? { ok: false, kind: "unexpected_response", status } : { ok: true, data: decoded };
  }
  const roomsPath = (providerId: string, requestId: string) => `/api/experience-providers/${encodeURIComponent(providerId)}/bookings/${encodeURIComponent(requestId)}/translate-rooms`;
  const siteRoomsPath = (providerId: string, bookingId: string) => `/api/experience-providers/${encodeURIComponent(providerId)}/site-bookings/${encodeURIComponent(bookingId)}/translate-rooms`;
  const standaloneRoomsPath = (providerId: string) => `/api/experience-providers/${encodeURIComponent(providerId)}/translate-rooms`;
  const ids = (...values: string[]) => values.every((value) => isExperienceTranslateRoomPathId(value));
  const invalid = <T>(): Promise<ExperienceTranslateRoomsResult<T>> => Promise.resolve({ ok: false, kind: "invalid_request" });
  const safeInvites = <T extends StandaloneTranslateRoomCreated | StandaloneTranslateInviteResult>(name: string): Decoder<T> => (value) => {
    if (!isExperienceTranslateRoomsSchema<T>(name, value)) return null;
    return hasSafeStandaloneTranslateInvites(value) ? value : null;
  };
  return {
    createStandaloneRoom(providerId: string, hostLanguage: StandaloneTranslateLanguage) {
      return ids(providerId) && (hostLanguage === "ja" || hostLanguage === "en")
        ? request("POST", standaloneRoomsPath(providerId), 201, safeInvites<StandaloneTranslateRoomCreated>("StandaloneTranslateRoomCreated"), { hostLanguage })
        : invalid<StandaloneTranslateRoomCreated>();
    },
    getCurrentStandaloneRoom(providerId: string) {
      return ids(providerId)
        ? request("GET", `${standaloneRoomsPath(providerId)}/current`, 200, schema<StandaloneTranslateRoomCurrent>("StandaloneTranslateRoomCurrent"))
        : invalid<StandaloneTranslateRoomCurrent>();
    },
    getStandaloneRoom(providerId: string, roomId: string) {
      return ids(providerId) && isStandaloneTranslateRoomId(roomId)
        ? request("GET", `${standaloneRoomsPath(providerId)}/${encodeURIComponent(roomId)}`, 200, schema<StandaloneTranslateRoom>("StandaloneTranslateRoom"))
        : invalid<StandaloneTranslateRoom>();
    },
    reissueStandaloneInvite(providerId: string, roomId: string, role: "host" | "guest") {
      return ids(providerId) && isStandaloneTranslateRoomId(roomId) && (role === "host" || role === "guest")
        ? request("POST", `${standaloneRoomsPath(providerId)}/${encodeURIComponent(roomId)}/invites/${role}`, 200, safeInvites<StandaloneTranslateInviteResult>("StandaloneTranslateInviteResult"), {})
        : invalid<StandaloneTranslateInviteResult>();
    },
    endStandaloneRoom(providerId: string, roomId: string) {
      return ids(providerId) && isStandaloneTranslateRoomId(roomId)
        ? request("POST", `${standaloneRoomsPath(providerId)}/${encodeURIComponent(roomId)}/end`, 200, schema<ExperienceTranslateRoomEndResponse>("TranslateRoomStateResult"), {})
        : invalid<ExperienceTranslateRoomEndResponse>();
    },
    /** Makes the room with both invites. The body is an empty object: the language comes from the booking. */
    createRoom(providerId: string, requestId: string) {
      return ids(providerId, requestId) ? request("POST", roomsPath(providerId, requestId), 201, schema<ExperienceTranslateRoomCreatedResponse>("ExperienceProviderTranslateRoomCreated"), {}) : invalid<ExperienceTranslateRoomCreatedResponse>();
    },
    getRoom(providerId: string, requestId: string, roomId: string) {
      return ids(providerId, requestId, roomId) ? request("GET", `${roomsPath(providerId, requestId)}/${encodeURIComponent(roomId)}`, 200, schema<ExperienceTranslateRoomStatusResponse>("ExperienceProviderTranslateRoomStatus")) : invalid<ExperienceTranslateRoomStatusResponse>();
    },
    endRoom(providerId: string, requestId: string, roomId: string) {
      return ids(providerId, requestId, roomId) ? request("POST", `${roomsPath(providerId, requestId)}/${encodeURIComponent(roomId)}/end`, 200, schema<ExperienceTranslateRoomEndResponse>("TranslateRoomStateResult"), {}) : invalid<ExperienceTranslateRoomEndResponse>();
    },
    /** Experience DBの公開予約UUIDをopaqueな文脈として渡す。状態・言語・roleは送らない。 */
    createSiteRoom(providerId: string, bookingId: string) {
      return ids(providerId) && isExperienceTranslateBookingId(bookingId) ? request("POST", siteRoomsPath(providerId, bookingId), 201, schema<ExperienceTranslateRoomCreatedResponse>("ExperienceProviderTranslateRoomCreated"), {}) : invalid<ExperienceTranslateRoomCreatedResponse>();
    },
    getSiteRoom(providerId: string, bookingId: string, roomId: string) {
      return ids(providerId, roomId) && isExperienceTranslateBookingId(bookingId) ? request("GET", `${siteRoomsPath(providerId, bookingId)}/${encodeURIComponent(roomId)}`, 200, schema<ExperienceTranslateRoomStatusResponse>("ExperienceProviderTranslateRoomStatus")) : invalid<ExperienceTranslateRoomStatusResponse>();
    },
    endSiteRoom(providerId: string, bookingId: string, roomId: string) {
      return ids(providerId, roomId) && isExperienceTranslateBookingId(bookingId) ? request("POST", `${siteRoomsPath(providerId, bookingId)}/${encodeURIComponent(roomId)}/end`, 200, schema<ExperienceTranslateRoomEndResponse>("TranslateRoomStateResult"), {}) : invalid<ExperienceTranslateRoomEndResponse>();
    },
  };
}

export type ExperienceTranslateRoomsClient = ReturnType<typeof createExperienceTranslateRoomsClient>;
