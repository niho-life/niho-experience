import type { ExperienceTranslateRoomCreatedResponse, ExperienceTranslateRoomState, ExperienceTranslateRoomStatusResponse } from "@niho-experience/api-client/experience-translate-rooms";
import type { StatusLabel } from "./status";

/*
 * 対面通訳 (#181): what the host screen knows about a room. NIHO is the authority (the room,
 * the invite codes, the relay tickets, the budget); this site shows the way in. The browser
 * gets the two invite URLs, the state and who has joined, never a participantId, an inviteCode
 * on its own or a token. The code is only inside the URL the QR encodes.
 */

/** Browser DTO for a room just made. */
export interface HostTranslateRoomResponse {
  room: {
    id: string;
    state: ExperienceTranslateRoomState;
    /** When both invite URLs stop working (ISO 8601). */
    expiresAt: string;
    hostInviteUrl: string;
    guestInviteUrl: string;
  };
}

export interface HostTranslateParticipantStatus {
  joined: boolean;
  ready: boolean;
}

/** Browser DTO for 参加状況. A role NIHO did not list has not joined. */
export interface HostTranslateRoomStatusResponse {
  state: ExperienceTranslateRoomState;
  host: HostTranslateParticipantStatus;
  guest: HostTranslateParticipantStatus;
  usageMinutes: number;
}

export interface HostTranslateRoomEndResponse {
  state: ExperienceTranslateRoomState;
}

export const NOT_JOINED: HostTranslateParticipantStatus = { joined: false, ready: false };

export function projectTranslateRoom(value: ExperienceTranslateRoomCreatedResponse): HostTranslateRoomResponse {
  return { room: { id: value.roomId, state: value.state, expiresAt: value.expiresAt, hostInviteUrl: value.host.inviteUrl, guestInviteUrl: value.guest.inviteUrl } };
}

export function projectTranslateRoomStatus(value: ExperienceTranslateRoomStatusResponse): HostTranslateRoomStatusResponse {
  const of = (role: "host" | "guest"): HostTranslateParticipantStatus => {
    const found = value.participants.find((participant) => participant.role === role);
    return found ? { joined: found.joined, ready: found.ready } : NOT_JOINED;
  };
  return { state: value.state, host: of("host"), guest: of("guest"), usageMinutes: value.usageMinutes };
}

/** An English-speaking guest, or one whose language NIHO did not record (the Epic: then always offer it). */
export function guestNeedsInterpretation(language: string): boolean {
  const value = language.trim().toLowerCase();
  return value === "" || value.startsWith("en");
}

/**
 * 通訳を始める is offered on a confirmed booking of such a guest whose day has not passed
 * (`date` and `today` are YYYY-MM-DD in Japan). A request still waiting for approval, a
 * cancelled booking or last week's dinner never shows it.
 */
export function translationOffered(booking: { confirmed: boolean; language: string; date: string }, today: string): boolean {
  return booking.confirmed && guestNeedsInterpretation(booking.language) && booking.date >= today;
}

export const TRANSLATE_ROOM_STATUS: Record<ExperienceTranslateRoomState, StatusLabel> = {
  created: { label: "開始待ち", tone: "wait" },
  active: { label: "通訳中", tone: "ok" },
  paused: { label: "一時停止", tone: "wait" },
  ended: { label: "終了", tone: "draft" },
};

/** 参加状況 of one person: 未参加 until their iPhone joined, 接続中 once it did (準備中 until earphones and consent are done). */
export function participantStatus(participant: HostTranslateParticipantStatus | undefined): StatusLabel {
  if (!participant?.joined) return { label: "未参加", tone: "draft" };
  return participant.ready ? { label: "接続中", tone: "ok" } : { label: "接続中 · 準備中", tone: "wait" };
}

/** "13:45" in Japan for an ISO instant. */
export function timeInJapan(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
}
