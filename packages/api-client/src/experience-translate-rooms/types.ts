import type { components } from "../generated/experience-translate-rooms-openapi.ts";

type Schemas = components["schemas"];

export type ExperienceTranslateRoomState = Schemas["ExperienceProviderTranslateRoomCreated"]["state"];
export type ExperienceTranslateParticipantRole = Schemas["ExperienceProviderTranslateRoomParticipant"]["role"];
export type ExperienceTranslateInvite = Schemas["TranslateInviteParticipant"];
export type ExperienceTranslateRoomCreatedResponse = Schemas["ExperienceProviderTranslateRoomCreated"];
export type ExperienceTranslateRoomParticipant = Schemas["ExperienceProviderTranslateRoomParticipant"];
export type ExperienceTranslateRoomStatusResponse = Schemas["ExperienceProviderTranslateRoomStatus"];
export type ExperienceTranslateRoomEndResponse = Schemas["TranslateRoomStateResult"];

export type ExperienceTranslateRoomsFailure =
  | { ok: false; kind: "invalid_request" }
  | { ok: false; kind: "rejected"; status: 401 | 403 }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "conflict" }
  | { ok: false; kind: "limited" }
  | { ok: false; kind: "network_error" }
  | { ok: false; kind: "unexpected_response"; status: number };

export type ExperienceTranslateRoomsResult<T> = { ok: true; data: T } | ExperienceTranslateRoomsFailure;

export const EXPERIENCE_TRANSLATE_ROOM_STATES = ["waiting", "active", "paused", "ended"] as const satisfies readonly ExperienceTranslateRoomState[];
export const EXPERIENCE_TRANSLATE_PARTICIPANT_ROLES = ["host", "guest"] as const satisfies readonly ExperienceTranslateParticipantRole[];
