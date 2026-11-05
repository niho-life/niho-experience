import { randomBytes } from "node:crypto";

/*
 * 対面通訳の部屋 (#181) in mock mode: synthetic rooms behind the pinned contract
 * (packages/api-client/contract/experience-translate-rooms-api.openapi.json) so the host screen
 * can be built before NIHO's N1b (niho-app #19447) exists. A room's participants "arrive" on a
 * fixed clock after it is made: the host joins and gets ready first, the guest after. Nothing
 * here is a real room, code or person; the invite URLs point at a reserved test host.
 */

export const MOCK_INVITE_ORIGIN = "https://app-stg.niho.test";
export const MOCK_STANDALONE_INVITE_ORIGIN = "https://app-stg.niho.life";
/** The invite codes stop working this long after the room is made (the Epic's 15 minutes). */
export const MOCK_INVITE_TTL_MS = 15 * 60 * 1000;
/** A standalone room can exist for at most 90 minutes. */
export const MOCK_STANDALONE_ROOM_TTL_MS = 90 * 60 * 1000;
/** When each synthetic participant joins and is ready, in ms after the room is made. */
export const MOCK_TIMELINE = { hostJoined: 4_000, hostReady: 7_000, guestJoined: 10_000, guestReady: 13_000 } as const;

type RoomState = "waiting" | "active" | "paused" | "ended";
interface MockRoom { providerId: string; requestId: string; roomId: string; createdAt: number; endedAt: number | null; hostInviteUrl: string; guestInviteUrl: string; hostParticipantId: string; guestParticipantId: string; hostCode: string; guestCode: string }
interface MockStandaloneRoom {
  providerId: string;
  roomId: string;
  hostLanguage: "ja" | "en";
  guestLanguage: "ja" | "en";
  createdAt: number;
  expiresAt: number;
  endedAt: number | null;
  hostInvite: { code: string; issuedAt: number };
  guestInvite: { code: string; issuedAt: number };
}

const ROOMS_PATH = /^\/api\/experience-providers\/([^/]+)\/site-bookings\/([^/]+)\/translate-rooms(?:\/([^/]+)(\/end)?)?$/;
const STANDALONE_PATH = /^\/api\/experience-providers\/([^/]+)\/translate-rooms(?:\/(current|([^/]+)(?:\/(end)|\/invites\/(host|guest))?))?$/;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const notFound = () => json(404, { error: { code: "NOT_FOUND", message: "mock: NOT_FOUND", details: {} } });
const token = (prefix: string) => `${prefix}${randomBytes(12).toString("base64url")}`;
const inviteCode = () => randomBytes(32).toString("base64url");

function participant(room: MockRoom, role: "host" | "guest", now: number) {
  const since = (room.endedAt ?? now) - room.createdAt;
  const joined = since >= (role === "host" ? MOCK_TIMELINE.hostJoined : MOCK_TIMELINE.guestJoined);
  const ready = since >= (role === "host" ? MOCK_TIMELINE.hostReady : MOCK_TIMELINE.guestReady);
  return { role, joined, ready };
}

function stateOf(room: MockRoom, now: number): RoomState {
  if (room.endedAt !== null) return "ended";
  return now - room.createdAt >= MOCK_TIMELINE.hostReady ? "active" : "waiting";
}

function usageMinutes(room: MockRoom, now: number): number {
  const activeAt = room.createdAt + MOCK_TIMELINE.hostReady;
  const until = room.endedAt ?? now;
  return until <= activeAt ? 0 : Math.floor((until - activeAt) / 60_000);
}

function standaloneParticipant(room: MockStandaloneRoom, role: "host" | "guest", now: number) {
  const issuedAt = role === "host" ? room.hostInvite.issuedAt : room.guestInvite.issuedAt;
  const until = room.endedAt ?? Math.min(now, room.expiresAt);
  const since = until - issuedAt;
  return {
    role,
    joined: since >= (role === "host" ? MOCK_TIMELINE.hostJoined : MOCK_TIMELINE.guestJoined),
    ready: since >= (role === "host" ? MOCK_TIMELINE.hostReady : MOCK_TIMELINE.guestReady),
  };
}

function standaloneState(room: MockStandaloneRoom, now: number): RoomState {
  if (room.endedAt !== null || now >= room.expiresAt) return "ended";
  // The synthetic native start is represented by both seats becoming ready; one ready
  // participant never starts the room on their own.
  return standaloneParticipant(room, "host", now).ready && standaloneParticipant(room, "guest", now).ready ? "active" : "waiting";
}

function standaloneUsageMinutes(room: MockStandaloneRoom, now: number): number {
  const activeAt = room.createdAt + Math.max(MOCK_TIMELINE.hostReady, MOCK_TIMELINE.guestReady);
  const until = room.endedAt ?? Math.min(now, room.expiresAt);
  return until <= activeAt ? 0 : Math.floor((until - activeAt) / 60_000);
}

