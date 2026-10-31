import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { StoreAccessDeniedError, StoreConflictError, StoreNotFoundError, StoreRateLimitedError, StoreValidationError } from "./errors.ts";
import { calendarMembershipRole } from "./product-calendar-authorization.ts";
import { isoValue, type DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import type { HostActor } from "./types.ts";
import { assertCanonicalInstant, assertStoreIdentifier } from "./validation.ts";

/** What a question is about, as the traveler's form offers it (ASK_HOST_TOPICS). */
export const GUEST_QUESTION_TOPICS = ["CHILDREN", "FOOD", "ACCESS", "LANGUAGE", "OTHER"] as const;
export type GuestQuestionTopic = (typeof GUEST_QUESTION_TOPICS)[number];
export type GuestQuestionLanguage = "EN" | "JA";
export type GuestQuestionDeliveryStatus = "PENDING" | "SENDING" | "SENT" | "FAILED";
/** What the mail worker reports for one claimed reply. RETRY puts it back with a backoff while attempts remain. */
export type GuestQuestionDeliveryOutcome = "SENT" | "RETRY" | "FAILED";

/**
 * The bounds migration 0022 keeps. The guest's limits match ASK_HOST_INPUT_LIMITS
 * (packages/api-client/src/journey.ts); the host's match the console's MESSAGE_TEXT_LIMIT.
 */
export const GUEST_QUESTION_LIMITS = {
  questionMinLength: 5,
  guestMessageMaxLength: 1000,
  hostMessageMaxLength: 4000,
  guestNameMaxLength: 100,
  guestEmailMaxLength: 254,
  newThreadsPerGuestPerHour: 3,
  newThreadsPerProductPerHour: 30,
  deliveryAttempts: 5,
  linkTtlDaysMax: 30,
} as const;

export interface SubmitGuestQuestionInput {
  readonly productSlug: string;
  readonly topic: GuestQuestionTopic;
  readonly message: string;
  readonly guestName: string;
  readonly guestEmail: string;
  /** The language the guest wrote in; EN when not given. */
  readonly language?: GuestQuestionLanguage;
  /** The browser's key for this question: the same key again is the same question. */
  readonly clientRequestKey: string;
}

export interface GuestQuestionMessage {
  readonly id: string;
  readonly author: "GUEST" | "HOST";
  readonly source: "SITE_FORM" | "REPLY_PAGE" | "HOST_CONSOLE";
  /** The guest's own words, or the English the guest gets. */
  readonly body: string;
  /** Guest: the Japanese translation (null until one is made). Host: the Japanese they wrote, or null when they wrote English. */
  readonly bodyJa: string | null;
  readonly createdAtUtc: string;
  /** The email of a host message; null for the guest's. */
  readonly deliveryStatus: GuestQuestionDeliveryStatus | null;
}

/** One row of メッセージ's list. Never the guest's email address. */
export interface GuestQuestionThreadSummary {
  readonly id: string;
  readonly productId: string;
  readonly productTitle: string;
  readonly guestName: string;
  readonly topic: GuestQuestionTopic;
  readonly language: GuestQuestionLanguage;
  /** The guest wrote last and the host has not answered. */
  readonly needsReply: boolean;
  /** The OWNER opened it since the guest last wrote. */
  readonly read: boolean;
  readonly lastMessageAtUtc: string;
  readonly createdAtUtc: string;
  readonly lastMessage: GuestQuestionMessage;
}

export interface GuestQuestionThread extends Omit<GuestQuestionThreadSummary, "lastMessage"> {
  /** Oldest first. */
  readonly messages: readonly GuestQuestionMessage[];
}

export interface GuestQuestionThreadPage {
  readonly threads: readonly GuestQuestionThreadSummary[];
  /** Pass back as `cursor` for the next page; null on the last one. */
  readonly nextCursor: string | null;
}

/** A host reply the mail worker now sends. The raw token exists only here and in the email it builds. */
export interface ClaimedGuestQuestionReply {
  readonly messageId: string;
  readonly providerId: string;
  readonly threadId: string;
  readonly guestEmail: string;
  readonly guestName: string;
  readonly guestLanguage: GuestQuestionLanguage;
  readonly experienceTitle: string;
  readonly hostDisplayName: string;
  readonly english: string;
  /** For `/questions/reply#t=<token>`: in the URL fragment only, never in a query, a log or the outbox. */
  readonly replyToken: string;
  readonly replyLinkExpiresAtUtc: string;
  /** 1 for the first try. */
  readonly attempt: number;
}

/** What the reply page shows to whoever holds the link: the guest's words and the host's English, never the Japanese. */
export interface GuestQuestionReplyLink {
  readonly experienceTitle: string;
  readonly hostDisplayName: string;
  readonly guestName: string;
  readonly messages: readonly { readonly from: "guest" | "host"; readonly atUtc: string; readonly body: string }[];
  readonly expiresAtUtc: string;
}

const RECEIVED = { status: "received" } as const;
const TOPICS: ReadonlySet<string> = new Set(GUEST_QUESTION_TOPICS);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const REQUEST_KEY = /^[A-Za-z0-9._:-]{8,120}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Control characters other than tab and line breaks. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f-]{36})$/i;

