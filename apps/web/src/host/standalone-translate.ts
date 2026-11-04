import type {
  StandaloneTranslateInvite,
  StandaloneTranslateLanguage,
  StandaloneTranslateRoom,
  StandaloneTranslateRoomCreated,
} from "@niho-experience/api-client/experience-translate-rooms";
import { NOT_JOINED, type HostTranslateParticipantStatus } from "./translate";

export type HostStandaloneTranslateLanguage = StandaloneTranslateLanguage;
export type HostStandaloneTranslateInvite = StandaloneTranslateInvite;
export type HostStandaloneTranslateRoom = StandaloneTranslateRoom;
export type HostStandaloneTranslateCreated = StandaloneTranslateRoomCreated;
export interface HostStandaloneTranslateCurrent { room: HostStandaloneTranslateRoom | null }
export interface HostStandaloneTranslateInviteResult { roomId: string; role: "host" | "guest"; invite: HostStandaloneTranslateInvite }

/** Browser path uses the local Experience provider id; the BFF resolves NIHO's id server-side. */
export function standaloneTranslateBffPath(localProviderId: string): string {
  return `translate/standalone/providers/${encodeURIComponent(localProviderId)}/rooms`;
}

export function standaloneParticipant(room: HostStandaloneTranslateRoom | null, role: "host" | "guest"): HostTranslateParticipantStatus {
  const participant = room?.participants.find((item) => item.role === role);
  return participant ? { joined: participant.joined, ready: participant.ready } : NOT_JOINED;
}

export function standaloneLanguageLabel(language: HostStandaloneTranslateLanguage): string {
  return language === "ja" ? "日本語" : "English";
}

export function standaloneTranslateErrorText(status: number, action: "load" | "create" | "invite" | "end"): string {
  if (status === 401 || status === 403) return "通訳を操作する権限を確認できません。NIHOでログインし直してください。";
  if (status === 404) {
    if (action === "create") return "この提供者ではまだ通訳を利用できません。";
    return action === "load" ? "通訳の部屋はありません。" : "この通訳はすでに終了しています。";
  }
  if (status === 409) return action === "create" ? "進行中の通訳を確認しています。" : "いまはこの操作を行えません。";
  if (status === 429) return "通訳の利用上限に達しています。時間をおいてもう一度お試しください。";
  return action === "load" ? "通訳の状態を読み込めませんでした。" : "通信を確認して、もう一度お試しください。";
}

export function standaloneInviteUsable(invite: HostStandaloneTranslateInvite | null, now = Date.now()): invite is HostStandaloneTranslateInvite {
  return invite !== null && Number.isFinite(Date.parse(invite.expiresAt)) && Date.parse(invite.expiresAt) > now;
}

/** Milliseconds until the next live invite must disappear, including the expiry instant. */
export function standaloneInviteExpiryDelay(invites: readonly (HostStandaloneTranslateInvite | null)[], now = Date.now()): number | null {
  const future = invites
    .map((invite) => invite ? Date.parse(invite.expiresAt) : Number.NaN)
    .filter((expiresAt) => Number.isFinite(expiresAt) && expiresAt > now);
  return future.length ? Math.min(2_147_483_647, Math.max(1, Math.min(...future) - now + 1)) : null;
}

/** Generation and room fence used before a late async response can update browser memory. */
export function standaloneResponseIsCurrent(generation: number, currentGeneration: number, expectedRoomId?: string, currentRoomId?: string | null): boolean {
  return generation === currentGeneration && (expectedRoomId === undefined || expectedRoomId === currentRoomId);
}
