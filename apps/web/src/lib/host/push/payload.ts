import "server-only";
import { createHash } from "node:crypto";
import { shortDateWithWeekdayJa, todayInJapan } from "@/host/format";
import { otaSiteLabel } from "@/host/ota-sites";
import type { HostNotificationKey } from "@/host/types";
import { HOST_APP_ICONS } from "../pwa";
import { HOST_APP_SCOPE } from "../routes";

/**
 * What a push to the host app may say (#177 P2, owner decision 2026-10-28): the kind, the experience,
 * the date and time and the party size. There is deliberately no field for a message's text, a contact or an
 * amount, so none can reach a lock screen. A guest's name comes only with a booking made on a reservation site
 * (`ota`, #194, owner decision 2026-11-01): the host learns there which site it came from and who booked.
 */
/**
 * What a push is about: one of 設定 › 通知's notifications, or a Google calendar this site cannot read (#238), which
 * always comes and has no switch there.
 */
export type HostPushKind = HostNotificationKey | "GOOGLE_CALENDAR_ATTENTION";

export interface HostPushEvent {
  providerId: string;
  kind: HostPushKind;
  /**
   * A question before booking (予約前の質問) rather than a message from someone who booked: still GUEST_MESSAGE
   * (its switch in 設定 › 通知 and its delivery), with its own title.
   */
  question?: true;
  experienceTitle?: string;
  /** ISO 8601; shown in Japan time. */
  startsAt?: string;
  seats?: number;
  /** A fixed line from this site in place of the experience, time and party (GOOGLE_CALENDAR_ATTENTION). */
  note?: string;
  /** Where a tap opens: a path under /host/. */
  url: string;
  /** Replaces the device's earlier notification with the same tag (and the push service's queued one). */
  tag: string;
  /** The app icon's count (Badging API), where the device has one. */
  badgeCount?: number;
  /**
   * A booking made on a reservation site (#194): which site, and whether it is new, cancelled or moved (from
   * `previousStartsAt`). It sets the title; `kind` stays the 設定 › 通知 notification it counts as.
   */
  ota?: { site: string; change: "NEW" | "CANCELLED" | "RESCHEDULED"; previousStartsAt?: string };
  /** The guest's name, with `ota` only. */
  guestName?: string;
  /** Only this product's people (its OWNER and operators) get it, instead of every member of the provider. */
  productId?: string;
  /**
   * 担当を募る (#535): a NIHO-managed request that needs an internal assignee. Only the people who can take the occurrence
   * (the provider's OWNER and COHOST and the product's operators; the assignee alone once there is one) get it. It sets the
   * title; `kind` stays NEW_BOOKING, which cannot be turned off. Needs `productId`.
   */
  assignment?: { occurrenceId: string };
  /** Only the provider's OWNER gets it (an operations suspension: only the OWNER can resume the listing). */
  ownerOnly?: true;
  /**
   * Operations stopped this listing or cleared that stop (#109, LISTING_SUSPENSION): it sets the title, and a clearing adds
   * the line that the OWNER still resumes it. Never the reason; the host reads it in /host.
   */
  listing?: { change: "SUSPENDED" | "CLEARED" };
}

/**
 * Declarative Web Push (#177 P3; W3C Push API §3.3, Safari 18.4+): a message with this `web_push` value is shown by the
 * browser itself, without waking the service worker, so it still appears when the worker cannot run.
 */
export const HOST_DECLARATIVE_PUSH = 8030;

/** The `notification` of a declarative message: the same words as the legacy fields, and where a tap goes. */
export interface HostDeclarativeNotification {
  title: string;
  body: string;
  /** Absolute when the site's origin is known, else the path (a browser resolves it against the registration's scope). */
  navigate: string;
  tag: string;
  lang: "ja";
  dir: "ltr";
  icon?: string;
  /**
   * What /host/sw.js reads when the browser hands it this notification as `event.notification` (mutable: true): where a tap goes
   * and the app icon's count. `badge` is kept for zero too, which the worker turns into clearAppBadge.
   */
  data: { url: string; badge?: number };
  /** The app icon's count as WebKit's examples write it: a string. Left out for zero; the worker clears it. */
  app_badge?: string;
}

/**
 * The JSON of a push. The legacy fields (`v` to `badge`) are what /host/sw.js reads (lib/host/service-worker.ts) in a
 * browser without declarative push. A browser with it reads `web_push` and `notification` and ignores the rest.
 * `mutable: true` keeps the worker's push event, which then has no data and gets this notification as `event.notification`
 * (Push API §10.3): the worker sets the app badge and tells the open pages, and shows nothing itself, so the browser shows this
 * one. A worker that shows a notification replaces it. Browsers without declarative push read the legacy fields instead.
 */
export interface HostPushMessage {
  v: 1;
  title: string;
  body: string;
  url: string;
  tag: string;
  badge?: number;
  web_push: typeof HOST_DECLARATIVE_PUSH;
  mutable: true;
  notification: HostDeclarativeNotification;
}

export const HOST_PUSH_TITLES: Record<HostPushKind, string> = {
  NEW_BOOKING: "新しい予約・申込",
  CANCELLATION: "予約が取り消されました",
  GUEST_MESSAGE: "予約者から連絡があります",
  DAY_BEFORE_SUMMARY: "明日の参加者のまとめ",
  NEW_REVIEW: "新しいレビュー",
  EMAIL_DELIVERY_FAILED: "予約者へのメールが届きませんでした",
  LISTING_SUSPENSION: "運営が掲載を停止しました",
  GOOGLE_CALENDAR_ATTENTION: "Googleカレンダーを確認してください",
};

/** A request that needs someone to take it: said apart from a booking, because the host is asked to press 対応する. */
export const HOST_PUSH_ASSIGNMENT_TITLE = "担当を募集中の申込";

