import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { BookingMessagesClosedError, StoreAccessDeniedError, StoreConflictError, StoreNotFoundError, StoreRateLimitedError, StoreValidationError } from "./errors.ts";
import { enqueueBookingMessageNotification, enqueueGuestQuestionNotification } from "./host-notification-outbox.ts";
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
/**
 * Where a message was written: the experience page's question form, the question reply page, a guest's booking page
 * (#285 slice 6b) or the host console.
 */
export type GuestQuestionMessageSource = "SITE_FORM" | "REPLY_PAGE" | "BOOKING_PAGE" | "HOST_CONSOLE";
/** A question before booking, or the messages of one booking made on this site (#285 slice 6b). */
export type GuestThreadKind = "QUESTION" | "BOOKING";
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
  /** A booking's messages (#285 slice 6b): a guest's messages per booking in an hour. */
  bookingMessagesPerHour: 10,
  /** A booking's messages stay open until this many days after the experience (as its page and sessions). */
  bookingMessageDaysAfterExperience: 30,
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
  readonly source: GuestQuestionMessageSource;
  /** The guest's own words, or the English the guest gets. */
  readonly body: string;
  /** Guest: the Japanese translation (null until one is made). Host: the Japanese they wrote, or null when they wrote English. */
  readonly bodyJa: string | null;
  readonly createdAtUtc: string;
  /** The email of a host message; null for the guest's. */
  readonly deliveryStatus: GuestQuestionDeliveryStatus | null;
}

/** The booking a thread is about (#285 slice 6b), as the host reads it: never the guest's address or phone. */
export interface GuestQuestionThreadBooking {
  readonly publicBookingId: string;
  readonly status: "CONFIRMED" | "PAYMENT_REVIEW" | "CANCELLED";
  /** The occurrence as booked (the snapshot), in its own time zone. */
  readonly localDate: string;
  readonly localStartTime: string;
  readonly startUtc: string;
  readonly adultCount: number;
  readonly childCount: number;
  /**
   * Messages may still be written, by the guest and the host: the booking is confirmed or under payment review, and
   * its experience ended less than 30 days ago. Otherwise the history stays readable only.
   */
  readonly open: boolean;
}

