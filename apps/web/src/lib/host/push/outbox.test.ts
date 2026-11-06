import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaimedHostNotification } from "@niho-experience/experience-store";

const mocks = vi.hoisted(() => ({ settings: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/experience/store-server", () => ({ providerNotificationSettings: mocks.settings }));

import type { HostPushDeps, HostPushReport } from "./notify";
import { drainHostNotifications, hostNotificationAllowed, hostPushEventFromOutbox, type HostNotificationDrainDeps } from "./outbox";
import { hostPushPayload, type HostPushEvent } from "./payload";

/** The notification job (#177 P2) against a fake outbox and a fake sender; all data is synthetic. */
const NOW = Date.parse("2026-11-01T00:00:00.000Z");
const MINUTE = 60_000;
const APPROVAL = "host.notify.approval_deadline";
const MESSAGE = "host.notify.guest_message";
const QUESTION = "host.notify.guest_question";
const NEW_BOOKING = "host.notify.new_booking";
const BOOKING_MESSAGE = "host.notify.booking_message";
const THREAD = "00000000-0000-4000-8000-0000000000aa";
const BOOKING = "0f8fad5b-d9cb-469f-a165-708677289501";
const approvalPayload = { v: 1, bookingId: "bk-1", experienceTitle: "Synthetic Tea Ceremony", startsAt: "2026-11-20T01:00:00.000Z", seats: 2, approvalDeadlineAt: "2026-11-01T01:00:00.000Z" };
const messagePayload = { v: 1, bookingId: "bk-2", messageId: "msg-1", experienceTitle: "Synthetic Tea Ceremony", startsAt: "2026-11-20T01:00:00.000Z", seats: 3 };
const questionPayload = { v: 1, threadId: THREAD, messageId: "00000000-0000-4000-8000-000000000101", experienceTitle: "Synthetic Tea Ceremony" };
const bookingMessagePayload = { v: 1, threadId: THREAD, messageId: "00000000-0000-4000-8000-000000000201", experienceTitle: "Synthetic Tea Ceremony", startsAt: "2026-11-20T01:00:00.000Z", seats: 3 };
const newBookingPayload = { v: 1, bookingId: BOOKING, experienceTitle: "Synthetic Tea Ceremony", startsAt: "2026-11-20T01:00:00.000Z", seats: 4 };
const ALLOWED_EVENT_KEYS = ["experienceTitle", "kind", "providerId", "seats", "startsAt", "tag", "url"];

let nextId = 1;
function row(topic: string, payload: unknown, extra: Partial<ClaimedHostNotification> = {}): ClaimedHostNotification {
  return { id: String(nextId++), providerId: "provider-a", topic, payload, attempts: 1, createdAt: new Date(NOW - MINUTE).toISOString(), ...extra };
}

function fakeOutbox(messages: ClaimedHostNotification[]) {
  return {
    // Hands out the rows the way the store does: up to `limit` per claim, each only once.
    claimDue: vi.fn(async (limit: number) => messages.splice(0, limit)),
    complete: vi.fn(async () => {}),
    retryAt: vi.fn(async () => {}),
  };
}

const pushDeps = { now: NOW } as unknown as HostPushDeps;
const report = (sent: number): HostPushReport => ({ recipients: sent, sent, gone: 0, failed: 0 });

function run(messages: ClaimedHostNotification[], overrides: Partial<HostNotificationDrainDeps> = {}) {
  const outbox = fakeOutbox(messages);
  const notify = vi.fn<(event: HostPushEvent, deps: HostPushDeps) => Promise<HostPushReport>>(async () => report(2));
  const allowed = vi.fn(async () => true);
  const log = vi.fn();
  const deps: HostNotificationDrainDeps = { outbox, pushDeps: () => pushDeps, allowed, now: () => NOW, notify, log, ...overrides };
  return { outbox, notify, allowed, log, result: drainHostNotifications(deps) };
}

beforeEach(() => {
  vi.clearAllMocks();
  nextId = 1;
});

describe("hostPushEventFromOutbox", () => {
  it("opens a new review without putting reviewer details in the push", () => {
    const reviewId = "00000000-0000-4000-8000-000000000109";
    expect(hostPushEventFromOutbox(row("host.notify.new_review", { v: 1, reviewId, experienceTitle: "Synthetic tea" }), NOW)).toEqual({
      ok: true,
      event: { providerId: "provider-a", kind: "NEW_REVIEW", experienceTitle: "Synthetic tea", url: `/host/reviews?providerId=provider-a#review-${reviewId}`, tag: `review-${reviewId}` },
    });
  });

  it("notifies the host of an email failure without exposing the guest address", () => {
    const bookingId = "00000000-0000-4000-8000-000000000210";
    const parsed = hostPushEventFromOutbox(row("host.notify.guest_email_delivery_failed", {
      v: 1, bookingId, classification: "NO_SUCH_ADDRESS", experienceTitle: "Synthetic Tea Ceremony",
      startsAt: "2026-11-20T01:00:00.000Z", seats: 2,
    }), NOW);
    expect(parsed).toEqual({
      ok: true,
      event: {
        providerId: "provider-a", kind: "EMAIL_DELIVERY_FAILED", experienceTitle: "Synthetic Tea Ceremony",
        startsAt: "2026-11-20T01:00:00.000Z", seats: 2,
        note: "宛先が相手側に存在しないと返されました。予約内容を開いて、連絡方法をご確認ください。",
        url: `/host/bookings?booking=${bookingId}&providerId=provider-a`, tag: `email-delivery-failed-${bookingId}`,
      },
    });
    if (parsed.ok) expect(hostPushPayload(parsed.event)).not.toContain("guest@example");
  });

  it("delivers one next-day attendee summary with counts only and closes a missed day's summary", () => {
    const summaryNow = Date.parse("2026-11-04T09:00:00.000Z"); // 18:00 in Japan
    const payload = { v: 1, localDate: "2026-11-05", bookingCount: 2, participantCount: 3 };
    const parsed = hostPushEventFromOutbox(row("host.notify.day_before_summary", payload), summaryNow);
    expect(parsed).toEqual({
      ok: true,
      event: {
        providerId: "provider-a", kind: "DAY_BEFORE_SUMMARY",
        note: "明日 2026年11月5日の確定予約：2件・3名",
        url: "/host/bookings", tag: "day-before-summary-2026-11-05",
      },
    });
    if (parsed.ok) {
      const message = JSON.parse(hostPushPayload(parsed.event));
      expect(message).toMatchObject({ title: "明日の参加者のまとめ", body: "明日 2026年11月5日の確定予約：2件・3名" });
      expect(message.body).not.toContain("Synthetic Guest");
    }
    expect(hostPushEventFromOutbox(row("host.notify.day_before_summary", payload), Date.parse("2026-11-05T00:00:00.000Z")))
      .toEqual({ ok: false, reason: "stale" });
  });

  it("turns an approval reminder into a deadline push that opens the booking", () => {
    const parsed = hostPushEventFromOutbox(row(APPROVAL, approvalPayload), NOW);
    expect(parsed).toEqual({
      ok: true,
      event: {
        providerId: "provider-a",
        kind: "APPROVAL_DEADLINE",
        experienceTitle: "Synthetic Tea Ceremony",
        startsAt: "2026-11-20T01:00:00.000Z",
        seats: 2,
        url: "/host/bookings?booking=bk-1&providerId=provider-a",
        tag: "approval-bk-1",
      },
    });
    // Both reminders of a booking share the tag, so the 1-hour one replaces the 6-hour one.
    if (parsed.ok) expect(JSON.parse(hostPushPayload(parsed.event))).toMatchObject({ title: "承認の期限が近づいています", url: "/host/bookings?booking=bk-1&providerId=provider-a", tag: "approval-bk-1" });
  });

  it("turns a guest message into a push that opens the conversation", () => {
    expect(hostPushEventFromOutbox(row(MESSAGE, messagePayload), NOW)).toEqual({
      ok: true,
      event: {
        providerId: "provider-a",
        kind: "GUEST_MESSAGE",
        experienceTitle: "Synthetic Tea Ceremony",
        startsAt: "2026-11-20T01:00:00.000Z",
        seats: 3,
        url: "/host/messages?booking=bk-2&providerId=provider-a",
        tag: "message-bk-2",
      },
    });
  });

  it("turns a question to the host into a GUEST_MESSAGE push with its own title that opens the thread", () => {
    const parsed = hostPushEventFromOutbox(row(QUESTION, questionPayload), NOW);
    expect(parsed).toEqual({
      ok: true,
      event: {
        providerId: "provider-a",
        kind: "GUEST_MESSAGE",
        question: true,
        experienceTitle: "Synthetic Tea Ceremony",
        url: `/host/messages?thread=${THREAD}&providerId=provider-a`,
        // The guest's later answers in the thread replace it on the device.
        tag: `question-${THREAD}`,
      },
    });
    if (parsed.ok) {
      const message = JSON.parse(hostPushPayload(parsed.event));
      expect(message).toMatchObject({
        v: 1,
        title: "予約前の質問が届きました",
        body: "Synthetic Tea Ceremony",
        url: `/host/messages?thread=${THREAD}&providerId=provider-a`,
        tag: `question-${THREAD}`,
      });
      // The declarative copy (#177 P3) says the same and replaces the device's earlier one by the same tag.
      expect(message.notification).toMatchObject({ title: message.title, body: message.body, navigate: message.url, tag: message.tag });
    }
  });

  it("turns a guest's message on their booking page into a GUEST_MESSAGE push that opens this site's thread (#285 slice 6b)", () => {
    const parsed = hostPushEventFromOutbox(row(BOOKING_MESSAGE, bookingMessagePayload), NOW);
    expect(parsed).toEqual({
      ok: true,
      event: {
        providerId: "provider-a",
        kind: "GUEST_MESSAGE",
        experienceTitle: "Synthetic Tea Ceremony",
        startsAt: "2026-11-20T01:00:00.000Z",
        seats: 3,
        url: `/host/messages?thread=${THREAD}&providerId=provider-a`,
        tag: `booking-message-${THREAD}`,
      },
    });
    if (parsed.ok) {
      const payload = JSON.parse(hostPushPayload(parsed.event));
      expect(payload.title).toBe("予約者から連絡があります");
      expect(payload.body).toContain("Synthetic Tea Ceremony");
      expect(payload.body).toContain("3名");
    }
    expect(hostPushEventFromOutbox(row(BOOKING_MESSAGE, { ...bookingMessagePayload, body: "synthetic text" }), NOW)).toEqual({ ok: false, reason: "invalid" });
    expect(hostPushEventFromOutbox(row(BOOKING_MESSAGE, bookingMessagePayload, { createdAt: new Date(NOW - 25 * 60 * MINUTE).toISOString() }), NOW)).toEqual({ ok: false, reason: "stale" });
  });

  it("asks 設定 › 通知 for GUEST_MESSAGE before a booking message and skips it when the OWNER turned it off", async () => {
    const allowed = vi.fn(async () => false);
    const { outbox, notify, result } = run([row(BOOKING_MESSAGE, bookingMessagePayload)], { allowed });
    expect(await result).toMatchObject({ claimed: 1, delivered: 0, skipped: 1 });
    expect(allowed.mock.calls).toEqual([["provider-a", "GUEST_MESSAGE"]]);
    expect(notify).not.toHaveBeenCalled();
    expect(outbox.complete.mock.calls).toEqual([["1", 1]]);
  });

  it("turns a guest booking confirmed on this site into a NEW_BOOKING push that opens it among this site's bookings", () => {
    const parsed = hostPushEventFromOutbox(row(NEW_BOOKING, newBookingPayload), NOW);
    expect(parsed).toEqual({
      ok: true,
      event: {
        providerId: "provider-a",
        kind: "NEW_BOOKING",
        experienceTitle: "Synthetic Tea Ceremony",
        startsAt: "2026-11-20T01:00:00.000Z",
        seats: 4,
        url: `/host/bookings?booking=${BOOKING}&providerId=provider-a`,
        tag: `booking-${BOOKING}`,
      },
    });
    if (parsed.ok) {
      expect(JSON.parse(hostPushPayload(parsed.event))).toMatchObject({ title: "新しい予約・申込", body: "Synthetic Tea Ceremony · 11/20（金）10:00 · 4名" });
    }
  });

  it("turns a guest booking the guest or support cancelled into a CANCELLATION push that opens it (#285 slice 7)", () => {
    const parsed = hostPushEventFromOutbox(row("host.notify.cancellation", newBookingPayload), NOW);
    expect(parsed).toEqual({
      ok: true,
      event: {
        providerId: "provider-a",
        kind: "CANCELLATION",
        experienceTitle: "Synthetic Tea Ceremony",
        startsAt: "2026-11-20T01:00:00.000Z",
        seats: 4,
        url: `/host/bookings?booking=${BOOKING}&providerId=provider-a`,
        tag: `cancellation-${BOOKING}`,
      },
    });
    if (parsed.ok) {
      expect(JSON.parse(hostPushPayload(parsed.event))).toMatchObject({ title: "予約が取り消されました", body: "Synthetic Tea Ceremony · 11/20（金）10:00 · 4名" });
    }
    expect(hostPushEventFromOutbox(row("host.notify.cancellation", { ...newBookingPayload, amount: 7500 }), NOW)).toEqual({ ok: false, reason: "invalid" });
  });

  it("turns an OTA booking into a push to the product's people naming the site and the guest, never the site's IDs (#194)", () => {
    const ref = "0b8f5a8e-2c1d-4e7f-9a3b-5c6d7e8f9a0b";
    const ota = { v: 1, change: "NEW", site: "GetYourGuide", ref, productId: "tea", experienceTitle: "Synthetic Tea Ceremony",
      startsAt: "2026-11-20T01:00:00.000Z", seats: 2, guestName: "Synthetic Traveler" };
    const parsed = hostPushEventFromOutbox(row("host.notify.ota_booking", ota), NOW);
    expect(parsed).toEqual({
      ok: true,
      event: {
        providerId: "provider-a", kind: "NEW_BOOKING", experienceTitle: "Synthetic Tea Ceremony", startsAt: "2026-11-20T01:00:00.000Z", seats: 2,
        ota: { site: "GetYourGuide", change: "NEW" }, guestName: "Synthetic Traveler", productId: "tea",
        url: `/host/bookings?ota=${ref}&providerId=provider-a`, tag: `ota-${ref}`,
      },
    });
    if (parsed.ok) {
      expect(JSON.parse(hostPushPayload(parsed.event))).toMatchObject({
        title: "GetYourGuide で新しい予約", body: "Synthetic Tea Ceremony · 11/20（金）10:00 · Synthetic Traveler 様 · 2名",
      });
    }
    const cancelled = hostPushEventFromOutbox(row("host.notify.ota_booking", { ...ota, change: "CANCELLED", guestName: undefined }), NOW);
    expect(cancelled.ok && cancelled.event).toMatchObject({ kind: "CANCELLATION", ota: { change: "CANCELLED" } });
    expect(cancelled.ok && "guestName" in cancelled.event).toBe(false);
    const moved = hostPushEventFromOutbox(row("host.notify.ota_booking", { ...ota, change: "RESCHEDULED", previousStartsAt: "2026-11-18T01:00:00.000Z" }), NOW);
    expect(moved.ok && moved.event).toMatchObject({ kind: "NEW_BOOKING", ota: { change: "RESCHEDULED", previousStartsAt: "2026-11-18T01:00:00.000Z" } });
    for (const bad of [{ ...ota, guestEmail: "traveler@example.test" }, { ...ota, change: "RESCHEDULED" }, { ...ota, ref: "R1" }]) {
      expect(hostPushEventFromOutbox(row("host.notify.ota_booking", bad), NOW)).toEqual({ ok: false, reason: "invalid" });
    }
    expect(hostPushEventFromOutbox(row("host.notify.ota_booking", ota, { createdAt: new Date(NOW - 25 * 60 * MINUTE).toISOString() }), NOW))
      .toEqual({ ok: false, reason: "stale" });
  });

  it("turns an operations suspension or its clearing into a push to the OWNER only that opens the product (#109)", async () => {
    const listing = { v: 1, productId: "sample-product-tea", experienceTitle: "Synthetic Tea Ceremony", change: "SUSPENDED" };
    const suspended = hostPushEventFromOutbox(row("host.notify.listing_suspension", listing), NOW);
    expect(suspended.ok).toBe(true);
    if (!suspended.ok) return;
    expect(suspended.event).toEqual({
      providerId: "provider-a", kind: "LISTING_SUSPENSION", experienceTitle: "Synthetic Tea Ceremony", listing: { change: "SUSPENDED" },
      ownerOnly: true, url: "/host/experiences/sample-product-tea?providerId=provider-a", tag: expect.stringMatching(/^listing-[0-9a-f]{32}$/),
    });
    // The screen it opens is the OWNER's: a product operator would be refused there, so none is sent it.
    expect(suspended.event).not.toHaveProperty("productId");
    expect(JSON.parse(hostPushPayload(suspended.event))).toMatchObject({ title: "運営が掲載を停止しました", body: "Synthetic Tea Ceremony" });
    const cleared = hostPushEventFromOutbox(row("host.notify.listing_suspension", { ...listing, change: "CLEARED" }), NOW);
    expect(cleared.ok && cleared.event).toMatchObject({ kind: "LISTING_SUSPENSION", listing: { change: "CLEARED" }, ownerOnly: true });
    // One notification per product on the device: the clearing replaces the suspension; another product has its own.
    expect(cleared.ok && cleared.event.tag).toBe(suspended.event.tag);
    const other = hostPushEventFromOutbox(row("host.notify.listing_suspension", { ...listing, productId: "sample-product-other" }), NOW);
    expect(other.ok && other.event.tag).not.toBe(suspended.event.tag);
    if (cleared.ok) {
      expect(JSON.parse(hostPushPayload(cleared.event))).toMatchObject({
        title: "運営による停止が解除されました", body: "Synthetic Tea Ceremony · オーナーが再公開すると、掲載に戻ります",
      });
    }
    for (const bad of [{ ...listing, reasonCode: "POLICY_REVIEW" }, { ...listing, change: "STOPPED" }, { ...listing, productId: "" },
      { ...listing, productId: "../x" }, { ...listing, experienceTitle: " " }, { v: 1, productId: "sample-product-tea", change: "SUSPENDED" }]) {
      expect(hostPushEventFromOutbox(row("host.notify.listing_suspension", bad), NOW)).toEqual({ ok: false, reason: "invalid" });
    }
    expect(hostPushEventFromOutbox(row("host.notify.listing_suspension", listing, { createdAt: new Date(NOW - 25 * 60 * MINUTE).toISOString() }), NOW))
      .toEqual({ ok: false, reason: "stale" });
    // 設定 › 通知's 掲載の運営停止・解除 cannot be turned off.
    expect(await hostNotificationAllowed("provider-a", "LISTING_SUSPENSION", () => ({ enabledFor: async () => false }))).toBe(true);
  });

  it("sends a cancellation whatever the OWNER turned off in 設定 › 通知", async () => {
    expect(await hostNotificationAllowed("provider-a", "CANCELLATION", () => ({ enabledFor: async () => false }))).toBe(true);
  });

  it("says a Google calendar cannot be read with a fixed line, opens the calendar, and never names the calendar", async () => {
    for (const reason of ["REVOKED", "UNAVAILABLE"] as const) {
      const parsed = hostPushEventFromOutbox(row("host.notify.google_calendar_attention", { v: 1, input: "RESOURCE", reason }), NOW);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.event).toMatchObject({ kind: "GOOGLE_CALENDAR_ATTENTION", url: "/host/calendar", tag: "google-calendar-attention" });
      const message = JSON.parse(hostPushPayload(parsed.event));
      expect(message.title).toBe("Googleカレンダーを確認してください");
      expect(message.body).toMatch(/新しい予約を止めています。受けた予約はそのままです。$/);
    }
    for (const payload of [{ v: 1, input: "RESOURCE", reason: "REVOKED", calendarId: "cal-secret" }, { v: 1, input: "ROOM", reason: "REVOKED" }, { v: 2, input: "PROVIDER", reason: "UNAVAILABLE" }]) {
      expect(hostPushEventFromOutbox(row("host.notify.google_calendar_attention", payload), NOW)).toEqual({ ok: false, reason: "invalid" });
    }
    expect(await hostNotificationAllowed("provider-a", "GOOGLE_CALENDAR_ATTENTION", () => ({ enabledFor: async () => false }))).toBe(true);
  });

  it("drops a question or a new booking older than a day, and one of another shape", () => {
    for (const [topic, payload] of [[QUESTION, questionPayload], [NEW_BOOKING, newBookingPayload]] as const) {
      expect(hostPushEventFromOutbox(row(topic, payload, { createdAt: new Date(NOW - 24 * 60 * MINUTE - 1).toISOString() }), NOW)).toEqual({ ok: false, reason: "stale" });
      expect(hostPushEventFromOutbox(row(topic, payload, { createdAt: "not a time" }), NOW)).toEqual({ ok: false, reason: "invalid" });
    }
    for (const message of [
      row(QUESTION, { ...questionPayload, guestName: "Sample Guest" }),
      row(QUESTION, { ...questionPayload, text: "synthetic question text" }),
      row(QUESTION, { ...questionPayload, threadId: "../admin" }),
      row(QUESTION, { ...questionPayload, v: 2 }),
      row(QUESTION, newBookingPayload),
      row(NEW_BOOKING, { ...newBookingPayload, amount: 12000 }),
      row(NEW_BOOKING, { ...newBookingPayload, seats: 0 }),
      row(NEW_BOOKING, { ...newBookingPayload, startsAt: "2026-11-20 10:00" }),
      row(NEW_BOOKING, questionPayload),
    ]) expect(hostPushEventFromOutbox(message, NOW)).toEqual({ ok: false, reason: "invalid" });
  });

  it("drops a passed deadline and a message older than a day", () => {
    expect(hostPushEventFromOutbox(row(APPROVAL, { ...approvalPayload, approvalDeadlineAt: new Date(NOW).toISOString() }), NOW)).toEqual({ ok: false, reason: "expired" });
    expect(hostPushEventFromOutbox(row(MESSAGE, messagePayload, { createdAt: new Date(NOW - 24 * 60 * MINUTE - 1).toISOString() }), NOW)).toEqual({ ok: false, reason: "stale" });
    expect(hostPushEventFromOutbox(row(MESSAGE, messagePayload, { createdAt: new Date(NOW - 24 * 60 * MINUTE).toISOString() }), NOW).ok).toBe(true);
  });

  it("refuses another topic, an unknown key and a wrong type", () => {
    for (const message of [
      row("booking.confirmed", { publicBookingId: "bk-1", providerId: "provider-a", outcome: "CONFIRMED" }),
      row(APPROVAL, messagePayload),
      row(MESSAGE, approvalPayload),
      row(APPROVAL, { ...approvalPayload, guestName: "合成 予約者" }),
      row(MESSAGE, { ...messagePayload, text: "synthetic message text" }),
      row(MESSAGE, { ...messagePayload, amount: 12000 }),
      row(MESSAGE, { ...messagePayload, seats: "3" }),
      row(APPROVAL, { ...approvalPayload, bookingId: "../admin" }),
      row(MESSAGE, null),
      row(MESSAGE, messagePayload, { createdAt: "not a time" }),
    ]) expect(hostPushEventFromOutbox(message, NOW)).toEqual({ ok: false, reason: "invalid" });
  });

  it("never builds an event with more than the allowed fields", () => {
    for (const message of [row(APPROVAL, approvalPayload), row(MESSAGE, messagePayload), row(QUESTION, questionPayload), row(NEW_BOOKING, newBookingPayload)]) {
      const parsed = hostPushEventFromOutbox(message, NOW);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(Object.keys(parsed.event).filter((key) => key !== "question").every((key) => ALLOWED_EVENT_KEYS.includes(key))).toBe(true);
        expect(hostPushPayload(parsed.event)).not.toMatch(/msg-1|synthetic message text|合成/);
      }
    }
  });
});

describe("hostNotificationAllowed", () => {
  it("always sends the locked kinds without reading the settings", async () => {
    const settings = vi.fn();
    expect(await hostNotificationAllowed("provider-a", "APPROVAL_DEADLINE", settings)).toBe(true);
    expect(await hostNotificationAllowed("provider-a", "NEW_BOOKING", settings)).toBe(true);
    expect(settings).not.toHaveBeenCalled();
  });

  it("follows the OWNER's switch for a stoppable kind, and does not send while it cannot be read", async () => {
    const enabledFor = vi.fn(async () => false);
    expect(await hostNotificationAllowed("provider-a", "GUEST_MESSAGE", () => ({ enabledFor }))).toBe(false);
    expect(enabledFor).toHaveBeenCalledWith("provider-a", "GUEST_MESSAGE");
    enabledFor.mockResolvedValueOnce(true);
    expect(await hostNotificationAllowed("provider-a", "GUEST_MESSAGE", () => ({ enabledFor }))).toBe(true);
    expect(await hostNotificationAllowed("provider-a", "GUEST_MESSAGE", () => null)).toBe(false);
    await expect(hostNotificationAllowed("provider-a", "GUEST_MESSAGE", () => ({ enabledFor: async () => { throw new Error("db down"); } }))).rejects.toThrow();
  });

  it("reads 設定 › 通知 from the experience DB by default (null while its flag is off)", async () => {
    mocks.settings.mockReturnValueOnce(null);
    expect(await hostNotificationAllowed("provider-a", "GUEST_MESSAGE")).toBe(false);
    mocks.settings.mockReturnValueOnce({ enabledFor: async () => true });
    expect(await hostNotificationAllowed("provider-a", "GUEST_MESSAGE")).toBe(true);
  });
});

describe("drainHostNotifications", () => {
  it("claims up to 50 rows one at a time, each for a minute, and completes each sent row, devices or not", async () => {
    const messages = [row(APPROVAL, approvalPayload), row(MESSAGE, messagePayload)];
    const notify = vi.fn(async (event: HostPushEvent) => report(event.kind === "GUEST_MESSAGE" ? 0 : 3));
    const { outbox, allowed, log, result } = run(messages, { notify });
    const counts = await result;
    expect(counts).toEqual({ claimed: 2, delivered: 2, devicesSent: 3, skipped: 0, dropped: 0, retried: 0 });
    expect(outbox.claimDue.mock.calls).toEqual([[1, 60_000], [1, 60_000], [1, 60_000]]);
    expect(outbox.complete.mock.calls).toEqual([["1", 1], ["2", 1]]);
    expect(outbox.retryAt).not.toHaveBeenCalled();
    expect(allowed.mock.calls).toEqual([["provider-a", "APPROVAL_DEADLINE"], ["provider-a", "GUEST_MESSAGE"]]);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledExactlyOnceWith(counts);
  });

  it("asks 設定 › 通知 for GUEST_MESSAGE before a question and skips it when the OWNER turned it off; a new booking always goes", async () => {
    const allowed = vi.fn(async (_providerId: string, kind: string) => kind !== "GUEST_MESSAGE");
    const { outbox, notify, result } = run([row(QUESTION, questionPayload), row(NEW_BOOKING, newBookingPayload)], { allowed });
    expect(await result).toEqual({ claimed: 2, delivered: 1, devicesSent: 2, skipped: 1, dropped: 0, retried: 0 });
    expect(allowed.mock.calls).toEqual([["provider-a", "GUEST_MESSAGE"], ["provider-a", "NEW_BOOKING"]]);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]![0]).toMatchObject({ kind: "NEW_BOOKING", tag: `booking-${BOOKING}` });
    expect(outbox.complete.mock.calls).toEqual([["1", 1], ["2", 1]]);
  });

  it("passes the event and fresh push dependencies to the sender", async () => {
    const pushDepsFactory = vi.fn(() => pushDeps);
    const { notify, result } = run([row(APPROVAL, approvalPayload)], { pushDeps: pushDepsFactory, limit: 10, leaseMs: 30_000 });
    await result;
    expect(pushDepsFactory).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]![0]).toMatchObject({ kind: "APPROVAL_DEADLINE", tag: "approval-bk-1" });
    expect(notify.mock.calls[0]![1]).toBe(pushDeps);
  });

  it("completes invalid, expired and stale rows without asking or sending", async () => {
    const messages = [
      row(APPROVAL, { ...approvalPayload, extra: true }),
      row(APPROVAL, { ...approvalPayload, approvalDeadlineAt: "2026-10-31T23:00:00.000Z" }),
      row(MESSAGE, messagePayload, { createdAt: "2026-10-30T00:00:00.000Z" }),
    ];
    const { outbox, notify, allowed, result } = run(messages);
    expect(await result).toEqual({ claimed: 3, delivered: 0, devicesSent: 0, skipped: 0, dropped: 3, retried: 0 });
    expect(outbox.complete).toHaveBeenCalledTimes(3);
    expect(allowed).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("completes a kind the provider turned off without sending", async () => {
    const { outbox, notify, result } = run([row(MESSAGE, messagePayload)], { allowed: async () => false });
    expect(await result).toMatchObject({ claimed: 1, skipped: 1, delivered: 0 });
    expect(outbox.complete).toHaveBeenCalledWith("1", 1);
    expect(notify).not.toHaveBeenCalled();
  });

  it("claims each row right before its send, so a slow batch keeps no row waiting under an old lease, and stops at the limit", async () => {
    const order: string[] = [];
    const queue = [row(MESSAGE, messagePayload), row(MESSAGE, messagePayload), row(MESSAGE, messagePayload)];
    const outbox = {
      claimDue: vi.fn(async (limit: number) => { order.push("claim"); return queue.splice(0, limit); }),
      complete: vi.fn(async () => { order.push("complete"); }),
      retryAt: vi.fn(async () => {}),
    };
    const notify = async () => { order.push("send"); return report(1); };
    const counts = await drainHostNotifications({ outbox, pushDeps: () => pushDeps, allowed: async () => true, now: () => NOW, notify, limit: 2 });
    expect(counts).toMatchObject({ claimed: 2, delivered: 2 });
    expect(order).toEqual(["claim", "send", "complete", "claim", "send", "complete"]);
    expect(queue).toHaveLength(1);
  });

  it("retries a failed send 1, 5, 15 and 60 minutes later, then gives up at the fifth attempt", async () => {
    const failing = vi.fn(async () => { throw new Error("recipients unavailable"); });
    const messages = [1, 2, 3, 4, 5].map((attempts) => row(APPROVAL, approvalPayload, { attempts }));
    const { outbox, result } = run(messages, { notify: failing });
    expect(await result).toEqual({ claimed: 5, delivered: 0, devicesSent: 0, skipped: 0, dropped: 1, retried: 4 });
    expect(outbox.retryAt.mock.calls).toEqual([
      ["1", new Date(NOW + MINUTE), 1],
      ["2", new Date(NOW + 5 * MINUTE), 2],
      ["3", new Date(NOW + 15 * MINUTE), 3],
      ["4", new Date(NOW + 60 * MINUTE), 4],
    ]);
    expect(outbox.complete.mock.calls).toEqual([["5", 5]]);
  });

  it("retries when the settings or the push dependencies cannot be read", async () => {
    const settingsDown = run([row(MESSAGE, messagePayload)], { allowed: async () => { throw new Error("settings unavailable"); } });
    expect(await settingsDown.result).toMatchObject({ retried: 1, skipped: 0 });
    expect(settingsDown.outbox.complete).not.toHaveBeenCalled();
    const depsDown = run([row(MESSAGE, messagePayload)], { pushDeps: () => { throw new Error("no keys"); } });
    expect(await depsDown.result).toMatchObject({ retried: 1, delivered: 0 });
    expect(depsDown.notify).not.toHaveBeenCalled();
  });

  it("gives up on a row claimed more often than maxAttempts without sending it", async () => {
    const { outbox, notify, result } = run([row(APPROVAL, approvalPayload, { attempts: 6 })]);
    expect(await result).toMatchObject({ claimed: 1, dropped: 1, delivered: 0 });
    expect(notify).not.toHaveBeenCalled();
    expect(outbox.complete).toHaveBeenCalledWith("1", 6);
    const custom = run([row(APPROVAL, approvalPayload, { id: "9", attempts: 6 })], { maxAttempts: 8, notify: async () => { throw new Error("down"); } });
    await custom.result;
    // Past the table, the backoff stays at an hour.
    expect(custom.outbox.retryAt).toHaveBeenCalledWith("9", new Date(NOW + 60 * MINUTE), 6);
  });

  it("does nothing on an empty outbox, and stops when the outbox cannot record a result", async () => {
    const empty = run([]);
    expect(await empty.result).toEqual({ claimed: 0, delivered: 0, devicesSent: 0, skipped: 0, dropped: 0, retried: 0 });
    expect(empty.notify).not.toHaveBeenCalled();
    const outbox = fakeOutbox([row(APPROVAL, approvalPayload)]);
    outbox.complete.mockRejectedValueOnce(new Error("db down"));
    await expect(drainHostNotifications({ outbox, pushDeps: () => pushDeps, allowed: async () => true, now: () => NOW, notify: async () => report(1) })).rejects.toThrow();
    expect(outbox.retryAt).not.toHaveBeenCalled();
  });

  it("logs counts only", async () => {
    const { log, result } = run([row(MESSAGE, messagePayload)]);
    await result;
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/bk-2|msg-1|Synthetic|provider-a/);
  });
});
