import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { StoreAccessDeniedError, StoreNotFoundError, StoreRateLimitedError, StoreValidationError } from "../src/errors.ts";
import { ExperiencePublicationRepository } from "../src/experience-publication.ts";
import { GuestQuestionRepository, PERSON_THREAD_LABEL, type ClaimedQuestionReply, type SubmitPersonMessageInput } from "../src/guest-questions.ts";
import { PeopleListingRepository } from "../src/people-listings.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const ADMIN = { nihoUserId: "adm_synthetic_person_messages" } as const;
const CONSENT = "provider-public-profile-v1";

/** A listed person with a photo; `owner` gives the provider a current OWNER account. */
async function listedPerson(pool: Pool, name: string, slug: string, owner: boolean): Promise<{ providerId: string; actor: { providerId: string; nihoUserId: string } }> {
  const publications = new ExperiencePublicationRepository(pool);
  const provider = await publications.createAdminProvider(ADMIN, { publicDisplayName: name, providerKind: "PERSON", consentVersion: CONSENT });
  const assetId = randomUUID();
  await publications.addProviderMediaAsAdmin(ADMIN, provider.providerId, 1, CONSENT, {
    id: assetId, objectKey: `experience-provider-media/${assetId}.jpg`, sourceRefHash: "b".repeat(64), width: 800, height: 800, byteSize: 4096,
    placement: "PROVIDER_PHOTO", altText: `${name} photo`, altTextJa: `${name}の写真`, publicCredit: null,
  });
  await new PeopleListingRepository(pool).adminSave(ADMIN.nihoUserId, provider.providerId, null, { slug, roleJa: "合成の職人", areaJa: "合成の町", quoteJa: null, introJa: null, sortOrder: 100 });
  const nihoUserId = `owner-${slug}`;
  if (owner) await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES ($1,$2,'OWNER',true)", [provider.providerId, nihoUserId]);
  return { providerId: provider.providerId, actor: { providerId: provider.providerId, nihoUserId } };
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
      const shiryu = await listedPerson(pool, "志龍", "shiryu", false);
      const other = await listedPerson(pool, "Synthetic Other", "other-person", true);

      // A person nobody can answer, one who is not listed, and a slug that is not one are all "not found" (no hint which).
      for (const personSlug of ["shiryu", "nobody", "Not A Slug!"]) {
        await assert.rejects(() => questions.submitPersonMessage(message({ personSlug })), StoreNotFoundError);
      }

      const key = randomUUID();
      assert.deepEqual(await questions.submitPersonMessage(message({ clientRequestKey: key, guestName: "  山田 \n 花子 ", guestEmail: " Hanako@Example.com " })), { status: "received" });
      assert.deepEqual(await questions.submitPersonMessage(message({ clientRequestKey: key, message: "同じ送信をもう一度（言葉は違う）" })), { status: "received" });
      const stored = await pool.query("SELECT provider_id, product_id, booking_id, topic, guest_name, guest_email, guest_email_key, guest_language, needs_reply, host_read_at FROM guest_question_threads");
      assert.deepEqual(stored.rows, [{
        provider_id: takuya.providerId, product_id: null, booking_id: null, topic: null, guest_name: "山田 花子", guest_email: "Hanako@Example.com",
        guest_email_key: "hanako@example.com", guest_language: "JA", needs_reply: true, host_read_at: null,
      }]);
      const messages = await pool.query("SELECT author, source, body, body_ja, delivery_status FROM guest_question_messages");
      assert.deepEqual(messages.rows, [{ author: "GUEST", source: "SITE_FORM", body: "はじめまして。今度お話を聞かせてください。", body_ja: null, delivery_status: null }]);

      // The translation's row and the host's push, each once; the push carries the person's label where a question carries its experience.
      const threadId = String((await pool.query("SELECT id FROM guest_question_threads")).rows[0].id);
      const messageId = String((await pool.query("SELECT id FROM guest_question_messages")).rows[0].id);
      const outbox = await pool.query("SELECT topic, provider_id, aggregate_id, payload FROM outbox_messages WHERE aggregate_type = 'guest_question_thread' ORDER BY id");
      assert.deepEqual(outbox.rows, [
        { topic: "guest_question.received", provider_id: takuya.providerId, aggregate_id: threadId, payload: { threadId, messageId } },
        { topic: "host.notify.guest_question", provider_id: takuya.providerId, aggregate_id: threadId, payload: { v: 1, threadId, messageId, experienceTitle: PERSON_THREAD_LABEL } },
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

      // The person leaving 街の人 (no OWNER account any more) closes the door at once.
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
});
