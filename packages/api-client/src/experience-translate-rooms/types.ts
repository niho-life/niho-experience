import type { components } from "../generated/experience-translate-rooms-openapi.ts";

type Schemas = components["schemas"];

export type ExperienceTranslateRoomState = Schemas["TranslateRoomState"];
export type ExperienceTranslateParticipantRole = Schemas["TranslateParticipantRole"];
export type ExperienceTranslateInvite = Schemas["TranslateInvite"];
export type ExperienceTranslateRoomCreatedResponse = Schemas["TranslateRoomCreatedResponse"];
export type ExperienceTranslateRoomParticipant = Schemas["TranslateRoomParticipant"];
export type ExperienceTranslateRoomStatusResponse = Schemas["TranslateRoomStatusResponse"];
export type ExperienceTranslateRoomEndResponse = Schemas["TranslateRoomEndResponse"];

export type ExperienceTranslateRoomsFailure =
  | { ok: false; kind: "invalid_request" }
  | { ok: false; kind: "rejected"; status: 401 | 403 }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "conflict" }
  | { ok: false; kind: "network_error" }
  | { ok: false; kind: "unexpected_response"; status: number };

export type ExperienceTranslateRoomsResult<T> = { ok: true; data: T } | ExperienceTranslateRoomsFailure;

export const EXPERIENCE_TRANSLATE_ROOM_STATES = ["created", "active", "paused", "ended"] as const satisfies readonly ExperienceTranslateRoomState[];
export const EXPERIENCE_TRANSLATE_PARTICIPANT_ROLES = ["host", "guest"] as const satisfies readonly ExperienceTranslateParticipantRole[];
