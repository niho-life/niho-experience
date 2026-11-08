import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HostMailOutbox } from "../src/host-mail-outbox.ts";
import { HOST_MAIL_TOPICS } from "../src/host-mail-shared.ts";
import { enqueueGuestMessageNotification, enqueueListingSuspensionNotification, enqueueNewReviewNotification, HOST_NOTIFICATION_TOPICS } from "../src/host-notification-outbox.ts";
import { withTransaction } from "../src/transaction.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe("host optional and mandatory notification mail producers", { skip: databaseUrl === undefined }, () => {
  it("writes owner mail rows in each producer transaction without copying addresses or guest PII", async () => {
    const db = await createIsolatedDatabase(databaseUrl, "host_notification_mail", { max: 4 });
    try {
      await db.pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a')");
      await db.pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES ('provider-a','owner-a','OWNER',true)");
      await db.pool.query("INSERT INTO host_notification_addresses (niho_user_id,login_email,login_email_at) VALUES ('owner-a','owner@example.test',clock_timestamp())");
      await withTransaction(db.pool, async (client) => {
        await enqueueGuestMessageNotification(client, { providerId: "provider-a", bookingId: "booking-1", messageId: "message-1", experienceTitle: "Synthetic walk", startsAt: "2099-01-02T01:00:00.000Z", seats: 2 });
        await enqueueNewReviewNotification(client, { providerId: "provider-a", reviewId: "10000000-0000-4000-8000-000000000109", experienceTitle: "Synthetic walk" });
        await enqueueListingSuspensionNotification(client, { providerId: "provider-a", productId: "walk", experienceTitle: "Synthetic walk", change: "SUSPENDED", stateVersion: 1 });
      });
      const rows = (await db.pool.query("SELECT topic,payload FROM outbox_messages WHERE topic LIKE 'host.mail.%' ORDER BY topic")).rows;
      assert.deepEqual(rows.map((row) => row.topic), [HOST_MAIL_TOPICS.guestMessage, HOST_MAIL_TOPICS.listingSuspension, HOST_MAIL_TOPICS.newReview].sort());
      for (const row of rows) {
        assert.equal(row.payload.to, "owner-a"); assert.equal("guestName" in row.payload, false); assert.equal(JSON.stringify(row.payload).includes("owner@example.test"), false);
      }
      const claimed = await new HostMailOutbox(db.pool).claimBookingMails({ limit: 10, leaseSeconds: 60 });
      assert.deepEqual(new Set(claimed.mails.map((mail) => mail.notificationTopic)), new Set([
        HOST_NOTIFICATION_TOPICS.guestMessage, HOST_NOTIFICATION_TOPICS.newReview, HOST_NOTIFICATION_TOPICS.listingSuspension,
      ]));
    } finally { await db.dispose(); }
  });

  it("rechecks the native recipient account before delivery and does not enqueue mail for a suspended account", async () => {
    const db = await createIsolatedDatabase(databaseUrl, "host_mail_native_recipient", { max: 2 });
    const owner = `hst_${"09".repeat(16)}`;
    try {
      await db.pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a')");
      await db.pool.query("INSERT INTO host_accounts (id,email,email_key,created_at,updated_at) VALUES ($1,'owner@example.test','owner@example.test',clock_timestamp(),clock_timestamp())", [owner]);
      await db.pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES ('provider-a',$1,'OWNER',true)", [owner]);
      await db.pool.query("INSERT INTO host_notification_addresses (niho_user_id,login_email,login_email_at) VALUES ($1,'owner@example.test',clock_timestamp())", [owner]);
      const enqueue = (id: string) => withTransaction(db.pool, (client) => enqueueNewReviewNotification(client, { providerId: "provider-a", reviewId: id, experienceTitle: "Synthetic walk" }));
      await enqueue("10000000-0000-4000-8000-000000000101");
      await db.pool.query("UPDATE host_accounts SET status='SUSPENDED',suspended_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1", [owner]);
      const claimed = await new HostMailOutbox(db.pool).claimBookingMails({ limit: 10, leaseSeconds: 60 });
      assert.equal(claimed.mails.length, 1);
      assert.equal(claimed.mails[0]?.to, null);
      await enqueue("10000000-0000-4000-8000-000000000102");
      assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM outbox_messages WHERE topic=$1", [HOST_MAIL_TOPICS.newReview])).rows[0]?.count, 1);
    } finally { await db.dispose(); }
  });
});
