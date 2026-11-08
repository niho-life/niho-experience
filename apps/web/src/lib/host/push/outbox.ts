import "server-only";
import { createHash } from "node:crypto";
import {
  HOST_NOTIFICATION_TOPICS,
  parseBookingMessagePayload,
  parseCancellationPayload,
  parseDayBeforeSummaryPayload,
  parseGoogleCalendarAttentionPayload,
  parseGuestEmailDeliveryFailedPayload,
  parseGuestMessagePayload,
  parseGuestQuestionPayload,
  parseListingSuspensionPayload,
  parseNewBookingPayload,
  parseNewReviewPayload,
  parseOtaBookingPayload,
  STOPPABLE_HOST_NOTIFICATION_KEYS,
  type ClaimedHostNotification,
  type HostNotificationOutbox,
  type ProviderNotificationSettings,
  type StoppableHostNotificationKey,
} from "@niho-experience/experience-store";
import { providerNotificationSettings } from "@/lib/experience/store-server";
import { HOST_BOOKINGS_PATH, HOST_CALENDAR_PATH, HOST_EXPERIENCES_PATH, HOST_MESSAGES_PATH, HOST_REVIEWS_PATH, withQuery } from "../routes";
import { notifyHostDevices, type HostPushDeps, type HostPushReport } from "./notify";
import type { HostPushEvent, HostPushKind } from "./payload";

/** The line under "Googleカレンダーを確認してください": what is closed and what is not. Never which calendar. */
export const GOOGLE_CALENDAR_ATTENTION_NOTES = {
  REVOKED: "Google との接続が切れました。つなぎ直すまで、その予定を使う体験の新しい予約を止めています。受けた予約はそのままです。",
  UNAVAILABLE: "Google の予定を読めません。読めるまで、その予定を使う体験の新しい予約を止めています。受けた予約はそのままです。",
} as const;

const GUEST_EMAIL_DELIVERY_FAILURE_NOTES = {
  NO_SUCH_ADDRESS: "宛先が相手側に存在しないと返されました。予約内容を開いて、連絡方法をご確認ください。",
  NO_SUCH_DOMAIN: "宛先のドメインが見つからないと返されました。予約内容を開いて、連絡方法をご確認ください。",
  REJECTED_BY_SERVER: "相手のメールサーバーが受け取りを拒みました。予約内容を開いて、別の連絡方法をご確認ください。",
  MAILBOX_FULL: "相手の受信箱が満杯でメールが届きませんでした。予約内容を開いて、別の連絡方法をご確認ください。",
  TEMPORARY_FAILED: "相手のサーバーに一時的な問題があり、再試行しても届きませんでした。予約内容を開いてご確認ください。",
  OTHER: "相手にメールが届きませんでした。予約内容を開いてご確認ください。",
} as const;

/**
 * The notification job (#177 P2) sends Experience-owned rows from `outbox_messages` as Web Push.
 * Booking, question, attendance, cancellation, review and summary flows write their own rows. This mapper
 * accepts only explicit `host.notify.*` payloads and returns the minimum event; logs contain counts only.
 */
const MESSAGE_STALE_MS = 24 * 60 * 60 * 1000;
const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

export type HostPushEventFromOutbox = { ok: true; event: HostPushEvent } | { ok: false; reason: "invalid" | "stale" };

/** A message, question or booking older than a day is no longer news on a lock screen. */
function staleness(message: ClaimedHostNotification, now: number): HostPushEventFromOutbox | null {
  const createdAt = Date.parse(message.createdAt);
  if (!Number.isFinite(createdAt)) return { ok: false, reason: "invalid" };
  return now - createdAt > MESSAGE_STALE_MS ? { ok: false, reason: "stale" } : null;
}

/**
 * One row as a push event, or why it is not sent: a row of another shape, or a message, question or new
 * booking older than a day. The event carries the experience, its time and the party size only (a question:
 * the experience only).
 */
