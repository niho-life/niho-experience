import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { StoreAccessDeniedError, StoreConflictError, StoreNotFoundError, StoreRateLimitedError, StoreValidationError } from "../src/errors.ts";
import { ExperiencePublicationRepository } from "../src/experience-publication.ts";
import { GuestQuestionRepository, PERSON_THREAD_LABEL, type ClaimedQuestionReply, type SubmitPersonMessageInput } from "../src/guest-questions.ts";
import { PeopleListingRepository } from "../src/people-listings.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const ADMIN = { nihoUserId: "adm_synthetic_person_messages" } as const;
const CONSENT = "provider-public-profile-v1";

/**
 * A listed person with a photo. `owner` gives the provider a current OWNER account that is the person; without it the listing is
 * a draft (no member). A provider can have several people: pass `providerId` to add one to a provider that exists.
 */
async function listedPerson(pool: Pool, name: string, slug: string, owner: boolean, existing?: { providerId: string }): Promise<{ providerId: string; actor: { providerId: string; nihoUserId: string } }> {
  const publications = new ExperiencePublicationRepository(pool);
  let providerId = existing?.providerId;
  if (!providerId) {
    const provider = await publications.createAdminProvider(ADMIN, { publicDisplayName: `${name} 事業`, providerKind: "BUSINESS", consentVersion: CONSENT });
    providerId = provider.providerId;
    const assetId = randomUUID();
    await publications.addProviderMediaAsAdmin(ADMIN, providerId, 1, CONSENT, {
      id: assetId, objectKey: `experience-provider-media/${assetId}.jpg`, sourceRefHash: "b".repeat(64), width: 800, height: 800, byteSize: 4096,
      placement: "PROVIDER_PHOTO", altText: `${name} photo`, altTextJa: `${name}の写真`, publicCredit: null,
    });
  }
  const nihoUserId = `owner-${slug}`;
  if (owner) await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES ($1,$2,$3,true)", [providerId, nihoUserId, existing ? "COHOST" : "OWNER"]);
  await new PeopleListingRepository(pool).adminSave(ADMIN.nihoUserId, null, null, { providerId, memberId: owner ? nihoUserId : null }, { slug, nameJa: name, roleJa: "合成の職人", areaJa: "合成の町", quoteJa: null, introJa: null, sortOrder: 100 });
  return { providerId, actor: { providerId, nihoUserId } };
}

function message(overrides: Partial<SubmitPersonMessageInput> = {}): SubmitPersonMessageInput {
  return { personSlug: "takuya", message: "はじめまして。今度お話を聞かせてください。", guestName: "山田 花子", guestEmail: "hanako@example.com", clientRequestKey: randomUUID(), ...overrides };
}