/** One row of メッセージ's list. Never the guest's email address. */
export interface GuestQuestionThreadSummary {
  readonly id: string;
  readonly productId: string;
  readonly productTitle: string;
  /** The guest's name: the question's, or the booking's (from its guest record). */
  readonly guestName: string;
  /** What a question is about; null for a booking's thread. */
  readonly topic: GuestQuestionTopic | null;
  readonly language: GuestQuestionLanguage;
  /** The booking the thread is about; null for a question before booking. */
  readonly booking: GuestQuestionThreadBooking | null;
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

interface ClaimedHostMessage {
  readonly messageId: string;
  readonly providerId: string;
  readonly threadId: string;
  readonly guestEmail: string;
  readonly guestName: string;
  readonly guestLanguage: GuestQuestionLanguage;
  readonly experienceTitle: string;
  readonly hostDisplayName: string;
  readonly english: string;
  /** 1 for the first try. */
  readonly attempt: number;
}

/** A host reply to a question the mail worker now sends. The raw token exists only here and in the email it builds. */
export interface ClaimedQuestionReply extends ClaimedHostMessage {
  readonly kind: "QUESTION";
  /** For `/questions/reply#t=<token>`: in the URL fragment only, never in a query, a log or the outbox. */
  readonly replyToken: string;
  readonly replyLinkExpiresAtUtc: string;
}

/**
 * A host message in a booking's thread (#285 slice 6b) the mail worker now sends. It carries no reply link: the
 * worker links to the booking page with a fresh one-time grant (GuestBookingAccess), when the page is open.
 */
export interface ClaimedBookingMessage extends ClaimedHostMessage {
  readonly kind: "BOOKING";
  readonly publicBookingId: string;
  /** The occurrence as booked (the snapshot), in its own time zone. */
  readonly localDate: string;
  readonly localStartTime: string;
  readonly timeZone: string;
}

/** What the mail worker sends: a reply to a question, or a host message about a booking. */
export type ClaimedGuestQuestionReply = ClaimedQuestionReply | ClaimedBookingMessage;

/** Before anyone wrote in a booking's thread, what メッセージ shows of it (#285 slice 6b). */
export interface GuestBookingThreadStart {
  /** The booking's thread, or null before anyone wrote. */
  readonly threadId: string | null;
  readonly productId: string;
  readonly productTitle: string;
  readonly guestName: string;
  readonly language: GuestQuestionLanguage;
  readonly booking: GuestQuestionThreadBooking;
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

/** Validated host reply input: the English the guest gets, and the Japanese the host wrote (or null). */
interface ValidReply {
  english: string;
  japanese: string | null;
  commandId: string;
}

function validReply(input: { english: string; japanese: string | null; commandId: string }): ValidReply {
  const commandId = uuid(input?.commandId, "commandId");
  const english = text(input?.english, "english", 1, GUEST_QUESTION_LIMITS.hostMessageMaxLength);
  const japanese = input?.japanese === null || input?.japanese === undefined || (typeof input.japanese === "string" && input.japanese.trim() === "")
    ? null
    : text(input.japanese, "japanese", 1, GUEST_QUESTION_LIMITS.hostMessageMaxLength);
  return { english, japanese, commandId };
}

/** The statuses whose booking has a thread to read (never a hold or an abandoned one). */
const BOOKING_THREAD_STATUSES = ["CONFIRMED", "PAYMENT_REVIEW", "CANCELLED"] as const;
const BOOKING_END = (b: string) => `(${b}.occurrence_snapshot->>'endUtc')::timestamptz`;

/**
 * SQL: the booking `b` still takes messages (#285 slice 6b): confirmed or under payment review, and its experience
 * ended less than 30 days ago (the database's clock).
 */
export function bookingMessagesOpenSql(b: string): string {
  return `(${b}.status IN ('CONFIRMED', 'PAYMENT_REVIEW') AND ${BOOKING_END(b)} + make_interval(days => ${GUEST_QUESTION_LIMITS.bookingMessageDaysAfterExperience}) > clock_timestamp())`;
}

/** One booking's messages at a time (the guest's page and the host console), so its one thread and the hourly count hold. */
export async function lockBookingMessages(client: PoolClient, providerId: string, bookingRowId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 59))", [`booking-messages:${providerId}/${bookingRowId}`]);
}

/** The booking's thread, locked for a new message; null before anyone wrote. Call under lockBookingMessages. */
export async function lockedBookingThread(client: PoolClient, providerId: string, bookingRowId: string): Promise<string | null> {
  const found = await client.query<DbRow>(
    "SELECT id FROM guest_question_threads WHERE provider_id = $1 AND booking_id = $2::bigint FOR NO KEY UPDATE",
    [providerId, bookingRowId],
  );
  return found.rows[0] ? String(found.rows[0].id) : null;
}

/** A booking's thread, started by whoever writes first. It keeps no name or address: they stay in booking_guests. */
export async function createBookingThread(client: PoolClient, booking: { providerId: string; bookingRowId: string; productId: string; language: GuestQuestionLanguage }): Promise<string> {
  const threadId = randomUUID();
  await client.query(
    `WITH now AS (SELECT clock_timestamp() AS at)
     INSERT INTO guest_question_threads (id, provider_id, product_id, booking_id, guest_language, last_message_at, created_at)
     SELECT $1::uuid, $2, $3, $4::bigint, $5, now.at, now.at FROM now`,
    [threadId, booking.providerId, booking.productId, booking.bookingRowId, booking.language],
  );
  return threadId;
}

