import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { StoreValidationError } from "../src/errors.ts";
import { GUEST_TRANSLATION_LIMITS, GuestQuestionTranslations } from "../src/guest-question-translations.ts";
import { GuestQuestionRepository, type SubmitGuestQuestionInput } from "../src/guest-questions.ts";
import { HOST_NOTIFICATION_TOPICS, HostNotificationOutbox } from "../src/host-notification-outbox.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const ownerA = { providerId: "provider-a", nihoUserId: "owner-a" } as const;

interface Context {
  readonly pool: Pool;
  readonly questions: GuestQuestionRepository;
  readonly translations: GuestQuestionTranslations;
}

/** A fresh schema with every migration, one synthetic provider, its OWNER and a published experience. */
async function withSchema(run: (context: Context) => Promise<void>): Promise<void> {
  const { Pool } = await import("pg");
  const schema = `guest_translations_${randomUUID().replaceAll("-", "")}`;
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
       VALUES ('provider-a','tea','sample-tea','PUBLISHED','Synthetic tea','{}','JPY',1000,'terms','seller','acct_synthetic','Sample Seller A')`,
    );
    await run({ pool, questions: new GuestQuestionRepository(pool), translations: new GuestQuestionTranslations(pool) });
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
}

function question(overrides: Partial<SubmitGuestQuestionInput> = {}): SubmitGuestQuestionInput {
  return {
    productSlug: "sample-tea", topic: "FOOD", message: "Is there a vegetarian option?", guestName: "Sample Guest",
    guestEmail: "guest@example.com", clientRequestKey: randomUUID(), ...overrides,
  };
}

async function threadIdFor(pool: Pool, guestEmail: string): Promise<string> {
  return String((await pool.query("SELECT id FROM guest_question_threads WHERE guest_email = $1", [guestEmail])).rows[0].id);
}

async function receivedRows(pool: Pool) {
  return (await pool.query(
    `SELECT id::text AS id, payload->>'messageId' AS message_id, attempts, available_at, processed_at
       FROM outbox_messages WHERE topic = 'guest_question.received' ORDER BY id`,
  )).rows;
}

/** As if every lease and backoff had already run out. */
async function makeDue(pool: Pool): Promise<void> {
  await pool.query("UPDATE outbox_messages SET available_at = clock_timestamp() - interval '1 second' WHERE processed_at IS NULL");
}

describe("PostgreSQL guest message translations (#285 slice 5)", { skip: databaseUrl === undefined }, () => {
  it("claims the guests' English one lease at a time, keeps the Japanese, and closes what needs none", async () => {
    await withSchema(async ({ pool, questions, translations }) => {
      await questions.submitQuestion(question());
      await questions.submitQuestion(question({ guestEmail: "ja@example.com", language: "JA", message: "ベジタリアン向けの料理はありますか？" }));
      await questions.submitQuestion(question({ guestEmail: "done@example.com", message: "Can I bring my child?" }));
      // An answer from the reply page is claimed like a question.
      const threadId = await threadIdFor(pool, "guest@example.com");
      await questions.reply(ownerA, threadId, { english: "Yes, we can.", japanese: "はい、できます。", commandId: randomUUID() });
      const [delivery] = await questions.claimReplyDeliveries({ limit: 5, leaseSeconds: 60, linkTtlDays: 14 });
      assert.equal(delivery?.kind, "QUESTION");
      await questions.submitGuestReply(delivery.replyToken, { message: "Great, thank you! See you on Nov 14 at 10:00.", clientRequestKey: randomUUID() });
      // One message was translated some other way already; one thread is erased.
      await pool.query("UPDATE guest_question_messages SET body_ja = '既訳' WHERE body = 'Can I bring my child?'");
      await questions.submitQuestion(question({ guestEmail: "gone@example.com", message: "Is it wheelchair accessible?" }));
      await pool.query("DELETE FROM guest_question_threads WHERE guest_email = 'gone@example.com'");

      const first = await translations.claimTranslations({ limit: 1, leaseSeconds: 120 });
      // The Japanese thread, the translated message and the erased one are closed without a claim.
      assert.equal(first.closed, 3);
      assert.equal(first.abandoned, 0);
      assert.equal(first.translations.length, 1);
      assert.equal(first.translations[0]!.text, "Is there a vegetarian option?");
      assert.equal(first.translations[0]!.attempts, 1);
      assert.doesNotMatch(JSON.stringify(first), /example\.com|Sample Guest/);
      const second = await translations.claimTranslations({ limit: 5, leaseSeconds: 120 });
      assert.deepEqual(second.translations.map((row) => row.text), ["Great, thank you! See you on Nov 14 at 10:00."]);
      // Both are leased: nothing more to claim.
      assert.deepEqual(await translations.claimTranslations({ limit: 5, leaseSeconds: 120 }), { translations: [], closed: 0, abandoned: 0 });
      const leased = (await receivedRows(pool)).find((row) => row.id === first.translations[0]!.id)!;
      assert.ok(leased.available_at.getTime() > Date.now() + 100_000);

      assert.equal(await translations.recordTranslation(first.translations[0]!.id, "  ベジタリアンの選択肢はありますか？\n"), true);
      assert.equal(await translations.recordTranslation(second.translations[0]!.id, "ありがとうございます！11月14日10時にお会いしましょう。"), true);
      // A late second report changes nothing.
      assert.equal(await translations.recordTranslation(first.translations[0]!.id, "別の訳"), false);
      const thread = await questions.getThread(ownerA, threadId);
      assert.deepEqual(thread.messages.map((message) => [message.author, message.bodyJa]), [
        ["GUEST", "ベジタリアンの選択肢はありますか？"],
        ["HOST", "はい、できます。"],
        ["GUEST", "ありがとうございます！11月14日10時にお会いしましょう。"],
      ]);
      assert.ok((await receivedRows(pool)).every((row) => row.processed_at instanceof Date));
      await makeDue(pool);
      assert.deepEqual(await translations.claimTranslations({ limit: 5, leaseSeconds: 120 }), { translations: [], closed: 0, abandoned: 0 });
    });
  });

  it("backs off after a failure, gives up at the attempt cap, and closes an abandoned last attempt", async () => {
    await withSchema(async ({ pool, questions, translations }) => {
      await questions.submitQuestion(question());
      const dbNow = async () => (await pool.query("SELECT clock_timestamp() AS now")).rows[0].now.getTime() as number;

      const [claimed] = (await translations.claimTranslations({ limit: 1, leaseSeconds: 60 })).translations;
      // Another run's count no longer owns the row.
      assert.equal(await translations.retryTranslation(claimed!.id, 2), "STALE");
      assert.equal(await translations.retryTranslation(claimed!.id, 1), "RETRY");
      let [row] = await receivedRows(pool);
      assert.ok(Math.abs(row.available_at.getTime() - (await dbNow()) - 2 * 60_000) < 5_000, "2 minutes after the first attempt");
      assert.equal(row.processed_at, null);

      await makeDue(pool);
      const [again] = (await translations.claimTranslations({ limit: 1, leaseSeconds: 60 })).translations;
      assert.equal(again!.attempts, 2);
      assert.equal(await translations.retryTranslation(again!.id, 2), "RETRY");
      [row] = await receivedRows(pool);
      assert.ok(Math.abs(row.available_at.getTime() - (await dbNow()) - 4 * 60_000) < 5_000, "4 minutes after the second");

      // The last attempt fails too: given up, and the host reads the English.
      await pool.query("UPDATE outbox_messages SET attempts = $1 WHERE id = $2", [GUEST_TRANSLATION_LIMITS.attempts - 1, claimed!.id]);
      await makeDue(pool);
      const [last] = (await translations.claimTranslations({ limit: 1, leaseSeconds: 60 })).translations;
      assert.equal(last!.attempts, GUEST_TRANSLATION_LIMITS.attempts);
      assert.equal(await translations.retryTranslation(last!.id, last!.attempts), "FAILED");
      [row] = await receivedRows(pool);
      assert.ok(row.processed_at instanceof Date);
      assert.equal((await pool.query("SELECT body_ja FROM guest_question_messages")).rows[0].body_ja, null);

      // A last attempt whose lease ran out without a report is closed by a later claim.
      await questions.submitQuestion(question({ guestEmail: "abandoned@example.com", message: "Do you have parking?" }));
      const [abandoned] = (await translations.claimTranslations({ limit: 1, leaseSeconds: 60 })).translations;
      await pool.query("UPDATE outbox_messages SET attempts = $1 WHERE id = $2", [GUEST_TRANSLATION_LIMITS.attempts, abandoned!.id]);
      assert.deepEqual(await translations.claimTranslations({ limit: 1, leaseSeconds: 60 }), { translations: [], closed: 0, abandoned: 0 });
      await makeDue(pool);
      assert.deepEqual(await translations.claimTranslations({ limit: 1, leaseSeconds: 60 }), { translations: [], closed: 0, abandoned: 1 });
      // Even a late report after giving up keeps the translation.
      assert.equal(await translations.recordTranslation(abandoned!.id, "駐車場はありますか？"), true);
    });
  });

  it("never shares a row between claimers, leaves the host's push alone, and refuses bad input", async () => {
    await withSchema(async ({ pool, questions, translations }) => {
      for (const n of [1, 2, 3]) await questions.submitQuestion(question({ guestEmail: `guest${n}@example.com` }));
      const [one, two] = await Promise.all([
        translations.claimTranslations({ limit: 2, leaseSeconds: 60 }),
        translations.claimTranslations({ limit: 2, leaseSeconds: 60 }),
      ]);
      const ids = [...one.translations, ...two.translations].map((row) => row.id);
      assert.equal(ids.length, 3);
      assert.equal(new Set(ids).size, 3);

      // The host's push rows are the notification job's: untouched here, and that job never claims the translation rows.
      const pushes = await pool.query("SELECT attempts, processed_at FROM outbox_messages WHERE topic = $1", [HOST_NOTIFICATION_TOPICS.guestQuestion]);
      assert.deepEqual(pushes.rows, [1, 2, 3].map(() => ({ attempts: 0, processed_at: null })));
      const claimed = await new HostNotificationOutbox(pool).claimDue(10, 60_000);
      assert.deepEqual(claimed.map((row) => row.topic), [1, 2, 3].map(() => HOST_NOTIFICATION_TOPICS.guestQuestion));
      assert.deepEqual(claimed.map((row) => row.providerId), ["provider-a", "provider-a", "provider-a"]);

      for (const bad of [
        { limit: 0, leaseSeconds: 60 }, { limit: GUEST_TRANSLATION_LIMITS.claimLimitMax + 1, leaseSeconds: 60 }, { limit: 1, leaseSeconds: 10 }, { limit: 1.5, leaseSeconds: 60 },
      ]) await assert.rejects(() => translations.claimTranslations(bad), StoreValidationError);
      for (const japanese of ["", "  ", "合成\u0007", "あ".repeat(GUEST_TRANSLATION_LIMITS.japaneseMaxLength + 1)]) {
        await assert.rejects(() => translations.recordTranslation(ids[0]!, japanese), StoreValidationError);
      }
      await assert.rejects(() => translations.recordTranslation("1; DROP TABLE outbox_messages", "訳"), StoreValidationError);
      await assert.rejects(() => translations.retryTranslation(ids[0]!, 0), StoreValidationError);
      // An id of another topic's row changes nothing.
      const pushId = String((await pool.query("SELECT id FROM outbox_messages WHERE topic = $1 LIMIT 1", [HOST_NOTIFICATION_TOPICS.guestQuestion])).rows[0].id);
      assert.equal(await translations.recordTranslation(pushId, "訳"), false);
      assert.equal(await translations.retryTranslation(pushId, 1), "STALE");
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM guest_question_messages WHERE body_ja IS NOT NULL")).rows[0].n, 0);
    });
  });
});
