import type { Pool } from "pg";
import { StoreError, StoreValidationError } from "./errors.ts";
import type { DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";

/**
 * The Japanese of what a guest wrote to the host (予約前の質問, #285 slice 5; docs/guest-questions.md). A
 * guest's question and every answer from the reply page write `guest_question.received` to `outbox_messages`
 * in their own transaction; the experience job claims those rows, has the English translated and keeps the
 * Japanese as the message's `body_ja`, which メッセージ shows beside the original. A row whose message needs
 * nothing (written in Japanese, already translated, or erased with its thread) is closed unclaimed. Like the
 * other consumers there is no lease column: a claim moves `available_at` past the lease, so a row the job
 * never finishes comes back by itself. Other topics stay untouched (the host's push has its own row).
 */
export const GUEST_TRANSLATION_TOPIC = "guest_question.received";
export const GUEST_TRANSLATION_LIMITS = {
  /** Claims of one message, the first included. Retries wait 2, 4, 8 and 16 minutes. */
  attempts: 5,
  claimLimitMax: 20,
  leaseSecondsMin: 30,
  leaseSecondsMax: 600,
  /** Rows that need nothing, closed per claim. */
  closedPerClaim: 100,
  /** guest_question_messages.body_ja's bound (migration 0022). */
  japaneseMaxLength: 4000,
} as const;

/** One claimed message to translate. Its text exists only here and in the request to the translator. */
export interface ClaimedGuestTranslation {
  /** The outbox row's bigint as text. */
  readonly id: string;
  /** Claims so far, this one included. */
  readonly attempts: number;
  readonly messageId: string;
  /** What the guest wrote, in English. */
  readonly text: string;
}

export interface GuestTranslationClaim {
  readonly translations: readonly ClaimedGuestTranslation[];
  /** Rows closed without a claim: the message needs no translation, or is gone. */
  readonly closed: number;
  /** Rows whose last attempt's lease ran out without a report: closed untranslated. */
  readonly abandoned: number;
}

/** After a failure: tried again later, given up (attempts used up), or no longer this claim's row. */
export type GuestTranslationRetry = "RETRY" | "FAILED" | "STALE";

const ROW_ID = /^[1-9][0-9]{0,18}$/;
const UUID_TEXT = "'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'";
/** Control characters other than tab and line breaks. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/**
 * The row's message, matched through the payload's `messageId`. The cast runs only on a UUID's shape, so a
 * hand-written row with another payload never fails the query.
 */
const MESSAGE_OF = (row: string) =>
  `m.provider_id = ${row}.provider_id
   AND m.id = (CASE WHEN ${row}.payload->>'messageId' ~ ${UUID_TEXT} THEN (${row}.payload->>'messageId')::uuid END)`;
/** The row's message is still the guest's English without a translation. */
const NEEDS_TRANSLATION = (row: string) =>
  `EXISTS (SELECT 1 FROM guest_question_messages m
             JOIN guest_question_threads t ON t.provider_id = m.provider_id AND t.id = m.thread_id
            WHERE ${MESSAGE_OF(row)} AND m.author = 'GUEST' AND m.body_ja IS NULL AND t.guest_language = 'EN')`;
const OPEN_ROW = (row: string) => `${row}.topic = $1 AND ${row}.processed_at IS NULL`;

function boundedInteger(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new StoreValidationError(`${path} must be an integer from ${min} to ${max}.`);
  return value;
}

function assertRowId(id: string): void {
  if (typeof id !== "string" || !ROW_ID.test(id)) throw new StoreValidationError("id must be an outbox row id.");
}

function count(value: unknown, key: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new StoreError(`Database returned an invalid ${key}.`);
  return parsed;
}

/** bigint ids as text, in numeric order. */
const byId = (a: ClaimedGuestTranslation, b: ClaimedGuestTranslation) => a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export class GuestQuestionTranslations {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * Up to `limit` guest messages to translate, oldest first, each claimed for `leaseSeconds`. Before that,
   * closes rows that need nothing (a bounded batch) and rows whose last attempt's lease ran out.
   */
  async claimTranslations(options: { limit: number; leaseSeconds: number }): Promise<GuestTranslationClaim> {
    const limit = boundedInteger(options?.limit, "limit", 1, GUEST_TRANSLATION_LIMITS.claimLimitMax);
    const leaseSeconds = boundedInteger(options?.leaseSeconds, "leaseSeconds", GUEST_TRANSLATION_LIMITS.leaseSecondsMin, GUEST_TRANSLATION_LIMITS.leaseSecondsMax);
    return withTransaction(this.#pool, async (client) => {
      const idle = await client.query<DbRow>(
        `WITH idle AS (
           SELECT o.id FROM outbox_messages o
            WHERE ${OPEN_ROW("o")} AND o.available_at <= clock_timestamp()
              AND (o.attempts >= $2 OR NOT ${NEEDS_TRANSLATION("o")})
            ORDER BY o.available_at, o.id
            LIMIT $3
            FOR UPDATE OF o SKIP LOCKED
         )
         UPDATE outbox_messages o SET processed_at = clock_timestamp()
           FROM idle
          WHERE o.id = idle.id
         RETURNING o.attempts >= $2 AND ${NEEDS_TRANSLATION("o")} AS abandoned`,
        [GUEST_TRANSLATION_TOPIC, GUEST_TRANSLATION_LIMITS.attempts, GUEST_TRANSLATION_LIMITS.closedPerClaim],
      );
      const abandoned = idle.rows.filter((row) => row.abandoned === true).length;
      const claimed = await client.query<DbRow>(
        `WITH due AS (
           SELECT o.id FROM outbox_messages o
            WHERE ${OPEN_ROW("o")} AND o.attempts < $2 AND o.available_at <= clock_timestamp()
              AND ${NEEDS_TRANSLATION("o")}
            ORDER BY o.available_at, o.id
            LIMIT $3
            FOR UPDATE OF o SKIP LOCKED
         ), claimed AS (
           UPDATE outbox_messages o
              SET available_at = clock_timestamp() + make_interval(secs => $4), attempts = o.attempts + 1
             FROM due
            WHERE o.id = due.id
           RETURNING o.id, o.attempts, o.provider_id, o.payload
         )
         SELECT c.id::text AS id, c.attempts, m.id::text AS message_id, m.body
           FROM claimed c
           JOIN guest_question_messages m ON ${MESSAGE_OF("c")}`,
        [GUEST_TRANSLATION_TOPIC, GUEST_TRANSLATION_LIMITS.attempts, limit, leaseSeconds],
      );
      const translations = claimed.rows
        .map((row): ClaimedGuestTranslation => ({ id: String(row.id), attempts: count(row.attempts, "attempts"), messageId: String(row.message_id), text: String(row.body) }))
        .sort(byId);
      return { translations, closed: idle.rows.length - abandoned, abandoned };
    });
  }

  /**
   * The Japanese of a claimed message: kept as its `body_ja` unless it already has one, and the row is done.
   * A late report after the lease ran out still counts (the translation is the same work). Answers whether
   * this report stored the Japanese (false: the message was translated already, or erased meanwhile).
   */
  async recordTranslation(id: string, japanese: string): Promise<boolean> {
    assertRowId(id);
    if (typeof japanese !== "string" || CONTROL.test(japanese)) throw new StoreValidationError("japanese must be text.");
    const text = japanese.trim();
    if (text.length < 1 || text.length > GUEST_TRANSLATION_LIMITS.japaneseMaxLength) {
      throw new StoreValidationError(`japanese must contain 1-${GUEST_TRANSLATION_LIMITS.japaneseMaxLength} characters.`);
    }
    return withTransaction(this.#pool, async (client) => {
      const stored = await client.query(
        `UPDATE guest_question_messages m SET body_ja = $3
           FROM outbox_messages o
          WHERE o.id = $2 AND o.topic = $1 AND ${MESSAGE_OF("o")} AND m.author = 'GUEST' AND m.body_ja IS NULL`,
        [GUEST_TRANSLATION_TOPIC, id, text],
      );
      await client.query(`UPDATE outbox_messages o SET processed_at = clock_timestamp() WHERE o.id = $2 AND ${OPEN_ROW("o")}`, [GUEST_TRANSLATION_TOPIC, id]);
      return (stored.rowCount ?? 0) > 0;
    });
  }

  /**
   * A failed translation for the claim counted `attempts`: wait 2^attempts minutes (60 at most), or give up
   * once the attempts are used up (the host reads the English). Once the lease ran out and another run
   * claimed the row, nothing changes.
   */
  async retryTranslation(id: string, attempts: number): Promise<GuestTranslationRetry> {
    assertRowId(id);
    boundedInteger(attempts, "attempts", 1, GUEST_TRANSLATION_LIMITS.attempts);
    const updated = await this.#pool.query<DbRow>(
      `UPDATE outbox_messages o
          SET available_at = CASE WHEN o.attempts < $3 THEN clock_timestamp() + make_interval(mins => LEAST(power(2, o.attempts), 60)::int) ELSE o.available_at END,
              processed_at = CASE WHEN o.attempts < $3 THEN NULL ELSE clock_timestamp() END
        WHERE o.id = $2 AND o.attempts = $4 AND ${OPEN_ROW("o")}
        RETURNING o.processed_at IS NOT NULL AS gave_up`,
      [GUEST_TRANSLATION_TOPIC, id, GUEST_TRANSLATION_LIMITS.attempts, attempts],
    );
    const row = updated.rows[0];
    if (!row) return "STALE";
    return row.gave_up === true ? "FAILED" : "RETRY";
  }
}
