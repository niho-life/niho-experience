import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PoolClient } from "pg";
import { StoreValidationError } from "../src/errors.ts";
import {
  cancelApprovalDeadlineReminders,
  enqueueApprovalDeadlineReminders,
  enqueueBookingMessageNotification,
  enqueueGuestMessageNotification,
  enqueueGuestQuestionNotification,
  enqueueNewBookingNotification,
  HOST_NOTIFICATION_TOPICS,
  HostNotificationOutbox,
  parseApprovalDeadlinePayload,
  parseBookingMessagePayload,
  parseGuestMessagePayload,
  parseGuestQuestionPayload,
  parseNewBookingPayload,
} from "../src/host-notification-outbox.ts";

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-11-01T00:00:00.000Z");
const booking = { providerId: "provider-a", bookingId: "bk-1", experienceTitle: "Synthetic Tea Ceremony", startsAt: "2026-11-20T10:00:00+09:00", seats: 2 };

function recordingClient() {
  const calls: { sql: string; params: unknown[] }[] = [];
  const client = { query: async (sql: string, params: unknown[]) => { calls.push({ sql, params }); return { rowCount: 1, rows: [] }; } };
  return { client: client as unknown as PoolClient, calls };
}

describe("host notification payloads (#177 P2)", () => {
  const approval = { v: 1, bookingId: "bk-1", experienceTitle: "Synthetic Tea Ceremony", startsAt: "2026-11-20T01:00:00.000Z", seats: 2, approvalDeadlineAt: "2026-11-02T00:00:00.000Z" };
  const message = { v: 1, bookingId: "bk-1", messageId: "msg-1", experienceTitle: "Synthetic Tea Ceremony", startsAt: "2026-11-20T01:00:00.000Z", seats: 2 };

  it("reads exactly the closed shapes", () => {
    assert.deepEqual(parseApprovalDeadlinePayload(approval), approval);
    assert.deepEqual(parseGuestMessagePayload(message), message);
    assert.equal(parseApprovalDeadlinePayload(message), null);
    assert.equal(parseGuestMessagePayload(approval), null);
  });

  it("refuses a stored JSON null where an instant belongs", () => {
    assert.equal(parseApprovalDeadlinePayload({ ...approval, approvalDeadlineAt: null }), null);
    assert.equal(parseApprovalDeadlinePayload({ ...approval, startsAt: null }), null);
    assert.equal(parseGuestMessagePayload({ ...message, startsAt: null }), null);
  });

  it("refuses unknown keys, missing keys, wrong types and out-of-range values", () => {
    for (const extra of [{ guestName: "合成 予約者" }, { body: "synthetic text" }, { amount: 12000 }]) {
      assert.equal(parseApprovalDeadlinePayload({ ...approval, ...extra }), null);
      assert.equal(parseGuestMessagePayload({ ...message, ...extra }), null);
    }
    const { seats: _seats, ...missing } = message;
    for (const bad of [
      missing, null, [], "text",
      { ...message, v: 2 }, { ...message, bookingId: "bk/1" }, { ...message, bookingId: "b".repeat(49) }, { ...message, messageId: "" },
      { ...message, experienceTitle: " " }, { ...message, experienceTitle: "体".repeat(201) }, { ...message, seats: 0 }, { ...message, seats: 501 },
      { ...message, seats: 1.5 }, { ...message, seats: "2" }, { ...message, startsAt: "2026-11-20" }, { ...message, startsAt: "2026-11-20T10:00:00+09:00" },
    ]) assert.equal(parseGuestMessagePayload(bad), null, JSON.stringify(bad));
    assert.equal(parseApprovalDeadlinePayload({ ...approval, approvalDeadlineAt: "tomorrow" }), null);
  });
});

