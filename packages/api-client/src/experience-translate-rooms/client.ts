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
 * 対面通訳の部屋: booked NIHO-login routes use the host bearer. Reservation-free Host Account
 * routes use only the server's fixed-audience Google ID token. Both transports omit cookies,
 * redirects and referrers, and accept only the pinned response shape.
 */

type Decoder<T> = (value: unknown) => T | null;
type BaseOptions = { nihoWebOrigin: string; fetch?: FetchLike; timeoutMs?: number } & (
  | { auth: { kind: "niho"; accessToken: string } }
  | { auth: { kind: "experience-service"; serviceIdToken: string } }
);
const TOKEN = /^[\x21-\x7e]{1,8192}$/;
const DEFAULT_TIMEOUT_MS = 10_000;
const schema = <T>(name: string): Decoder<T> => (value) => isExperienceTranslateRoomsSchema<T>(name, value) ? value : null;

export function createExperienceTranslateRoomsClient(options: BaseOptions) {
  const origin = normalizeOrigin(options.nihoWebOrigin);
  const token = options.auth.kind === "niho" ? options.auth.accessToken : options.auth.serviceIdToken;
  if (!TOKEN.test(token)) throw new Error("Experience translate rooms token is invalid");
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  async function request<T>(method: "GET" | "POST", path: string, status: number, decode: Decoder<T>, body?: unknown): Promise<ExperienceTranslateRoomsResult<T>> {
    let response: Response;
    try {
      response = await send(new URL(path, origin).href, {
        method,
        headers: {
          accept: "application/json",
          ...(options.auth.kind === "niho"
            ? { authorization: `Bearer ${token}` }
            : { "x-niho-experience-service-id-token": token }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
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
  const siteRoomsPath = (providerId: string, bookingId: string) => `/api/experience-providers/${encodeURIComponent(providerId)}/site-bookings/${encodeURIComponent(bookingId)}/translate-rooms`;
  const standaloneRoomsPath = (providerId: string) => options.auth.kind === "experience-service"
    ? `/api/experience-host/translate-providers/${encodeURIComponent(providerId)}/translate-rooms`
    : `/api/experience-providers/${encodeURIComponent(providerId)}/translate-rooms`;
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
    /** Experience DBの公開予約UUIDをopaqueな文脈として渡す。状態・言語・roleは送らない。 */
    createSiteRoom(providerId: string, bookingId: string) {
      return options.auth.kind === "niho" && ids(providerId) && isExperienceTranslateBookingId(bookingId) ? request("POST", siteRoomsPath(providerId, bookingId), 201, schema<ExperienceTranslateRoomCreatedResponse>("ExperienceProviderTranslateRoomCreated"), {}) : invalid<ExperienceTranslateRoomCreatedResponse>();
    },
    getSiteRoom(providerId: string, bookingId: string, roomId: string) {
      return options.auth.kind === "niho" && ids(providerId, roomId) && isExperienceTranslateBookingId(bookingId) ? request("GET", `${siteRoomsPath(providerId, bookingId)}/${encodeURIComponent(roomId)}`, 200, schema<ExperienceTranslateRoomStatusResponse>("ExperienceProviderTranslateRoomStatus")) : invalid<ExperienceTranslateRoomStatusResponse>();
    },
    endSiteRoom(providerId: string, bookingId: string, roomId: string) {
      return options.auth.kind === "niho" && ids(providerId, roomId) && isExperienceTranslateBookingId(bookingId) ? request("POST", `${siteRoomsPath(providerId, bookingId)}/${encodeURIComponent(roomId)}/end`, 200, schema<ExperienceTranslateRoomEndResponse>("TranslateRoomStateResult"), {}) : invalid<ExperienceTranslateRoomEndResponse>();
    },
  };
}

export type ExperienceTranslateRoomsClient = ReturnType<typeof createExperienceTranslateRoomsClient>;
