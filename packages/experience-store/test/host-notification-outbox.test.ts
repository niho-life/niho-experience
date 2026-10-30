import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PoolClient } from "pg";
import { StoreValidationError } from "../src/errors.ts";
import {
  cancelApprovalDeadlineReminders,
  enqueueApprovalDeadlineReminders,
  enqueueGuestMessageNotification,
  HOST_NOTIFICATION_TOPICS,
  HostNotificationOutbox,
  parseApprovalDeadlinePayload,
  parseGuestMessagePayload,
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
    await assert.rejects(() => outbox.complete("1; DROP TABLE outbox_messages"), StoreValidationError);
    await assert.rejects(() => outbox.retryAt("1", new Date(Number.NaN)), StoreValidationError);
    assert.equal(queries.length, 0);
    assert.deepEqual(await outbox.claimDue(10, 60_000), []);
    assert.deepEqual(queries[0], [[HOST_NOTIFICATION_TOPICS.approvalDeadline, HOST_NOTIFICATION_TOPICS.guestMessage], 10, 60_000]);
  });
});