describe("question and new booking payloads (#285 slice 5)", () => {
  const question = { v: 1, threadId: "00000000-0000-4000-8000-0000000000aa", messageId: "00000000-0000-4000-8000-000000000101", experienceTitle: "Synthetic Tea Ceremony" };
  const newBooking = { v: 1, bookingId: "0f8fad5b-d9cb-469f-a165-708677289501", experienceTitle: "Synthetic Tea Ceremony", startsAt: "2026-11-20T01:00:00.000Z", seats: 3 };

  it("reads exactly the closed shapes, with nothing about who wrote or what", () => {
    assert.deepEqual(parseGuestQuestionPayload(question), question);
    assert.deepEqual(parseNewBookingPayload(newBooking), newBooking);
    assert.equal(parseGuestQuestionPayload(newBooking), null);
    assert.equal(parseNewBookingPayload(question), null);
    for (const extra of [{ guestName: "Sample Guest" }, { body: "synthetic text" }, { guestEmail: "guest@example.com" }, { amount: 12000 }]) {
      assert.equal(parseGuestQuestionPayload({ ...question, ...extra }), null);
      assert.equal(parseNewBookingPayload({ ...newBooking, ...extra }), null);
    }
    for (const bad of [{ ...question, v: 2 }, { ...question, threadId: "../admin" }, { ...question, messageId: "" }, { ...question, experienceTitle: " " }]) {
      assert.equal(parseGuestQuestionPayload(bad), null, JSON.stringify(bad));
    }
    for (const bad of [{ ...newBooking, seats: 0 }, { ...newBooking, startsAt: null }, { ...newBooking, startsAt: "2026-11-20T10:00:00+09:00" }, { ...newBooking, bookingId: "bk/1" }]) {
      assert.equal(parseNewBookingPayload(bad), null, JSON.stringify(bad));
    }
  });

  it("writes one row per message or booking, due now, with a title clipped to what a row holds", async () => {
    const { client, calls } = recordingClient();
    const longTitle = `Synthetic ${"tea ".repeat(70)}`.trim();
    await enqueueGuestQuestionNotification(client, { providerId: "provider-a", threadId: question.threadId, messageId: question.messageId, experienceTitle: longTitle });
    assert.deepEqual(calls[0]!.params.slice(0, 5), ["provider-a", "guest_question_thread", question.threadId, HOST_NOTIFICATION_TOPICS.guestQuestion, `host-push:guest-question:${question.messageId}`]);
    assert.equal(calls[0]!.params[6], null);
    const payload = JSON.parse(String(calls[0]!.params[5]));
    assert.deepEqual(Object.keys(payload).sort(), ["experienceTitle", "messageId", "threadId", "v"]);
    assert.equal(payload.experienceTitle.length, 200);
    assert.ok(payload.experienceTitle.endsWith("…"));
    assert.ok(parseGuestQuestionPayload(payload));
    // An emoji at the cut is kept whole or left out, never halved: half of a surrogate pair is not valid JSON for jsonb.
    await enqueueGuestQuestionNotification(client, { providerId: "provider-a", threadId: question.threadId, messageId: question.messageId, experienceTitle: `${"a".repeat(198)}🍵Tea` });
    const clipped = JSON.parse(String(calls[1]!.params[5])).experienceTitle as string;
    assert.equal(clipped, `${"a".repeat(198)}…`);
    assert.doesNotMatch(clipped, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
    calls.splice(1);

    await enqueueNewBookingNotification(client, { providerId: "provider-a", bookingId: newBooking.bookingId, experienceTitle: "Synthetic Tea Ceremony", startsAt: "2026-11-20T10:00:00+09:00", seats: 3 });
    assert.deepEqual(calls[1]!.params.slice(0, 5), ["provider-a", "booking", newBooking.bookingId, HOST_NOTIFICATION_TOPICS.newBooking, `host-push:new-booking:${newBooking.bookingId}`]);
    assert.deepEqual(JSON.parse(String(calls[1]!.params[5])), newBooking);
    assert.match(calls[1]!.sql, /ON CONFLICT \(provider_id, deduplication_key\) DO NOTHING/);
  });

  it("refuses invalid input before touching the database", async () => {
    const { client, calls } = recordingClient();
    const ok = { providerId: "provider-a", threadId: question.threadId, messageId: question.messageId, experienceTitle: "Synthetic" };
    for (const bad of [{ ...ok, providerId: "" }, { ...ok, threadId: "t/1" }, { ...ok, messageId: "" }, { ...ok, experienceTitle: "  " }]) {
      await assert.rejects(() => enqueueGuestQuestionNotification(client, bad), StoreValidationError);
    }
    const booked = { providerId: "provider-a", bookingId: newBooking.bookingId, experienceTitle: "Synthetic", startsAt: newBooking.startsAt, seats: 3 };
    for (const bad of [{ ...booked, seats: 0 }, { ...booked, startsAt: "soon" }, { ...booked, bookingId: "bk 1" }, { ...booked, experienceTitle: "" }]) {
      await assert.rejects(() => enqueueNewBookingNotification(client, bad), StoreValidationError);
    }
    assert.equal(calls.length, 0);
  });
});

describe("booking message payloads (#285 slice 6b)", () => {
  const message = {
    v: 1, threadId: "00000000-0000-4000-8000-0000000000bb", messageId: "00000000-0000-4000-8000-000000000201",
    experienceTitle: "Synthetic Tea Ceremony", startsAt: "2026-11-20T01:00:00.000Z", seats: 3,
  };

  it("reads exactly the closed shape: the thread, the message, the experience, its time and the party, never who wrote or what", () => {
    assert.deepEqual(parseBookingMessagePayload(message), message);
    assert.equal(parseGuestQuestionPayload(message), null);
    assert.equal(parseGuestMessagePayload(message), null);
    for (const extra of [{ guestName: "Sample Guest" }, { body: "synthetic text" }, { guestEmail: "guest@example.com" }, { bookingId: "bk-1" }]) {
      assert.equal(parseBookingMessagePayload({ ...message, ...extra }), null);
    }
    for (const bad of [{ ...message, v: 2 }, { ...message, threadId: "../admin" }, { ...message, seats: 0 }, { ...message, startsAt: "2026-11-20T10:00:00+09:00" }, { ...message, experienceTitle: "" }]) {
      assert.equal(parseBookingMessagePayload(bad), null, JSON.stringify(bad));
    }
  });

  it("writes one row per message, due now, under the thread, and refuses invalid input before the database", async () => {
    const { client, calls } = recordingClient();
    await enqueueBookingMessageNotification(client, {
      providerId: "provider-a", threadId: message.threadId, messageId: message.messageId, experienceTitle: "Synthetic Tea Ceremony", startsAt: "2026-11-20T10:00:00+09:00", seats: 3,
    });
    assert.deepEqual(calls[0]!.params.slice(0, 5), ["provider-a", "guest_question_thread", message.threadId, HOST_NOTIFICATION_TOPICS.bookingMessage, `host-push:booking-message:${message.messageId}`]);
    assert.equal(calls[0]!.params[6], null);
    assert.deepEqual(JSON.parse(String(calls[0]!.params[5])), message);
    const ok = { providerId: "provider-a", threadId: message.threadId, messageId: message.messageId, experienceTitle: "Synthetic", startsAt: message.startsAt, seats: 2 };
    for (const bad of [{ ...ok, threadId: "t/1" }, { ...ok, messageId: "" }, { ...ok, seats: 0 }, { ...ok, startsAt: "soon" }, { ...ok, experienceTitle: " " }]) {
      await assert.rejects(() => enqueueBookingMessageNotification(client, bad), StoreValidationError);
    }
    assert.equal(calls.length, 1);
  });
});

describe("host notification producers (#177 P2)", () => {
  it("schedules reminders 6 hours and 1 hour before the deadline, skipping passed ones", async () => {
    const at = async (hoursLeft: number) => {
      const { client, calls } = recordingClient();
      const inserted = await enqueueApprovalDeadlineReminders(client, { ...booking, approvalDeadlineAt: new Date(NOW.getTime() + hoursLeft * HOUR).toISOString(), now: NOW });
      return { inserted, rows: calls.map(({ params }) => ({ key: params[4], availableAt: params[6], topic: params[3], aggregate: [params[1], params[2]] })) };
    };
    const far = await at(10);
    assert.equal(far.inserted, 2);
    assert.deepEqual(far.rows.map((row) => [row.key, row.availableAt]), [
      ["host-push:approval-deadline:bk-1:6h", "2026-11-01T04:00:00.000Z"],
      ["host-push:approval-deadline:bk-1:1h", "2026-11-01T09:00:00.000Z"],
    ]);
    assert.ok(far.rows.every((row) => row.topic === HOST_NOTIFICATION_TOPICS.approvalDeadline && row.aggregate[0] === "booking" && row.aggregate[1] === "bk-1"));
    assert.deepEqual((await at(6)).rows.map((row) => [row.key, row.availableAt]), [["host-push:approval-deadline:bk-1:1h", "2026-11-01T05:00:00.000Z"]]);
    assert.deepEqual((await at(0.5)).rows.map((row) => [row.key, row.availableAt]), [["host-push:approval-deadline:bk-1:1h", NOW.toISOString()]]);
    assert.deepEqual(await at(0), { inserted: 0, rows: [] });
    assert.deepEqual(await at(-1), { inserted: 0, rows: [] });
  });

  it("stores canonical instants and only the closed payload", async () => {
    const { client, calls } = recordingClient();
    await enqueueGuestMessageNotification(client, { ...booking, messageId: "msg-1", guestName: "合成 予約者" } as typeof booking & { messageId: string });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.params[4], "host-push:guest-message:msg-1");
    assert.equal(calls[0]!.params[6], null);
    assert.deepEqual(JSON.parse(String(calls[0]!.params[5])), { v: 1, bookingId: "bk-1", messageId: "msg-1", experienceTitle: "Synthetic Tea Ceremony", startsAt: "2026-11-20T01:00:00.000Z", seats: 2 });
    assert.match(calls[0]!.sql, /ON CONFLICT \(provider_id, deduplication_key\) DO NOTHING/);
  });

  it("refuses invalid input before touching the database", async () => {
    const { client, calls } = recordingClient();
    const deadline = { approvalDeadlineAt: "2026-11-02T00:00:00.000Z", now: NOW };
    for (const bad of [
      { ...booking, providerId: "" }, { ...booking, bookingId: "bk 1" }, { ...booking, experienceTitle: "" }, { ...booking, seats: 0 }, { ...booking, startsAt: "soon" },
    ]) {
      await assert.rejects(() => enqueueApprovalDeadlineReminders(client, { ...bad, ...deadline }), StoreValidationError);
      await assert.rejects(() => enqueueGuestMessageNotification(client, { ...bad, messageId: "msg-1" }), StoreValidationError);
    }
    await assert.rejects(() => enqueueApprovalDeadlineReminders(client, { ...booking, approvalDeadlineAt: "later", now: NOW }), StoreValidationError);
    await assert.rejects(() => enqueueApprovalDeadlineReminders(client, { ...booking, ...deadline, now: new Date(Number.NaN) }), StoreValidationError);
    await assert.rejects(() => enqueueGuestMessageNotification(client, { ...booking, messageId: "msg/1" }), StoreValidationError);
    await assert.rejects(() => cancelApprovalDeadlineReminders(client, { providerId: "provider-a", bookingId: "" }), StoreValidationError);
    assert.equal(calls.length, 0);
  });

  it("closes only the booking's unprocessed approval reminders", async () => {
    const { client, calls } = recordingClient();
    await cancelApprovalDeadlineReminders(client, { providerId: "provider-a", bookingId: "bk-1" });
    assert.match(calls[0]!.sql, /processed_at IS NULL/);
    assert.deepEqual(calls[0]!.params, ["provider-a", HOST_NOTIFICATION_TOPICS.approvalDeadline, "booking", "bk-1"]);
  });
});

