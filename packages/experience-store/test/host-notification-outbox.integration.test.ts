import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it } from "node:test";
import {
  cancelApprovalDeadlineReminders,
  enqueueApprovalDeadlineReminders,
  enqueueGuestMessageNotification,
  HOST_NOTIFICATION_TOPICS,
  HostNotificationOutbox,
} from "../src/host-notification-outbox.ts";
import { withTransaction } from "../src/transaction.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const HOUR = 60 * 60 * 1000;
const booking = { providerId: "provider-a", experienceTitle: "Synthetic Tea Ceremony", startsAt: "2026-11-20T01:00:00.000Z", seats: 2 };

describe("PostgreSQL host notification outbox (#177 P2)", { skip: databaseUrl === undefined }, () => {
  it("enqueues, cancels, claims with SKIP LOCKED and a lease, and never touches other topics", async () => {
    const { Pool } = await import("pg");
    const schema = `host_notification_outbox_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: databaseUrl, max: 6, options: `-c search_path=${schema}` });
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      const migrations = (await readdir(new URL("../migrations/", import.meta.url))).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort();
      for (const name of migrations) await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a'),('provider-b')");
      const rows = async (where = "TRUE") => (await pool.query(
        `SELECT id::text AS id, provider_id, aggregate_type, aggregate_id, topic, deduplication_key, payload, available_at, processed_at, attempts
           FROM outbox_messages WHERE ${where} ORDER BY id`,
      )).rows;
      const dbNow = async () => new Date((await pool.query("SELECT clock_timestamp() AS now")).rows[0].now);

      // Reminders 6 hours and 1 hour before a deadline 10 hours away; a repeat adds nothing.
      const now = await dbNow();
      const deadline = new Date(now.getTime() + 10 * HOUR);
      const far = { ...booking, bookingId: "bk-far", approvalDeadlineAt: deadline.toISOString(), now };
      assert.equal(await withTransaction(pool, (client) => enqueueApprovalDeadlineReminders(client, far)), 2);
      assert.equal(await withTransaction(pool, (client) => enqueueApprovalDeadlineReminders(client, far)), 0);
      const farRows = await rows("aggregate_id = 'bk-far'");
      assert.deepEqual(farRows.map((row) => [row.deduplication_key, row.available_at.getTime()]), [
        ["host-push:approval-deadline:bk-far:6h", deadline.getTime() - 6 * HOUR],
        ["host-push:approval-deadline:bk-far:1h", deadline.getTime() - HOUR],
      ]);
      assert.ok(farRows.every((row) => row.topic === HOST_NOTIFICATION_TOPICS.approvalDeadline && row.aggregate_type === "booking" && row.attempts === 0));
      assert.deepEqual(farRows[0].payload, { v: 1, bookingId: "bk-far", experienceTitle: booking.experienceTitle, startsAt: booking.startsAt, seats: 2, approvalDeadlineAt: deadline.toISOString() });

      // 3 hours left: only the 1-hour reminder. 30 minutes left: the 1-hour one is due now. Past: nothing.
      const mid = { ...booking, bookingId: "bk-mid", approvalDeadlineAt: new Date(now.getTime() + 3 * HOUR).toISOString(), now };
      assert.equal(await withTransaction(pool, (client) => enqueueApprovalDeadlineReminders(client, mid)), 1);
      assert.deepEqual((await rows("aggregate_id = 'bk-mid'")).map((row) => [row.deduplication_key, row.available_at.getTime()]), [["host-push:approval-deadline:bk-mid:1h", now.getTime() + 2 * HOUR]]);
      const near = { ...booking, bookingId: "bk-near", approvalDeadlineAt: new Date(now.getTime() + 30 * 60 * 1000).toISOString(), now };
      assert.equal(await withTransaction(pool, (client) => enqueueApprovalDeadlineReminders(client, near)), 1);
      assert.deepEqual((await rows("aggregate_id = 'bk-near'")).map((row) => [row.deduplication_key, row.available_at.getTime()]), [["host-push:approval-deadline:bk-near:1h", now.getTime()]]);
      const past = { ...booking, bookingId: "bk-past", approvalDeadlineAt: new Date(now.getTime() - 1).toISOString(), now };
      assert.equal(await withTransaction(pool, (client) => enqueueApprovalDeadlineReminders(client, past)), 0);
      assert.equal((await rows("aggregate_id = 'bk-past'")).length, 0);

      // One row per guest message; the same message again adds nothing.
      const message = { ...booking, bookingId: "bk-far", messageId: "msg-1" };
      assert.equal(await withTransaction(pool, (client) => enqueueGuestMessageNotification(client, message)), 1);
      assert.equal(await withTransaction(pool, (client) => enqueueGuestMessageNotification(client, message)), 0);
      assert.deepEqual((await rows("deduplication_key = 'host-push:guest-message:msg-1'")).map((row) => row.payload), [
        { v: 1, bookingId: "bk-far", messageId: "msg-1", experienceTitle: booking.experienceTitle, startsAt: booking.startsAt, seats: 2 },
      ]);

      // Approving bk-far closes its two reminders, not its message nor another booking's reminder.
      assert.equal(await withTransaction(pool, (client) => cancelApprovalDeadlineReminders(client, { providerId: "provider-a", bookingId: "bk-far" })), 2);
      assert.equal(await withTransaction(pool, (client) => cancelApprovalDeadlineReminders(client, { providerId: "provider-a", bookingId: "bk-far" })), 0);
      assert.ok((await rows("aggregate_id = 'bk-far' AND topic = 'host.notify.approval_deadline'")).every((row) => row.processed_at !== null));
      assert.equal((await rows("deduplication_key = 'host-push:guest-message:msg-1'"))[0].processed_at, null);
      assert.equal((await rows("aggregate_id = 'bk-mid'"))[0].processed_at, null);

      // Another topic, due and unprocessed, is never claimed, completed or moved.
      await pool.query(
        `INSERT INTO outbox_messages (provider_id,aggregate_type,aggregate_id,topic,deduplication_key,payload,available_at)
         VALUES ('provider-a','booking','bk-other','booking.confirmed','stripe-event-synthetic','{"outcome":"CONFIRMED"}'::jsonb, clock_timestamp() - interval '1 hour')`,
      );
      const [other] = await rows("topic = 'booking.confirmed'");
      const outbox = new HostNotificationOutbox(pool);

      // Due now: bk-near's reminder and the message (bk-mid's is 2 hours away).
      const first = await outbox.claimDue(50, 60_000);
      assert.deepEqual(first.map((row) => row.topic).sort(), [HOST_NOTIFICATION_TOPICS.approvalDeadline, HOST_NOTIFICATION_TOPICS.guestMessage]);
      assert.ok(first.every((row) => row.providerId === "provider-a" && row.attempts === 1 && Number.isFinite(Date.parse(row.createdAt))));
      assert.deepEqual(first.find((row) => row.topic === HOST_NOTIFICATION_TOPICS.guestMessage)?.payload, { v: 1, bookingId: "bk-far", messageId: "msg-1", experienceTitle: booking.experienceTitle, startsAt: booking.startsAt, seats: 2 });
      // Claimed: moved past the lease, so a second claim gets nothing.
      assert.deepEqual(await outbox.claimDue(50, 60_000), []);
      for (const row of first) await outbox.complete(row.id, row.attempts);
      assert.ok((await rows(`id IN (${first.map((row) => row.id).join(",")})`)).every((row) => row.processed_at !== null));
      // complete and retryAt leave another topic's row alone even by id.
      await outbox.complete(other.id, Number(other.attempts));
      await outbox.retryAt(other.id, new Date(Date.now() + HOUR), Number(other.attempts));
      assert.deepEqual(await rows("topic = 'booking.confirmed'"), [other]);

      // retryAt: later is not due, earlier is.
      const retried = (await rows("aggregate_id = 'bk-mid'"))[0];
      await outbox.retryAt(retried.id, new Date((await dbNow()).getTime() - 1_000), Number(retried.attempts));
      const [due] = await outbox.claimDue(50, 60_000);
      assert.equal(due?.id, retried.id);
      await outbox.retryAt(retried.id, new Date((await dbNow()).getTime() + HOUR), due!.attempts);
      assert.deepEqual(await outbox.claimDue(50, 60_000), []);
      await outbox.retryAt(retried.id, new Date((await dbNow()).getTime() - 1_000), due!.attempts);

      // A claimed row that is never completed comes back once its lease runs out, counted again.
      const [leased] = await outbox.claimDue(50, 1_000);
      assert.equal(leased?.id, retried.id);
      assert.equal(leased?.attempts, 2);
      assert.deepEqual(await outbox.claimDue(50, 1_000), []);
      await sleep(1_200);
      const [back] = await outbox.claimDue(50, 60_000);
      assert.equal(back?.id, retried.id);
      assert.equal(back?.attempts, 3);
      // The run whose lease ran out can no longer close or move the row the next run holds.
      await outbox.complete(retried.id, leased!.attempts);
      await outbox.retryAt(retried.id, new Date((await dbNow()).getTime() + HOUR), leased!.attempts);
      assert.equal((await rows(`id = ${retried.id}`))[0]?.processed_at, null);
      assert.deepEqual(await outbox.claimDue(50, 60_000), []);
      await outbox.complete(retried.id, back!.attempts);
      assert.notEqual((await rows(`id = ${retried.id}`))[0]?.processed_at, null);

      // A row locked by another transaction is skipped, not waited for.
      for (let index = 0; index < 10; index += 1) {
        await withTransaction(pool, (client) => enqueueGuestMessageNotification(client, { ...booking, providerId: index % 2 ? "provider-a" : "provider-b", bookingId: `bk-${index}`, messageId: `msg-race-${index}` }));
      }
      const pending = await rows("processed_at IS NULL AND topic = 'host.notify.guest_message'");
      assert.equal(pending.length, 10);
      const locker = await pool.connect();
      try {
        await locker.query("BEGIN");
        await locker.query("SELECT id FROM outbox_messages WHERE id = $1 FOR UPDATE", [pending[0].id]);
        const skipped = await outbox.claimDue(50, 60_000);
        assert.equal(skipped.length, 9);
        assert.ok(!skipped.some((row) => row.id === pending[0].id));
        await locker.query("ROLLBACK");
      } finally {
        locker.release();
      }
      for (const row of await rows("topic = 'host.notify.guest_message' AND processed_at IS NULL")) await outbox.retryAt(row.id, new Date((await dbNow()).getTime() - 1_000), Number(row.attempts));

      // Concurrent claimers never share a row, and together they get all of them.
      const claims = await Promise.all([outbox.claimDue(4, 60_000), outbox.claimDue(4, 60_000), outbox.claimDue(4, 60_000)]);
      const ids = claims.flat().map((row) => row.id);
      assert.equal(new Set(ids).size, ids.length);
      const rest = await outbox.claimDue(50, 60_000);
      assert.deepEqual([...ids, ...rest.map((row) => row.id)].sort(), pending.map((row) => row.id).sort());
      assert.deepEqual(await rows("topic = 'booking.confirmed'"), [other]);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });
});
