import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { addLocalDays, type ScheduleRule } from "@niho-experience/experience-domain";
import type { Pool } from "pg";
import { GuestBookingAccess } from "../src/booking-access.ts";
import { GuestBookingMessages } from "../src/booking-messages.ts";
import { BookingMessagesClosedError, StoreConflictError, StoreNotFoundError, StoreRateLimitedError, StoreValidationError } from "../src/errors.ts";
import { GuestBookingRepository, type GuestBookingStart, type StartGuestBookingInput } from "../src/guest-bookings.ts";
import { GuestQuestionTranslations } from "../src/guest-question-translations.ts";
import { GuestQuestionRepository } from "../src/guest-questions.ts";
import { HOST_NOTIFICATION_TOPICS, parseBookingMessagePayload } from "../src/host-notification-outbox.ts";
import { ExperienceStore } from "../src/repository.ts";

/** 予約ごとのメッセージ (#285 slice 6b): a booking's thread between its guest and the host, against a real schema. Synthetic data only. */
const databaseUrl = process.env.TEST_DATABASE_URL;
const ownerA = { providerId: "provider-a", nihoUserId: "owner-a" } as const;
const ownerB = { providerId: "provider-b", nihoUserId: "owner-b" } as const;
const CONSENT = "sample-terms-2026-10";
const NO_QUESTIONS = createHash("sha256").update("[]", "utf8").digest("hex");
const DAY_MS = 86_400_000;
const GUEST_EMAIL = "Guest@Example.com";

function day(offset: number): string {
  return addLocalDays(new Date(Date.now() + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10), offset);
}

const RULE: ScheduleRule = {
  id: "sample-walk-am", timeZone: "Asia/Tokyo", startsOn: day(1), localStartTime: "10:00", durationMinutes: 90, capacity: 12,
  bookingCutoffMinutes: 60, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "DAILY" },
};

function request(overrides: Partial<StartGuestBookingInput> = {}): StartGuestBookingInput {
  return {
    slug: "sample-walk", offerId: "sample-walk-am", occurrenceDate: day(2), adultCount: 2, childCount: 1, expectedTotalYen: 7500,
    bookingQuestionsFingerprint: NO_QUESTIONS, answers: [], termsConsentVersion: CONSENT, currentConsentVersion: CONSENT,
    conditionsConsentVersion: null, guestName: "Sample Guest", guestEmail: GUEST_EMAIL, guestLanguage: "EN",
    clientRequestKey: randomUUID(), ...overrides,
  };
}

interface Context {
  readonly pool: Pool;
  readonly store: ExperienceStore;
  readonly guests: GuestBookingRepository;
  readonly access: GuestBookingAccess;
  readonly messages: GuestBookingMessages;
  readonly questions: GuestQuestionRepository;
}