/** A current OWNER, not capped below OWNER by NIHO and not a product operator (as 設定 › 通知). */
export async function requireOwner(client: PoolClient, actor: HostActor): Promise<void> {
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

/**
 * A guest wrote to the host: `guest_question.received` (the Japanese translation, #285 slice 5) and the
 * host's push (GUEST_MESSAGE, which the OWNER can turn off), each its own row because a row is done once.
 */
async function enqueueGuestMessage(client: PoolClient, providerId: string, threadId: string, messageId: string, experienceTitle: string): Promise<void> {
  await enqueue(client, providerId, threadId, messageId, "guest_question.received");
  await enqueueGuestQuestionNotification(client, { providerId, threadId, messageId, experienceTitle });
}

/**
 * A guest wrote on their booking page (#285 slice 6b): the same translation row as a question, and the host's push
 * with the booking's time and party (GUEST_MESSAGE, which the OWNER can turn off).
 */
export async function enqueueBookingGuestMessage(
  client: PoolClient,
  input: { providerId: string; threadId: string; messageId: string; experienceTitle: string; startsAt: string; seats: number },
): Promise<void> {
  await enqueue(client, input.providerId, input.threadId, input.messageId, "guest_question.received");
  await enqueueBookingMessageNotification(client, input);
}

const MESSAGE_COLUMNS = "id, author, source, body, body_ja, created_at, delivery_status";
/** A thread with its experience and, for a booking's thread, the booking and its guest record (never the address). */
const THREAD_FROM = `guest_question_threads t
  JOIN experience_products p ON p.provider_id = t.provider_id AND p.id = t.product_id
  LEFT JOIN bookings b ON b.provider_id = t.provider_id AND b.id = t.booking_id
  LEFT JOIN booking_guests g ON g.provider_id = t.provider_id AND g.booking_id = t.booking_id`;
const BOOKING_COLUMNS = `b.public_booking_id::text AS booking_public_id, b.status AS booking_status,
  b.occurrence_snapshot->>'localDate' AS booking_local_date, b.occurrence_snapshot->>'localStartTime' AS booking_local_start,
  b.occurrence_snapshot->>'startUtc' AS booking_start_utc, g.adult_count AS booking_adults, g.child_count AS booking_children,
  ${bookingMessagesOpenSql("b")} AS booking_open`;
const THREAD_COLUMNS = `t.id, t.product_id, p.public_title, COALESCE(t.guest_name, g.guest_name) AS guest_name, t.topic, t.guest_language,
  t.needs_reply, t.host_read_at, t.last_message_at, t.created_at,
  to_char(t.last_message_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at, ${BOOKING_COLUMNS}`;

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

/** The booking columns of BOOKING_COLUMNS as the host reads them; null for a question's thread. */
function threadBooking(row: DbRow): GuestQuestionThreadBooking | null {
  if (row.booking_public_id === null || row.booking_public_id === undefined) return null;
  const status = String(row.booking_status);
  return {
    publicBookingId: String(row.booking_public_id),
    status: (BOOKING_THREAD_STATUSES as readonly string[]).includes(status) ? status as GuestQuestionThreadBooking["status"] : "CANCELLED",
    localDate: String(row.booking_local_date),
    localStartTime: String(row.booking_local_start),
    startUtc: new Date(String(row.booking_start_utc)).toISOString(),
    adultCount: Number(row.booking_adults ?? 0),
    childCount: Number(row.booking_children ?? 0),
    open: row.booking_open === true,
  };
}

function threadFields(row: DbRow): Omit<GuestQuestionThreadSummary, "lastMessage"> {
  return {
    id: String(row.id),
    productId: String(row.product_id),
    productTitle: String(row.public_title),
    guestName: String(row.guest_name ?? ""),
    topic: row.topic === null || row.topic === undefined ? null : String(row.topic) as GuestQuestionTopic,
    language: String(row.guest_language) as GuestQuestionLanguage,
    booking: threadBooking(row),
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

function threadKind(value: unknown): GuestThreadKind | null {
  if (value === undefined || value === null) return null;
  if (value !== "QUESTION" && value !== "BOOKING") throw new StoreValidationError("kind must be QUESTION or BOOKING.");
  return value;
}

/** A booking made on this site with what its thread needs, read in the provider's scope. */
interface BookingForThread {
  bookingRowId: string;
  threadId: string | null;
  productId: string;
  productTitle: string;
  guestName: string;
  language: GuestQuestionLanguage;
  experienceTitle: string;
  view: GuestQuestionThreadBooking;
}

/**
 * The provider's booking made on this site by its public ID: confirmed, under payment review or cancelled, with a
 * guest record not erased. null for anything else (another provider's, a hold, NIHO's, erased).
 */
export async function bookingForThread(client: PoolClient, providerId: string, publicBookingId: string): Promise<BookingForThread | null> {
  const found = await client.query<DbRow>(
    `SELECT b.id::text AS booking_row_id, b.product_id, p.public_title, g.guest_name, g.guest_language, t.id AS thread_id,
            ${BOOKING_COLUMNS}
       FROM bookings b
       JOIN booking_guests g ON g.provider_id = b.provider_id AND g.booking_id = b.id
       JOIN experience_products p ON p.provider_id = b.provider_id AND p.id = b.product_id
       LEFT JOIN guest_question_threads t ON t.provider_id = b.provider_id AND t.booking_id = b.id
      WHERE b.provider_id = $1 AND b.public_booking_id = $2::uuid AND b.status = ANY($3::text[]) AND g.pii_erased_at IS NULL`,
    [providerId, publicBookingId, BOOKING_THREAD_STATUSES],
  );
  const row = found.rows[0];
  if (!row) return null;
  return {
    bookingRowId: String(row.booking_row_id),
    threadId: row.thread_id === null || row.thread_id === undefined ? null : String(row.thread_id),
    productId: String(row.product_id),
    productTitle: String(row.public_title),
    guestName: String(row.guest_name ?? ""),
    language: String(row.guest_language) as GuestQuestionLanguage,
    experienceTitle: String(row.public_title),
    view: threadBooking(row)!,
  };
}

/**
 * The host's message in a thread locked for it: the same command again answers the same message, another reply with
 * it is refused; a closed booking's thread takes no new one. Queued for the mail worker (`guest_question.reply`).
 */
async function insertHostReply(client: PoolClient, actor: HostActor, threadId: string, reply: ValidReply, open: boolean): Promise<GuestQuestionMessage> {
  const previous = await client.query<DbRow>(
    `SELECT ${MESSAGE_COLUMNS}, thread_id, author_niho_user_id FROM guest_question_messages WHERE provider_id = $1 AND command_id = $2::uuid`,
    [actor.providerId, reply.commandId],
  );
  const before = previous.rows[0];
  if (before) {
    const same = String(before.thread_id) === threadId && before.body === reply.english && (before.body_ja ?? null) === reply.japanese && before.author_niho_user_id === actor.nihoUserId;
    if (!same) throw new StoreConflictError("The reply command ID was already used with a different reply.");
    return messageFromRow(before);
  }
  if (!open) throw new BookingMessagesClosedError();
  const inserted = await client.query<DbRow>(
    `INSERT INTO guest_question_messages
       (id, provider_id, thread_id, author, source, body, body_ja, author_niho_user_id, command_id, delivery_status, created_at)
     VALUES ($1::uuid, $2, $3::uuid, 'HOST', 'HOST_CONSOLE', $4, $5, $6, $7::uuid, 'PENDING', clock_timestamp())
     RETURNING ${MESSAGE_COLUMNS}`,
    [randomUUID(), actor.providerId, threadId, reply.english, reply.japanese, actor.nihoUserId, reply.commandId],
  );
  const message = inserted.rows[0]!;
  // Dated by the message itself (a Date parameter would lose the microseconds).
  await client.query(
    `UPDATE guest_question_threads t
        SET needs_reply = false, last_message_at = m.created_at, host_read_at = COALESCE(t.host_read_at, m.created_at)
       FROM guest_question_messages m
      WHERE t.provider_id = $1 AND t.id = $2::uuid AND m.provider_id = $1 AND m.id = $3::uuid`,
    [actor.providerId, threadId, message.id],
  );
  await enqueue(client, actor.providerId, threadId, String(message.id), "guest_question.reply");
  return messageFromRow(message);
}

/** A reply's transaction: the same command ID racing on another thread is a conflict, not a database error. */
async function replying<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isUniqueViolation(error)) throw new StoreConflictError("The reply command ID was already used with a different reply.");
    throw error;
  }
}

