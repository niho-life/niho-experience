import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { StoreAccessDeniedError, StoreRateLimitedError, StoreValidationError } from "../src/errors.ts";
import { HostMailOutbox } from "../src/host-mail-outbox.ts";
import { HOST_MAIL_TOPICS } from "../src/host-mail-shared.ts";
import { HostNotificationAddresses } from "../src/host-notification-addresses.ts";
import { enqueueCancellationNotification, enqueueNewBookingNotification, enqueueOtaBookingNotification, HOST_NOTIFICATION_TOPICS } from "../src/host-notification-outbox.ts";
import { withTransaction } from "../src/transaction.ts";

// ホストへのメールの宛先とメール (#194, owner decision 2026-11-01). Synthetic users and addresses only.
const databaseUrl = process.env.TEST_DATABASE_URL;

async function withSchema(name: string, work: (pool: Pool) => Promise<void>): Promise<void> {
  const { Pool } = await import("pg");
  const schema = `${name}_${randomUUID().replaceAll("-", "")}`;
  const pool: Pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const migrations = (await readdir(new URL("../migrations/", import.meta.url))).filter((file) => /^\d{4}.*\.sql$/.test(file)).sort();
    for (const file of migrations) await pool.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
    await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a'),('provider-b')");
    await pool.query(
      `INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES
         ('provider-a','owner-a','OWNER',true),('provider-a','editor-a','EDITOR',true),('provider-a','former-a','OWNER',false),
         ('provider-a','owner-two','OWNER',true),('provider-b','owner-b','OWNER',true)`,
    );
    for (const [provider, id] of [["provider-a", "tea"], ["provider-a", "solo"]] as const) {
      await pool.query(
        `INSERT INTO experience_products
          (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,
           seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
         VALUES ($1,$2,$2,'PUBLISHED',$3,'{}','JPY',1000,'terms','seller','acct_synthetic','Synthetic Seller')`,
        [provider, id, `Synthetic ${id}`],
      );
    }
    for (const [userId, productId] of [["operator-tea", "tea"], ["operator-solo", "solo"]] as const) {
      const invitation = randomUUID();
      await pool.query(
        `INSERT INTO product_operator_invitations
          (id,provider_id,product_id,token_hash,assignment_label,invited_by_niho_user_id,expires_at,state,accepted_niho_user_id,accepted_at)
         VALUES ($1,'provider-a',$2,decode(repeat('cd',32),'hex'),'Synthetic instructor','owner-a',clock_timestamp()+interval '1 day',
                 'ACCEPTED',$3,clock_timestamp())`,
        [invitation, productId, userId],
      );
      await pool.query(
        "INSERT INTO product_operator_grants (provider_id,product_id,niho_user_id,invitation_id,assignment_label) VALUES ('provider-a',$1,$2,$3,'Synthetic instructor')",
        [productId, userId, invitation],
      );
    }
    await work(pool);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
}

/** The raw token of the newest confirmation email for `email`, as the mail job makes it right before sending. */
async function sendConfirmation(outbox: HostMailOutbox): Promise<{ token: string; email: string } | null> {
  const { confirmations } = await outbox.claimAddressConfirmations({ limit: 1, leaseSeconds: 60 });
  const [claimed] = confirmations;
  if (!claimed) return null;
  await outbox.completeAddressConfirmation(claimed.id);
  if (!claimed.confirmation) return null;
  const token = await outbox.issueAddressConfirmationToken(claimed.confirmation.confirmationId);
  return token ? { token, email: claimed.confirmation.email } : null;
}