function uuid(value: unknown, path: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new StoreValidationError(`${path} must be a UUID.`);
  return value.toLowerCase();
}

function text(value: unknown, path: string, min: number, max: number): string {
  if (typeof value !== "string" || CONTROL.test(value)) throw new StoreValidationError(`${path} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) throw new StoreValidationError(`${path} must contain ${min}-${max} characters.`);
  return trimmed;
}

function requestKey(value: unknown, path: string): string {
  if (typeof value !== "string" || !REQUEST_KEY.test(value)) throw new StoreValidationError(`${path} must be 8-120 letters, digits or ._:-`);
  return value;
}

function boundedInteger(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new StoreValidationError(`${path} must be an integer from ${min} to ${max}.`);
  return value;
}

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

interface ValidQuestion {
  productSlug: string;
  topic: GuestQuestionTopic;
  message: string;
  guestName: string;
  guestEmail: string;
  language: GuestQuestionLanguage;
  clientRequestKey: string;
}

function validQuestion(input: SubmitGuestQuestionInput): ValidQuestion {
  if (input === null || typeof input !== "object") throw new StoreValidationError("question must be an object.");
  if (typeof input.productSlug !== "string" || input.productSlug.length < 1 || input.productSlug.length > 160) throw new StoreValidationError("productSlug is invalid.");
  if (typeof input.topic !== "string" || !TOPICS.has(input.topic)) throw new StoreValidationError("topic is not a known topic.");
  const language = input.language ?? "EN";
  if (language !== "EN" && language !== "JA") throw new StoreValidationError("language must be EN or JA.");
  // A name is one line: runs of spaces and line breaks become one space.
  const name = typeof input.guestName === "string" ? input.guestName.replace(/\s+/g, " ") : input.guestName;
  const email = text(input.guestEmail, "guestEmail", 3, GUEST_QUESTION_LIMITS.guestEmailMaxLength);
  if (!EMAIL.test(email)) throw new StoreValidationError("guestEmail must be an email address.");
  return {
    productSlug: input.productSlug,
    topic: input.topic,
    message: text(input.message, "message", GUEST_QUESTION_LIMITS.questionMinLength, GUEST_QUESTION_LIMITS.guestMessageMaxLength),
    guestName: text(name, "guestName", 1, GUEST_QUESTION_LIMITS.guestNameMaxLength),
    guestEmail: email,
    language,
    clientRequestKey: requestKey(input.clientRequestKey, "clientRequestKey"),
  };
}

/** A current OWNER, not capped below OWNER by NIHO and not a product operator (as 設定 › 通知). */
async function requireOwner(client: PoolClient, actor: HostActor): Promise<void> {
  assertStoreIdentifier(actor.providerId, "actor.providerId");
  assertStoreIdentifier(actor.nihoUserId, "actor.nihoUserId");
  if (await calendarMembershipRole(client, actor, ["OWNER"]) !== "OWNER") throw new StoreAccessDeniedError();
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}

/** Only ids: names, addresses and what anyone wrote stay in the tables (docs/guest-questions.md). */
async function enqueue(client: PoolClient, providerId: string, threadId: string, messageId: string, topic: "guest_question.received" | "guest_question.reply"): Promise<void> {
  await client.query(
    `INSERT INTO outbox_messages (provider_id, aggregate_type, aggregate_id, topic, deduplication_key, payload)
     VALUES ($1, 'guest_question_thread', $2, $3, $4, $5::jsonb)`,
    [providerId, threadId, topic, `${topic}:${messageId}`, JSON.stringify({ threadId, messageId })],
  );
}

const MESSAGE_COLUMNS = "id, author, source, body, body_ja, created_at, delivery_status";
const THREAD_COLUMNS = `t.id, t.product_id, p.public_title, t.guest_name, t.topic, t.guest_language, t.needs_reply, t.host_read_at,
  t.last_message_at, t.created_at, to_char(t.last_message_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at`;

function messageFromRow(row: DbRow, prefix = ""): GuestQuestionMessage {
  const status = row[`${prefix}delivery_status`];
  const bodyJa = row[`${prefix}body_ja`];
  return {
    id: String(row[`${prefix}id`]),
    author: String(row[`${prefix}author`]) as GuestQuestionMessage["author"],
    source: String(row[`${prefix}source`]) as GuestQuestionMessage["source"],
    body: String(row[`${prefix}body`]),
    bodyJa: bodyJa === null || bodyJa === undefined ? null : String(bodyJa),
    createdAtUtc: isoValue(row, `${prefix}created_at`),
    deliveryStatus: status === null || status === undefined ? null : (String(status) as GuestQuestionDeliveryStatus),
  };
}

function threadFields(row: DbRow): Omit<GuestQuestionThreadSummary, "lastMessage"> {
  return {
    id: String(row.id),
    productId: String(row.product_id),
    productTitle: String(row.public_title),
    guestName: String(row.guest_name),
    topic: String(row.topic) as GuestQuestionTopic,
    language: String(row.guest_language) as GuestQuestionLanguage,
    needsReply: row.needs_reply === true,
    read: row.host_read_at !== null && row.host_read_at !== undefined,
    lastMessageAtUtc: isoValue(row, "last_message_at"),
    createdAtUtc: isoValue(row, "created_at"),
  };
}

function encodeCursor(row: DbRow): string {
  return Buffer.from(`${String(row.cursor_at)}|${String(row.id)}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: unknown): { at: string; id: string } | null {
  if (cursor === undefined || cursor === null) return null;
  if (typeof cursor !== "string" || cursor.length > 200) throw new StoreValidationError("cursor is invalid.");
  const match = CURSOR.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!match || !UUID.test(match[2]!)) throw new StoreValidationError("cursor is invalid.");
  return { at: match[1]!, id: match[2]!.toLowerCase() };
}

/**
 * 予約前の質問 (#105, #106; migration 0022). The question form and the reply page have no identity:
 * their methods take a slug or a one-time link. The host's methods need a current OWNER of the
 * provider (as 設定 › 通知). The mail job (/internal/experience-jobs/v1/drain) claims host replies, reports how each
 * went and erases questions a year after their last message.
 * The guest's email address leaves this class only in `claimReplyDeliveries`.
 */
export class GuestQuestionRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /* ---------- the traveler's form (public) ---------- */

  /** Whether the experience page offers "Ask the host": exactly one PUBLISHED experience has this slug. */
  async questionsOpen(productSlug: string): Promise<boolean> {
    if (typeof productSlug !== "string" || productSlug.length < 1 || productSlug.length > 160) return false;
    const result = await this.#pool.query("SELECT 1 FROM experience_products WHERE slug = $1 AND status = 'PUBLISHED' LIMIT 2", [productSlug]);
    return result.rows.length === 1;
  }

  /**
   * A new question: the thread, the guest's message and the outbox event in one transaction. The same
   * clientRequestKey for the experience again answers `received` without a second thread. Throws
   * StoreNotFoundError unless the experience is PUBLISHED, StoreRateLimitedError past the hourly limits.
   */
  async submitQuestion(input: SubmitGuestQuestionInput): Promise<{ status: "received" }> {
    const question = validQuestion(input);
    return withTransaction(this.#pool, async (client) => {
      // A slug is unique per provider only: two published experiences with it answer neither.
      const products = await client.query<DbRow>(
        `SELECT provider_id, id FROM experience_products WHERE slug = $1 AND status = 'PUBLISHED'
          ORDER BY provider_id, id LIMIT 2 FOR SHARE`,
        [question.productSlug],
      );
      const product = products.rows.length === 1 ? products.rows[0]! : undefined;
      if (!product) throw new StoreNotFoundError("published experience");
      const providerId = String(product.provider_id);
      const productId = String(product.id);
      // One question at a time per experience, so the counts below hold until this one is in.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 53))", [`guest-questions:${providerId}/${productId}`]);
      const repeated = await client.query(
        "SELECT 1 FROM guest_question_threads WHERE provider_id = $1 AND product_id = $2 AND client_request_key = $3",
        [providerId, productId, question.clientRequestKey],
      );
      if (repeated.rows[0]) return RECEIVED;

      const counts = await client.query<DbRow>(
        `SELECT count(*) FILTER (WHERE guest_email_key = lower($3))::int AS by_guest,
                count(*)::int AS by_product,
                GREATEST(1, ceil(extract(epoch FROM min(created_at) FILTER (WHERE guest_email_key = lower($3)) + interval '60 minutes' - clock_timestamp())))::int AS guest_retry,
                GREATEST(1, ceil(extract(epoch FROM min(created_at) + interval '60 minutes' - clock_timestamp())))::int AS product_retry
           FROM guest_question_threads
          WHERE provider_id = $1 AND product_id = $2 AND created_at > clock_timestamp() - interval '60 minutes'`,
        [providerId, productId, question.guestEmail],
      );
      const count = counts.rows[0]!;
      if (Number(count.by_guest) >= GUEST_QUESTION_LIMITS.newThreadsPerGuestPerHour) throw new StoreRateLimitedError(Number(count.guest_retry));
      if (Number(count.by_product) >= GUEST_QUESTION_LIMITS.newThreadsPerProductPerHour) throw new StoreRateLimitedError(Number(count.product_retry));

      const threadId = randomUUID();
      const messageId = randomUUID();
      await client.query(
        `WITH now AS (SELECT clock_timestamp() AS at)
         INSERT INTO guest_question_threads
           (id, provider_id, product_id, topic, guest_name, guest_email, guest_email_key, guest_language, client_request_key, last_message_at, created_at)
         SELECT $1::uuid, $2, $3, $4, $5, $6, lower($6), $7, $8, now.at, now.at FROM now`,
        [threadId, providerId, productId, question.topic, question.guestName, question.guestEmail, question.language, question.clientRequestKey],
      );
      await client.query(
        `INSERT INTO guest_question_messages (id, provider_id, thread_id, author, source, body, created_at)
         SELECT $1::uuid, $2, $3::uuid, 'GUEST', 'SITE_FORM', $4, last_message_at
           FROM guest_question_threads WHERE provider_id = $2 AND id = $3::uuid`,
        [messageId, providerId, threadId, question.message],
      );
      await enqueue(client, providerId, threadId, messageId, "guest_question.received");
      return RECEIVED;
    });
  }

  /* ---------- the host console (OWNER) ---------- */

  /** The provider's threads, the latest first. `cursor` is the previous page's nextCursor. */
  async listThreads(actor: HostActor, options: { unreadOnly?: boolean; cursor?: string | null; limit?: number } = {}): Promise<GuestQuestionThreadPage> {
    const limit = boundedInteger(options.limit ?? 30, "limit", 1, 100);
    const after = decodeCursor(options.cursor);
    return withTransaction(this.#pool, async (client) => {
      await requireOwner(client, actor);
      const result = await client.query<DbRow>(
        `SELECT ${THREAD_COLUMNS},
                m.id AS m_id, m.author AS m_author, m.source AS m_source, m.body AS m_body, m.body_ja AS m_body_ja,
                m.created_at AS m_created_at, m.delivery_status AS m_delivery_status
           FROM guest_question_threads t
           JOIN experience_products p ON p.provider_id = t.provider_id AND p.id = t.product_id
           JOIN LATERAL (
             SELECT ${MESSAGE_COLUMNS} FROM guest_question_messages
              WHERE provider_id = t.provider_id AND thread_id = t.id
              ORDER BY created_at DESC, id DESC LIMIT 1
           ) m ON true
          WHERE t.provider_id = $1
            AND (NOT $2::boolean OR t.host_read_at IS NULL)
            AND ($3::timestamptz IS NULL OR (t.last_message_at, t.id) < ($3::timestamptz, $4::uuid))
          ORDER BY t.last_message_at DESC, t.id DESC
          LIMIT $5`,
        [actor.providerId, options.unreadOnly === true, after?.at ?? null, after?.id ?? null, limit + 1],
      );
      const rows = result.rows.slice(0, limit);
      return {
        threads: rows.map((row) => ({ ...threadFields(row), lastMessage: messageFromRow(row, "m_") })),
        nextCursor: result.rows.length > limit ? encodeCursor(rows.at(-1)!) : null,
      };
    });
  }

  /** One thread with every message, oldest first. Another provider's is not found. */
  async getThread(actor: HostActor, threadId: string): Promise<GuestQuestionThread> {
    const id = uuid(threadId, "threadId");
    return withTransaction(this.#pool, async (client) => {
      await requireOwner(client, actor);
      const thread = await client.query<DbRow>(
        `SELECT ${THREAD_COLUMNS} FROM guest_question_threads t
           JOIN experience_products p ON p.provider_id = t.provider_id AND p.id = t.product_id
          WHERE t.provider_id = $1 AND t.id = $2::uuid`,
        [actor.providerId, id],
      );
      const row = thread.rows[0];
      if (!row) throw new StoreNotFoundError("guest question");
      const messages = await client.query<DbRow>(
        `SELECT ${MESSAGE_COLUMNS} FROM guest_question_messages WHERE provider_id = $1 AND thread_id = $2::uuid ORDER BY created_at, id`,
        [actor.providerId, id],
      );
      return { ...threadFields(row), messages: messages.rows.map((message) => messageFromRow(message)) };
    });
  }

  /** The OWNER opened the thread. Already read stays read from the first time. */
  async markThreadRead(actor: HostActor, threadId: string): Promise<void> {
    const id = uuid(threadId, "threadId");
    await withTransaction(this.#pool, async (client) => {
      await requireOwner(client, actor);
      const result = await client.query(
        "UPDATE guest_question_threads SET host_read_at = COALESCE(host_read_at, clock_timestamp()) WHERE provider_id = $1 AND id = $2::uuid",
        [actor.providerId, id],
      );
      if ((result.rowCount ?? 0) === 0) throw new StoreNotFoundError("guest question");
    });
  }

  /**
   * 返信: the English the guest gets (and the Japanese the host wrote, or null), queued for the mail
   * worker. The same commandId with the same reply answers the same message; with anything else,
   * StoreConflictError.
   */
  async reply(actor: HostActor, threadId: string, input: { english: string; japanese: string | null; commandId: string }): Promise<GuestQuestionMessage> {
    const id = uuid(threadId, "threadId");
    const commandId = uuid(input?.commandId, "commandId");
    const english = text(input?.english, "english", 1, GUEST_QUESTION_LIMITS.hostMessageMaxLength);
    const japanese = input?.japanese === null || input?.japanese === undefined || (typeof input.japanese === "string" && input.japanese.trim() === "")
      ? null
      : text(input.japanese, "japanese", 1, GUEST_QUESTION_LIMITS.hostMessageMaxLength);
    try {
      return await withTransaction(this.#pool, async (client) => {
        await requireOwner(client, actor);
        const thread = await client.query(
          "SELECT 1 FROM guest_question_threads WHERE provider_id = $1 AND id = $2::uuid FOR NO KEY UPDATE",
          [actor.providerId, id],
        );
        if (!thread.rows[0]) throw new StoreNotFoundError("guest question");
        const previous = await client.query<DbRow>(
          `SELECT ${MESSAGE_COLUMNS}, thread_id, author_niho_user_id FROM guest_question_messages WHERE provider_id = $1 AND command_id = $2::uuid`,
          [actor.providerId, commandId],
        );
        const before = previous.rows[0];
        if (before) {
          const same = String(before.thread_id) === id && before.body === english && (before.body_ja ?? null) === japanese && before.author_niho_user_id === actor.nihoUserId;
          if (!same) throw new StoreConflictError("The reply command ID was already used with a different reply.");
          return messageFromRow(before);
        }
        const inserted = await client.query<DbRow>(
          `INSERT INTO guest_question_messages
             (id, provider_id, thread_id, author, source, body, body_ja, author_niho_user_id, command_id, delivery_status, created_at)
           VALUES ($1::uuid, $2, $3::uuid, 'HOST', 'HOST_CONSOLE', $4, $5, $6, $7::uuid, 'PENDING', clock_timestamp())
           RETURNING ${MESSAGE_COLUMNS}`,
          [randomUUID(), actor.providerId, id, english, japanese, actor.nihoUserId, commandId],
        );
        const message = inserted.rows[0]!;
        // Dated by the message itself (a Date parameter would lose the microseconds).
        await client.query(
          `UPDATE guest_question_threads t
              SET needs_reply = false, last_message_at = m.created_at, host_read_at = COALESCE(t.host_read_at, m.created_at)
             FROM guest_question_messages m
            WHERE t.provider_id = $1 AND t.id = $2::uuid AND m.provider_id = $1 AND m.id = $3::uuid`,
          [actor.providerId, id, message.id],
        );
        await enqueue(client, actor.providerId, id, String(message.id), "guest_question.reply");
        return messageFromRow(message);
      });
    } catch (error) {
      // The same command ID racing on another thread.
      if (isUniqueViolation(error)) throw new StoreConflictError("The reply command ID was already used with a different reply.");
      throw error;
    }
  }

  /* ---------- the mail job (server-side, #285 slice 5) ---------- */

  /**
   * Up to `limit` host replies to email now: PENDING ones whose backoff has passed and SENDING ones
   * whose lease ran out, with attempts left. Each becomes SENDING for `leaseSeconds` and gets a fresh
   * one-time reply link valid for `linkTtlDays` (only its SHA-256 is stored).
   */
  async claimReplyDeliveries(options: { limit: number; leaseSeconds: number; linkTtlDays: number }): Promise<ClaimedGuestQuestionReply[]> {
    const limit = boundedInteger(options?.limit, "limit", 1, 50);
    const leaseSeconds = boundedInteger(options?.leaseSeconds, "leaseSeconds", 30, 3600);
    const linkTtlDays = boundedInteger(options?.linkTtlDays, "linkTtlDays", 1, GUEST_QUESTION_LIMITS.linkTtlDaysMax);
    return withTransaction(this.#pool, async (client) => {
      // The last attempt's lease ran out without a report: the reply could not be sent.
      await client.query(
        `UPDATE guest_question_messages SET delivery_status = 'FAILED', lease_until = NULL
          WHERE delivery_status = 'SENDING' AND lease_until <= clock_timestamp() AND delivery_attempts >= $1`,
        [GUEST_QUESTION_LIMITS.deliveryAttempts],
      );
      const claimed = await client.query<DbRow>(
        `WITH due AS (
           SELECT provider_id, id FROM guest_question_messages
            WHERE delivery_status IN ('PENDING', 'SENDING') AND delivery_attempts < $3
              AND (lease_until IS NULL OR lease_until <= clock_timestamp())
            ORDER BY created_at, id
            LIMIT $1
            FOR UPDATE SKIP LOCKED
         )
         UPDATE guest_question_messages m
            SET delivery_status = 'SENDING', delivery_attempts = m.delivery_attempts + 1,
                lease_until = clock_timestamp() + make_interval(secs => $2)
           FROM due
          WHERE m.provider_id = due.provider_id AND m.id = due.id
         RETURNING m.id, m.provider_id, m.thread_id, m.body, m.delivery_attempts, m.created_at`,
        [limit, leaseSeconds, GUEST_QUESTION_LIMITS.deliveryAttempts],
      );
      const rows = [...claimed.rows].sort((a, b) => isoValue(a, "created_at").localeCompare(isoValue(b, "created_at")) || String(a.id).localeCompare(String(b.id)));
      const deliveries: ClaimedGuestQuestionReply[] = [];
      for (const row of rows) {
        const details = await client.query<DbRow>(
          `SELECT t.guest_email, t.guest_name, t.guest_language, p.public_title, p.seller_display_name
             FROM guest_question_threads t
             JOIN experience_products p ON p.provider_id = t.provider_id AND p.id = t.product_id
            WHERE t.provider_id = $1 AND t.id = $2::uuid`,
          [row.provider_id, row.thread_id],
        );
        const detail = details.rows[0]!;
        const replyToken = randomBytes(32).toString("base64url");
        const link = await client.query<DbRow>(
          `WITH now AS (SELECT clock_timestamp() AS at)
           INSERT INTO guest_question_reply_tokens (token_hash, provider_id, thread_id, host_message_id, expires_at, created_at)
           SELECT $1, $2, $3::uuid, $4::uuid, now.at + make_interval(days => $5), now.at FROM now
           RETURNING expires_at`,
          [tokenDigest(replyToken), row.provider_id, row.thread_id, row.id, linkTtlDays],
        );
        deliveries.push({
          messageId: String(row.id),
          providerId: String(row.provider_id),
          threadId: String(row.thread_id),
          guestEmail: String(detail.guest_email),
          guestName: String(detail.guest_name),
          guestLanguage: String(detail.guest_language) as GuestQuestionLanguage,
          experienceTitle: String(detail.public_title),
          hostDisplayName: String(detail.seller_display_name),
          english: String(row.body),
          replyToken,
          replyLinkExpiresAtUtc: isoValue(link.rows[0]!, "expires_at"),
          attempt: Number(row.delivery_attempts),
        });
      }
      return deliveries;
    });
  }

  /**
   * How a claimed reply went. SENT always wins (a late report after the lease ran out still stops a
   * second email); RETRY and FAILED change only a reply that is SENDING. RETRY waits 2, 4, 8 or 16
   * minutes, and becomes FAILED once no attempts are left. Answers the status the reply has now.
   */
  async recordReplyDelivery(messageId: string, outcome: GuestQuestionDeliveryOutcome): Promise<GuestQuestionDeliveryStatus> {
    const id = uuid(messageId, "messageId");
    if (outcome !== "SENT" && outcome !== "RETRY" && outcome !== "FAILED") throw new StoreValidationError("outcome must be SENT, RETRY or FAILED.");
    const updated = await this.#pool.query<DbRow>(
      `UPDATE guest_question_messages
          SET delivery_status = CASE
                WHEN $2 = 'SENT' THEN 'SENT'
                WHEN $2 = 'RETRY' AND delivery_attempts < $3 THEN 'PENDING'
                ELSE 'FAILED' END,
              delivered_at = CASE WHEN $2 = 'SENT' THEN clock_timestamp() END,
              lease_until = CASE WHEN $2 = 'RETRY' AND delivery_attempts < $3
                THEN clock_timestamp() + make_interval(mins => (2 ^ delivery_attempts)::int) END
        WHERE id = $1::uuid AND author = 'HOST'
          AND (delivery_status = 'SENDING' OR ($2 = 'SENT' AND delivery_status <> 'SENT'))
        RETURNING delivery_status`,
      [id, outcome, GUEST_QUESTION_LIMITS.deliveryAttempts],
    );
    if (updated.rows[0]) return String(updated.rows[0].delivery_status) as GuestQuestionDeliveryStatus;
    const current = await this.#pool.query<DbRow>("SELECT delivery_status FROM guest_question_messages WHERE id = $1::uuid AND author = 'HOST'", [id]);
    if (!current.rows[0]) throw new StoreNotFoundError("host reply");
    return String(current.rows[0].delivery_status) as GuestQuestionDeliveryStatus;
  }

  /**
   * Deletes questions whose last message is older than `lastMessageBefore` (never after now), at most
   * `limit` per call; returns how many. Their messages and reply links go with them (ON DELETE CASCADE);
   * outbox rows name ids only and stay. The owner decided (2026-10-31, #285) one year after the last
   * message; the mail job calls this with now − 1 year (docs/guest-questions.md).
   */
  async eraseInactiveThreads(options: { readonly lastMessageBefore: string; readonly limit?: number }): Promise<number> {
    assertCanonicalInstant(options?.lastMessageBefore, "lastMessageBefore");
    const limit = boundedInteger(options.limit ?? 500, "limit", 1, 5_000);
    const result = await this.#pool.query(
      `WITH due AS (
         SELECT provider_id, id FROM guest_question_threads
          WHERE last_message_at < LEAST($1::timestamptz, clock_timestamp())
          ORDER BY last_message_at, id
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       DELETE FROM guest_question_threads t
        USING due
        WHERE t.provider_id = due.provider_id AND t.id = due.id`,
      [options.lastMessageBefore, limit],
    );
    return result.rowCount ?? 0;
  }

  /* ---------- the guest's reply page (one-time link) ---------- */

  /** The conversation behind a reply link; null when the link is unknown, expired or already used. */
  async openReplyLink(token: string): Promise<GuestQuestionReplyLink | null> {
    if (typeof token !== "string" || !TOKEN.test(token)) return null;
    const found = await this.#pool.query<DbRow>(
      `SELECT r.provider_id, r.thread_id, r.expires_at, r.used_at, r.expires_at > clock_timestamp() AS open,
              t.guest_name, p.public_title, p.seller_display_name
         FROM guest_question_reply_tokens r
         JOIN guest_question_threads t ON t.provider_id = r.provider_id AND t.id = r.thread_id
         JOIN experience_products p ON p.provider_id = t.provider_id AND p.id = t.product_id
        WHERE r.token_hash = $1`,
      [tokenDigest(token)],
    );
    const row = found.rows[0];
    if (!row || row.used_at !== null || row.open !== true) return null;
    const messages = await this.#pool.query<DbRow>(
      "SELECT author, body, created_at FROM guest_question_messages WHERE provider_id = $1 AND thread_id = $2 ORDER BY created_at, id",
      [row.provider_id, row.thread_id],
    );
    return {
      experienceTitle: String(row.public_title),
      hostDisplayName: String(row.seller_display_name),
      guestName: String(row.guest_name),
      // The host's English only: the Japanese they wrote is for the host console.
      messages: messages.rows.map((message) => ({ from: message.author === "HOST" ? "host" : "guest", atUtc: isoValue(message, "created_at"), body: String(message.body) })),
      expiresAtUtc: isoValue(row, "expires_at"),
    };
  }

  /**
   * The guest's answer through a reply link. The link answers once: the same clientRequestKey again
   * answers `received`; another answer is StoreConflictError. Unknown or expired: StoreNotFoundError.
   */
  async submitGuestReply(token: string, input: { message: string; clientRequestKey: string }): Promise<{ status: "received" }> {
    if (typeof token !== "string" || !TOKEN.test(token)) throw new StoreNotFoundError("reply link");
    const message = text(input?.message, "message", 1, GUEST_QUESTION_LIMITS.guestMessageMaxLength);
    const key = requestKey(input?.clientRequestKey, "clientRequestKey");
    try {
      return await withTransaction(this.#pool, async (client) => {
        const found = await client.query<DbRow>(
          `SELECT provider_id, thread_id, used_at, used_client_request_key, expires_at > clock_timestamp() AS open
             FROM guest_question_reply_tokens WHERE token_hash = $1 FOR UPDATE`,
          [tokenDigest(token)],
        );
        const link = found.rows[0];
        if (!link) throw new StoreNotFoundError("reply link");
        if (link.used_at !== null) {
          if (link.used_client_request_key === key) return RECEIVED;
          throw new StoreConflictError("The reply link was already used.");
        }
        if (link.open !== true) throw new StoreNotFoundError("reply link");
        const providerId = String(link.provider_id);
        const threadId = String(link.thread_id);
        await client.query("SELECT 1 FROM guest_question_threads WHERE provider_id = $1 AND id = $2::uuid FOR NO KEY UPDATE", [providerId, threadId]);
        const inserted = await client.query<DbRow>(
          `INSERT INTO guest_question_messages (id, provider_id, thread_id, author, source, body, client_request_key, created_at)
           VALUES ($1::uuid, $2, $3::uuid, 'GUEST', 'REPLY_PAGE', $4, $5, clock_timestamp())
           RETURNING id`,
          [randomUUID(), providerId, threadId, message, key],
        );
        const created = inserted.rows[0]!;
        await client.query(
          `UPDATE guest_question_reply_tokens r SET used_at = m.created_at, used_client_request_key = $3
             FROM guest_question_messages m
            WHERE r.token_hash = $1 AND m.provider_id = r.provider_id AND m.id = $2::uuid`,
          [tokenDigest(token), created.id, key],
        );
        await client.query(
          `UPDATE guest_question_threads t SET needs_reply = true, host_read_at = NULL, last_message_at = m.created_at
             FROM guest_question_messages m
            WHERE t.provider_id = $1 AND t.id = $2::uuid AND m.provider_id = $1 AND m.id = $3::uuid`,
          [providerId, threadId, created.id],
        );
        await enqueue(client, providerId, threadId, String(created.id), "guest_question.received");
        return RECEIVED;
      });
    } catch (error) {
      // The same answer sent through another of the thread's links.
      if (isUniqueViolation(error)) throw new StoreConflictError("This answer was already received.");
      throw error;
    }
  }
}