describe("PostgreSQL messages to a person (#589)", { skip: databaseUrl === undefined }, () => {
  it("takes a message only for a person who is shown, once per request key, within the hourly limits, and keeps it from other providers", async () => {
    const db = await createIsolatedDatabase(databaseUrl, "person_messages", { max: 4 });
    try {
      const pool = db.pool;
      const questions = new GuestQuestionRepository(pool);
      const takuya = await listedPerson(pool, "高浜 拓也", "takuya", true);
      await listedPerson(pool, "志龍", "shiryu", false);
      const other = await listedPerson(pool, "Synthetic Other", "other-person", true);

      // A person without an account (a draft), one who is not listed, and a slug that is not one are all "not found" (no hint which).
      for (const personSlug of ["shiryu", "nobody", "Not A Slug!"]) {
        await assert.rejects(() => questions.submitPersonMessage(message({ personSlug })), StoreNotFoundError);
      }

      const key = randomUUID();
      assert.deepEqual(await questions.submitPersonMessage(message({ clientRequestKey: key, guestName: "  山田 \n 花子 ", guestEmail: " Hanako@Example.com " })), { status: "received" });
      assert.deepEqual(await questions.submitPersonMessage(message({ clientRequestKey: key, message: "同じ送信をもう一度（言葉は違う）" })), { status: "received" });
      const stored = await pool.query("SELECT provider_id, product_id, booking_id, topic, guest_name, guest_email, guest_email_key, guest_language, needs_reply, host_read_at, person_name, person_listing_id IS NOT NULL AS addressed FROM guest_question_threads");
      assert.deepEqual(stored.rows, [{
        provider_id: takuya.providerId, product_id: null, booking_id: null, topic: null, guest_name: "山田 花子", guest_email: "Hanako@Example.com",
        guest_email_key: "hanako@example.com", guest_language: "JA", needs_reply: true, host_read_at: null, person_name: "高浜 拓也", addressed: true,
      }]);
      const messages = await pool.query("SELECT author, source, body, body_ja, delivery_status FROM guest_question_messages");
      assert.deepEqual(messages.rows, [{ author: "GUEST", source: "SITE_FORM", body: "はじめまして。今度お話を聞かせてください。", body_ja: null, delivery_status: null }]);

      // The translation's row and the host's push, each once; the push carries the person's label where a question carries its experience.
      const threadId = String((await pool.query("SELECT id FROM guest_question_threads")).rows[0].id);
      const messageId = String((await pool.query("SELECT id FROM guest_question_messages")).rows[0].id);
      const outbox = await pool.query("SELECT topic, provider_id, aggregate_id, payload FROM outbox_messages WHERE aggregate_type = 'guest_question_thread' ORDER BY id");
      assert.deepEqual(outbox.rows, [
        { topic: "guest_question.received", provider_id: takuya.providerId, aggregate_id: threadId, payload: { threadId, messageId } },
        { topic: "host.notify.guest_question", provider_id: takuya.providerId, aggregate_id: threadId, payload: { v: 1, threadId, messageId, experienceTitle: PERSON_THREAD_LABEL, personName: "高浜 拓也", toMemberId: "owner-takuya" } },
      ]);
      assert.doesNotMatch(JSON.stringify(outbox.rows), /example\.com|山田|お話/);

      // Out-of-bounds input never reaches the tables.
      for (const bad of [{ message: "あ" }, { message: "あ".repeat(1001) }, { guestName: "   " }, { guestEmail: "not-an-address" }, { clientRequestKey: "short" }, { language: "FR" as never }, { personSlug: "" }]) {
        await assert.rejects(() => questions.submitPersonMessage(message(bad)), StoreValidationError);
      }

      // Only the person's own provider reads it: the OWNER of another provider sees nothing of it.
      const mine = await questions.listThreads(takuya.actor);
      assert.equal(mine.threads.length, 1);
      assert.equal(mine.threads[0]!.productId, null);
      assert.equal(mine.threads[0]!.productTitle, null);
      assert.equal(mine.threads[0]!.personName, "高浜 拓也");
      assert.equal(mine.threads[0]!.guestName, "山田 花子");
      assert.equal(mine.threads[0]!.language, "JA");
      assert.deepEqual((await questions.listThreads(other.actor)).threads, []);
      await assert.rejects(() => questions.getThread(other.actor, threadId), StoreNotFoundError);
      await assert.rejects(() => questions.reply({ providerId: takuya.providerId, nihoUserId: "someone-else" }, threadId, { english: "x", japanese: null, commandId: randomUUID() }), StoreAccessDeniedError);
      assert.equal(JSON.stringify(mine).includes("example.com"), false);

      // Three new messages per guest address and person an hour; another person counts on their own.
      await questions.submitPersonMessage(message({ guestEmail: "hanako@example.com" }));
      await questions.submitPersonMessage(message({ guestEmail: "HANAKO@example.com" }));
      const limited = await questions.submitPersonMessage(message()).then(() => null, (error: unknown) => error);
      assert.ok(limited instanceof StoreRateLimitedError);
      assert.ok(limited.retryAfterSeconds >= 1 && limited.retryAfterSeconds <= 3600);
      assert.deepEqual(await questions.submitPersonMessage(message({ clientRequestKey: key })), { status: "received" });
      assert.deepEqual(await questions.submitPersonMessage(message({ personSlug: "other-person" })), { status: "received" });

      // Thirty new threads per person an hour, whoever writes.
      for (let index = 0; index < 27; index += 1) await questions.submitPersonMessage(message({ guestEmail: `guest-${index}@example.com` }));
      await assert.rejects(() => questions.submitPersonMessage(message({ guestEmail: "guest-late@example.com" })), StoreRateLimitedError);

      // The person leaving 街の人 (no longer an OWNER or co-host) closes the door at once.
      await pool.query("UPDATE provider_memberships SET active=false WHERE provider_id=$1", [takuya.providerId]);
      await assert.rejects(() => questions.submitPersonMessage(message({ guestEmail: "after@example.com" })), StoreNotFoundError);
    } finally {
      await db.dispose();
    }
  });

  it("is answered like a question: the reply goes by email with a link, the guest answers on the reply page in Japanese, and the thread is erased after a year", async () => {
    const db = await createIsolatedDatabase(databaseUrl, "person_messages_reply", { max: 4 });
    try {
      const pool = db.pool;
      const questions = new GuestQuestionRepository(pool);
      const takuya = await listedPerson(pool, "高浜 拓也", "takuya", true);
      await questions.submitPersonMessage(message());
      const threadId = String((await pool.query("SELECT id FROM guest_question_threads")).rows[0].id);

      const reply = await questions.reply(takuya.actor, threadId, { english: "Thank you for writing. Let's talk.", japanese: "ご連絡ありがとうございます。お話ししましょう。", commandId: randomUUID() });
      assert.equal(reply.author, "HOST");
      assert.equal((await questions.getThread(takuya.actor, threadId)).needsReply, false);

      const [claimed] = await questions.claimReplyDeliveries({ limit: 1, leaseSeconds: 120, linkTtlDays: 14 });
      assert.ok(claimed && claimed.kind === "QUESTION");
      const delivery = claimed as ClaimedQuestionReply;
      assert.equal(delivery.guestEmail, "hanako@example.com");
      assert.equal(delivery.guestLanguage, "JA");
      assert.equal(delivery.experienceTitle, null);
      assert.equal(delivery.hostDisplayName, "高浜 拓也");
      assert.equal(delivery.japanese, "ご連絡ありがとうございます。お話ししましょう。");
      assert.equal(await questions.recordReplyDelivery(delivery.messageId, "SENT"), "SENT");

      // The reply page: a Japanese guest reads the host's Japanese, about no experience.
      const link = await questions.openReplyLink(delivery.replyToken);
      assert.ok(link);
      assert.equal(link.experienceTitle, null);
      assert.equal(link.hostDisplayName, "高浜 拓也");
      assert.equal(link.language, "JA");
      assert.deepEqual(link.messages.map((item) => [item.from, item.body]), [["guest", "はじめまして。今度お話を聞かせてください。"], ["host", "ご連絡ありがとうございます。お話ししましょう。"]]);

      // Their answer brings the thread back to "waiting for a reply", unread, and tells the host with the person's label.
      assert.deepEqual(await questions.submitGuestReply(delivery.replyToken, { message: "来週はいかがでしょう。", clientRequestKey: randomUUID() }), { status: "received" });
      const after = await questions.getThread(takuya.actor, threadId);
      assert.equal(after.needsReply, true);
      assert.equal(after.read, false);
      assert.equal(after.messages.length, 3);
      const pushes = await pool.query("SELECT payload FROM outbox_messages WHERE topic = 'host.notify.guest_question' ORDER BY id");
      assert.deepEqual(pushes.rows.map((row) => row.payload.experienceTitle), [PERSON_THREAD_LABEL, PERSON_THREAD_LABEL]);

      // A year after the last message the thread goes with its messages and links.
      await pool.query("UPDATE guest_question_threads SET last_message_at = clock_timestamp() - interval '400 days'");
      assert.equal(await questions.eraseInactiveThreads({ lastMessageBefore: new Date(Date.now() - 365 * 86_400_000).toISOString() }), 1);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM guest_question_messages")).rows[0].n, 0);
    } finally {
      await db.dispose();
    }
  });
  it("lands in the provider's inbox addressed to the person, which the OWNER and the co-hosts read and answer (an editor does not)", async () => {
    const db = await createIsolatedDatabase(databaseUrl, "person_messages_inbox", { max: 4 });
    try {
      const pool = db.pool;
      const questions = new GuestQuestionRepository(pool);
      // One provider (NIHO kamakura), two people: its OWNER and a co-host, each with their own page.
      const takuya = await listedPerson(pool, "高浜 拓也", "takuya", true);
      const staff = await listedPerson(pool, "スタッフ 花", "staff-hana", true, { providerId: takuya.providerId });
      await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES ($1,'editor-user','EDITOR',true)", [takuya.providerId]);
      const editor = { providerId: takuya.providerId, nihoUserId: "editor-user" };

      await questions.submitPersonMessage(message({ personSlug: "takuya", guestName: "山田 花子" }));
      await questions.submitPersonMessage(message({ personSlug: "staff-hana", guestName: "鈴木 太郎", guestEmail: "taro@example.com" }));

      // Both land in the one provider's inbox, each addressed to the person it was sent to.
      const inbox = await questions.listThreads(takuya.actor);
      assert.deepEqual(inbox.threads.map((thread) => [thread.guestName, thread.personName]).sort(), [["山田 花子", "高浜 拓也"], ["鈴木 太郎", "スタッフ 花"]]);
      // The co-host reads the same inbox (the OWNER's thread too), opens it, and answers it.
      const asCohost = await questions.listThreads(staff.actor);
      assert.equal(asCohost.threads.length, 2);
      const toTakuya = inbox.threads.find((thread) => thread.personName === "高浜 拓也")!;
      const opened = await questions.getThread(staff.actor, toTakuya.id);
      assert.equal(opened.personName, "高浜 拓也");
      await questions.markThreadRead(staff.actor, toTakuya.id);
      const reply = await questions.reply(staff.actor, toTakuya.id, { english: "Thank you. We will be glad to meet you.", japanese: "ありがとうございます。お会いできるのを楽しみにしています。", commandId: randomUUID() });
      assert.equal(reply.author, "HOST");
      assert.equal((await questions.getThread(takuya.actor, toTakuya.id)).needsReply, false);

      // An editor reads and answers nothing of it.
      await assert.rejects(() => questions.listThreads(editor), StoreAccessDeniedError);
      await assert.rejects(() => questions.getThread(editor, toTakuya.id), StoreAccessDeniedError);
      await assert.rejects(() => questions.reply(editor, toTakuya.id, { english: "x", japanese: null, commandId: randomUUID() }), StoreAccessDeniedError);

      // The limits are each person's own: 30 to one person an hour (the first above and 29 more) leaves the other's door open.
      for (let index = 0; index < 29; index += 1) await questions.submitPersonMessage(message({ personSlug: "takuya", guestEmail: `many-${index}@example.com` }));
      await assert.rejects(() => questions.submitPersonMessage(message({ personSlug: "takuya", guestEmail: "late@example.com" })), StoreRateLimitedError);
      assert.deepEqual(await questions.submitPersonMessage(message({ personSlug: "staff-hana", guestEmail: "ok@example.com" })), { status: "received" });

      // A person withdrawn from 街の人 keeps the messages already sent, still addressed by the name they were sent to.
      await pool.query("DELETE FROM experience_people_listings WHERE slug='staff-hana'");
      const after = await questions.listThreads(takuya.actor);
      assert.ok(after.threads.some((thread) => thread.personName === "スタッフ 花"));
    } finally {
      await db.dispose();
    }
  });
  it("notifies the addressed person and the OWNERs only, by email and push, and names the person (#608)", async () => {
    const db = await createIsolatedDatabase(databaseUrl, "person_messages_notify", { max: 4 });
    try {
      const pool = db.pool;
      const questions = new GuestQuestionRepository(pool);
      const takuya = await listedPerson(pool, "高浜 拓也", "takuya", true);
      const hana = await listedPerson(pool, "スタッフ 花", "staff-hana", true, { providerId: takuya.providerId });
      await listedPerson(pool, "スタッフ 次郎", "staff-jiro", true, { providerId: takuya.providerId });
      // Everyone has an address here; the OWNER and two co-hosts.
      for (const user of ["owner-takuya", "owner-staff-hana", "owner-staff-jiro"]) {
        await pool.query("INSERT INTO host_notification_addresses (niho_user_id, override_email, override_confirmed_at) VALUES ($1, $2, clock_timestamp())", [user, `${user}@example.com`]);
      }
      const recipients = async () => (await pool.query("SELECT payload->>'to' AS recipient FROM outbox_messages WHERE topic = 'host.mail.guest_question' ORDER BY 1")).rows.map((row) => row.recipient);

      // A message to a co-host: the co-host and the OWNER get the email; the other co-host does not.
      await questions.submitPersonMessage(message({ personSlug: "staff-hana" }));
      assert.deepEqual(await recipients(), ["owner-staff-hana", "owner-takuya"]);
      const rows = await pool.query("SELECT topic, payload FROM outbox_messages WHERE topic IN ('host.notify.guest_question', 'host.mail.guest_question') ORDER BY id");
      for (const row of rows.rows) {
        assert.equal(row.payload.personName, "スタッフ 花");
        assert.equal(row.payload.toMemberId, "owner-staff-hana");
      }
      assert.equal(rows.rows.filter((row) => row.topic === "host.notify.guest_question").length, 1);

      // A message to the OWNER: one email, not two.
      await pool.query("DELETE FROM outbox_messages WHERE topic LIKE 'host.%'");
      await questions.submitPersonMessage(message({ personSlug: "takuya", guestEmail: "other@example.com" }));
      assert.deepEqual(await recipients(), ["owner-takuya"]);

      // The guest's answer on the reply page is addressed the same way; a withdrawn listing falls back to the OWNERs.
      await pool.query("DELETE FROM outbox_messages WHERE topic LIKE 'host.%'");
      const threadId = String((await pool.query("SELECT id FROM guest_question_threads WHERE person_name = 'スタッフ 花'")).rows[0].id);
      await questions.reply(hana.actor, threadId, { english: null, japanese: "ありがとうございます。", commandId: randomUUID() });
      const [claimed] = await questions.claimReplyDeliveries({ limit: 1, leaseSeconds: 120, linkTtlDays: 14 });
      await questions.submitGuestReply((claimed as ClaimedQuestionReply).replyToken, { message: "来週はいかがでしょう。", clientRequestKey: randomUUID() });
      assert.deepEqual(await recipients(), ["owner-staff-hana", "owner-takuya"]);
      await pool.query("DELETE FROM outbox_messages WHERE topic LIKE 'host.%'");
      await pool.query("DELETE FROM experience_people_listings WHERE slug = 'staff-hana'");
      await questions.reply(hana.actor, threadId, { english: null, japanese: "では来週にしましょう。", commandId: randomUUID() });
      const [again] = await questions.claimReplyDeliveries({ limit: 1, leaseSeconds: 120, linkTtlDays: 14 });
      await pool.query("DELETE FROM outbox_messages WHERE topic LIKE 'host.%'");
      await questions.submitGuestReply((again as ClaimedQuestionReply).replyToken, { message: "ありがとうございます。", clientRequestKey: randomUUID() });
      assert.deepEqual(await recipients(), ["owner-takuya"]);
    } finally {
      await db.dispose();
    }
  });

  it("answers a guest who writes Japanese in Japanese alone, and still needs the English for a guest who writes English (#608)", async () => {
    const db = await createIsolatedDatabase(databaseUrl, "person_messages_japanese_reply", { max: 4 });
    try {
      const pool = db.pool;
      const questions = new GuestQuestionRepository(pool);
      const takuya = await listedPerson(pool, "高浜 拓也", "takuya", true);
      await questions.submitPersonMessage(message());
      const threadId = String((await pool.query("SELECT id FROM guest_question_threads")).rows[0].id);

      // Nothing at all is refused; so is a blank English.
      await assert.rejects(() => questions.reply(takuya.actor, threadId, { english: null, japanese: null, commandId: randomUUID() }), StoreValidationError);
      await assert.rejects(() => questions.reply(takuya.actor, threadId, { english: "  ", japanese: "  ", commandId: randomUUID() }), StoreValidationError);

      // Japanese alone: kept as the message, sent as the Japanese, and the same command is the same reply.
      const commandId = randomUUID();
      const sent = await questions.reply(takuya.actor, threadId, { english: null, japanese: "ご連絡ありがとうございます。", commandId });
      assert.equal(sent.body, "ご連絡ありがとうございます。");
      assert.equal(sent.bodyJa, "ご連絡ありがとうございます。");
      assert.equal((await questions.reply(takuya.actor, threadId, { english: null, japanese: "ご連絡ありがとうございます。", commandId })).id, sent.id);
      await assert.rejects(() => questions.reply(takuya.actor, threadId, { english: null, japanese: "別の返信", commandId }), StoreConflictError);
      const [claimed] = await questions.claimReplyDeliveries({ limit: 1, leaseSeconds: 120, linkTtlDays: 14 });
      assert.equal((claimed as ClaimedQuestionReply).japanese, "ご連絡ありがとうございます。");

      // A guest who writes English still needs the English (here a question about an experience, in English).
      await pool.query("UPDATE guest_question_threads SET guest_language = 'EN'");
      await assert.rejects(() => questions.reply(takuya.actor, threadId, { english: null, japanese: "日本語だけ", commandId: randomUUID() }), StoreValidationError);
      assert.equal((await questions.reply(takuya.actor, threadId, { english: "Thank you.", japanese: "ありがとう", commandId: randomUUID() })).body, "Thank you.");
    } finally {
      await db.dispose();
    }
  });
});
