import { randomBytes } from "node:crypto";

/*
 * 対面通訳の部屋 (#181) in mock mode: synthetic rooms behind the pinned contract
 * (packages/api-client/contract/experience-translate-rooms-api.openapi.json) so the host screen
 * can be built before NIHO's N1b (niho-app #19447) exists. A room's participants "arrive" on a
 * fixed clock after it is made: the host joins and gets ready first, the guest after. Nothing
 * here is a real room, code or person; the invite URLs point at a reserved test host.
 */

export const MOCK_INVITE_ORIGIN = "https://app-stg.niho.test";
/** The invite codes stop working this long after the room is made (the Epic's 15 minutes). */
export const MOCK_INVITE_TTL_MS = 15 * 60 * 1000;
/** When each synthetic participant joins and is ready, in ms after the room is made. */
export const MOCK_TIMELINE = { hostJoined: 4_000, hostReady: 7_000, guestJoined: 10_000, guestReady: 13_000 } as const;

type RoomState = "created" | "active" | "paused" | "ended";
interface MockRoom { providerId: string; requestId: string; roomId: string; createdAt: number; endedAt: number | null; hostInviteUrl: string; guestInviteUrl: string; hostParticipantId: string; guestParticipantId: string; hostCode: string; guestCode: string }

const ROOMS_PATH = /^\/api\/experience-providers\/([^/]+)\/bookings\/([^/]+)\/translate-rooms(?:\/([^/]+)(\/end)?)?$/;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const notFound = () => json(404, { error: { code: "NOT_FOUND", message: "mock: NOT_FOUND", details: {} } });
const token = (prefix: string) => `${prefix}${randomBytes(12).toString("base64url")}`;

function participant(room: MockRoom, role: "host" | "guest", now: number) {
  const since = (room.endedAt ?? now) - room.createdAt;
  const joined = since >= (role === "host" ? MOCK_TIMELINE.hostJoined : MOCK_TIMELINE.guestJoined);
  const ready = since >= (role === "host" ? MOCK_TIMELINE.hostReady : MOCK_TIMELINE.guestReady);
  return { role, joined, ready };
}

function stateOf(room: MockRoom, now: number): RoomState {
  if (room.endedAt !== null) return "ended";
  return now - room.createdAt >= MOCK_TIMELINE.hostReady ? "active" : "created";
}

function usageMinutes(room: MockRoom, now: number): number {
  const activeAt = room.createdAt + MOCK_TIMELINE.hostReady;
  const until = room.endedAt ?? now;
  return until <= activeAt ? 0 : Math.floor((until - activeAt) / 60_000);
}

export interface MockTranslateRoomsDeps {
  now: () => number;
  /** Whether the signed-in host belongs to the provider (the api-client mock decides). */
  providerExists: (providerId: string) => Promise<boolean>;
}

export interface MockTranslateRooms {
  /** Handles a translate-rooms request, or returns null when the path is something else. */
  route(request: Request, deps: MockTranslateRoomsDeps): Promise<Response | null>;
}

/** One store of rooms, kept for the life of the server process (the api-client mock's per-fetch state would lose them between polls). */
export function createMockTranslateRooms(): MockTranslateRooms {
  const rooms = new Map<string, MockRoom>();
  const key = (providerId: string, requestId: string, roomId: string) => `${providerId}\u0000${requestId}\u0000${roomId}`;
  return {
    async route(request, deps) {
      let pathname: string;
      try { pathname = new URL(request.url).pathname; } catch { return null; }
      const match = ROOMS_PATH.exec(pathname);
      if (!match) return null;
      let providerId: string, requestId: string, roomId: string | undefined;
      try {
        providerId = decodeURIComponent(match[1] ?? ""); requestId = decodeURIComponent(match[2] ?? ""); roomId = match[3] === undefined ? undefined : decodeURIComponent(match[3]);
      } catch { return notFound(); }
      const end = match[4] !== undefined;
      const method = request.method.toUpperCase();
      if (!(await deps.providerExists(providerId))) return notFound();
      const now = deps.now();
      if (roomId === undefined) {
        if (method !== "POST") return notFound();
        const hostCode = token("mock-host-"), guestCode = token("mock-guest-");
        const room: MockRoom = {
          providerId, requestId, roomId: token("mock-room-"), createdAt: now, endedAt: null,
          hostParticipantId: token("mock-participant-"), guestParticipantId: token("mock-participant-"), hostCode, guestCode,
          hostInviteUrl: `${MOCK_INVITE_ORIGIN}/i/${hostCode}`, guestInviteUrl: `${MOCK_INVITE_ORIGIN}/i/${guestCode}`,
        };
        rooms.set(key(providerId, requestId, room.roomId), room);
        return json(201, {
          roomId: room.roomId, state: "created",
          host: { participantId: room.hostParticipantId, inviteCode: room.hostCode, inviteUrl: room.hostInviteUrl },
          guest: { participantId: room.guestParticipantId, inviteCode: room.guestCode, inviteUrl: room.guestInviteUrl },
          expiresAt: new Date(now + MOCK_INVITE_TTL_MS).toISOString(),
        });
      }
      const room = rooms.get(key(providerId, requestId, roomId));
      if (!room) return notFound();
      if (end) {
        if (method !== "POST") return notFound();
        room.endedAt ??= now;
        return json(200, { state: "ended" });
      }
      if (method !== "GET") return notFound();
      return json(200, { state: stateOf(room, now), participants: [participant(room, "host", now), participant(room, "guest", now)], usageMinutes: usageMinutes(room, now) });
    },
  };
}