export function hostPushEventFromOutbox(message: ClaimedHostNotification, now: number): HostPushEventFromOutbox {
  const providerId = message.providerId;
  if (message.topic === HOST_NOTIFICATION_TOPICS.guestMessage) {
    const payload = parseGuestMessagePayload(message.payload);
    if (!payload) return { ok: false, reason: "invalid" };
    const stale = staleness(message, now);
    if (stale) return stale;
    return {
      ok: true,
      event: {
        providerId,
        kind: "GUEST_MESSAGE",
        experienceTitle: payload.experienceTitle,
        startsAt: payload.startsAt,
        seats: payload.seats,
        url: withQuery(HOST_MESSAGES_PATH, { booking: payload.bookingId, providerId }),
        tag: `message-${payload.bookingId}`,
      },
    };
  }
  if (message.topic === HOST_NOTIFICATION_TOPICS.guestQuestion) {
    const payload = parseGuestQuestionPayload(message.payload);
    if (!payload) return { ok: false, reason: "invalid" };
    const stale = staleness(message, now);
    if (stale) return stale;
    return {
      ok: true,
      event: {
        providerId,
        kind: "GUEST_MESSAGE",
        question: true,
        experienceTitle: payload.experienceTitle,
        url: withQuery(HOST_MESSAGES_PATH, { thread: payload.threadId, providerId }),
        // A guest's later answer in the same thread replaces the earlier notification.
        tag: `question-${payload.threadId}`,
      },
    };
  }
  if (message.topic === HOST_NOTIFICATION_TOPICS.bookingMessage) {
    const payload = parseBookingMessagePayload(message.payload);
    if (!payload) return { ok: false, reason: "invalid" };
    const stale = staleness(message, now);
    if (stale) return stale;
    return {
      ok: true,
      event: {
        providerId,
        kind: "GUEST_MESSAGE",
        experienceTitle: payload.experienceTitle,
        startsAt: payload.startsAt,
        seats: payload.seats,
        // This site's threads (#285 slice 6b), with this one opened.
        url: withQuery(HOST_MESSAGES_PATH, { thread: payload.threadId, providerId }),
        // The guest's next message in the same booking replaces the earlier notification.
        tag: `booking-message-${payload.threadId}`,
      },
    };
  }
  if (message.topic === HOST_NOTIFICATION_TOPICS.newBooking) {
    const payload = parseNewBookingPayload(message.payload);
    if (!payload) return { ok: false, reason: "invalid" };
    const stale = staleness(message, now);
    if (stale) return stale;
    return {
      ok: true,
      event: {
        providerId,
        kind: "NEW_BOOKING",
        experienceTitle: payload.experienceTitle,
        startsAt: payload.startsAt,
        seats: payload.seats,
        // The bookings made on this site (#285 slice 8), with this one opened.
        url: withQuery(HOST_BOOKINGS_PATH, { booking: payload.bookingId, providerId }),
        tag: `booking-${payload.bookingId}`,
      },
    };
  }
  if (message.topic === HOST_NOTIFICATION_TOPICS.newReview) {
    const payload = parseNewReviewPayload(message.payload);
    if (!payload) return { ok: false, reason: "invalid" };
    const stale = staleness(message, now);
    if (stale) return stale;
    return {
      ok: true,
      event: {
        providerId,
        kind: "NEW_REVIEW",
        experienceTitle: payload.experienceTitle,
        url: `${withQuery(HOST_REVIEWS_PATH, { providerId })}#review-${payload.reviewId}`,
        tag: `review-${payload.reviewId}`,
      },
    };
  }
  if (message.topic === HOST_NOTIFICATION_TOPICS.guestEmailDeliveryFailed) {
    const payload = parseGuestEmailDeliveryFailedPayload(message.payload);
    if (!payload) return { ok: false, reason: "invalid" };
    return {
      ok: true,
      event: {
        providerId,
        kind: "EMAIL_DELIVERY_FAILED",
        experienceTitle: payload.experienceTitle,
        startsAt: payload.startsAt,
        seats: payload.seats,
        note: GUEST_EMAIL_DELIVERY_FAILURE_NOTES[payload.classification],
        url: withQuery(HOST_BOOKINGS_PATH, { booking: payload.bookingId, providerId }),
        tag: `email-delivery-failed-${payload.bookingId}`,
      },
    };
  }
  if (message.topic === HOST_NOTIFICATION_TOPICS.dayBeforeSummary) {
    const payload = parseDayBeforeSummaryPayload(message.payload);
    if (!payload) return { ok: false, reason: "invalid" };
    const japanToday = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(now));
    const tomorrow = new Date(`${japanToday}T00:00:00.000Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    if (payload.localDate !== tomorrow.toISOString().slice(0, 10)) return { ok: false, reason: "stale" };
    const [year, month, day] = payload.localDate.split("-").map(Number);
    return {
      ok: true,
      event: {
        providerId,
        kind: "DAY_BEFORE_SUMMARY",
        note: `明日 ${year}年${month}月${day}日の確定予約：${payload.bookingCount}件・${payload.participantCount}名`,
        url: withQuery(HOST_BOOKINGS_PATH, { providerId }),
        tag: `day-before-summary-${payload.localDate}`,
      },
    };
  }
  if (message.topic === HOST_NOTIFICATION_TOPICS.cancellation) {
    const payload = parseCancellationPayload(message.payload);
    if (!payload) return { ok: false, reason: "invalid" };
    const stale = staleness(message, now);
    if (stale) return stale;
    return {
      ok: true,
      event: {
        providerId,
        kind: "CANCELLATION",
        experienceTitle: payload.experienceTitle,
        startsAt: payload.startsAt,
        seats: payload.seats,
        // The bookings made on this site (#285 slice 8), with the cancelled one opened.
        url: withQuery(HOST_BOOKINGS_PATH, { booking: payload.bookingId, providerId }),
        tag: `cancellation-${payload.bookingId}`,
      },
    };
  }
  if (message.topic === HOST_NOTIFICATION_TOPICS.otaBooking) {
    const payload = parseOtaBookingPayload(message.payload);
    if (!payload) return { ok: false, reason: "invalid" };
    const stale = staleness(message, now);
    if (stale) return stale;
    return {
      ok: true,
      event: {
        providerId,
        // 設定 › 通知's 新しい予約・申込 (a move too) or 予約の取消: both always come.
        kind: payload.change === "CANCELLED" ? "CANCELLATION" : "NEW_BOOKING",
        experienceTitle: payload.experienceTitle,
        startsAt: payload.startsAt,
        seats: payload.seats,
        ota: { site: payload.site, change: payload.change, ...(payload.previousStartsAt === undefined ? {} : { previousStartsAt: payload.previousStartsAt }) },
        ...(payload.guestName === undefined ? {} : { guestName: payload.guestName }),
        // The product's OWNER and operators only (#194).
        productId: payload.productId,
        // The bookings, with this one opened (its handle, never the site's IDs).
        url: withQuery(HOST_BOOKINGS_PATH, { ota: payload.ref, providerId }),
        // A later change of the same booking replaces the earlier notification.
        tag: `ota-${payload.ref}`,
      },
    };
  }
  if (message.topic === HOST_NOTIFICATION_TOPICS.listingSuspension) {
    const payload = parseListingSuspensionPayload(message.payload);
    if (!payload) return { ok: false, reason: "invalid" };
    const stale = staleness(message, now);
    if (stale) return stale;
    return {
      ok: true,
      event: {
        providerId,
        kind: "LISTING_SUSPENSION",
        experienceTitle: payload.experienceTitle,
        listing: { change: payload.change },
        // The OWNER only: the screen below is the OWNER's (a product operator is refused there), and only the OWNER can resume.
        ownerOnly: true,
        // 体験の編集, where the listing's state (運営停止中・再公開が必要) and its 再公開 are.
        url: withQuery(`${HOST_EXPERIENCES_PATH}/${encodeURIComponent(payload.productId)}`, { providerId }),
        // A clearing replaces the suspension on the device.
        tag: `listing-${createHash("sha256").update(payload.productId).digest("hex").slice(0, 32)}`,
      },
    };
  }
  if (message.topic === HOST_NOTIFICATION_TOPICS.googleCalendarAttention) {
    const payload = parseGoogleCalendarAttentionPayload(message.payload);
    if (!payload) return { ok: false, reason: "invalid" };
    const stale = staleness(message, now);
    if (stale) return stale;
    return {
      ok: true,
      event: {
        providerId,
        kind: "GOOGLE_CALENDAR_ATTENTION",
        note: GOOGLE_CALENDAR_ATTENTION_NOTES[payload.reason],
        // The calendar screen shows which experiences wait and where to reconnect or choose the calendar again.
        url: HOST_CALENDAR_PATH,
        tag: "google-calendar-attention",
      },
    };
  }
  return { ok: false, reason: "invalid" };
}

const isStoppable = (kind: HostPushKind): kind is StoppableHostNotificationKey => (STOPPABLE_HOST_NOTIFICATION_KEYS as readonly string[]).includes(kind);

/**
 * Whether the provider gets this kind (設定 › 通知, #109). The locked kinds always come. A stoppable
 * kind follows the OWNER's switch in the experience DB; while that cannot be read (its flag is off or
 * the DB is not configured) it is not sent. A failed read throws, and the job tries again later.
 */
export async function hostNotificationAllowed(
  providerId: string,
  kind: HostPushKind,
  settings: () => Pick<ProviderNotificationSettings, "enabledFor"> | null = providerNotificationSettings,
): Promise<boolean> {
  if (!isStoppable(kind)) return true;
  const reader = settings();
  return reader ? reader.enabledFor(providerId, kind) : false;
}

export interface HostNotificationDrainCounts {
  claimed: number;
  /** Rows whose send finished (with or without devices; per-device failures stay on the subscription). */
  delivered: number;
  /** Devices the push service accepted. */
  devicesSent: number;
  /** Turned off in 設定 › 通知. */
  skipped: number;
  /** Not sent: another shape, past its time, or given up after `maxAttempts`. */
  dropped: number;
  retried: number;
}

export interface HostNotificationDrainDeps {
  outbox: Pick<HostNotificationOutbox, "claimDue" | "complete" | "retryAt">;
  /** Built per row, so each send has its own clock. */
  pushDeps: () => HostPushDeps;
  allowed: (providerId: string, kind: HostPushKind) => Promise<boolean>;
  now: () => number;
  notify?: (event: HostPushEvent, deps: HostPushDeps) => Promise<HostPushReport>;
  limit?: number;
  leaseMs?: number;
  maxAttempts?: number;
  log?: (counts: HostNotificationDrainCounts) => void;
}

type Outcome = "delivered" | "skipped" | "dropped" | "retry";

/**
 * One run: claims up to `limit` due rows and sends each. Shown, skipped or dropped rows are completed; a send
 * that throws (the subscriptions or the settings could not be read) is retried 1, 5, 15 and 60
 * minutes later and given up on after `maxAttempts` claims. A row claimed more often than that
 * without finishing (runs cut off mid-send) is given up on too.
 *
 * Each row is claimed right before its send, so every send has the whole lease: a slow batch cannot let
 * another run claim (and send again) the rows it has not reached yet. Completing names the claim, so a
 * send that outlived its lease cannot close the row another run now holds.
 */
export async function drainHostNotifications(deps: HostNotificationDrainDeps): Promise<HostNotificationDrainCounts> {
  const { outbox, limit = 50, leaseMs = 60_000, maxAttempts = 5, notify = notifyHostDevices } = deps;
  const counts: HostNotificationDrainCounts = { claimed: 0, delivered: 0, devicesSent: 0, skipped: 0, dropped: 0, retried: 0 };

  while (counts.claimed < limit) {
    const [message] = await outbox.claimDue(1, leaseMs);
    if (!message) break;
    counts.claimed += 1;
    const parsed = hostPushEventFromOutbox(message, deps.now());
    let outcome: Outcome;
    if (!parsed.ok || message.attempts > maxAttempts) {
      outcome = "dropped";
    } else {
      try {
        if (!(await deps.allowed(message.providerId, parsed.event.kind))) {
          outcome = "skipped";
        } else {
          counts.devicesSent += (await notify(parsed.event, deps.pushDeps())).sent;
          outcome = "delivered";
        }
      } catch {
        outcome = message.attempts >= maxAttempts ? "dropped" : "retry";
      }
    }
    if (outcome === "retry") {
      const backoff = RETRY_BACKOFF_MS[Math.min(message.attempts, RETRY_BACKOFF_MS.length) - 1] ?? RETRY_BACKOFF_MS[0]!;
      await outbox.retryAt(message.id, new Date(deps.now() + backoff), message.attempts);
      counts.retried += 1;
    } else {
      await outbox.complete(message.id, message.attempts);
      counts[outcome] += 1;
    }
  }
  deps.log?.(counts);
  return counts;
}
