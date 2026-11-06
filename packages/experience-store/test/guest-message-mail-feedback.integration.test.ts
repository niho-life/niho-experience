import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { addLocalDays, type ScheduleRule } from "@niho-experience/experience-domain";
import type { Pool } from "pg";
import { GuestBookingMessages } from "../src/booking-messages.ts";
import { EXPERIENCE_SUPPORT_CONSENT_VERSION, GuestBookingRepository, type GuestBookingStart, type StartGuestBookingInput } from "../src/guest-bookings.ts";
import { GuestMailOutbox, type GuestMailDeliveryFeedback } from "../src/guest-mail-outbox.ts";
import { GuestQuestionRepository } from "../src/guest-questions.ts";
import { HOST_NOTIFICATION_TOPICS, parseGuestEmailDeliveryFailedPayload } from "../src/host-notification-outbox.ts";
import { ExperienceStore } from "../src/repository.ts";
import { consentSupportOffForTest, seedTestPublications } from "./helpers/experience-publication-fixtures.ts";

/**
 * Post-accept bounce feedback for a booking thread's mail (#128): the host's replies and NIHO support contacts carry
 * the same opaque reference as the booking outbox mails; a reply to a question before booking does not. Synthetic data only.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const ownerA = { providerId: "provider-a", nihoUserId: "owner-a" } as const;
const CONSENT = "sample-terms-2026-10";
const NO_QUESTIONS = createHash("sha256").update("[]", "utf8").digest("hex");
const REF = /^ex1_[0-9a-f]{32}$/;
const LEASE = { limit: 10, leaseSeconds: 60, linkTtlDays: 14 } as const;

function day(offset: number): string {
  return addLocalDays(new Date(Date.now() + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10), offset);
}

const RULE: ScheduleRule = {
  id: "sample-walk-am", timeZone: "Asia/Tokyo", startsOn: day(1), localStartTime: "10:00", durationMinutes: 90, capacity: 12,
  bookingCutoffMinutes: 60, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "DAILY" },
};

function request(overrides: Partial<StartGuestBookingInput> = {}): StartGuestBookingInput {
  return {
    slug: "sample-walk", offerId: "sample-walk-am", occurrenceDate: day(2), adultCount: 1, childCount: 0, expectedTotalYen: 3000,
    bookingQuestionsFingerprint: NO_QUESTIONS, answers: [], termsConsentVersion: CONSENT, currentConsentVersion: CONSENT,
    conditionsConsentVersion: null, guestName: "Sample Guest", guestEmail: "guest@example.com", guestLanguage: "EN",
    clientRequestKey: randomUUID(), ...overrides,
  };
}

interface Context {
  readonly pool: Pool;
  readonly store: ExperienceStore;
  readonly guests: GuestBookingRepository;
  readonly questions: GuestQuestionRepository;
  readonly messages: GuestBookingMessages;
  readonly outbox: GuestMailOutbox;
}

async function withSchema(run: (context: Context) => Promise<void>): Promise<void> {
  const { Pool } = await import("pg");
  const schema = `guest_message_feedback_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const migrations = (await readdir(new URL("../migrations/", import.meta.url))).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort();
    for (const name of migrations) await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a')");
    await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES ('provider-a','owner-a','OWNER',true)");
    await pool.query(
      `INSERT INTO experience_products
         (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
       VALUES ('provider-a','walk','sample-walk','PUBLISHED','Synthetic walk','{}','JPY',3000,'terms-v1','seller-provider-a','acct_SampleA0001','Sample Seller A')`,
    );
    const store = new ExperienceStore(pool);
    const guests = new GuestBookingRepository(pool);
    await consentSupportOffForTest(guests, ownerA);
    await guests.setSaleTerms(ownerA, "walk", {
      childPricing: null, minimumParticipants: 1, maxPartySize: 6,
      cancellationPolicy: "FREE_UNTIL_48H", bookingQuestions: [], conditionsVersion: null,
    });
    await store.saveScheduleRule(ownerA, "walk", RULE, null, randomUUID());
    await seedTestPublications(pool);
    await run({ pool, store, guests, questions: new GuestQuestionRepository(pool), messages: new GuestBookingMessages(pool), outbox: new GuestMailOutbox(pool) });
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
}

let events = 0;
async function confirmed(context: Context, overrides: Partial<StartGuestBookingInput> = {}): Promise<GuestBookingStart> {
  const start = await context.guests.startGuestBooking(request(overrides));
  events += 1;
  const paid = await context.store.confirmBookingPayment({ providerId: "provider-a" }, {
    publicBookingId: start.publicBookingId, connectedAccountId: "acct_SampleA0001", stripePaymentRef: `pi_sample_msg_${events}`,
    stripeEventId: `evt_sample_msg_${events}`, stripeEventType: "checkout.session.completed", eventOccurredAtUtc: new Date().toISOString(),
    amount: start.totalAmount, currency: "JPY",
  });
  assert.equal(paid.booking.status, "CONFIRMED");
  return start;
}

const reply = (english: string) => ({ english, japanese: null, commandId: randomUUID() });

function bounce(deliveryRef: string, eventId: string, overrides: Partial<GuestMailDeliveryFeedback> = {}): GuestMailDeliveryFeedback {
  return {
    eventId, deliveryRef, reportType: "BOUNCE", verification: "CORRELATED_DSN", classification: "NO_SUCH_ADDRESS",
    reportedAt: new Date("2026-11-04T03:00:00.000Z"), ...overrides,
  };
}

async function messageRow(pool: Pool, id: string) {
  return (await pool.query("SELECT delivery_status, delivery_attempts, mail_delivery_ref FROM guest_question_messages WHERE id=$1::uuid", [id])).rows[0]!;
}

async function failureNotices(pool: Pool) {
  return (await pool.query("SELECT payload FROM outbox_messages WHERE topic=$1", [HOST_NOTIFICATION_TOPICS.guestEmailDeliveryFailed])).rows;
}

/** A host reply to a question asked before booking, claimed once. */
async function questionReply(context: Context, guestEmail: string): Promise<string> {
  await context.questions.submitQuestion({
    productSlug: "sample-walk", topic: "FOOD", message: "Is there a vegetarian option?", guestName: "Asker", guestEmail, clientRequestKey: randomUUID(),
  });
  const thread = (await context.pool.query("SELECT id::text AS id FROM guest_question_threads WHERE booking_id IS NULL ORDER BY created_at DESC LIMIT 1")).rows[0]!;
  return (await context.questions.reply(ownerA, String(thread.id), reply("Yes, we can."))).id;
}

