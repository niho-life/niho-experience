import "server-only";
import { normalizeOrigin, type FetchLike } from "../client.ts";
import { isExperienceTranslateRoomPathId, isExperienceTranslateRoomsSchema } from "./schema.ts";
import type { ExperienceTranslateRoomCreatedResponse, ExperienceTranslateRoomEndResponse, ExperienceTranslateRoomStatusResponse, ExperienceTranslateRoomsResult } from "./types.ts";

/*
 * 対面通訳の部屋 (#181): the host's own ID token makes, reads and ends a room of one of the
 * provider's bookings. The same fixed transport as the provider operations client: Bearer only,
 * no cookies, no redirects, no referrer, a timeout and no retry. Responses are accepted only in
 * the pinned shape, so a relay ticket or a budget NIHO might add later never reaches a caller
 * by accident.
 */

type Decoder<T> = (value: unknown) => T | null;
type BaseOptions = { nihoWebOrigin: string; idToken: string; fetch?: FetchLike; timeoutMs?: number };
const TOKEN = /^[\x21-\x7e]{1,8192}$/;
const DEFAULT_TIMEOUT_MS = 10_000;
const schema = <T>(name: string): Decoder<T> => (value) => isExperienceTranslateRoomsSchema<T>(name, value) ? value : null;

export function createExperienceTranslateRoomsClient(options: BaseOptions) {
  const origin = normalizeOrigin(options.nihoWebOrigin);
  if (!TOKEN.test(options.idToken)) throw new Error("Experience translate rooms token is invalid");
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  async function request<T>(method: "GET" | "POST", path: string, status: number, decode: Decoder<T>, body?: unknown): Promise<ExperienceTranslateRoomsResult<T>> {
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
    try { value = await response.json() as unknown; } catch { return { ok: false, kind: "unexpected_response", status }; }
    const decoded = decode(value);
    return decoded === null ? { ok: false, kind: "unexpected_response", status } : { ok: true, data: decoded };
  }
  const roomsPath = (providerId: string, requestId: string) => `/api/experience-providers/${encodeURIComponent(providerId)}/bookings/${encodeURIComponent(requestId)}/translate-rooms`;
  const ids = (...values: string[]) => values.every((value) => isExperienceTranslateRoomPathId(value));
  const invalid = <T>(): Promise<ExperienceTranslateRoomsResult<T>> => Promise.resolve({ ok: false, kind: "invalid_request" });
  return {
    /** Makes the room with both invites. The body is an empty object: the language comes from the booking. */
    createRoom(providerId: string, requestId: string) {
      return ids(providerId, requestId) ? request("POST", roomsPath(providerId, requestId), 201, schema<ExperienceTranslateRoomCreatedResponse>("TranslateRoomCreatedResponse"), {}) : invalid<ExperienceTranslateRoomCreatedResponse>();
    },
    getRoom(providerId: string, requestId: string, roomId: string) {
      return ids(providerId, requestId, roomId) ? request("GET", `${roomsPath(providerId, requestId)}/${encodeURIComponent(roomId)}`, 200, schema<ExperienceTranslateRoomStatusResponse>("TranslateRoomStatusResponse")) : invalid<ExperienceTranslateRoomStatusResponse>();
    },
    endRoom(providerId: string, requestId: string, roomId: string) {
      return ids(providerId, requestId, roomId) ? request("POST", `${roomsPath(providerId, requestId)}/${encodeURIComponent(roomId)}/end`, 200, schema<ExperienceTranslateRoomEndResponse>("TranslateRoomEndResponse"), {}) : invalid<ExperienceTranslateRoomEndResponse>();
    },
  };
}

export type ExperienceTranslateRoomsClient = ReturnType<typeof createExperienceTranslateRoomsClient>;
