import "server-only";
import {
  HOST_NOTIFICATION_TOPICS,
  parseApprovalDeadlinePayload,
  parseBookingMessagePayload,
  parseCancellationPayload,
  parseGuestMessagePayload,
  parseGuestQuestionPayload,
  parseNewBookingPayload,
  STOPPABLE_HOST_NOTIFICATION_KEYS,
  type ClaimedHostNotification,
  type HostNotificationOutbox,
  type ProviderNotificationSettings,
} from "@niho-experience/experience-store";
import type { HostNotificationKey } from "@/host/types";
import { providerNotificationSettings } from "@/lib/experience/store-server";
import { HOST_BOOKINGS_PATH, HOST_MESSAGES_PATH, withQuery } from "../routes";
import { notifyHostDevices, type HostPushDeps, type HostPushReport } from "./notify";
import type { HostPushEvent } from "./payload";

/**
 * The notification job (#177 P2, owner decision 2026-10-31): sends what `outbox_messages` holds for
 * the host topics as Web Push. Questions to the host, guest bookings confirmed on this site (#285 slice 5),
 * those the guest or NIHO support cancelled (slice 7) and what a guest wrote on their booking page (slice 6b) write their rows; approval reminders and booking messages wait for those flows to move to
 * the experience DB (ADR 0002). Logs and answers counts only: never an endpoint, a payload or a booking.
 */
const MESSAGE_STALE_MS = 24 * 60 * 60 * 1000;
const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

export type HostPushEventFromOutbox = { ok: true; event: HostPushEvent } | { ok: false; reason: "invalid" | "expired" | "stale" };

/** A message, question or booking older than a day is no longer news on a lock screen. */
function staleness(message: ClaimedHostNotification, now: number): HostPushEventFromOutbox | null {
  const createdAt = Date.parse(message.createdAt);
  if (!Number.isFinite(createdAt)) return { ok: false, reason: "invalid" };
  return now - createdAt > MESSAGE_STALE_MS ? { ok: false, reason: "stale" } : null;
}

/**
 * One row as a push event, or why it is not sent: a row of another shape, an approval deadline that
 * has passed, or a message, question or new booking older than a day. The event carries the experience,
 * its time and the party size only (a question: the experience only).
 */
export function hostPushEventFromOutbox(message: ClaimedHostNotification, now: number): HostPushEventFromOutbox {
  const providerId = message.providerId;
  if (message.topic === HOST_NOTIFICATION_TOPICS.approvalDeadline) {
    const payload = parseApprovalDeadlinePayload(message.payload);
    if (!payload) return { ok: false, reason: "invalid" };
    if (Date.parse(payload.approvalDeadlineAt) <= now) return { ok: false, reason: "expired" };
    return {
      ok: true,
      event: {
        providerId,
        kind: "APPROVAL_DEADLINE",
        experienceTitle: payload.experienceTitle,
        startsAt: payload.startsAt,
        seats: payload.seats,
        url: withQuery(HOST_BOOKINGS_PATH, { booking: payload.bookingId, providerId }),
        // The 1-hour reminder replaces the 6-hour one on the device.
        tag: `approval-${payload.bookingId}`,
      },
    };
  }
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
        // This site's threads (#285 slice 6b), with this one opened; `source=site` keeps them beside NIHO's messages.
        url: withQuery(HOST_MESSAGES_PATH, { thread: payload.threadId, source: "site", providerId }),
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
        url: withQuery(HOST_BOOKINGS_PATH, { booking: payload.bookingId, source: "site", providerId }),
        tag: `booking-${payload.bookingId}`,
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
        url: withQuery(HOST_BOOKINGS_PATH, { booking: payload.bookingId, source: "site", providerId }),
        tag: `cancellation-${payload.bookingId}`,
      },
    };
  }
  return { ok: false, reason: "invalid" };
}

const isStoppable = (kind: HostNotificationKey) => (STOPPABLE_HOST_NOTIFICATION_KEYS as readonly string[]).includes(kind);

/**
 * Whether the provider gets this kind (設定 › 通知, #109). The locked kinds always come. A stoppable
 * kind follows the OWNER's switch in the experience DB; while that cannot be read (its flag is off or
 * the DB is not configured) it is not sent. A failed read throws, and the job tries again later.
 */
export async function hostNotificationAllowed(
  providerId: string,
  kind: HostNotificationKey,
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
  allowed: (providerId: string, kind: HostNotificationKey) => Promise<boolean>;
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