export const HOST_PUSH_QUESTION_TITLE = "予約前の質問が届きました";

/** A clearing of an operations stop: the listing stays off until the OWNER resumes it (owner_resume_required). */
export const HOST_PUSH_LISTING_CLEARED_TITLE = "運営による停止が解除されました";
export const HOST_PUSH_LISTING_CLEARED_NOTE = "オーナーが再公開すると、掲載に戻ります";

/** A booking on a reservation site: the site's name goes first, so the host sees where it came from. */
export function hostPushOtaTitle(ota: NonNullable<HostPushEvent["ota"]>): string {
  const site = otaSiteLabel(ota.site);
  return ota.change === "NEW" ? `${site} で新しい予約` : ota.change === "CANCELLED" ? `${site} の予約が取り消されました` : `${site} の予約の日時が変わりました`;
}

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
export function whenJa(startsAt: string | undefined): string | null {
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

/** "10/22（木）18:00 → 10/24（土）18:00" for a move, else the time alone. */
function whenLine(event: HostPushEvent): string | null {
  const when = whenJa(event.startsAt);
  const before = event.ota?.change === "RESCHEDULED" ? whenJa(event.ota.previousStartsAt) : null;
  return before && when ? `${before} → ${when}` : when;
}

/**
 * The words of a push, line by line: its title and what its body says (the experience, the time, an OTA guest's name and
 * the party). The host's email about the same booking says the same (#194, lib/mail/host-templates.ts).
 */
export function hostPushLines(event: HostPushEvent): { title: string; experience: string | null; when: string | null; guest: string | null; seats: string | null } {
  return {
    title: event.ota ? hostPushOtaTitle(event.ota)
      : event.assignment ? HOST_PUSH_ASSIGNMENT_TITLE
      : event.listing?.change === "CLEARED" ? HOST_PUSH_LISTING_CLEARED_TITLE
      : event.kind === "GUEST_MESSAGE" && event.question === true ? HOST_PUSH_QUESTION_TITLE : HOST_PUSH_TITLES[event.kind],
    experience: titleLine(event.experienceTitle),
    when: whenLine(event),
    guest: event.ota ? titleLine(event.guestName) : null,
    seats: Number.isInteger(event.seats) && event.seats! > 0 ? `${event.seats}名` : null,
  };
}

/** The legacy fields and the declarative `notification` for one message (see HostPushMessage). */
function pushMessage(input: { title: string; body: string; url: string; tag: string; badgeCount?: number }, origin?: string): HostPushMessage {
  const badge = Number.isInteger(input.badgeCount) && input.badgeCount! >= 0 ? input.badgeCount! : undefined;
  const absolute = (path: string) => (origin ? new URL(path, origin).href : path);
  return {
    v: 1,
    title: input.title,
    body: input.body,
    url: input.url,
    tag: input.tag,
    ...(badge !== undefined ? { badge } : {}),
    web_push: HOST_DECLARATIVE_PUSH,
    mutable: true,
    notification: {
      title: input.title,
      body: input.body,
      navigate: absolute(input.url),
      tag: input.tag,
      lang: "ja",
      dir: "ltr",
      data: { url: absolute(input.url), ...(badge !== undefined ? { badge } : {}) },
      ...(origin ? { icon: absolute(HOST_APP_ICONS.icon192) } : {}),
      ...(badge !== undefined && badge > 0 ? { app_badge: String(badge) } : {}),
    },
  };
}

/** `origin` is this site's (https://experience.niho.life): with it a declarative message names absolute addresses. */
export function hostPushPayload(event: HostPushEvent, origin?: string): string {
  const tag = event.tag.trim();
  if (!tag || tag.length > TAG_MAX) throw new Error("A host push tag must be 1-64 characters");
  const lines = hostPushLines(event);
  const message = pushMessage({
    title: lines.title,
    body: event.note ?? [lines.experience, lines.when, lines.guest ? `${lines.guest} 様` : null, lines.seats,
      event.listing?.change === "CLEARED" ? HOST_PUSH_LISTING_CLEARED_NOTE : null].filter(Boolean).join(" · "),
    url: hostPushUrl(event.url),
    tag,
    badgeCount: event.badgeCount,
  }, origin);
  const json = JSON.stringify(message);
  if (Buffer.byteLength(json) > HOST_PUSH_MAX_BYTES) throw new Error("A host push payload must stay within 3 KB");
  return json;
}

/** 設定 › この端末's テスト通知: the same shape, nothing about a booking. */
export function hostPushTestPayload(origin?: string): string {
  return JSON.stringify(pushMessage({ title: "テスト通知", body: "この端末に NIHO 体験ホストの通知が届きます。", url: "/host/settings#settings-device", tag: "host-push-test" }, origin));
}

/** Time-critical kinds go out at once; a summary is useless once it has passed. */
export function hostPushDelivery(kind: HostPushKind): { urgency: "high" | "normal"; ttlSeconds: number } {
  // A calendar that cannot be read keeps new bookings closed until the host acts.
  const urgent = kind === "NEW_BOOKING" || kind === "GUEST_MESSAGE" || kind === "CANCELLATION"
    || kind === "GOOGLE_CALENDAR_ATTENTION";
  const ttlSeconds = kind === "DAY_BEFORE_SUMMARY" ? 12 * 60 * 60 : 24 * 60 * 60;
  return { urgency: urgent ? "high" : "normal", ttlSeconds };
}

/** The push service's Topic (base64url, at most 32): a digest, so the tag's ids do not reach it. */
export function hostPushTopic(tag: string): string {
  return createHash("sha256").update(tag).digest("base64url").slice(0, 32);
}
