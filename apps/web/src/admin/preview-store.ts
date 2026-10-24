import "server-only";
import type { AdminOperation } from "./bookings";
import { AdminPreviewStateStore } from "./preview-state";
import type { AdminActor } from "./types";

const processState = globalThis as typeof globalThis & { __nihoAdminPreviewStore?: AdminPreviewStateStore };
// Page rendering and the Route Handler may be compiled as separate server entrypoints. A bounded
// process-global instance keeps their view of one preview session coherent.
const store = processState.__nihoAdminPreviewStore ??= new AdminPreviewStateStore();

export const adminPreviewBookings = (sessionId: string, expiresAt: number, now = Date.now()) => store.bookings(sessionId, expiresAt, now);
export const adminPreviewNotifications = (sessionId: string, expiresAt: number, now = Date.now()) => store.notifications(sessionId, expiresAt, now);
export const markAdminPreviewNotificationsRead = (sessionId: string, expiresAt: number, notificationIds: readonly string[], now = Date.now()) =>
  store.markNotificationsRead(sessionId, expiresAt, notificationIds, now);
export const runAdminPreviewOperation = (sessionId: string, expiresAt: number, bookingId: string, idempotencyKey: string, operation: AdminOperation, actor: AdminActor, now = Date.now()) =>
  store.run(sessionId, expiresAt, bookingId, idempotencyKey, operation, actor, now);
