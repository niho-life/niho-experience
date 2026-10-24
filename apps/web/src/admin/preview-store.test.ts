import { describe, expect, it } from "vitest";
import { AdminPreviewStateStore } from "./preview-state";
import { MOCK_ADMIN_BOOKINGS, MOCK_ADMIN_NOTIFICATIONS } from "./mock";

const actor = { id: "admin-preview", name: "NIHO サポート 山本" };

describe("admin preview session store", () => {
  it("keeps mutations coherent across page reads", () => {
    const store = new AdminPreviewStateStore();
    const session = "preview-store-session-a";
    const expiresAt = Date.now() + 60_000;
    const result = store.run(session, expiresAt, "bk-garden-301", "operation-key-a", { action: "contact", reason: "候補者を共有" }, actor);
    expect(result.ok).toBe(true);
    const reread = store.bookings(session, expiresAt).find((booking) => booking.id === "bk-garden-301");
    expect(reread?.adminHistory.at(-1)).toMatchObject({ actorId: actor.id, detail: "連絡プレビュー · 候補者を共有" });
  });

  it("converges an exact retry and rejects key reuse for another payload", () => {
    const store = new AdminPreviewStateStore();
    const session = "preview-store-session-b";
    const expiresAt = Date.now() + 60_000;
    const operation = { action: "contact" as const, reason: "ホストへ連絡" };
    const first = store.run(session, expiresAt, "bk-garden-301", "operation-key-b", operation, actor);
    const repeat = store.run(session, expiresAt, "bk-garden-301", "operation-key-b", { ...operation, reason: "  ホストへ連絡  " }, actor);
    const mismatch = store.run(session, expiresAt, "bk-garden-301", "operation-key-b", { ...operation, reason: "別の連絡" }, actor);
    const otherBooking = store.run(session, expiresAt, "bk-2041", "operation-key-b", operation, actor);
    expect(first.ok).toBe(true);
    expect(repeat).toMatchObject({ ok: true, repeated: true });
    expect(mismatch).toMatchObject({ ok: false, status: 409 });
    expect(otherBooking).toMatchObject({ ok: false, status: 409 });
  });

  it("keeps notification reads isolated by preview session and preserves the first read time", () => {
    const store = new AdminPreviewStateStore();
    const expiresAt = 100_000;
    const id = MOCK_ADMIN_NOTIFICATIONS[0]!.id;
    const first = store.markNotificationsRead("preview-notices-a", expiresAt, [id], 10_000);
    const repeat = store.markNotificationsRead("preview-notices-a", expiresAt, [id], 20_000);
    const other = store.notifications("preview-notices-b", expiresAt, 20_000);
    expect(first.ok).toBe(true);
    expect(repeat.ok).toBe(true);
    if (!first.ok || !repeat.ok) throw new Error("expected synthetic read to succeed");
    expect(repeat.notifications.find((item) => item.id === id)?.readAt).toBe(first.notifications.find((item) => item.id === id)?.readAt);
    expect(other.notifications.find((item) => item.id === id)?.readAt).toBeNull();
    expect(other.unreadCount).toBe(MOCK_ADMIN_NOTIFICATIONS.length);
  });

  it("returns no notification data after the absolute session expiry", () => {
    const store = new AdminPreviewStateStore();
    const id = MOCK_ADMIN_NOTIFICATIONS[0]!.id;
    expect(store.notifications("expired-notices", 10_000, 10_000)).toEqual({ notifications: [], unreadCount: 0 });
    expect(store.markNotificationsRead("expired-notices", 10_000, [id], 10_000)).toMatchObject({ ok: false, status: 401 });
  });

  it("seeds all five event types only for support-ON bookings", () => {
    const store = new AdminPreviewStateStore();
    const list = store.notifications("preview-notice-types", 100_000, 10_000);
    expect(new Set(list.notifications.map((item) => item.kind))).toEqual(new Set(["new_booking", "booking_changed", "cancellation", "refund_attention", "new_contact"]));
    for (const notification of list.notifications) {
      expect(MOCK_ADMIN_BOOKINGS.find((booking) => booking.id === notification.bookingId)?.support.enabled).toBe(true);
    }
    expect(list.notifications.some((item) => item.bookingId === "bk-studio-101")).toBe(false);
  });

  it("returns notification receipts newest-first without changing the seed order", () => {
    const store = new AdminPreviewStateStore();
    const seedOrder = MOCK_ADMIN_NOTIFICATIONS.map((item) => item.id);
    const list = store.notifications("preview-notice-order", 100_000, 10_000);
    expect(list.notifications.map((item) => item.id)).toEqual([
      "notice-contact-garden-301",
      "notice-change-2041",
      "notice-new-booking-2041",
      "notice-refund-2033",
      "notice-cancel-2033",
    ]);
    expect(MOCK_ADMIN_NOTIFICATIONS.map((item) => item.id)).toEqual(seedOrder);
  });

  it("marks notification receipts without changing booking state or attention work", () => {
    const store = new AdminPreviewStateStore();
    const session = "preview-read-independent";
    const expiresAt = 100_000;
    const before = store.bookings(session, expiresAt, 10_000).find((booking) => booking.id === "bk-2041")!;
    const notice = MOCK_ADMIN_NOTIFICATIONS.find((item) => item.bookingId === before.id)!;
    expect(store.markNotificationsRead(session, expiresAt, [notice.id], 20_000).ok).toBe(true);
    const after = store.bookings(session, expiresAt, 20_000).find((booking) => booking.id === before.id)!;
    expect(after.status).toBe(before.status);
    expect(after.needsAttention).toBe(before.needsAttention);
    expect(after.attentionReason).toBe(before.attentionReason);
  });

  it("rejects an unknown notification atomically", () => {
    const store = new AdminPreviewStateStore();
    const session = "preview-invalid-notice";
    const expiresAt = 100_000;
    const known = MOCK_ADMIN_NOTIFICATIONS[0]!.id;
    expect(store.markNotificationsRead(session, expiresAt, [known, "unknown-notification"], 10_000)).toMatchObject({ ok: false, status: 400 });
    expect(store.notifications(session, expiresAt, 20_000).notifications.find((item) => item.id === known)?.readAt).toBeNull();
  });
});
