import "server-only";
import { createHash } from "node:crypto";
import { shortDateWithWeekdayJa, todayInJapan } from "@/host/format";
import type { HostNotificationKey } from "@/host/types";
import { HOST_APP_SCOPE } from "../routes";

/**
 * What a push to the host app may say (#177 P2, owner decision 2026-10-28): the kind, the experience,
 * the date and time and the party size. There is deliberately no field for a guest's name, a
 * message's text or an amount, so none can reach a lock screen.
 */
export interface HostPushEvent {
  providerId: string;
  kind: HostNotificationKey;
  /**
   * A question before booking (予約前の質問) rather than a message from someone who booked: still GUEST_MESSAGE
   * (its switch in 設定 › 通知 and its delivery), with its own title.
   */
  question?: true;
  experienceTitle?: string;
  /** ISO 8601; shown in Japan time. */
  startsAt?: string;
  seats?: number;
  /** Where a tap opens: a path under /host/. */
  url: string;
  /** Replaces the device's earlier notification with the same tag (and the push service's queued one). */
  tag: string;
  /** The app icon's count (Badging API), where the device has one. */
  badgeCount?: number;
}

/** The JSON the service worker reads (lib/host/service-worker.ts). */
export interface HostPushMessage {
  v: 1;
  title: string;
  body: string;
  url: string;
  tag: string;
  badge?: number;
}

export const HOST_PUSH_TITLES: Record<HostNotificationKey, string> = {
  NEW_BOOKING: "新しい予約・申込",
  APPROVAL_DEADLINE: "承認の期限が近づいています",
  CANCELLATION: "予約が取り消されました",
  GUEST_MESSAGE: "予約者から連絡があります",
  DAY_BEFORE_SUMMARY: "明日の参加者のまとめ",
  NEW_REVIEW: "新しいレビュー",
  LISTING_REVIEW: "掲載の審査結果",
};

export const HOST_PUSH_QUESTION_TITLE = "予約前の質問が届きました";

export const HOST_PUSH_MAX_BYTES = 3 * 1024;
const TITLE_MAX = 80;
const URL_MAX = 512;
const TAG_MAX = 64;
const JST_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** A path under /host/ on this site, or an error: a tap must stay inside the app. */
export function hostPushUrl(url: string): string {
  if (url.length > URL_MAX || !url.startsWith(HOST_APP_SCOPE) || url.includes("\\")) throw new Error("A host push URL must be a path under /host/");
  const parsed = new URL(url, "https://host.invalid");
  if (parsed.origin !== "https://host.invalid" || !parsed.pathname.startsWith(HOST_APP_SCOPE)) throw new Error("A host push URL must be a path under /host/");
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/** "10/22（木）18:00" in Japan time, or null. */
function whenJa(startsAt: string | undefined): string | null {
  const at = startsAt ? Date.parse(startsAt) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  return `${shortDateWithWeekdayJa(todayInJapan(at))}${JST_TIME.format(new Date(at))}`;
}

function titleLine(title: string | undefined): string | null {
  const clean = title?.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  if (clean.length <= TITLE_MAX) return clean;
  // Whole code points only: half of an emoji would show as a broken character on the lock screen.
  let clipped = "";
  for (const character of clean) {
    if (clipped.length + character.length > TITLE_MAX - 1) break;
    clipped += character;
  }
  return `${clipped}…`;
}

export function hostPushPayload(event: HostPushEvent): string {
  const tag = event.tag.trim();
  if (!tag || tag.length > TAG_MAX) throw new Error("A host push tag must be 1-64 characters");
  const seats = Number.isInteger(event.seats) && event.seats! > 0 ? `${event.seats}名` : null;
  const message: HostPushMessage = {
    v: 1,
    title: event.kind === "GUEST_MESSAGE" && event.question === true ? HOST_PUSH_QUESTION_TITLE : HOST_PUSH_TITLES[event.kind],
    body: [titleLine(event.experienceTitle), whenJa(event.startsAt), seats].filter(Boolean).join(" · "),
    url: hostPushUrl(event.url),
    tag,
    ...(Number.isInteger(event.badgeCount) && event.badgeCount! >= 0 ? { badge: event.badgeCount } : {}),
  };
  const json = JSON.stringify(message);
  if (Buffer.byteLength(json) > HOST_PUSH_MAX_BYTES) throw new Error("A host push payload must stay within 3 KB");
  return json;
}

/** 設定 › この端末's テスト通知: the same shape, nothing about a booking. */
export function hostPushTestPayload(): string {
  const message: HostPushMessage = { v: 1, title: "テスト通知", body: "この端末に NIHO 体験ホストの通知が届きます。", url: "/host/settings#settings-device", tag: "host-push-test" };
  return JSON.stringify(message);
}

/** Time-critical kinds go out at once; a deadline or a summary is useless once it has passed. */
export function hostPushDelivery(kind: HostNotificationKey): { urgency: "high" | "normal"; ttlSeconds: number } {
  const urgent = kind === "NEW_BOOKING" || kind === "APPROVAL_DEADLINE" || kind === "GUEST_MESSAGE" || kind === "CANCELLATION";
  const ttlSeconds = kind === "APPROVAL_DEADLINE" ? 60 * 60 : kind === "DAY_BEFORE_SUMMARY" ? 12 * 60 * 60 : 24 * 60 * 60;
  return { urgency: urgent ? "high" : "normal", ttlSeconds };
}

/** The push service's Topic (base64url, at most 32): a digest, so the tag's ids do not reach it. */
export function hostPushTopic(tag: string): string {
  return createHash("sha256").update(tag).digest("base64url").slice(0, 32);
}
