import { applyAdminOperation, type AdminOperation } from "./bookings";
import { mockAdminBooking, MOCK_ADMIN_BOOKINGS, MOCK_ADMIN_NOTIFICATIONS, MOCK_ADMIN_NOW } from "./mock";
import { sortAdminNotificationsNewestFirst } from "./notifications";
import type { AdminActor, AdminBooking, AdminNotification } from "./types";

const MAX_SESSIONS = 128;
const MAX_COMPLETED_PER_SESSION = 256;
const MAX_NOTIFICATION_READS_PER_SESSION = 256;

interface CompletedOperation {
  bookingId: string;
  fingerprint: string;
  booking: AdminBooking;
  message: string;
}

interface PreviewSessionState {
  bookings: Map<string, AdminBooking>;
  completed: Map<string, CompletedOperation>;
  notificationReads: Map<string, string>;
  expiresAt: number;
  touchedAt: number;
}

export interface AdminNotificationList {
  notifications: readonly AdminNotification[];
  unreadCount: number;
}

function fingerprint(operation: AdminOperation): string {
  if (operation.action !== "cancel") return JSON.stringify([operation.action, operation.reason.trim()]);
  const { refund, reason, message } = operation.cancellation;
  return JSON.stringify([operation.action, operation.reason.trim(), refund, reason, message.trim()]);
}

/** Bounded, process-local state behind the synthetic Admin preview. */
export class AdminPreviewStateStore {
  private readonly sessions = new Map<string, PreviewSessionState>();

  private prune(now: number) {
    for (const [id, state] of this.sessions) if (state.expiresAt <= now) this.sessions.delete(id);
    if (this.sessions.size <= MAX_SESSIONS) return;
    const oldest = [...this.sessions.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt).slice(0, this.sessions.size - MAX_SESSIONS);
    for (const [id] of oldest) this.sessions.delete(id);
  }

  private stateFor(sessionId: string, expiresAt: number, now: number): PreviewSessionState {
    this.prune(now);
    let state = this.sessions.get(sessionId);
    if (!state) {
      if (this.sessions.size >= MAX_SESSIONS) {
        const oldest = [...this.sessions.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
        if (oldest) this.sessions.delete(oldest[0]);
      }
      state = { bookings: new Map(), completed: new Map(), notificationReads: new Map(), expiresAt, touchedAt: now };
      this.sessions.set(sessionId, state);
    } else {
      state.expiresAt = Math.min(state.expiresAt, expiresAt);
      state.touchedAt = now;
    }
    return state;
  }

  bookings(sessionId: string, expiresAt: number, now = Date.now()): readonly AdminBooking[] {
    const state = this.stateFor(sessionId, expiresAt, now);
    return MOCK_ADMIN_BOOKINGS.map((booking) => state.bookings.get(booking.id) ?? booking);
  }

  notifications(sessionId: string, expiresAt: number, now = Date.now()): AdminNotificationList {
    if (expiresAt <= now) {
      this.prune(now);
      return { notifications: [], unreadCount: 0 };
    }
    const state = this.stateFor(sessionId, expiresAt, now);
    const notifications = sortAdminNotificationsNewestFirst(MOCK_ADMIN_NOTIFICATIONS.map((notification) => ({
      ...notification,
      readAt: state.notificationReads.get(notification.id) ?? null,
    })));
    return { notifications, unreadCount: notifications.filter((notification) => !notification.readAt).length };
  }

  markNotificationsRead(sessionId: string, expiresAt: number, notificationIds: readonly string[], now = Date.now()) {
    if (expiresAt <= now) {
      this.prune(now);
      return { ok: false as const, status: 401, message: "管理セッションの期限が切れました。" };
    }
    const knownIds = new Set(MOCK_ADMIN_NOTIFICATIONS.map((notification) => notification.id));
    if (!notificationIds.length || notificationIds.length > MAX_NOTIFICATION_READS_PER_SESSION || notificationIds.some((id) => !knownIds.has(id))) {
      return { ok: false as const, status: 400, message: "通知を更新できませんでした。画面を読み直してください。" };
    }
    const state = this.stateFor(sessionId, expiresAt, now);
    const readAt = new Date(now).toISOString();
    for (const id of notificationIds) {
      if (!state.notificationReads.has(id)) state.notificationReads.set(id, readAt);
    }
    while (state.notificationReads.size > MAX_NOTIFICATION_READS_PER_SESSION) state.notificationReads.delete(state.notificationReads.keys().next().value!);
    return { ok: true as const, ...this.notifications(sessionId, expiresAt, now) };
  }

  run(sessionId: string, expiresAt: number, bookingId: string, idempotencyKey: string, operation: AdminOperation, actor: AdminActor, now = Date.now()) {
    const state = this.stateFor(sessionId, expiresAt, now);
    const operationFingerprint = fingerprint(operation);
    const prior = state.completed.get(idempotencyKey);
    if (prior) {
      if (prior.bookingId !== bookingId || prior.fingerprint !== operationFingerprint) return { ok: false as const, status: 409, message: "同じ操作キーが別の内容に使われました。画面を読み直してください。" };
      return { ok: true as const, booking: prior.booking, message: prior.message, repeated: true };
    }
    const booking = state.bookings.get(bookingId) ?? mockAdminBooking(bookingId);
    if (!booking) return { ok: false as const, status: 404, message: "予約が見つかりません。" };
    const result = applyAdminOperation(booking, operation, actor, MOCK_ADMIN_NOW);
    if (!result.ok) return { ok: false as const, status: result.code === "support_off" ? 403 : 409, message: result.message };
    state.bookings.set(bookingId, result.booking);
    state.completed.set(idempotencyKey, { bookingId, fingerprint: operationFingerprint, booking: result.booking, message: result.message });
    if (state.completed.size > MAX_COMPLETED_PER_SESSION) state.completed.delete(state.completed.keys().next().value!);
    return { ok: true as const, booking: result.booking, message: result.message, repeated: false };
  }
}