/**
 * 予約前の質問 (#105, #106; migration 0022). The question form and the reply page have no identity:
 * their methods take a slug or a one-time link. The host's methods need a current OWNER of the
 * provider (as 設定 › 通知). The mail job (/internal/experience-jobs/v1/drain) claims host replies, reports how each
 * went and erases questions a year after their last message.
 * A booking made on this site has one thread of its own in the same tables (#285 slice 6b, migration 0031): the
 * guest writes on their booking page (GuestBookingMessages), the host answers here; its name and address stay in
 * booking_guests. The guest's email address leaves this class only in `claimReplyDeliveries`.
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
        `SELECT provider_id, id, public_title FROM experience_products WHERE slug = $1 AND status = 'PUBLISHED'
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
      await enqueueGuestMessage(client, providerId, threadId, messageId, String(product.public_title));
      return RECEIVED;
    });
  }

  /* ---------- the host console (OWNER) ---------- */

  /**
   * The provider's threads, the latest first. `cursor` is the previous page's nextCursor. `kind` keeps questions
   * or bookings' threads only (#285 slice 6b); both when absent.
   */
  async listThreads(actor: HostActor, options: { unreadOnly?: boolean; cursor?: string | null; limit?: number; kind?: GuestThreadKind | null } = {}): Promise<GuestQuestionThreadPage> {
    const limit = boundedInteger(options.limit ?? 30, "limit", 1, 100);
    const after = decodeCursor(options.cursor);
    const kind = threadKind(options.kind);
    return withTransaction(this.#pool, async (client) => {
      await requireOwner(client, actor);
      const result = await client.query<DbRow>(
        `SELECT ${THREAD_COLUMNS},
                m.id AS m_id, m.author AS m_author, m.source AS m_source, m.body AS m_body, m.body_ja AS m_body_ja,
                m.created_at AS m_created_at, m.delivery_status AS m_delivery_status
           FROM ${THREAD_FROM}
           JOIN LATERAL (
             SELECT ${MESSAGE_COLUMNS} FROM guest_question_messages
              WHERE provider_id = t.provider_id AND thread_id = t.id
              ORDER BY created_at DESC, id DESC LIMIT 1
           ) m ON true
          WHERE t.provider_id = $1
            AND (NOT $2::boolean OR t.host_read_at IS NULL)
            AND ($3::timestamptz IS NULL OR (t.last_message_at, t.id) < ($3::timestamptz, $4::uuid))
            AND ($6::text IS NULL OR ($6::text = 'BOOKING') = (t.booking_id IS NOT NULL))
          ORDER BY t.last_message_at DESC, t.id DESC
          LIMIT $5`,
        [actor.providerId, options.unreadOnly === true, after?.at ?? null, after?.id ?? null, limit + 1, kind],
      );
      const rows = result.rows.slice(0, limit);
      return {
        threads: rows.map((row) => ({ ...threadFields(row), lastMessage: messageFromRow(row, "m_") })),
        nextCursor: result.rows.length > limit ? encodeCursor(rows.at(-1)!) : null,
      };
    });
  }

  /** How many of the provider's threads there are (of `kind` only, when given): メッセージ's notice beside NIHO's. */
  async countThreads(actor: HostActor, options: { kind?: GuestThreadKind | null } = {}): Promise<number> {
    const kind = threadKind(options.kind);
    return withTransaction(this.#pool, async (client) => {
      await requireOwner(client, actor);
      const counted = await client.query<DbRow>(
        `SELECT count(*)::int AS count FROM guest_question_threads t
          WHERE t.provider_id = $1 AND ($2::text IS NULL OR ($2::text = 'BOOKING') = (t.booking_id IS NOT NULL))`,
        [actor.providerId, kind],
      );
      return Number(counted.rows[0]?.count ?? 0);
    });
  }

  /** One thread with every message, oldest first. Another provider's is not found. */
  async getThread(actor: HostActor, threadId: string): Promise<GuestQuestionThread> {
    const id = uuid(threadId, "threadId");
    return withTransaction(this.#pool, async (client) => {
      await requireOwner(client, actor);
      const thread = await client.query<DbRow>(
        `SELECT ${THREAD_COLUMNS} FROM ${THREAD_FROM}
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

  /**
   * A booking made on this site, as メッセージ opens it from 予約 or この回 (#285 slice 6b): its thread when someone
   * wrote, or what to show before the host's first message starts one. Another provider's booking, a hold, an
   * abandoned one, one of NIHO's and one whose guest data was erased are not found.
   */
  async findBookingThread(actor: HostActor, publicBookingId: string): Promise<GuestBookingThreadStart> {
    const bookingId = uuid(publicBookingId, "publicBookingId");
    return withTransaction(this.#pool, async (client) => {
      await requireOwner(client, actor);
      const booking = await bookingForThread(client, actor.providerId, bookingId);
      if (!booking) throw new StoreNotFoundError("guest booking");
      return {
        threadId: booking.threadId,
        productId: booking.productId,
        productTitle: booking.productTitle,
        guestName: booking.guestName,
        language: booking.language,
        booking: booking.view,
      };
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
   * StoreConflictError. A booking's thread that no longer takes messages (#285 slice 6b): BookingMessagesClosedError.
   */
  async reply(actor: HostActor, threadId: string, input: { english: string; japanese: string | null; commandId: string }): Promise<GuestQuestionMessage> {
    const id = uuid(threadId, "threadId");
    const reply = validReply(input);
    return replying(() => withTransaction(this.#pool, async (client) => {
      await requireOwner(client, actor);
      const thread = await client.query<DbRow>(
        `SELECT t.booking_id IS NULL OR ${bookingMessagesOpenSql("b")} AS open
           FROM guest_question_threads t
           LEFT JOIN bookings b ON b.provider_id = t.provider_id AND b.id = t.booking_id
          WHERE t.provider_id = $1 AND t.id = $2::uuid FOR NO KEY UPDATE OF t`,
        [actor.providerId, id],
      );
      if (!thread.rows[0]) throw new StoreNotFoundError("guest question");
      return insertHostReply(client, actor, id, reply, thread.rows[0].open === true);
    }));
  }

  /**
   * 返信 to a booking made on this site (#285 slice 6b), from メッセージ opened on the booking: its thread, which this
   * message starts when nobody wrote yet. Idempotent by commandId as `reply`. Not found as findBookingThread; a
   * booking that no longer takes messages: BookingMessagesClosedError.
   */
  async replyToBooking(actor: HostActor, publicBookingId: string, input: { english: string; japanese: string | null; commandId: string }): Promise<{ threadId: string; message: GuestQuestionMessage }> {
    const bookingId = uuid(publicBookingId, "publicBookingId");
    const reply = validReply(input);
    return replying(() => withTransaction(this.#pool, async (client) => {
      await requireOwner(client, actor);
      const booking = await bookingForThread(client, actor.providerId, bookingId);
      if (!booking) throw new StoreNotFoundError("guest booking");
      await lockBookingMessages(client, actor.providerId, booking.bookingRowId);
      let threadId = await lockedBookingThread(client, actor.providerId, booking.bookingRowId);
      if (!threadId) {
        // A command already used elsewhere is refused before anything is started.
        const used = await client.query("SELECT 1 FROM guest_question_messages WHERE provider_id = $1 AND command_id = $2::uuid", [actor.providerId, reply.commandId]);
        if (used.rows[0]) throw new StoreConflictError("The reply command ID was already used with a different reply.");
        if (!booking.view.open) throw new BookingMessagesClosedError();
        threadId = await createBookingThread(client, { providerId: actor.providerId, bookingRowId: booking.bookingRowId, productId: booking.productId, language: booking.language });
      }
      return { threadId, message: await insertHostReply(client, actor, threadId, reply, booking.view.open) };
    }));
  }

  /* ---------- the mail job (server-side, #285 slice 5) ---------- */

  /**
   * Up to `limit` host replies to email now: PENDING ones whose backoff has passed and SENDING ones
   * whose lease ran out, with attempts left. Each becomes SENDING for `leaseSeconds`. A reply to a question gets a
   * fresh one-time reply link valid for `linkTtlDays` (only its SHA-256 is stored); a message in a booking's thread
   * (#285 slice 6b) gets none (the worker links to the booking page) and is sent to the booking's guest record. One
   * whose guest record was erased meanwhile has no one to go to: it becomes FAILED and is not returned.
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
          `SELECT COALESCE(t.guest_email, g.guest_email) AS guest_email, COALESCE(t.guest_name, g.guest_name) AS guest_name,
                  t.guest_language, t.booking_id IS NOT NULL AS for_booking, b.public_booking_id::text AS public_booking_id,
                  b.occurrence_snapshot, p.public_title, COALESCE(b.seller_snapshot->>'displayName', p.seller_display_name) AS seller_display_name
             FROM ${THREAD_FROM}
            WHERE t.provider_id = $1 AND t.id = $2::uuid`,
          [row.provider_id, row.thread_id],
        );
        const detail = details.rows[0]!;
        const base = {
          messageId: String(row.id),
          providerId: String(row.provider_id),
          threadId: String(row.thread_id),
          guestEmail: String(detail.guest_email),
          guestName: String(detail.guest_name),
          guestLanguage: String(detail.guest_language) as GuestQuestionLanguage,
          experienceTitle: String(detail.public_title),
          hostDisplayName: String(detail.seller_display_name),
          english: String(row.body),
          attempt: Number(row.delivery_attempts),
        };
        if (detail.for_booking === true) {
          if (detail.guest_email === null || detail.guest_name === null) {
            await client.query("UPDATE guest_question_messages SET delivery_status = 'FAILED', lease_until = NULL WHERE provider_id = $1 AND id = $2::uuid", [row.provider_id, row.id]);
            continue;
          }
          const occurrence = (detail.occurrence_snapshot ?? {}) as Record<string, unknown>;
          deliveries.push({
            ...base,
            kind: "BOOKING",
            publicBookingId: String(detail.public_booking_id),
            localDate: String(occurrence.localDate),
            localStartTime: String(occurrence.localStartTime),
            timeZone: String(occurrence.timeZone),
          });
          continue;
        }
        const replyToken = randomBytes(32).toString("base64url");
        const link = await client.query<DbRow>(
          `WITH now AS (SELECT clock_timestamp() AS at)
           INSERT INTO guest_question_reply_tokens (token_hash, provider_id, thread_id, host_message_id, expires_at, created_at)
           SELECT $1, $2, $3::uuid, $4::uuid, now.at + make_interval(days => $5), now.at FROM now
           RETURNING expires_at`,
          [tokenDigest(replyToken), row.provider_id, row.thread_id, row.id, linkTtlDays],
        );
        deliveries.push({ ...base, kind: "QUESTION", replyToken, replyLinkExpiresAtUtc: isoValue(link.rows[0]!, "expires_at") });
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
   * message; the mail job calls this with now − 1 year (docs/guest-questions.md). A booking's thread (#285 slice 6b)
   * is not a question: it goes with its booking's guest data (eraseGuestData).
   */
  async eraseInactiveThreads(options: { readonly lastMessageBefore: string; readonly limit?: number }): Promise<number> {
    assertCanonicalInstant(options?.lastMessageBefore, "lastMessageBefore");
    const limit = boundedInteger(options.limit ?? 500, "limit", 1, 5_000);
    const result = await this.#pool.query(
      `WITH due AS (
         SELECT provider_id, id FROM guest_question_threads
          WHERE last_message_at < LEAST($1::timestamptz, clock_timestamp()) AND booking_id IS NULL
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
        const thread = await client.query<DbRow>(
          `SELECT p.public_title FROM guest_question_threads t
             JOIN experience_products p ON p.provider_id = t.provider_id AND p.id = t.product_id
            WHERE t.provider_id = $1 AND t.id = $2::uuid FOR NO KEY UPDATE OF t`,
          [providerId, threadId],
        );
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
        await enqueueGuestMessage(client, providerId, threadId, String(created.id), String(thread.rows[0]!.public_title));
        return RECEIVED;
      });
    } catch (error) {
      // The same answer sent through another of the thread's links.
      if (isUniqueViolation(error)) throw new StoreConflictError("This answer was already received.");
      throw error;
    }
  }
}
