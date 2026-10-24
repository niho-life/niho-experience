import type { AdminNotification, AdminNotificationKind } from "./types";

const NOTIFICATION_ID = /^[A-Za-z0-9_-]{1,100}$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?(?:Z|[+-]\d{2}:\d{2})?$/;
export const MAX_NOTIFICATION_IDS_PER_REQUEST = 64;
const NOTIFICATION_KINDS = new Set<AdminNotificationKind>(["new_booking", "booking_changed", "cancellation", "refund_attention", "new_contact"]);

export interface AdminNotificationResponse {
  notifications: readonly AdminNotification[];
  unreadCount: number;
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validDateTime(value: unknown): value is string {
  return typeof value === "string" && ISO_DATE_TIME.test(value) && Number.isFinite(Date.parse(value));
}

function isAdminNotification(value: unknown): value is AdminNotification {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return typeof input.id === "string"
    && NOTIFICATION_ID.test(input.id)
    && typeof input.bookingId === "string"
    && NOTIFICATION_ID.test(input.bookingId)
    && validText(input.bookingNumber)
    && typeof input.kind === "string"
    && NOTIFICATION_KINDS.has(input.kind as AdminNotificationKind)
    && validText(input.title)
    && validText(input.detail)
    && validDateTime(input.occurredAt)
    && (input.readAt === null || validDateTime(input.readAt));
}

/** Validate the small local preview API response before any item reaches rendering. */
export function decodeAdminNotificationResponse(value: unknown): AdminNotificationResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.notifications) || !input.notifications.every(isAdminNotification)) return null;
  if (typeof input.unreadCount !== "number" || !Number.isFinite(input.unreadCount) || !Number.isInteger(input.unreadCount) || input.unreadCount < 0) return null;
  if (input.unreadCount !== input.notifications.filter((notification) => notification.readAt === null).length) return null;
  return { notifications: input.notifications, unreadCount: input.unreadCount };
}

/** Return a new array: newest receipt first, then opaque id for a deterministic tie. */
export function sortAdminNotificationsNewestFirst<T extends Pick<AdminNotification, "id" | "occurredAt">>(notifications: readonly T[]): T[] {
  return [...notifications].sort((a, b) => {
    const time = Date.parse(b.occurredAt) - Date.parse(a.occurredAt);
    if (time !== 0) return time;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Strict mutation body: one non-empty, duplicate-free list and no extra fields. */
export function notificationIdsFromBody(value: unknown): readonly string[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 1 || !Array.isArray(input.notificationIds)) return null;
  const ids = input.notificationIds;
  if (!ids.length || ids.length > MAX_NOTIFICATION_IDS_PER_REQUEST) return null;
  if (ids.some((id) => typeof id !== "string" || !NOTIFICATION_ID.test(id))) return null;
  if (new Set(ids).size !== ids.length) return null;
  return ids as string[];
}