describe("HostNotificationOutbox input checks", () => {
  it("bounds the batch and the lease and checks row ids", async () => {
    const queries: unknown[][] = [];
    const outbox = new HostNotificationOutbox({ query: async (_sql: string, params: unknown[]) => { queries.push(params); return { rows: [] }; } } as never);
    await assert.rejects(() => outbox.claimDue(0, 60_000), StoreValidationError);
    await assert.rejects(() => outbox.claimDue(201, 60_000), StoreValidationError);
    await assert.rejects(() => outbox.claimDue(10, 999), StoreValidationError);
    await assert.rejects(() => outbox.complete("1; DROP TABLE outbox_messages", 1), StoreValidationError);
    await assert.rejects(() => outbox.complete("1", -1), StoreValidationError);
    await assert.rejects(() => outbox.retryAt("1", new Date(Number.NaN), 1), StoreValidationError);
    await assert.rejects(() => outbox.retryAt("1", new Date(), 1.5), StoreValidationError);
    assert.equal(queries.length, 0);
    assert.deepEqual(await outbox.claimDue(10, 60_000), []);
    assert.deepEqual(queries[0], [[
      HOST_NOTIFICATION_TOPICS.approvalDeadline, HOST_NOTIFICATION_TOPICS.guestMessage, HOST_NOTIFICATION_TOPICS.guestQuestion, HOST_NOTIFICATION_TOPICS.newBooking,
      HOST_NOTIFICATION_TOPICS.cancellation, HOST_NOTIFICATION_TOPICS.bookingMessage,
    ], 10, 60_000]);
  });
});