function standaloneRoomBody(room: MockStandaloneRoom, now: number) {
  return {
    roomId: room.roomId,
    state: standaloneState(room, now),
    hostLanguage: room.hostLanguage,
    guestLanguage: room.guestLanguage,
    expiresAt: new Date(room.expiresAt).toISOString(),
    participants: [standaloneParticipant(room, "host", now), standaloneParticipant(room, "guest", now)],
    usageMinutes: standaloneUsageMinutes(room, now),
  };
}

function standaloneInvite(room: MockStandaloneRoom, role: "host" | "guest") {
  const value = role === "host" ? room.hostInvite : room.guestInvite;
  return { inviteUrl: `${MOCK_STANDALONE_INVITE_ORIGIN}/t#${value.code}`, expiresAt: new Date(value.issuedAt + MOCK_INVITE_TTL_MS).toISOString() };
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
  const standalone = new Map<string, MockStandaloneRoom>();
  const key = (providerId: string, requestId: string, roomId: string) => `${providerId}\u0000${requestId}\u0000${roomId}`;
  return {
    async route(request, deps) {
      let pathname: string;
      try { pathname = new URL(request.url).pathname; } catch { return null; }
      const standaloneMatch = STANDALONE_PATH.exec(pathname);
      if (standaloneMatch) {
        let providerId: string;
        let roomId: string | undefined;
        try {
          providerId = decodeURIComponent(standaloneMatch[1] ?? "");
          roomId = standaloneMatch[3] === undefined ? undefined : decodeURIComponent(standaloneMatch[3]);
        } catch { return notFound(); }
        if (!(await deps.providerExists(providerId))) return notFound();
        const method = request.method.toUpperCase();
        const now = deps.now();
        const current = standalone.get(providerId);
        if (standaloneMatch[2] === "current") {
          if (method !== "GET") return notFound();
          return json(200, { room: current && standaloneState(current, now) !== "ended" ? standaloneRoomBody(current, now) : null });
        }
        if (roomId === undefined) {
          if (method !== "POST") return notFound();
          let value: unknown;
          try { value = await request.json(); } catch { return json(400, { error: { code: "INVALID_INPUT", message: "mock: INVALID_INPUT", details: {} } }); }
          const record = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
          if (!record || Object.keys(record).length !== 1 || (record.hostLanguage !== "ja" && record.hostLanguage !== "en")) {
            return json(400, { error: { code: "INVALID_INPUT", message: "mock: INVALID_INPUT", details: {} } });
          }
          if (current && standaloneState(current, now) !== "ended") return json(409, { error: { code: "TRANSLATE_ROOM_EXISTS", message: "mock: TRANSLATE_ROOM_EXISTS", details: { roomId: current.roomId } } });
          const room: MockStandaloneRoom = {
            providerId,
            roomId: token("mock-standalone-room-"),
            hostLanguage: record.hostLanguage,
            guestLanguage: record.hostLanguage === "ja" ? "en" : "ja",
            createdAt: now,
            expiresAt: now + MOCK_STANDALONE_ROOM_TTL_MS,
            endedAt: null,
            hostInvite: { code: inviteCode(), issuedAt: now },
            guestInvite: { code: inviteCode(), issuedAt: now },
          };
          standalone.set(providerId, room);
          return json(201, { room: standaloneRoomBody(room, now), host: standaloneInvite(room, "host"), guest: standaloneInvite(room, "guest") });
        }
        if (!current || current.roomId !== roomId) return notFound();
        if (standaloneMatch[4] === "end") {
          if (method !== "POST") return notFound();
          current.endedAt ??= now;
          return json(200, { roomId: current.roomId, state: "ended" });
        }
        const role = standaloneMatch[5] as "host" | "guest" | undefined;
        if (role) {
          if (method !== "POST" || standaloneState(current, now) === "ended") return notFound();
          current[role === "host" ? "hostInvite" : "guestInvite"] = { code: inviteCode(), issuedAt: now };
          return json(200, { roomId: current.roomId, role, invite: standaloneInvite(current, role) });
        }
        if (method !== "GET") return notFound();
        return json(200, standaloneRoomBody(current, now));
      }
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
        const hostCode = inviteCode(), guestCode = inviteCode();
        const room: MockRoom = {
          providerId, requestId, roomId: token("mock-room-"), createdAt: now, endedAt: null,
          hostParticipantId: token("mock-participant-"), guestParticipantId: token("mock-participant-"), hostCode, guestCode,
          hostInviteUrl: `${MOCK_INVITE_ORIGIN}/t#${hostCode}`, guestInviteUrl: `${MOCK_INVITE_ORIGIN}/t#${guestCode}`,
        };
        rooms.set(key(providerId, requestId, room.roomId), room);
        return json(201, {
          roomId: room.roomId, state: "waiting",
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
        return json(200, { roomId: room.roomId, state: "ended" });
      }
      if (method !== "GET") return notFound();
      return json(200, { state: stateOf(room, now), participants: [participant(room, "host", now), participant(room, "guest", now)], usageMinutes: usageMinutes(room, now) });
    },
  };
}