describe("PostgreSQL host notification addresses (#194)", { skip: databaseUrl === undefined }, () => {
  it("copies a sign-in's verified address only for someone with access, and clears it when it is no longer verified", async () => {
    await withSchema("host_addresses_login", async (pool) => {
      const addresses = new HostNotificationAddresses(pool);
      assert.equal(await addresses.recordLogin({ nihoUserId: "owner-a", verifiedEmail: "owner-a@example.test" }), "stored");
      assert.equal(await addresses.recordLogin({ nihoUserId: "operator-tea", verifiedEmail: "tea@example.test" }), "stored");
      // No membership, no grant: nothing is kept, not even for a former OWNER.
      assert.equal(await addresses.recordLogin({ nihoUserId: "stranger", verifiedEmail: "stranger@example.test" }), "skipped");
      assert.equal(await addresses.recordLogin({ nihoUserId: "former-a", verifiedEmail: "former@example.test" }), "skipped");
      // A sign-in to accept an invitation keeps it for a day before the grant exists.
      assert.equal(await addresses.recordLogin({ nihoUserId: "invitee", verifiedEmail: "invitee@example.test", invitation: true }), "stored");
      assert.deepEqual(await addresses.get("owner-a"), { loginEmail: "owner-a@example.test", overrideEmail: null, effectiveEmail: "owner-a@example.test", pendingEmail: null });
      assert.deepEqual(await addresses.get("stranger"), { loginEmail: null, overrideEmail: null, effectiveEmail: null, pendingEmail: null });
      // A later sign-in replaces the copy; one without a verified address clears it.
      assert.equal(await addresses.recordLogin({ nihoUserId: "owner-a", verifiedEmail: "Owner.New@example.test" }), "stored");
      assert.equal((await addresses.get("owner-a")).effectiveEmail, "Owner.New@example.test");
      assert.equal(await addresses.recordLogin({ nihoUserId: "owner-a", verifiedEmail: null }), "cleared");
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM host_notification_addresses WHERE niho_user_id='owner-a'")).rows[0]?.n, 0);
      assert.equal(await addresses.recordLogin({ nihoUserId: "owner-a", verifiedEmail: null }), "skipped");
      for (const bad of ["no-at-sign", "two@@example.test", "space @example.test", "a@b", `${"a".repeat(250)}@example.test`]) {
        await assert.rejects(() => addresses.recordLogin({ nihoUserId: "owner-a", verifiedEmail: bad }), StoreValidationError, bad);
      }
      await assert.rejects(() => addresses.recordLogin({ nihoUserId: "", verifiedEmail: "a@example.test" }), StoreValidationError);
    });
  });

  it("changes the address only once the link is opened, once and within the hour, and goes back to the sign-in's", async () => {
    await withSchema("host_addresses_override", async (pool) => {
      const addresses = new HostNotificationAddresses(pool);
      const outbox = new HostMailOutbox(pool);
      await addresses.recordLogin({ nihoUserId: "owner-a", verifiedEmail: "owner-a@example.test" });

      // Only within a provider the person belongs to.
      await assert.rejects(() => addresses.requestChange({ nihoUserId: "owner-a", providerId: "provider-b", email: "desk@example.test" }), StoreAccessDeniedError);
      await assert.rejects(() => addresses.requestChange({ nihoUserId: "stranger", providerId: "provider-a", email: "desk@example.test" }), StoreAccessDeniedError);
      await assert.rejects(() => addresses.requestChange({ nihoUserId: "owner-a", providerId: "provider-a", email: "not an address" }), StoreValidationError);

      const asked = await addresses.requestChange({ nihoUserId: "owner-a", providerId: "provider-a", email: " desk@example.test " });
      assert.equal(asked.kind, "PENDING");
      assert.deepEqual(asked.address, { loginEmail: "owner-a@example.test", overrideEmail: null, effectiveEmail: "owner-a@example.test", pendingEmail: "desk@example.test" });
      // One outbox row for the mail job, naming only the request.
      const queued = await pool.query("SELECT provider_id, aggregate_type, payload FROM outbox_messages WHERE topic=$1", [HOST_MAIL_TOPICS.addressConfirmation]);
      assert.deepEqual(queued.rows, [{ provider_id: "provider-a", aggregate_type: "host_notification_address", payload: { v: 1 } }]);

      // The job's token: only its digest is kept; a second token replaces the first.
      const { confirmations } = await outbox.claimAddressConfirmations({ limit: 1, leaseSeconds: 60 });
      assert.equal(confirmations.length, 1);
      const claimed = confirmations[0]!;
      assert.equal(claimed.confirmation?.email, "desk@example.test");
      const first = await outbox.issueAddressConfirmationToken(claimed.confirmation!.confirmationId);
      const second = await outbox.issueAddressConfirmationToken(claimed.confirmation!.confirmationId);
      assert.match(first ?? "", /^[A-Za-z0-9_-]{43}$/);
      assert.notEqual(first, second);
      const stored = await pool.query("SELECT encode(token_hash,'hex') AS hash FROM host_notification_address_confirmations");
      assert.equal(JSON.stringify(stored.rows).includes(second!), false);
      await outbox.completeAddressConfirmation(claimed.id);
      assert.equal(await addresses.confirm(first!), null);
      assert.equal(await addresses.confirm("short"), null);
      assert.equal((await addresses.get("owner-a")).effectiveEmail, "owner-a@example.test");

      // Opened: the address is in use; the link works once.
      assert.deepEqual(await addresses.confirm(second!), { email: "desk@example.test" });
      assert.deepEqual(await addresses.get("owner-a"), { loginEmail: "owner-a@example.test", overrideEmail: "desk@example.test", effectiveEmail: "desk@example.test", pendingEmail: null });
      assert.equal(await addresses.confirm(second!), null);
      // A later sign-in keeps the choice.
      await addresses.recordLogin({ nihoUserId: "owner-a", verifiedEmail: "owner-a@example.test" });
      assert.equal((await addresses.get("owner-a")).effectiveEmail, "desk@example.test");

      // Asking for the address in use changes nothing; the sign-in's address needs no link.
      assert.equal((await addresses.requestChange({ nihoUserId: "owner-a", providerId: "provider-a", email: "DESK@example.test" })).kind, "UNCHANGED");
      const back = await addresses.requestChange({ nihoUserId: "owner-a", providerId: "provider-a", email: "owner-a@example.test" });
      assert.deepEqual([back.kind, back.address.effectiveEmail, back.address.overrideEmail], ["DEFAULT", "owner-a@example.test", null]);

      // Expired: an hour after the request, the email is not sent and the link no longer works.
      await addresses.requestChange({ nihoUserId: "owner-a", providerId: "provider-a", email: "late@example.test" });
      await pool.query("UPDATE host_notification_address_confirmations SET created_at = clock_timestamp() - interval '61 minutes' WHERE email='late@example.test'");
      assert.equal((await addresses.get("owner-a")).pendingEmail, null);
      const late = await outbox.claimAddressConfirmations({ limit: 1, leaseSeconds: 60 });
      assert.equal(late.confirmations[0]?.confirmation, null);
      await outbox.completeAddressConfirmation(late.confirmations[0]!.id);
      const lateId = String((await pool.query("SELECT id::text FROM host_notification_address_confirmations WHERE email='late@example.test'")).rows[0]?.id);
      assert.equal(await outbox.issueAddressConfirmationToken(lateId), null);

      // A newer request and 取り消す cancel the older ones.
      await addresses.requestChange({ nihoUserId: "owner-a", providerId: "provider-a", email: "one@example.test" });
      await addresses.requestChange({ nihoUserId: "owner-a", providerId: "provider-a", email: "two@example.test" });
      const sentOne = await sendConfirmation(outbox);
      const sentTwo = await sendConfirmation(outbox);
      assert.equal(sentOne, null);
      assert.equal(sentTwo?.email, "two@example.test");
      assert.equal((await addresses.cancelChange("owner-a")).pendingEmail, null);
      assert.equal(await addresses.confirm(sentTwo!.token), null);

      // ログインのメールに戻す.
      await addresses.requestChange({ nihoUserId: "owner-a", providerId: "provider-a", email: "three@example.test" });
      const sentThree = await sendConfirmation(outbox);
      assert.deepEqual(await addresses.confirm(sentThree!.token), { email: "three@example.test" });
      assert.deepEqual(await addresses.useLoginEmail("owner-a"), { loginEmail: "owner-a@example.test", overrideEmail: null, effectiveEmail: "owner-a@example.test", pendingEmail: null });

      // Five requests an hour (late, one, two, three and this one): the sixth waits.
      await addresses.requestChange({ nihoUserId: "owner-a", providerId: "provider-a", email: "four@example.test" });
      await assert.rejects(() => addresses.requestChange({ nihoUserId: "owner-a", providerId: "provider-a", email: "five@example.test" }), StoreRateLimitedError);

      // An operator sets theirs within the provider of their grant, without a sign-in copy; access ending closes the link.
      const operator = await addresses.requestChange({ nihoUserId: "operator-tea", providerId: "provider-a", email: "tea-desk@example.test" });
      assert.equal(operator.kind, "PENDING");
      const sentOperator = await sendConfirmation(outbox);
      assert.equal(sentOperator?.email, "four@example.test");
      const sentTea = await sendConfirmation(outbox);
      assert.equal(sentTea?.email, "tea-desk@example.test");
      await pool.query("UPDATE product_operator_grants SET active=false, revoked_at=clock_timestamp() WHERE niho_user_id='operator-tea'");
      assert.equal(await addresses.confirm(sentTea!.token), null);
    });
  });

  it("sends a booking's email to its people's address in use, and deletes the addresses once access ends", async () => {
    await withSchema("host_addresses_mail", async (pool) => {
      const addresses = new HostNotificationAddresses(pool);
      const outbox = new HostMailOutbox(pool);
      for (const [userId, email] of [["owner-a", "owner-a@example.test"], ["editor-a", "editor-a@example.test"], ["operator-tea", "tea@example.test"], ["operator-solo", "solo@example.test"], ["owner-b", "owner-b@example.test"]] as const) {
        assert.equal(await addresses.recordLogin({ nihoUserId: userId, verifiedEmail: email }), "stored");
      }
      // owner-two has no address: no row is written for them.
      const facts = { providerId: "provider-a", bookingId: randomUUID(), experienceTitle: "Synthetic tea", startsAt: "2099-01-03T01:00:00.000Z", seats: 2 };
      const ref = randomUUID();
      await withTransaction(pool, async (client) => {
        assert.equal(await enqueueNewBookingNotification(client, facts), 1);
        assert.equal(await enqueueNewBookingNotification(client, facts), 0);
        assert.equal(await enqueueCancellationNotification(client, facts), 1);
        assert.equal(await enqueueOtaBookingNotification(client, {
          providerId: "provider-a", change: "RESCHEDULED", site: "GetYourGuide", ref, localRevision: 2, productId: "tea",
          experienceTitle: "Synthetic tea", startsAt: "2099-01-06T01:00:00.000Z", previousStartsAt: "2099-01-04T01:00:00.000Z", seats: 1,
          guestName: "Synthetic Guest",
        }), 1);
      });
      const rows = (await pool.query("SELECT topic, payload FROM outbox_messages WHERE topic LIKE 'host.mail.%' ORDER BY id")).rows as { topic: string; payload: Record<string, unknown> }[];
      // This site's bookings: the OWNER only (the repeat adds nothing). The OTA booking: the OWNER and the product's operator.
      // Each booking's people in one order (by their ID, whatever the collation).
      assert.deepEqual(rows.map((row) => [row.topic, row.payload.to]), [
        [HOST_MAIL_TOPICS.newBooking, "owner-a"],
        [HOST_MAIL_TOPICS.cancellation, "owner-a"],
        [HOST_MAIL_TOPICS.otaBooking, "operator-tea"],
        [HOST_MAIL_TOPICS.otaBooking, "owner-a"],
      ]);
      // No guest name is written into the email rows.
      assert.equal(rows.some((row) => "guestName" in row.payload), false);
      // The push rows are as before.
      const pushes = await pool.query("SELECT topic FROM outbox_messages WHERE topic LIKE 'host.notify.%' ORDER BY id");
      assert.deepEqual(pushes.rows.map((row) => row.topic), [HOST_NOTIFICATION_TOPICS.newBooking, HOST_NOTIFICATION_TOPICS.cancellation, HOST_NOTIFICATION_TOPICS.otaBooking]);

      // Sent to the address in use when it goes: a confirmed choice wins over the sign-in's.
      await pool.query("UPDATE host_notification_addresses SET override_email='desk@example.test', override_confirmed_at=clock_timestamp() WHERE niho_user_id='owner-a'");
      // The operator's grant ends before the job runs: their email is not sent.
      await pool.query("UPDATE product_operator_grants SET active=false, revoked_at=clock_timestamp() WHERE niho_user_id='operator-tea'");
      const claim = await outbox.claimBookingMails({ limit: 10, leaseSeconds: 60 });
      assert.equal(claim.abandoned, 0);
      assert.deepEqual(claim.mails.map((mail) => [mail.notificationTopic, mail.to, mail.guestName, "to" in mail.payload]), [
        [HOST_NOTIFICATION_TOPICS.newBooking, "desk@example.test", null, false],
        [HOST_NOTIFICATION_TOPICS.cancellation, "desk@example.test", null, false],
        // The operator's grant ended: not sent. The reservation is not in the ledger here, so there is no kept name to read.
        [HOST_NOTIFICATION_TOPICS.otaBooking, null, null, false],
        [HOST_NOTIFICATION_TOPICS.otaBooking, "desk@example.test", null, false],
      ]);
      assert.deepEqual(claim.mails[3]!.payload, {
        v: 1, change: "RESCHEDULED", site: "GetYourGuide", ref, productId: "tea", experienceTitle: "Synthetic tea",
        startsAt: "2099-01-06T01:00:00.000Z", previousStartsAt: "2099-01-04T01:00:00.000Z", seats: 1,
      });
      // Claimed rows are leased; retries back off and the last attempt gives up.
      assert.equal((await outbox.claimBookingMails({ limit: 10, leaseSeconds: 60 })).mails.length, 0);
      assert.equal(await outbox.retryBookingMail(claim.mails[0]!.id, claim.mails[0]!.attempts), "RETRY");
      assert.equal(await outbox.retryBookingMail(claim.mails[0]!.id, claim.mails[0]!.attempts + 1), "STALE");
      for (const mail of claim.mails.slice(1)) await outbox.completeBookingMail(mail.id);
      await pool.query("UPDATE outbox_messages SET attempts=8, available_at=clock_timestamp() WHERE topic=$1", [HOST_MAIL_TOPICS.newBooking]);
      assert.deepEqual(await outbox.claimBookingMails({ limit: 10, leaseSeconds: 60 }), { mails: [], abandoned: 1 });
      await assert.rejects(() => outbox.claimBookingMails({ limit: 0, leaseSeconds: 60 }), StoreValidationError);
      await assert.rejects(() => outbox.completeBookingMail("not-an-id"), StoreValidationError);

      // Access ends: the operator whose grant was revoked, an EDITOR who left, an expired grant. An invitation's sign-in waits a day.
      await addresses.recordLogin({ nihoUserId: "invitee", verifiedEmail: "invitee@example.test", invitation: true });
      await pool.query("UPDATE provider_memberships SET active=false WHERE niho_user_id='editor-a'");
      await pool.query("UPDATE product_operator_grants SET granted_at=granted_at - interval '1 day', expires_at=clock_timestamp() - interval '1 minute' WHERE niho_user_id='operator-solo'");
      const purged = await addresses.purge({ limit: 50 });
      assert.equal(purged, 3);
      const kept = (await pool.query("SELECT niho_user_id FROM host_notification_addresses ORDER BY niho_user_id")).rows.map((row) => row.niho_user_id);
      assert.deepEqual(kept, ["invitee", "owner-a", "owner-b"]);
      await pool.query("UPDATE host_notification_addresses SET access_grace_until=clock_timestamp() - interval '1 second' WHERE niho_user_id='invitee'");
      assert.equal(await addresses.purge(), 1);
      assert.equal(await addresses.purge(), 0);
      await assert.rejects(() => addresses.purge({ limit: 0 }), StoreValidationError);
    });
  });
});
