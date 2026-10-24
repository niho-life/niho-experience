import { describe, expect, it } from "vitest";
import type { AdminNotification } from "./types";
import { decodeAdminNotificationResponse, MAX_NOTIFICATION_IDS_PER_REQUEST, notificationIdsFromBody, sortAdminNotificationsNewestFirst } from "./notifications";

const notification: AdminNotification = {
  id: "notice-a",
  bookingId: "booking-a",
  bookingNumber: "EX-100",
  kind: "new_booking",
  title: "新しい申込",
  detail: "確認してください。",
  occurredAt: "2026-10-21T13:45",
  readAt: null,
};

describe("Admin notification read input", () => {
  it("accepts only the strict notificationIds body", () => {
    expect(notificationIdsFromBody({ notificationIds: ["notice-new-booking-2041"] })).toEqual(["notice-new-booking-2041"]);
    expect(notificationIdsFromBody({ notificationIds: ["notice-a"], extra: true })).toBeNull();
    expect(notificationIdsFromBody({ notificationIds: [] })).toBeNull();
    expect(notificationIdsFromBody({ notificationIds: ["notice-a", "notice-a"] })).toBeNull();
    expect(notificationIdsFromBody({ notificationIds: ["contact@example.test"] })).toBeNull();
  });

  it("rejects oversized batches before mutation", () => {
    const ids = Array.from({ length: MAX_NOTIFICATION_IDS_PER_REQUEST + 1 }, (_, index) => `notice-${index}`);
    expect(notificationIdsFromBody({ notificationIds: ids })).toBeNull();
  });

  it("decodes every render field and rejects malformed items", () => {
    expect(decodeAdminNotificationResponse({ notifications: [notification], unreadCount: 1 })).toEqual({ notifications: [notification], unreadCount: 1 });
    expect(decodeAdminNotificationResponse({ notifications: [null], unreadCount: 1 })).toBeNull();
    expect(decodeAdminNotificationResponse({ notifications: [{ ...notification, kind: "unknown" }], unreadCount: 1 })).toBeNull();
    expect(decodeAdminNotificationResponse({ notifications: [{ ...notification, occurredAt: "not-a-time" }], unreadCount: 1 })).toBeNull();
    expect(decodeAdminNotificationResponse({ notifications: [{ ...notification, occurredAt: "1" }], unreadCount: 1 })).toBeNull();
    expect(decodeAdminNotificationResponse({ notifications: [{ ...notification, readAt: Number.POSITIVE_INFINITY }], unreadCount: 0 })).toBeNull();
  });

  it("rejects non-finite, fractional, negative and non-number unread counts", () => {
    for (const unreadCount of [Number.NaN, Number.POSITIVE_INFINITY, 0.5, -1, "1"]) {
      expect(decodeAdminNotificationResponse({ notifications: [notification], unreadCount })).toBeNull();
    }
    expect(decodeAdminNotificationResponse({ notifications: [notification], unreadCount: 0 })).toBeNull();
  });

  it("sorts a copy newest-first and breaks equal times by opaque id", () => {
    const input = [
      { ...notification, id: "notice-z", occurredAt: "2026-10-20T10:00" },
      { ...notification, id: "notice-b", occurredAt: "2026-10-21T10:00" },
      { ...notification, id: "notice-a", occurredAt: "2026-10-21T10:00" },
    ];
    const originalIds = input.map((item) => item.id);
    expect(sortAdminNotificationsNewestFirst(input).map((item) => item.id)).toEqual(["notice-a", "notice-b", "notice-z"]);
    expect(input.map((item) => item.id)).toEqual(originalIds);
  });
});