async function withSchema(run: (context: Context) => Promise<void>): Promise<void> {
  const { Pool } = await import("pg");
  const schema = `booking_messages_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const migrations = (await readdir(new URL("../migrations/", import.meta.url))).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort();
    for (const name of migrations) await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a'),('provider-b')");
    await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES ('provider-a','owner-a','OWNER',true),('provider-a','editor-a','EDITOR',true),('provider-b','owner-b','OWNER',true)");
    await pool.query(
      `INSERT INTO experience_products
         (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
       VALUES ('provider-a','walk','sample-walk','PUBLISHED','Synthetic walk','{}','JPY',3000,'terms-v1','seller-provider-a','acct_SampleA0001','Sample Seller A'),
              ('provider-a','tea','sample-tea','PUBLISHED','Synthetic tea','{}','JPY',3000,'terms-v1','seller-provider-a','acct_SampleA0001','Sample Seller A')`,
    );
    const store = new ExperienceStore(pool);
    const guests = new GuestBookingRepository(pool);
    await guests.setProviderSaleSettings("provider-a", { supportEnabled: false });
    await guests.setSaleTerms(ownerA, "walk", {
      childPricing: { priceYen: 1500, minAge: 4, maxAge: 12, adultRequired: true }, minimumParticipants: 1, maxPartySize: 6,
      cancellationPolicy: "FREE_UNTIL_48H", bookingQuestions: [], conditionsVersion: null,
    });
    await store.saveScheduleRule(ownerA, "walk", RULE, null, randomUUID());
    await run({ pool, store, guests, access: new GuestBookingAccess(pool), messages: new GuestBookingMessages(pool), questions: new GuestQuestionRepository(pool) });
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
    publicBookingId: start.publicBookingId, connectedAccountId: "acct_SampleA0001", stripePaymentRef: `pi_sample_${events}`,
    stripeEventId: `evt_sample_${events}`, stripeEventType: "checkout.session.completed", eventOccurredAtUtc: new Date().toISOString(),
    amount: start.totalAmount, currency: "JPY",
  });
  assert.equal(paid.booking.status, "CONFIRMED");
  return start;
}

/** The guest opens their booking from a link: the session id the page's cookie would hold. */
async function session(context: Context, publicBookingId: string): Promise<string> {
  const grant = await context.access.issueBookingAccessGrant(publicBookingId);
  assert.ok(grant);
  const opened = await context.access.openBookingSession(grant.token);
  assert.ok(opened);
  return opened.sessionId;
}

async function setStatus(pool: Pool, publicBookingId: string, status: "CANCELLED" | "PAYMENT_REVIEW"): Promise<void> {
  await pool.query(
    "UPDATE bookings SET status=$2, confirmed_at=NULL, cancelled_at=CASE WHEN $2='CANCELLED' THEN clock_timestamp() END WHERE public_booking_id=$1",
    [publicBookingId, status],
  );
}

/** Moves the booking's experience `daysAgo` days into the past (the snapshot trigger is off for this test schema only). */
async function endedDaysAgo(pool: Pool, publicBookingId: string, daysAgo: number): Promise<void> {
  const end = new Date(Date.now() - daysAgo * DAY_MS).toISOString();
  const start = new Date(Date.parse(end) - 90 * 60_000).toISOString();
  await pool.query("ALTER TABLE bookings DISABLE TRIGGER bookings_protect_snapshots");
  await pool.query(
    "UPDATE bookings SET occurrence_snapshot = occurrence_snapshot || jsonb_build_object('startUtc', $2::text, 'endUtc', $3::text) WHERE public_booking_id=$1",
    [publicBookingId, start, end],
  );
  await pool.query("ALTER TABLE bookings ENABLE TRIGGER bookings_protect_snapshots");
}

const reply = (english: string, japanese: string | null = null) => ({ english, japanese, commandId: randomUUID() });

describe("PostgreSQL booking messages (#285 slice 6b)", { skip: databaseUrl === undefined }, () => {
  it("keeps one thread per booking for the guest's session: the message, its translation row and the host's push, idempotent by key", async () => {
    await withSchema(async (context) => {
      const { pool, messages } = context;
      const booking = await confirmed(context);
      const other = await confirmed(context, { guestEmail: "other@example.com", guestName: "Other Guest" });
      const sessionId = await session(context, booking.publicBookingId);
      const otherSession = await session(context, other.publicBookingId);

      assert.deepEqual(await messages.readConversation(sessionId, booking.publicBookingId), { open: true, messages: [] });
      const key = randomUUID();
      assert.deepEqual(await messages.sendMessage(sessionId, booking.publicBookingId, { message: "  Is there parking nearby?  ", clientRequestKey: key }), { status: "received", repeated: false });
      // A lost answer sent again is the same message; the same key with other words is refused.
      assert.deepEqual(await messages.sendMessage(sessionId, booking.publicBookingId, { message: "Is there parking nearby?", clientRequestKey: key }), { status: "received", repeated: true });
      await assert.rejects(() => messages.sendMessage(sessionId, booking.publicBookingId, { message: "Something else", clientRequestKey: key }), StoreConflictError);
      await messages.sendMessage(sessionId, booking.publicBookingId, { message: "We may be 5 minutes late.", clientRequestKey: randomUUID() });

      for (const bad of [{ message: "   ", clientRequestKey: randomUUID() }, { message: "x".repeat(1001), clientRequestKey: randomUUID() }, { message: "ok", clientRequestKey: "short" }, { message: "a\u0000b", clientRequestKey: randomUUID() }]) {
        await assert.rejects(() => messages.sendMessage(sessionId, booking.publicBookingId, bad), StoreValidationError);
      }

      // One thread, keeping no name, address, topic or key of its own.
      const threads = await pool.query("SELECT booking_id IS NOT NULL AS for_booking, product_id, topic, guest_name, guest_email, guest_email_key, client_request_key, guest_language, needs_reply, host_read_at FROM guest_question_threads");
      assert.deepEqual(threads.rows, [{
        for_booking: true, product_id: "walk", topic: null, guest_name: null, guest_email: null, guest_email_key: null, client_request_key: null,
        guest_language: "EN", needs_reply: true, host_read_at: null,
      }]);
      const conversation = await messages.readConversation(sessionId, booking.publicBookingId);
      assert.equal(conversation?.open, true);
      assert.deepEqual(conversation?.messages.map((message) => [message.from, message.body]), [["guest", "Is there parking nearby?"], ["guest", "We may be 5 minutes late."]]);

      // Another booking's session reads and writes nothing of this one; an unknown session is no booking.
      assert.equal(await messages.readConversation(otherSession, booking.publicBookingId), null);
      assert.equal(await messages.sendMessage(otherSession, booking.publicBookingId, { message: "hello", clientRequestKey: randomUUID() }), null);
      assert.equal(await messages.readConversation("x".repeat(43), booking.publicBookingId), null);
      assert.equal(await messages.readConversation(sessionId, "not-a-booking"), null);
      assert.deepEqual(await messages.readConversation(otherSession, other.publicBookingId), { open: true, messages: [] });

      // Each message: the translation row and the host's push, ids, the experience, its time and the party only.
      const outbox = await pool.query("SELECT topic, aggregate_type, payload FROM outbox_messages WHERE topic IN ('guest_question.received', $1) ORDER BY id", [HOST_NOTIFICATION_TOPICS.bookingMessage]);
      assert.deepEqual(outbox.rows.map((row) => row.topic), ["guest_question.received", HOST_NOTIFICATION_TOPICS.bookingMessage, "guest_question.received", HOST_NOTIFICATION_TOPICS.bookingMessage]);
      const push = parseBookingMessagePayload(outbox.rows[1]!.payload);
      assert.ok(push);
      assert.equal(push.experienceTitle, "Synthetic walk");
      assert.equal(push.seats, 3);
      const everything = JSON.stringify(outbox.rows);
      assert.ok(!/guest@example\.com|Sample Guest|parking/i.test(everything));

      // The translation step takes a booking's message as it takes a question.
      const claim = await new GuestQuestionTranslations(pool).claimTranslations({ limit: 10, leaseSeconds: 60 });
      assert.deepEqual(claim.translations.map((item) => item.text), ["Is there parking nearby?", "We may be 5 minutes late."]);
    });
  });

  it("takes 10 messages an hour per booking, then asks to wait", async () => {
    await withSchema(async (context) => {
      const booking = await confirmed(context);
      const sessionId = await session(context, booking.publicBookingId);
      for (let index = 0; index < 10; index += 1) {
        await context.messages.sendMessage(sessionId, booking.publicBookingId, { message: `Message ${index}`, clientRequestKey: randomUUID() });
      }
      const limited = await context.messages.sendMessage(sessionId, booking.publicBookingId, { message: "One more", clientRequestKey: randomUUID() }).catch((error: unknown) => error);
      assert.ok(limited instanceof StoreRateLimitedError);
      assert.ok(limited.retryAfterSeconds >= 1 && limited.retryAfterSeconds <= 3600);
      // An hour later the count starts again.
      await context.pool.query("UPDATE guest_question_messages SET created_at = created_at - interval '61 minutes'");
      assert.equal((await context.messages.sendMessage(sessionId, booking.publicBookingId, { message: "One more", clientRequestKey: randomUUID() }))?.status, "received");
    });
  });

  it("opens while confirmed or under payment review and until 30 days after the experience; a cancelled booking reads its history only", async () => {
    await withSchema(async (context) => {
      const { pool, messages, questions } = context;
      const booking = await confirmed(context);
      const sessionId = await session(context, booking.publicBookingId);
      const key = randomUUID();
      await messages.sendMessage(sessionId, booking.publicBookingId, { message: "Hello!", clientRequestKey: key });

      await setStatus(pool, booking.publicBookingId, "PAYMENT_REVIEW");
      assert.equal((await messages.sendMessage(sessionId, booking.publicBookingId, { message: "Paid twice?", clientRequestKey: randomUUID() }))?.repeated, false);

      await setStatus(pool, booking.publicBookingId, "CANCELLED");
      assert.equal((await messages.readConversation(sessionId, booking.publicBookingId))?.open, false);
      await assert.rejects(() => messages.sendMessage(sessionId, booking.publicBookingId, { message: "Still there?", clientRequestKey: randomUUID() }), BookingMessagesClosedError);
      // A retry of a message that got in before is still the same message.
      assert.deepEqual(await messages.sendMessage(sessionId, booking.publicBookingId, { message: "Hello!", clientRequestKey: key }), { status: "received", repeated: true });
      const thread = await questions.findBookingThread(ownerA, booking.publicBookingId);
      assert.equal(thread.booking.open, false);
      await assert.rejects(() => questions.reply(ownerA, thread.threadId!, reply("Sorry to see you go.")), BookingMessagesClosedError);
      await assert.rejects(() => questions.replyToBooking(ownerA, booking.publicBookingId, reply("Sorry to see you go.")), BookingMessagesClosedError);

      // A confirmed booking whose experience is over: open for 30 days, then history only.
      const later = await confirmed(context, { guestEmail: "later@example.com" });
      const laterSession = await session(context, later.publicBookingId);
      const started = await questions.replyToBooking(ownerA, later.publicBookingId, reply("Thanks for coming!"));
      await endedDaysAgo(pool, later.publicBookingId, 29);
      assert.equal((await messages.readConversation(laterSession, later.publicBookingId))?.open, true);
      await endedDaysAgo(pool, later.publicBookingId, 31);
      assert.equal((await messages.readConversation(laterSession, later.publicBookingId))?.open, false);
      await assert.rejects(() => messages.sendMessage(laterSession, later.publicBookingId, { message: "Thanks again", clientRequestKey: randomUUID() }), BookingMessagesClosedError);
      assert.equal((await questions.getThread(ownerA, started.threadId)).booking?.open, false);
      await assert.rejects(() => questions.reply(ownerA, started.threadId, reply("Come again.")), BookingMessagesClosedError);
    });
  });

  it("shows the host booking threads beside questions, starts one with the host's first message, and keeps providers apart", async () => {
    await withSchema(async (context) => {
      const { pool, messages, questions } = context;
      const booking = await confirmed(context);
      const sessionId = await session(context, booking.publicBookingId);
      await questions.submitQuestion({ productSlug: "sample-tea", topic: "FOOD", message: "Is there a vegetarian option?", guestName: "Asker", guestEmail: "asker@example.com", clientRequestKey: randomUUID() });

      // Before anyone wrote: the booking, and no thread.
      const start = await questions.findBookingThread(ownerA, booking.publicBookingId.toUpperCase());
      assert.equal(start.threadId, null);
      assert.equal(start.productTitle, "Synthetic walk");
      assert.equal(start.guestName, "Sample Guest");
      assert.equal(start.booking.publicBookingId, booking.publicBookingId);
      assert.equal(start.booking.localDate, day(2));
      assert.equal(start.booking.localStartTime, "10:00");
      assert.deepEqual([start.booking.adultCount, start.booking.childCount, start.booking.status, start.booking.open], [2, 1, "CONFIRMED", true]);

      // The host writes first: the thread starts, the message waits for the email.
      const command = reply("Welcome! See you soon.", "ようこそ。お待ちしています。");
      const first = await questions.replyToBooking(ownerA, booking.publicBookingId, command);
      assert.equal(first.message.deliveryStatus, "PENDING");
      assert.deepEqual(await questions.replyToBooking(ownerA, booking.publicBookingId, command), first);
      await assert.rejects(() => questions.replyToBooking(ownerA, booking.publicBookingId, { ...command, english: "Other words" }), StoreConflictError);
      assert.equal((await questions.findBookingThread(ownerA, booking.publicBookingId)).threadId, first.threadId);

      // The guest reads the host's English, never the Japanese; then answers.
      const seen = await messages.readConversation(sessionId, booking.publicBookingId);
      assert.deepEqual(seen?.messages.map((message) => [message.from, message.body]), [["host", "Welcome! See you soon."]]);
      assert.ok(!JSON.stringify(seen).includes("ようこそ"));
      await messages.sendMessage(sessionId, booking.publicBookingId, { message: "Thank you!", clientRequestKey: randomUUID() });

      const page = await questions.listThreads(ownerA);
      assert.equal(page.threads.length, 2);
      const listed = page.threads.find((thread) => thread.id === first.threadId);
      assert.ok(listed);
      assert.equal(listed.guestName, "Sample Guest");
      assert.equal(listed.topic, null);
      assert.equal(listed.needsReply, true);
      assert.equal(listed.read, false);
      assert.equal(listed.lastMessage.body, "Thank you!");
      assert.equal(listed.lastMessage.source, "BOOKING_PAGE");
      assert.equal(listed.booking?.publicBookingId, booking.publicBookingId);
      assert.equal(page.threads.find((thread) => thread.id !== first.threadId)?.booking, null);
      assert.ok(!JSON.stringify(page).toLowerCase().includes("guest@example.com"));
      assert.deepEqual((await questions.listThreads(ownerA, { kind: "BOOKING" })).threads.map((thread) => thread.id), [first.threadId]);
      assert.equal((await questions.listThreads(ownerA, { kind: "QUESTION" })).threads.length, 1);
      assert.equal(await questions.countThreads(ownerA, { kind: "BOOKING" }), 1);
      assert.equal(await questions.countThreads(ownerA), 2);
      await assert.rejects(() => questions.listThreads(ownerA, { kind: "OTHER" as "BOOKING" }), StoreValidationError);

      const thread = await questions.getThread(ownerA, first.threadId);
      assert.deepEqual(thread.messages.map((message) => [message.author, message.source, message.bodyJa]), [["HOST", "HOST_CONSOLE", "ようこそ。お待ちしています。"], ["GUEST", "BOOKING_PAGE", null]]);
      assert.ok(!JSON.stringify(thread).toLowerCase().includes("guest@example.com"));
      const answered = await questions.reply(ownerA, first.threadId, reply("Our pleasure."));
      assert.equal(answered.deliveryStatus, "PENDING");
      assert.equal((await questions.getThread(ownerA, first.threadId)).needsReply, false);

      // Another provider sees and writes none of it; a booking ID that is no booking of this site is not found.
      assert.deepEqual((await questions.listThreads(ownerB)).threads, []);
      assert.equal(await questions.countThreads(ownerB), 0);
      await assert.rejects(() => questions.findBookingThread(ownerB, booking.publicBookingId), StoreNotFoundError);
      await assert.rejects(() => questions.getThread(ownerB, first.threadId), StoreNotFoundError);
      await assert.rejects(() => questions.replyToBooking(ownerB, booking.publicBookingId, reply("Hi")), StoreNotFoundError);
      await assert.rejects(() => questions.findBookingThread(ownerA, randomUUID()), StoreNotFoundError);
      await assert.rejects(() => questions.findBookingThread({ providerId: "provider-a", nihoUserId: "editor-a" }, booking.publicBookingId));
      const hold = await context.guests.startGuestBooking(request());
      await assert.rejects(() => questions.findBookingThread(ownerA, hold.publicBookingId), StoreNotFoundError);
      assert.equal(Number((await pool.query("SELECT count(*) FROM guest_question_threads WHERE booking_id IS NOT NULL")).rows[0]!.count), 1);
    });
  });

  it("emails the host's messages to the booking's guest without a reply link, and fails one whose guest was erased", async () => {
    await withSchema(async (context) => {
      const { pool, questions } = context;
      const booking = await confirmed(context);
      const sent = await questions.replyToBooking(ownerA, booking.publicBookingId, reply("See you at the station.", "駅でお待ちしています。"));

      const [claimed, ...rest] = await questions.claimReplyDeliveries({ limit: 10, leaseSeconds: 60, linkTtlDays: 14 });
      assert.equal(rest.length, 0);
      assert.ok(claimed && claimed.kind === "BOOKING");
      assert.equal(claimed.messageId, sent.message.id);
      assert.equal(claimed.guestEmail, GUEST_EMAIL);
      assert.equal(claimed.guestName, "Sample Guest");
      assert.equal(claimed.english, "See you at the station.");
      assert.equal(claimed.publicBookingId, booking.publicBookingId);
      assert.equal(claimed.localDate, day(2));
      assert.equal(claimed.localStartTime, "10:00");
      assert.equal(claimed.timeZone, "Asia/Tokyo");
      assert.equal(claimed.hostDisplayName, "Sample Seller A");
      assert.ok(!("replyToken" in claimed));
      assert.equal(Number((await pool.query("SELECT count(*) FROM guest_question_reply_tokens")).rows[0]!.count), 0);
      assert.equal(await questions.recordReplyDelivery(claimed.messageId, "SENT"), "SENT");

      // The guest's record erased under a waiting message (outside eraseGuestData): nobody to send it to.
      const late = await questions.reply(ownerA, sent.threadId, reply("One more thing."));
      await pool.query(
        `UPDATE booking_guests g SET guest_name=NULL, guest_email=NULL, guest_email_key=NULL, guest_phone=NULL, note=NULL, answers=NULL, utm=NULL, pii_erased_at=clock_timestamp()
           FROM bookings b WHERE b.provider_id=g.provider_id AND b.id=g.booking_id AND b.public_booking_id=$1`,
        [booking.publicBookingId],
      );
      assert.deepEqual(await questions.claimReplyDeliveries({ limit: 10, leaseSeconds: 60, linkTtlDays: 14 }), []);
      assert.equal((await pool.query("SELECT delivery_status FROM guest_question_messages WHERE id=$1", [late.id])).rows[0]!.delivery_status, "FAILED");
    });
  });

  it("erases a booking's thread with its guest data, not a year after its last message", async () => {
    await withSchema(async (context) => {
      const { pool, guests, messages, questions } = context;
      const booking = await confirmed(context);
      const kept = await confirmed(context, { guestEmail: "kept@example.com" });
      const sessionId = await session(context, booking.publicBookingId);
      const keptSession = await session(context, kept.publicBookingId);
      await messages.sendMessage(sessionId, booking.publicBookingId, { message: "Hello", clientRequestKey: randomUUID() });
      await messages.sendMessage(keptSession, kept.publicBookingId, { message: "Hi", clientRequestKey: randomUUID() });
      await questions.replyToBooking(ownerA, booking.publicBookingId, reply("Hello back"));

      // Old messages: a booking's thread is not a question.
      await pool.query("UPDATE guest_question_threads SET last_message_at = clock_timestamp() - interval '2 years'");
      assert.equal(await questions.eraseInactiveThreads({ lastMessageBefore: new Date(Date.now() - 365 * DAY_MS).toISOString() }), 0);

      await endedDaysAgo(pool, booking.publicBookingId, 400);
      assert.equal(await guests.eraseGuestData({ endedBefore: new Date(Date.now() - 365 * DAY_MS).toISOString() }), 1);
      const left = await pool.query(
        `SELECT b.public_booking_id::text AS booking, count(m.id)::int AS messages FROM guest_question_threads t
           JOIN bookings b ON b.provider_id = t.provider_id AND b.id = t.booking_id
           JOIN guest_question_messages m ON m.provider_id = t.provider_id AND m.thread_id = t.id
          GROUP BY b.public_booking_id`,
      );
      assert.deepEqual(left.rows, [{ booking: kept.publicBookingId, messages: 1 }]);
      await assert.rejects(() => questions.findBookingThread(ownerA, booking.publicBookingId), StoreNotFoundError);
    });
  });
});
