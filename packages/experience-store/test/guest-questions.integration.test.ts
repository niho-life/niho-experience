import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { StoreAccessDeniedError, StoreConflictError, StoreNotFoundError, StoreRateLimitedError, StoreValidationError } from "../src/errors.ts";
import { GuestQuestionRepository, type SubmitGuestQuestionInput } from "../src/guest-questions.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const ownerA = { providerId: "provider-a", nihoUserId: "owner-a" } as const;
const ownerB = { providerId: "provider-b", nihoUserId: "owner-b" } as const;

/** A fresh schema with every migration and synthetic providers, members and experiences. */
async function withSchema(run: (pool: Pool, repository: GuestQuestionRepository) => Promise<void>): Promise<void> {
  const { Pool } = await import("pg");
  const schema = `guest_questions_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const migrations = (await readdir(new URL("../migrations/", import.meta.url))).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort();
    for (const name of migrations) await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a'),('provider-b')");
    await pool.query(
      `INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES
         ('provider-a','owner-a','OWNER',true),('provider-a','editor-a','EDITOR',true),
         ('provider-a','former-a','OWNER',false),('provider-b','owner-b','OWNER',true)`,
    );
    await pool.query(
      `INSERT INTO experience_products
         (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
       VALUES ('provider-a','tea','sample-tea','PUBLISHED','Synthetic tea','{}','JPY',1000,'terms','seller','acct_synthetic','Sample Seller A'),
              ('provider-a','draft','sample-draft','DRAFT','Synthetic draft','{}','JPY',1000,'terms','seller','acct_synthetic','Sample Seller A'),
              ('provider-a','dup','sample-dup','PUBLISHED','Synthetic dup A','{}','JPY',1000,'terms','seller','acct_synthetic','Sample Seller A'),
              ('provider-b','walk','sample-walk','PUBLISHED','Synthetic walk','{}','JPY',2000,'terms','seller','acct_other','Sample Seller B'),
              ('provider-b','dup','sample-dup','PUBLISHED','Synthetic dup B','{}','JPY',2000,'terms','seller','acct_other','Sample Seller B')`,
    );
    await run(pool, new GuestQuestionRepository(pool));
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
}

function question(overrides: Partial<SubmitGuestQuestionInput> = {}): SubmitGuestQuestionInput {
  return {
    productSlug: "sample-tea",
    topic: "FOOD",
    message: "Is there a vegetarian option?",
    guestName: "Sample Guest",
    guestEmail: "guest@example.com",
    clientRequestKey: randomUUID(),
    ...overrides,
  };
}

async function threadIdFor(pool: Pool, productId: string, guestEmail: string): Promise<string> {
  const result = await pool.query<{ id: string }>("SELECT id FROM guest_question_threads WHERE product_id = $1 AND guest_email = $2 ORDER BY created_at DESC LIMIT 1", [productId, guestEmail]);
  assert.ok(result.rows[0]);
  return result.rows[0].id;
}

/**
 * Every outbox event names ids only: never a name, an address or what anyone wrote. The host's push adds the
 * experience's title for the lock screen.
 */
async function assertOutboxCarriesIdsOnly(pool: Pool): Promise<void> {
  const outbox = await pool.query<{ topic: string; payload: Record<string, unknown> }>("SELECT topic, payload FROM outbox_messages WHERE aggregate_type = 'guest_question_thread'");
  assert.ok(outbox.rows.length > 0);
  for (const row of outbox.rows) {
    const keys = row.topic === "host.notify.guest_question" ? ["experienceTitle", "messageId", "threadId", "v"] : ["messageId", "threadId"];
    assert.deepEqual(Object.keys(row.payload).sort(), keys);
  }
  assert.doesNotMatch(JSON.stringify(outbox.rows), /example\.com|Sample Guest|vegetarian|Sample Answer/i);
}

describe("PostgreSQL guest questions (#105 #106)", { skip: databaseUrl === undefined }, () => {
  it("takes questions only for one published experience, once per request key, within the hourly limits", async () => {
    await withSchema(async (pool, questions) => {
      assert.equal(await questions.questionsOpen("sample-tea"), true);
      assert.equal(await questions.questionsOpen("sample-draft"), false);
      assert.equal(await questions.questionsOpen("sample-missing"), false);
      // The same slug published by two providers answers neither.
      assert.equal(await questions.questionsOpen("sample-dup"), false);
      for (const productSlug of ["sample-draft", "sample-missing", "sample-dup"]) {
        await assert.rejects(() => questions.submitQuestion(question({ productSlug })), StoreNotFoundError);
      }

      const key = randomUUID();
      assert.deepEqual(await questions.submitQuestion(question({ clientRequestKey: key, guestName: "  Sample \n Guest ", guestEmail: " Guest@Example.com " })), { status: "received" });
      assert.deepEqual(await questions.submitQuestion(question({ clientRequestKey: key, message: "A retry with other words" })), { status: "received" });
      const stored = await pool.query("SELECT guest_name, guest_email, guest_email_key, guest_language, needs_reply, host_read_at FROM guest_question_threads");
      assert.deepEqual(stored.rows, [{ guest_name: "Sample Guest", guest_email: "Guest@Example.com", guest_email_key: "guest@example.com", guest_language: "EN", needs_reply: true, host_read_at: null }]);
      const messages = await pool.query("SELECT author, source, body, body_ja, delivery_status FROM guest_question_messages");
      assert.deepEqual(messages.rows, [{ author: "GUEST", source: "SITE_FORM", body: "Is there a vegetarian option?", body_ja: null, delivery_status: null }]);
      // The translation's row and the host's push (GUEST_MESSAGE), each once.
      const outbox = await pool.query("SELECT topic, provider_id, aggregate_id, deduplication_key, payload, processed_at FROM outbox_messages ORDER BY id");
      const threadId = await threadIdFor(pool, "tea", "Guest@Example.com");
      const messageId = String((await pool.query("SELECT id FROM guest_question_messages")).rows[0].id);
      assert.deepEqual(outbox.rows, [
        { topic: "guest_question.received", provider_id: "provider-a", aggregate_id: threadId, deduplication_key: `guest_question.received:${messageId}`, payload: { threadId, messageId }, processed_at: null },
        {
          topic: "host.notify.guest_question", provider_id: "provider-a", aggregate_id: threadId, deduplication_key: `host-push:guest-question:${messageId}`,
          payload: { v: 1, threadId, messageId, experienceTitle: "Synthetic tea" }, processed_at: null,
        },
      ]);
      await assertOutboxCarriesIdsOnly(pool);

      // Nothing out of bounds reaches the tables.
      for (const bad of [
        { topic: "PRICE" as never },
        { message: "Hi?" },
        { message: "x".repeat(1001) },
        { guestName: "   " },
        { guestEmail: "not-an-address" },
        { guestEmail: "guest@example.com\u0007" },
        { clientRequestKey: "short" },
        { language: "FR" as never },
      ]) {
        await assert.rejects(() => questions.submitQuestion(question(bad)), StoreValidationError);
      }

      // Three new questions per guest address and experience an hour.
      await questions.submitQuestion(question({ guestEmail: "guest@example.com" }));
      await questions.submitQuestion(question({ guestEmail: "GUEST@example.com" }));
      const limited = await questions.submitQuestion(question()).then(() => null, (error: unknown) => error);
      assert.ok(limited instanceof StoreRateLimitedError);
      assert.ok(limited.retryAfterSeconds >= 1 && limited.retryAfterSeconds <= 3600);
      // A retry of a question already taken is still taken.
      assert.deepEqual(await questions.submitQuestion(question({ clientRequestKey: key })), { status: "received" });
      // Another experience counts on its own.
      assert.deepEqual(await questions.submitQuestion(question({ productSlug: "sample-walk" })), { status: "received" });

      // Thirty new questions per experience an hour, whoever asks.
      for (let index = 0; index < 27; index += 1) await questions.submitQuestion(question({ guestEmail: `guest-${index}@example.com` }));
      await assert.rejects(() => questions.submitQuestion(question({ guestEmail: "guest-late@example.com" })), StoreRateLimitedError);
      // An hour later both limits have room again.
      await pool.query("UPDATE guest_question_threads SET created_at = created_at - interval '61 minutes', last_message_at = last_message_at - interval '61 minutes'");
      assert.deepEqual(await questions.submitQuestion(question()), { status: "received" });
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM guest_question_threads WHERE product_id = 'tea'")).rows[0].n, 31);
    });
  });

  it("lets only the OWNER read and answer the provider's questions, never with the guest's address", async () => {
    await withSchema(async (pool, questions) => {
      await questions.submitQuestion(question());
      await questions.submitQuestion(question({ productSlug: "sample-walk", guestEmail: "walker@example.com" }));
      const threadA = await threadIdFor(pool, "tea", "guest@example.com");
      const threadB = await threadIdFor(pool, "walk", "walker@example.com");

      const page = await questions.listThreads(ownerA);
      assert.equal(page.nextCursor, null);
      assert.equal(page.threads.length, 1);
      const [summary] = page.threads;
      assert.equal(summary?.id, threadA);
      assert.equal(summary?.productTitle, "Synthetic tea");
      assert.equal(summary?.guestName, "Sample Guest");
      assert.equal(summary?.topic, "FOOD");
      assert.equal(summary?.needsReply, true);
      assert.equal(summary?.read, false);
      assert.equal(summary?.lastMessage.body, "Is there a vegetarian option?");
      assert.doesNotMatch(JSON.stringify(page), /example\.com/);

      // Not the OWNER, an inactive OWNER, another provider's OWNER, NIHO capping the role, a product operator.
      for (const actor of [
        { providerId: "provider-a", nihoUserId: "editor-a" },
        { providerId: "provider-a", nihoUserId: "former-a" },
        { providerId: "provider-a", nihoUserId: "owner-b" },
        { ...ownerA, calendarRoleCeiling: "EDITOR" as const },
        { ...ownerA, calendarScope: "OPERATOR" as const },
      ]) {
        await assert.rejects(() => questions.listThreads(actor), StoreAccessDeniedError);
        await assert.rejects(() => questions.getThread(actor, threadA), StoreAccessDeniedError);
        await assert.rejects(() => questions.markThreadRead(actor, threadA), StoreAccessDeniedError);
        await assert.rejects(() => questions.reply(actor, threadA, { english: "Yes.", japanese: null, commandId: randomUUID() }), StoreAccessDeniedError);
      }
      // Another provider's thread, or none at all, is not found.
      for (const id of [threadB, randomUUID()]) {
        await assert.rejects(() => questions.getThread(ownerA, id), StoreNotFoundError);
        await assert.rejects(() => questions.markThreadRead(ownerA, id), StoreNotFoundError);
        await assert.rejects(() => questions.reply(ownerA, id, { english: "Yes.", japanese: null, commandId: randomUUID() }), StoreNotFoundError);
      }
      await assert.rejects(() => questions.getThread(ownerA, "not-a-uuid"), StoreValidationError);

      await questions.markThreadRead(ownerA, threadA);
      assert.equal((await questions.getThread(ownerA, threadA)).read, true);
      assert.equal((await questions.listThreads(ownerA, { unreadOnly: true })).threads.length, 0);

      // 返信: the English the guest gets, with or without the host's Japanese; the same command once.
      const commandId = randomUUID();
      const reply = { english: "Yes, we can make it vegetarian.", japanese: "はい、ベジタリアンにできます。", commandId };
      const sent = await questions.reply(ownerA, threadA, reply);
      assert.equal(sent.author, "HOST");
      assert.equal(sent.deliveryStatus, "PENDING");
      assert.equal((await questions.reply(ownerA, threadA, reply)).id, sent.id);
      await assert.rejects(() => questions.reply(ownerA, threadA, { ...reply, english: "No." }), StoreConflictError);
      await assert.rejects(() => questions.reply(ownerA, threadA, { ...reply, japanese: null }), StoreConflictError);
      // The same command on another of the provider's threads; another provider's commands are its own.
      await questions.submitQuestion(question({ guestEmail: "second@example.com" }));
      const threadA2 = await threadIdFor(pool, "tea", "second@example.com");
      await assert.rejects(() => questions.reply(ownerA, threadA2, reply), StoreConflictError);
      assert.equal((await questions.reply(ownerB, threadB, reply)).deliveryStatus, "PENDING");
      await assert.rejects(() => questions.reply(ownerA, threadA, { english: " ", japanese: null, commandId: randomUUID() }), StoreValidationError);
      await assert.rejects(() => questions.reply(ownerA, threadA, { english: "x".repeat(4001), japanese: null, commandId: randomUUID() }), StoreValidationError);
      const direct = await questions.reply(ownerA, threadA, { english: "See you then.", japanese: "", commandId: randomUUID() });
      assert.equal(direct.bodyJa, null);

      const thread = await questions.getThread(ownerA, threadA);
      assert.equal(thread.needsReply, false);
      assert.deepEqual(thread.messages.map((message) => [message.author, message.body, message.bodyJa, message.deliveryStatus]), [
        ["GUEST", "Is there a vegetarian option?", null, null],
        ["HOST", "Yes, we can make it vegetarian.", "はい、ベジタリアンにできます。", "PENDING"],
        ["HOST", "See you then.", null, "PENDING"],
      ]);
      assert.equal(thread.lastMessageAtUtc, thread.messages.at(-1)?.createdAtUtc);
      assert.doesNotMatch(JSON.stringify(thread), /example\.com/);
      const replies = await pool.query("SELECT provider_id FROM outbox_messages WHERE topic = 'guest_question.reply' ORDER BY id");
      assert.deepEqual(replies.rows.map((row) => row.provider_id), ["provider-a", "provider-b", "provider-a"]);
      await assertOutboxCarriesIdsOnly(pool);

      // Pages, the latest first, each thread once.
      for (let index = 0; index < 4; index += 1) await questions.submitQuestion(question({ guestEmail: `page-${index}@example.com` }));
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const next: Awaited<ReturnType<GuestQuestionRepository["listThreads"]>> = await questions.listThreads(ownerA, { limit: 2, cursor });
        assert.ok(next.threads.length <= 2);
        seen.push(...next.threads.map((item) => item.id));
        cursor = next.nextCursor;
      } while (cursor);
      assert.equal(seen.length, 6);
      assert.equal(new Set(seen).size, 6);
      assert.equal(seen.at(-1), threadA2);
      assert.equal(seen.at(-2), threadA);
      await assert.rejects(() => questions.listThreads(ownerA, { cursor: "bm90LWEtY3Vyc29y" }), StoreValidationError);
    });
  });

  it("claims host replies for the mail worker with one-time links kept only as hashes", async () => {
    await withSchema(async (pool, questions) => {
      await questions.submitQuestion(question());
      const threadId = await threadIdFor(pool, "tea", "guest@example.com");
      const sent = await questions.reply(ownerA, threadId, { english: "Yes, we can.", japanese: "はい。", commandId: randomUUID() });

      const [claimed, ...others] = await questions.claimReplyDeliveries({ limit: 10, leaseSeconds: 60, linkTtlDays: 14 });
      assert.equal(others.length, 0);
      assert.ok(claimed);
      assert.equal(claimed.messageId, sent.id);
      assert.equal(claimed.providerId, "provider-a");
      assert.equal(claimed.threadId, threadId);
      assert.equal(claimed.guestEmail, "guest@example.com");
      assert.equal(claimed.guestName, "Sample Guest");
      assert.equal(claimed.guestLanguage, "EN");
      assert.equal(claimed.experienceTitle, "Synthetic tea");
      assert.equal(claimed.hostDisplayName, "Sample Seller A");
      assert.equal(claimed.english, "Yes, we can.");
      assert.equal(claimed.attempt, 1);
      assert.match(claimed.replyToken, /^[A-Za-z0-9_-]{43}$/);
      const days = (Date.parse(claimed.replyLinkExpiresAtUtc) - Date.now()) / 86_400_000;
      assert.ok(days > 13.9 && days < 14.01);
      const state = await pool.query("SELECT delivery_status, delivery_attempts, lease_until > clock_timestamp() AS leased FROM guest_question_messages WHERE id = $1", [sent.id]);
      assert.deepEqual(state.rows, [{ delivery_status: "SENDING", delivery_attempts: 1, leased: true }]);
      const tokens = await pool.query<{ token_hash: Buffer; row: string }>("SELECT token_hash, r::text AS row FROM guest_question_reply_tokens r");
      assert.equal(tokens.rows.length, 1);
      assert.deepEqual(tokens.rows[0]?.token_hash, createHash("sha256").update(claimed.replyToken, "utf8").digest());
      assert.ok(!tokens.rows[0]?.row.includes(claimed.replyToken));
      await assertOutboxCarriesIdsOnly(pool);

      // Leased: nobody else takes it until the lease runs out, then it is tried again with a new link.
      assert.deepEqual(await questions.claimReplyDeliveries({ limit: 10, leaseSeconds: 60, linkTtlDays: 14 }), []);
      await pool.query("UPDATE guest_question_messages SET lease_until = clock_timestamp() - interval '1 second' WHERE id = $1", [sent.id]);
      const [again] = await questions.claimReplyDeliveries({ limit: 10, leaseSeconds: 60, linkTtlDays: 14 });
      assert.equal(again?.messageId, sent.id);
      assert.equal(again?.attempt, 2);
      assert.notEqual(again?.replyToken, claimed.replyToken);

      // RETRY waits before the next try; SENT stays SENT.
      assert.equal(await questions.recordReplyDelivery(sent.id, "RETRY"), "PENDING");
      assert.deepEqual(await questions.claimReplyDeliveries({ limit: 10, leaseSeconds: 60, linkTtlDays: 14 }), []);
      await pool.query("UPDATE guest_question_messages SET lease_until = clock_timestamp() - interval '1 second' WHERE id = $1", [sent.id]);
      assert.equal((await questions.claimReplyDeliveries({ limit: 10, leaseSeconds: 60, linkTtlDays: 14 }))[0]?.attempt, 3);
      assert.equal(await questions.recordReplyDelivery(sent.id, "SENT"), "SENT");
      assert.equal(await questions.recordReplyDelivery(sent.id, "SENT"), "SENT");
      assert.equal(await questions.recordReplyDelivery(sent.id, "RETRY"), "SENT");
      assert.equal((await questions.getThread(ownerA, threadId)).messages.at(-1)?.deliveryStatus, "SENT");
      assert.equal((await pool.query("SELECT delivered_at IS NOT NULL AS delivered FROM guest_question_messages WHERE id = $1", [sent.id])).rows[0].delivered, true);

      // FAILED is final; so is a last attempt whose lease ran out.
      const failing = await questions.reply(ownerA, threadId, { english: "One more thing.", japanese: null, commandId: randomUUID() });
      await questions.claimReplyDeliveries({ limit: 10, leaseSeconds: 60, linkTtlDays: 14 });
      assert.equal(await questions.recordReplyDelivery(failing.id, "FAILED"), "FAILED");
      const exhausted = await questions.reply(ownerA, threadId, { english: "And another.", japanese: null, commandId: randomUUID() });
      await pool.query("UPDATE guest_question_messages SET delivery_status = 'SENDING', delivery_attempts = 5, lease_until = clock_timestamp() - interval '1 second' WHERE id = $1", [exhausted.id]);
      assert.deepEqual(await questions.claimReplyDeliveries({ limit: 10, leaseSeconds: 60, linkTtlDays: 14 }), []);
      assert.equal((await questions.getThread(ownerA, threadId)).messages.at(-1)?.deliveryStatus, "FAILED");

      await assert.rejects(() => questions.recordReplyDelivery(randomUUID(), "SENT"), StoreNotFoundError);
      await assert.rejects(() => questions.recordReplyDelivery(sent.id, "LOST" as never), StoreValidationError);
      await assert.rejects(() => questions.claimReplyDeliveries({ limit: 10, leaseSeconds: 60, linkTtlDays: 31 }), StoreValidationError);
    });
  });

  it("opens a reply link once and brings the guest's answer back to the host", async () => {
    await withSchema(async (pool, questions) => {
      await questions.submitQuestion(question());
      const threadId = await threadIdFor(pool, "tea", "guest@example.com");
      await questions.markThreadRead(ownerA, threadId);
      await questions.reply(ownerA, threadId, { english: "Yes, we can.", japanese: "はい、できます。", commandId: randomUUID() });
      const [claimed] = await questions.claimReplyDeliveries({ limit: 10, leaseSeconds: 60, linkTtlDays: 14 });
      assert.ok(claimed);

      const link = await questions.openReplyLink(claimed.replyToken);
      assert.ok(link);
      assert.equal(link.experienceTitle, "Synthetic tea");
      assert.equal(link.hostDisplayName, "Sample Seller A");
      assert.equal(link.guestName, "Sample Guest");
      assert.equal(link.expiresAtUtc, claimed.replyLinkExpiresAtUtc);
      // The host's English only, never their Japanese.
      assert.deepEqual(link.messages.map(({ from, body }) => ({ from, body })), [
        { from: "guest", body: "Is there a vegetarian option?" },
        { from: "host", body: "Yes, we can." },
      ]);
      assert.doesNotMatch(JSON.stringify(link), /はい|example\.com/);
      assert.equal(await questions.openReplyLink("not-a-token"), null);
      assert.equal(await questions.openReplyLink("A".repeat(43)), null);

      const key = randomUUID();
      assert.deepEqual(await questions.submitGuestReply(claimed.replyToken, { message: "Sample Answer: thank you!", clientRequestKey: key }), { status: "received" });
      assert.deepEqual(await questions.submitGuestReply(claimed.replyToken, { message: "Sample Answer: thank you!", clientRequestKey: key }), { status: "received" });
      await assert.rejects(() => questions.submitGuestReply(claimed.replyToken, { message: "Another answer", clientRequestKey: randomUUID() }), StoreConflictError);
      assert.equal(await questions.openReplyLink(claimed.replyToken), null);

      const thread = await questions.getThread(ownerA, threadId);
      assert.equal(thread.needsReply, true);
      assert.equal(thread.read, false);
      assert.deepEqual(thread.messages.map((message) => [message.author, message.source]), [["GUEST", "SITE_FORM"], ["HOST", "HOST_CONSOLE"], ["GUEST", "REPLY_PAGE"]]);
      assert.equal(thread.lastMessageAtUtc, thread.messages.at(-1)?.createdAtUtc);
      const received = await pool.query("SELECT payload FROM outbox_messages WHERE topic = 'guest_question.received' ORDER BY id");
      assert.equal(received.rows.length, 2);
      assert.deepEqual(received.rows[1]?.payload, { threadId, messageId: thread.messages.at(-1)?.id });
      // The answer notifies the host too; the repeated answer adds no second push.
      const pushes = await pool.query("SELECT payload FROM outbox_messages WHERE topic = 'host.notify.guest_question' ORDER BY id");
      assert.deepEqual(pushes.rows.map((row) => row.payload), [
        { v: 1, threadId, messageId: thread.messages[0]?.id, experienceTitle: "Synthetic tea" },
        { v: 1, threadId, messageId: thread.messages.at(-1)?.id, experienceTitle: "Synthetic tea" },
      ]);
      await assertOutboxCarriesIdsOnly(pool);

      // An expired link neither opens nor takes an answer; an unknown one is not found.
      await questions.reply(ownerA, threadId, { english: "Glad to help.", japanese: null, commandId: randomUUID() });
      const [later] = await questions.claimReplyDeliveries({ limit: 10, leaseSeconds: 60, linkTtlDays: 1 });
      assert.ok(later);
      await pool.query("UPDATE guest_question_reply_tokens SET created_at = created_at - interval '2 days', expires_at = expires_at - interval '2 days' WHERE used_at IS NULL");
      assert.equal(await questions.openReplyLink(later.replyToken), null);
      await assert.rejects(() => questions.submitGuestReply(later.replyToken, { message: "Too late?", clientRequestKey: randomUUID() }), StoreNotFoundError);
      await assert.rejects(() => questions.submitGuestReply("B".repeat(43), { message: "Hello", clientRequestKey: randomUUID() }), StoreNotFoundError);
      await assert.rejects(() => questions.submitGuestReply(later.replyToken, { message: " ", clientRequestKey: randomUUID() }), StoreValidationError);
    });
  });

  it("erases questions a year after their last message, with their messages and reply links, a bounded batch at a time", async () => {
    await withSchema(async (pool, questions) => {
      await questions.submitQuestion(question({ guestEmail: "old@example.com" }));
      await questions.submitQuestion(question({ guestEmail: "older@example.com" }));
      await questions.submitQuestion(question({ guestEmail: "recent@example.com" }));
      const old = await threadIdFor(pool, "tea", "old@example.com");
      const older = await threadIdFor(pool, "tea", "older@example.com");
      const recent = await threadIdFor(pool, "tea", "recent@example.com");
      await questions.reply(ownerA, old, { english: "Yes, we can.", japanese: null, commandId: randomUUID() });
      await questions.reply(ownerA, recent, { english: "Of course.", japanese: null, commandId: randomUUID() });
      assert.equal((await questions.claimReplyDeliveries({ limit: 10, leaseSeconds: 60, linkTtlDays: 14 })).length, 2);
      // The old threads' last messages were 400 and 500 days ago; the recent one's 300 days ago.
      await pool.query("UPDATE guest_question_threads SET last_message_at = clock_timestamp() - interval '400 days' WHERE id = $1", [old]);
      await pool.query("UPDATE guest_question_threads SET last_message_at = clock_timestamp() - interval '500 days' WHERE id = $1", [older]);
      await pool.query("UPDATE guest_question_threads SET last_message_at = clock_timestamp() - interval '300 days' WHERE id = $1", [recent]);
      const outboxBefore = (await pool.query("SELECT count(*)::int AS n FROM outbox_messages")).rows[0].n as number;

      const yearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString();
      assert.equal(await questions.eraseInactiveThreads({ lastMessageBefore: yearAgo, limit: 1 }), 1);
      assert.deepEqual((await pool.query("SELECT id FROM guest_question_threads WHERE id = $1", [older])).rows, []);
      assert.equal(await questions.eraseInactiveThreads({ lastMessageBefore: yearAgo }), 1);
      assert.equal(await questions.eraseInactiveThreads({ lastMessageBefore: yearAgo }), 0);

      const left = await pool.query("SELECT t.id, t.guest_email FROM guest_question_threads t");
      assert.deepEqual(left.rows, [{ id: recent, guest_email: "recent@example.com" }]);
      const messages = await pool.query("SELECT DISTINCT thread_id FROM guest_question_messages");
      assert.deepEqual(messages.rows, [{ thread_id: recent }]);
      const tokens = await pool.query("SELECT DISTINCT thread_id FROM guest_question_reply_tokens");
      assert.deepEqual(tokens.rows, [{ thread_id: recent }]);
      // Outbox rows name ids only and stay.
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM outbox_messages")).rows[0].n, outboxBefore);
      await assertOutboxCarriesIdsOnly(pool);

      await assert.rejects(() => questions.eraseInactiveThreads({ lastMessageBefore: "last year" }), StoreValidationError);
      await assert.rejects(() => questions.eraseInactiveThreads({ lastMessageBefore: yearAgo, limit: 0 }), StoreValidationError);
    });
  });
});