describe("PostgreSQL booking thread mail feedback (#128)", { skip: databaseUrl === undefined }, () => {
  it("stamps a booking thread message once and keeps the reference across a retry; a reply before booking gets none", async () => {
    await withSchema(async (context) => {
      const { pool, questions } = context;
      const booking = await confirmed(context);
      const sent = await questions.replyToBooking(ownerA, booking.publicBookingId, reply("See you at the station."));
      assert.equal((await messageRow(pool, sent.message.id)).mail_delivery_ref, null, "not stamped before the first claim");

      const [first] = await questions.claimReplyDeliveries(LEASE);
      assert.ok(first && first.kind === "BOOKING");
      assert.match(first.deliveryRef, REF);
      assert.equal((await messageRow(pool, sent.message.id)).mail_delivery_ref, first.deliveryRef);
      assert.equal(await questions.recordReplyDelivery(first.messageId, "RETRY"), "PENDING");

      await pool.query("UPDATE guest_question_messages SET lease_until = clock_timestamp() - interval '1 second' WHERE id=$1::uuid", [first.messageId]);
      const [second] = await questions.claimReplyDeliveries(LEASE);
      assert.ok(second && second.kind === "BOOKING");
      assert.equal(second.attempt, 2);
      assert.equal(second.deliveryRef, first.deliveryRef);
      assert.equal(await questions.recordReplyDelivery(second.messageId, "SENT"), "SENT");

      const questionMessageId = await questionReply(context, "asker@example.com");
      const [claimed] = await questions.claimReplyDeliveries(LEASE);
      assert.ok(claimed && claimed.kind === "QUESTION");
      assert.equal(claimed.messageId, questionMessageId);
      assert.ok(!("deliveryRef" in claimed));
      assert.equal((await messageRow(pool, questionMessageId)).mail_delivery_ref, null);
    });
  });

  it("records a confirmed hard bounce of a host reply, suppresses later booking thread mail, and notifies the host without PII", async () => {
    await withSchema(async (context) => {
      const { pool, questions, outbox } = context;
      const booking = await confirmed(context, { guestEmail: "bounce@example.com" });
      const later = await confirmed(context, { guestEmail: "Bounce@Example.com" });
      const sent = await questions.replyToBooking(ownerA, booking.publicBookingId, reply("See you at the station."));
      const [claimed] = await questions.claimReplyDeliveries(LEASE);
      assert.ok(claimed && claimed.kind === "BOOKING");
      assert.equal(await questions.recordReplyDelivery(claimed.messageId, "SENT"), "SENT");

      const event = bounce(claimed.deliveryRef, "niho_msg_feedback_01");
      assert.equal(await outbox.recordDeliveryFeedback(event), "RECORDED");
      assert.equal(await outbox.recordDeliveryFeedback(event), "DUPLICATE");
      assert.equal(await outbox.recordDeliveryFeedback({ ...event, eventId: "niho_msg_feedback_02", reportedAt: new Date(event.reportedAt.getTime() + 1_000) }), "DUPLICATE");
      await assert.rejects(() => outbox.recordDeliveryFeedback({ ...event, classification: "NO_SUCH_DOMAIN" }));

      const ledger = await pool.query(
        `SELECT f.provider_id, b.public_booking_id::text AS public_booking_id, f.report_type, f.verification, f.classification
           FROM guest_mail_delivery_feedback f JOIN bookings b ON b.provider_id=f.provider_id AND b.id=f.booking_id`,
      );
      assert.deepEqual(ledger.rows, [{ provider_id: "provider-a", public_booking_id: booking.publicBookingId, report_type: "BOUNCE", verification: "CORRELATED_DSN", classification: "NO_SUCH_ADDRESS" }]);
      const suppressed = await pool.query("SELECT count(*)::int AS n FROM booking_guests WHERE mail_suppressed_at IS NOT NULL AND mail_suppression_classification='NO_SUCH_ADDRESS'");
      assert.equal(suppressed.rows[0]!.n, 2, "every booking of the same address at this provider");

      const notices = await failureNotices(pool);
      assert.equal(notices.length, 1);
      const serialized = JSON.stringify(notices[0]).toLowerCase();
      for (const secret of ["bounce@example.com", "see you at the station", claimed.deliveryRef]) assert.equal(serialized.includes(secret), false);
      const notice = parseGuestEmailDeliveryFailedPayload(notices[0]!.payload);
      assert.ok(notice);
      assert.equal(notice.bookingId, booking.publicBookingId);
      assert.equal(notice.classification, "NO_SUCH_ADDRESS");

      // Later booking thread mail to the suppressed address is not retried and is not marked sent.
      const next = await questions.replyToBooking(ownerA, booking.publicBookingId, reply("One more thing."));
      const other = await questions.replyToBooking(ownerA, later.publicBookingId, reply("About your second booking."));
      assert.deepEqual(await questions.claimReplyDeliveries(LEASE), []);
      for (const id of [next.message.id, other.message.id]) {
        const row = await messageRow(pool, id);
        assert.equal(row.delivery_status, "FAILED");
        assert.equal(row.delivery_attempts, 0);
      }
      assert.equal((await messageRow(pool, sent.message.id)).delivery_status, "SENT");

      // A reply before booking has no booking guest record: out of this suppression, sent as before.
      const questionMessageId = await questionReply(context, "bounce@example.com");
      const [question] = await questions.claimReplyDeliveries(LEASE);
      assert.ok(question && question.kind === "QUESTION");
      assert.equal(question.messageId, questionMessageId);
    });
  });

  it("records a NIHO support contact's bounce against its booking", async () => {
    await withSchema(async (context) => {
      const { pool, guests, messages, questions, outbox } = context;
      await guests.setProviderSupportSettings(ownerA, { supportEnabled: true, consentVersion: EXPERIENCE_SUPPORT_CONSENT_VERSION, expectedVersion: 1 });
      const booking = await confirmed(context, { guestEmail: "support-bounce@example.com" });
      assert.deepEqual(await messages.sendSupportMessage({ nihoUserId: "admin-a" }, booking.publicBookingId, { commandId: randomUUID(), message: "NIHO support contact" }), { status: "received", repeated: false });
      const [claimed] = await questions.claimReplyDeliveries(LEASE);
      assert.ok(claimed && claimed.kind === "BOOKING_SUPPORT");
      assert.match(claimed.deliveryRef, REF);
      assert.equal(await questions.recordReplyDelivery(claimed.messageId, "SENT"), "SENT");
      assert.equal(await outbox.recordDeliveryFeedback(bounce(claimed.deliveryRef, "niho_support_feedback_1", { classification: "NO_SUCH_DOMAIN" })), "RECORDED");
      const guest = await pool.query("SELECT mail_suppression_classification FROM booking_guests");
      assert.equal(guest.rows[0]!.mail_suppression_classification, "NO_SUCH_DOMAIN");
      assert.equal((await failureNotices(pool)).length, 1);
    });
  });

  it("does not suppress after a temporary failure or an unverified complaint, and leaves an unknown reference unmatched", async () => {
    await withSchema(async (context) => {
      const { pool, questions, outbox } = context;
      const booking = await confirmed(context, { guestEmail: "soft@example.com" });
      await questions.replyToBooking(ownerA, booking.publicBookingId, reply("First."));
      const [first] = await questions.claimReplyDeliveries(LEASE);
      assert.ok(first && first.kind === "BOOKING");
      await questions.recordReplyDelivery(first.messageId, "SENT");

      assert.equal(await outbox.recordDeliveryFeedback(bounce(first.deliveryRef, "niho_soft_feedback_01", { classification: "MAILBOX_FULL" })), "RECORDED");
      assert.equal(await outbox.recordDeliveryFeedback({
        eventId: "niho_arf_feedback_0001", deliveryRef: first.deliveryRef, reportType: "COMPLAINT", verification: "UNVERIFIED_ARF",
        classification: "SPAM_COMPLAINT", reportedAt: new Date("2026-11-04T04:00:00.000Z"),
      }), "RECORDED");
      const ledger = await pool.query("SELECT report_type, classification FROM guest_mail_delivery_feedback ORDER BY report_type");
      assert.deepEqual(ledger.rows, [{ report_type: "BOUNCE", classification: "MAILBOX_FULL" }, { report_type: "COMPLAINT", classification: "SPAM_COMPLAINT" }]);
      assert.equal((await pool.query("SELECT mail_suppressed_at FROM booking_guests")).rows[0]!.mail_suppressed_at, null);
      // The host hears about the bounce (as for the booking outbox mails), not about the unverified complaint.
      assert.equal((await failureNotices(pool)).length, 1);

      await questions.replyToBooking(ownerA, booking.publicBookingId, reply("Second."));
      const [second] = await questions.claimReplyDeliveries(LEASE);
      assert.ok(second && second.kind === "BOOKING");
      assert.notEqual(second.deliveryRef, first.deliveryRef, "one reference per message");

      assert.equal(await outbox.recordDeliveryFeedback(bounce(`ex1_${"0".repeat(32)}`, "niho_unknown_ref_0001")), "UNMATCHED");
    });
  });

  it("leaves feedback unmatched once the guest's data was erased, keeping the erasure check", async () => {
    await withSchema(async (context) => {
      const { pool, guests, questions, outbox } = context;
      const booking = await confirmed(context, { guestEmail: "erased@example.com" });
      const kept = await confirmed(context, { guestEmail: "kept@example.com" });
      await questions.replyToBooking(ownerA, booking.publicBookingId, reply("Thanks for coming."));
      await questions.replyToBooking(ownerA, kept.publicBookingId, reply("See you."));
      const claimed = await questions.claimReplyDeliveries(LEASE);
      const ref = (publicBookingId: string) => {
        const found = claimed.find((item) => item.kind === "BOOKING" && item.publicBookingId === publicBookingId);
        assert.ok(found && found.kind === "BOOKING");
        return found.deliveryRef;
      };
      const erasedRef = ref(booking.publicBookingId);
      const keptRef = ref(kept.publicBookingId);

      // The guest record erased while the thread stays (outside eraseGuestData): no address to suppress.
      await pool.query(
        `UPDATE booking_guests g SET guest_name=NULL, guest_email=NULL, guest_email_key=NULL, guest_phone=NULL, note=NULL, answers=NULL, utm=NULL, pii_erased_at=clock_timestamp()
           FROM bookings b WHERE b.provider_id=g.provider_id AND b.id=g.booking_id AND b.public_booking_id=$1`,
        [booking.publicBookingId],
      );
      assert.equal(await outbox.recordDeliveryFeedback(bounce(erasedRef, "niho_erased_feedback_1")), "UNMATCHED");
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM guest_mail_delivery_feedback")).rows[0]!.n, 0);

      // eraseGuestData takes the booking's thread, its references and its feedback with it.
      assert.equal(await outbox.recordDeliveryFeedback(bounce(keptRef, "niho_kept_feedback_01")), "RECORDED");
      await pool.query("ALTER TABLE bookings DISABLE TRIGGER bookings_protect_snapshots");
      await pool.query(
        "UPDATE bookings SET occurrence_snapshot = occurrence_snapshot || jsonb_build_object('startUtc', $2::text, 'endUtc', $3::text) WHERE public_booking_id=$1",
        [kept.publicBookingId, new Date(Date.now() - 100 * 86_400_000).toISOString(), new Date(Date.now() - 99 * 86_400_000).toISOString()],
      );
      await pool.query("ALTER TABLE bookings ENABLE TRIGGER bookings_protect_snapshots");
      await guests.eraseGuestData({ endedBefore: new Date(Date.now() - 30 * 86_400_000).toISOString() });
      const after = await pool.query(
        `SELECT g.pii_erased_at IS NOT NULL AS erased, g.mail_suppressed_at
           FROM booking_guests g JOIN bookings b ON b.provider_id=g.provider_id AND b.id=g.booking_id WHERE b.public_booking_id=$1`,
        [kept.publicBookingId],
      );
      assert.deepEqual(after.rows, [{ erased: true, mail_suppressed_at: null }]);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM guest_question_messages WHERE mail_delivery_ref=$1", [keptRef])).rows[0]!.n, 0);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM guest_mail_delivery_feedback")).rows[0]!.n, 0);
      assert.equal(await outbox.recordDeliveryFeedback(bounce(keptRef, "niho_kept_feedback_02")), "UNMATCHED");
    });
  });
});
