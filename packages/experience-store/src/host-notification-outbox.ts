import type { Pool, PoolClient } from "pg";
import { StoreError, StoreValidationError } from "./errors.ts";
import { isoValue, type DbRow } from "./rows.ts";
import { assertStoreIdentifier } from "./validation.ts";

/**
 * The host app's push notifications kept in `outbox_messages` (#177 P2, owner decision 2026-10-31).
 * A guest question or an answer from the reply page (`guestQuestion`), a guest booking confirmed on
 * this site (`newBooking`, #285) and one a guest or NIHO support cancelled (`cancellation`, #285 slice 7)
 * write their rows in their own transactions; the approval and booking
 * message rows wait for those flows to move to the experience DB (ADR 0002). The job claims only these
 * topics: `booking.confirmed`, `guest_question.*` and every other topic stay untouched.
 */
export const HOST_NOTIFICATION_TOPICS = {
  approvalDeadline: "host.notify.approval_deadline",
  guestMessage: "host.notify.guest_message",
  guestQuestion: "host.notify.guest_question",
  newBooking: "host.notify.new_booking",
  cancellation: "host.notify.cancellation",
} as const;
export type HostNotificationTopic = (typeof HOST_NOTIFICATION_TOPICS)[keyof typeof HOST_NOTIFICATION_TOPICS];

const TOPICS: readonly string[] = Object.values(HOST_NOTIFICATION_TOPICS);
const AGGREGATE_TYPE = "booking";
const QUESTION_AGGREGATE_TYPE = "guest_question_thread";

/**
 * What a row may carry: the booking, the experience, its date and time and the party size. There
 * is deliberately no field for a guest's name, a message's text or an amount.
 */
export interface ApprovalDeadlinePayload {
  readonly v: 1;
  readonly bookingId: string;
  readonly experienceTitle: string;
  /** Canonical UTC instant (`toISOString`). */
  readonly startsAt: string;
  readonly seats: number;
  readonly approvalDeadlineAt: string;
}

export interface GuestMessagePayload {
  readonly v: 1;
  readonly bookingId: string;
  readonly messageId: string;
  readonly experienceTitle: string;
  readonly startsAt: string;
  readonly seats: number;
}

/** A question to the host (予約前の質問): the thread and the message only, never who wrote it or what. */
export interface GuestQuestionPayload {
  readonly v: 1;
  readonly threadId: string;
  readonly messageId: string;
  readonly experienceTitle: string;
}

/** A guest booking confirmed on this site. `seats` is the party (adults and children). */
export interface NewBookingPayload {
  readonly v: 1;
  readonly bookingId: string;
  readonly experienceTitle: string;
  readonly startsAt: string;
  readonly seats: number;
}

/**
 * A guest booking made on this site that the guest or NIHO support cancelled (#285 slice 7): the same facts as
 * a new booking. A host who cancels gets nothing for their own cancellation.
 */
export type CancellationPayload = NewBookingPayload;

/** One claimed row. `id` is the row's bigint as text; the payload is parsed by the consumer. */
export interface ClaimedHostNotification {
  readonly id: string;
  readonly providerId: string;
  readonly topic: string;
  readonly payload: unknown;
  /** Claims so far, this one included. */
  readonly attempts: number;
  readonly createdAt: string;
}

const PUBLIC_ID = /^[A-Za-z0-9_-]{1,48}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const ROW_ID = /^[1-9][0-9]{0,18}$/;
const TITLE_MAX = 200;
const SEATS_MAX = 500;
const HOUR_MS = 60 * 60 * 1000;
const APPROVAL_KEYS = ["approvalDeadlineAt", "bookingId", "experienceTitle", "seats", "startsAt", "v"];
const MESSAGE_KEYS = ["bookingId", "experienceTitle", "messageId", "seats", "startsAt", "v"];
const QUESTION_KEYS = ["experienceTitle", "messageId", "threadId", "v"];
const NEW_BOOKING_KEYS = ["bookingId", "experienceTitle", "seats", "startsAt", "v"];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const publicId = (value: unknown): value is string => typeof value === "string" && PUBLIC_ID.test(value);
const title = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= TITLE_MAX;
const seats = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= SEATS_MAX;

/** An ISO 8601 instant as `toISOString` writes it, or null. */
function canonicalInstant(value: unknown): string | null {
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/** Exactly these keys, no more and no fewer. */
function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

/** A stored instant: a string already canonical, so a hand-written row in another form (or a JSON null) is refused. */
const storedInstant = (value: unknown): value is string => typeof value === "string" && canonicalInstant(value) === value;

/** The approval reminder's payload, or null for anything else (an unknown key, a wrong type). */
export function parseApprovalDeadlinePayload(value: unknown): ApprovalDeadlinePayload | null {
  if (!isRecord(value) || !hasExactKeys(value, APPROVAL_KEYS) || value.v !== 1) return null;
  const { bookingId, experienceTitle, startsAt, seats: count, approvalDeadlineAt } = value;
  if (!publicId(bookingId) || !title(experienceTitle) || !storedInstant(startsAt) || !seats(count) || !storedInstant(approvalDeadlineAt)) return null;
  return { v: 1, bookingId, experienceTitle, startsAt, seats: count, approvalDeadlineAt };
}

/** The guest message's payload, or null for anything else. */
export function parseGuestMessagePayload(value: unknown): GuestMessagePayload | null {
  if (!isRecord(value) || !hasExactKeys(value, MESSAGE_KEYS) || value.v !== 1) return null;
  const { bookingId, messageId, experienceTitle, startsAt, seats: count } = value;
  if (!publicId(bookingId) || !publicId(messageId) || !title(experienceTitle) || !storedInstant(startsAt) || !seats(count)) return null;
  return { v: 1, bookingId, messageId, experienceTitle, startsAt, seats: count };
}

/** The question's payload, or null for anything else. */
export function parseGuestQuestionPayload(value: unknown): GuestQuestionPayload | null {
  if (!isRecord(value) || !hasExactKeys(value, QUESTION_KEYS) || value.v !== 1) return null;
  const { threadId, messageId, experienceTitle } = value;
  if (!publicId(threadId) || !publicId(messageId) || !title(experienceTitle)) return null;
  return { v: 1, threadId, messageId, experienceTitle };
}

/** The new booking's payload, or null for anything else. */
export function parseNewBookingPayload(value: unknown): NewBookingPayload | null {
  if (!isRecord(value) || !hasExactKeys(value, NEW_BOOKING_KEYS) || value.v !== 1) return null;
  const { bookingId, experienceTitle, startsAt, seats: count } = value;
  if (!publicId(bookingId) || !title(experienceTitle) || !storedInstant(startsAt) || !seats(count)) return null;
  return { v: 1, bookingId, experienceTitle, startsAt, seats: count };
}

/** The cancellation's payload (the same keys as a new booking's), or null for anything else. */
export function parseCancellationPayload(value: unknown): CancellationPayload | null {
  return parseNewBookingPayload(value);
}

/**
 * An experience's title as a row carries it: a product title may be longer than a row allows (300
 * against 200), and a notification must not fail the guest's question or the payment over it.
 */
function clippedTitle(value: string): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= TITLE_MAX) return clean;
  // Whole code points only: half of a surrogate pair is not valid JSON, and jsonb would refuse the row (and the
  // question or the payment with it).
  let clipped = "";
  for (const character of clean) {
    if (clipped.length + character.length > TITLE_MAX - 1) break;
    clipped += character;
  }
  return `${clipped}…`;
}

interface BookingFacts {
  readonly providerId: string;
  readonly bookingId: string;
  readonly experienceTitle: string;
  readonly startsAt: string;
  readonly seats: number;
}

function validBooking(input: BookingFacts): { startsAt: string } {
  assertStoreIdentifier(input.providerId, "providerId");
  if (!publicId(input.bookingId)) throw new StoreValidationError("bookingId must contain 1-48 letters, digits, '_' or '-'.");
  if (!title(input.experienceTitle)) throw new StoreValidationError(`experienceTitle must contain 1-${TITLE_MAX} characters.`);
  if (!seats(input.seats)) throw new StoreValidationError(`seats must be an integer from 1 to ${SEATS_MAX}.`);
  const startsAt = canonicalInstant(input.startsAt);
  if (startsAt === null) throw new StoreValidationError("startsAt must be an ISO 8601 instant.");
  return { startsAt };
}

async function insertRow(
  client: PoolClient,
  row: { providerId: string; bookingId: string; topic: HostNotificationTopic; deduplicationKey: string; payload: object; availableAt: string | null; aggregateType?: string },
): Promise<number> {
  const result = await client.query(
    `INSERT INTO outbox_messages (provider_id, aggregate_type, aggregate_id, topic, deduplication_key, payload, available_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, COALESCE($7::timestamptz, clock_timestamp()))
     ON CONFLICT (provider_id, deduplication_key) DO NOTHING`,
    [row.providerId, row.aggregateType ?? AGGREGATE_TYPE, row.bookingId, row.topic, row.deduplicationKey, JSON.stringify(row.payload), row.availableAt],
  );
  return result.rowCount ?? 0;
}

/**
 * A booking waiting for the host's approval: reminders 6 hours and 1 hour before its deadline (the
 * host console's 設定 › 通知 promises both). A reminder whose time has passed is skipped; with less
 * than an hour left, the 1-hour one is due now; past the deadline, nothing. Called in the booking's
 * own transaction. The number of new rows (a repeat adds none).
 */
export async function enqueueApprovalDeadlineReminders(
  client: PoolClient,
  input: BookingFacts & { readonly approvalDeadlineAt: string; readonly now: Date },
): Promise<number> {
  const { startsAt } = validBooking(input);
  const approvalDeadlineAt = canonicalInstant(input.approvalDeadlineAt);
  if (approvalDeadlineAt === null) throw new StoreValidationError("approvalDeadlineAt must be an ISO 8601 instant.");
  const now = input.now.getTime();
  if (!Number.isFinite(now)) throw new StoreValidationError("now must be a valid time.");
  const deadline = Date.parse(approvalDeadlineAt);
  if (deadline <= now) return 0;

  const payload: ApprovalDeadlinePayload = { v: 1, bookingId: input.bookingId, experienceTitle: input.experienceTitle, startsAt, seats: input.seats, approvalDeadlineAt };
  const due: [string, number][] = [];
  if (deadline - 6 * HOUR_MS > now) due.push(["6h", deadline - 6 * HOUR_MS]);
  due.push(["1h", Math.max(deadline - HOUR_MS, now)]);
  let inserted = 0;
  for (const [lead, at] of due) {
    inserted += await insertRow(client, {
      providerId: input.providerId,
      bookingId: input.bookingId,
      topic: HOST_NOTIFICATION_TOPICS.approvalDeadline,
      deduplicationKey: `host-push:approval-deadline:${input.bookingId}:${lead}`,
      payload,
      availableAt: new Date(at).toISOString(),
    });
  }
  return inserted;
}

/** Approved, declined, cancelled or expired: the booking's unsent reminders are closed. The number closed. */
export async function cancelApprovalDeadlineReminders(client: PoolClient, input: { readonly providerId: string; readonly bookingId: string }): Promise<number> {
  assertStoreIdentifier(input.providerId, "providerId");
  if (!publicId(input.bookingId)) throw new StoreValidationError("bookingId must contain 1-48 letters, digits, '_' or '-'.");
  const result = await client.query(
    `UPDATE outbox_messages SET processed_at = clock_timestamp()
      WHERE provider_id = $1 AND topic = $2 AND aggregate_type = $3 AND aggregate_id = $4 AND processed_at IS NULL`,
    [input.providerId, HOST_NOTIFICATION_TOPICS.approvalDeadline, AGGREGATE_TYPE, input.bookingId],
  );
  return result.rowCount ?? 0;
}

/** A guest wrote to the host: one notification per message, due now. 1 when added, 0 for a repeat. */
export async function enqueueGuestMessageNotification(client: PoolClient, input: BookingFacts & { readonly messageId: string }): Promise<number> {
  const { startsAt } = validBooking(input);
  if (!publicId(input.messageId)) throw new StoreValidationError("messageId must contain 1-48 letters, digits, '_' or '-'.");
  const payload: GuestMessagePayload = { v: 1, bookingId: input.bookingId, messageId: input.messageId, experienceTitle: input.experienceTitle, startsAt, seats: input.seats };
  return insertRow(client, {
    providerId: input.providerId,
    bookingId: input.bookingId,
    topic: HOST_NOTIFICATION_TOPICS.guestMessage,
    deduplicationKey: `host-push:guest-message:${input.messageId}`,
    payload,
    availableAt: null,
  });
}

/**
 * A guest asked the host a question or answered through the reply page (予約前の質問): one notification
 * per message, due now, sent as GUEST_MESSAGE (stoppable in 設定 › 通知). Called in the message's own
 * transaction. 1 when added, 0 for a repeat.
 */
export async function enqueueGuestQuestionNotification(
  client: PoolClient,
  input: { readonly providerId: string; readonly threadId: string; readonly messageId: string; readonly experienceTitle: string },
): Promise<number> {
  assertStoreIdentifier(input.providerId, "providerId");
  if (!publicId(input.threadId)) throw new StoreValidationError("threadId must contain 1-48 letters, digits, '_' or '-'.");
  if (!publicId(input.messageId)) throw new StoreValidationError("messageId must contain 1-48 letters, digits, '_' or '-'.");
  const experienceTitle = typeof input.experienceTitle === "string" ? clippedTitle(input.experienceTitle) : "";
  if (!title(experienceTitle)) throw new StoreValidationError("experienceTitle must contain text.");
  const payload: GuestQuestionPayload = { v: 1, threadId: input.threadId, messageId: input.messageId, experienceTitle };
  return insertRow(client, {
    providerId: input.providerId,
    bookingId: input.threadId,
    aggregateType: QUESTION_AGGREGATE_TYPE,
    topic: HOST_NOTIFICATION_TOPICS.guestQuestion,
    deduplicationKey: `host-push:guest-question:${input.messageId}`,
    payload,
    availableAt: null,
  });
}

/**
 * A guest booking made on this site was confirmed: one NEW_BOOKING notification (it cannot be turned
 * off), due now. Called in the confirming transaction. 1 when added, 0 for a repeat.
 */
export async function enqueueNewBookingNotification(client: PoolClient, input: BookingFacts): Promise<number> {
  const facts = { ...input, experienceTitle: typeof input.experienceTitle === "string" ? clippedTitle(input.experienceTitle) : "" };
  const { startsAt } = validBooking(facts);
  const payload: NewBookingPayload = { v: 1, bookingId: facts.bookingId, experienceTitle: facts.experienceTitle, startsAt, seats: facts.seats };
  return insertRow(client, {
    providerId: facts.providerId,
    bookingId: facts.bookingId,
    topic: HOST_NOTIFICATION_TOPICS.newBooking,
    deduplicationKey: `host-push:new-booking:${facts.bookingId}`,
    payload,
    availableAt: null,
  });
}

/**
 * A guest booking made on this site was cancelled by the guest or by NIHO support (#285 slice 7): one CANCELLATION
 * notification (it cannot be turned off), due now. Called in the cancelling transaction. 1 when added, 0 for a repeat.
 */
export async function enqueueCancellationNotification(client: PoolClient, input: BookingFacts): Promise<number> {
  const facts = { ...input, experienceTitle: typeof input.experienceTitle === "string" ? clippedTitle(input.experienceTitle) : "" };
  const { startsAt } = validBooking(facts);
  const payload: CancellationPayload = { v: 1, bookingId: facts.bookingId, experienceTitle: facts.experienceTitle, startsAt, seats: facts.seats };
  return insertRow(client, {
    providerId: facts.providerId,
    bookingId: facts.bookingId,
    topic: HOST_NOTIFICATION_TOPICS.cancellation,
    deduplicationKey: `host-push:cancellation:${facts.bookingId}`,
    payload,
    availableAt: null,
  });
}

function assertRowId(id: string): void {
  if (!ROW_ID.test(id)) throw new StoreValidationError("id must be an outbox row id.");
}

function assertAttempts(attempts: number): void {
  if (!Number.isSafeInteger(attempts) || attempts < 0) throw new StoreValidationError("attempts must be the claim's attempt count.");
}

function claimedFromRow(row: DbRow): ClaimedHostNotification {
  const attempts = Number(row.attempts);
  if (typeof row.provider_id !== "string" || typeof row.topic !== "string" || !Number.isSafeInteger(attempts)) throw new StoreError("Database returned an invalid outbox row.");
  return { id: String(row.id), providerId: row.provider_id, topic: row.topic, payload: row.payload, attempts, createdAt: isoValue(row, "created_at") };
}

/** bigint ids as text, in numeric order. */
const byId = (a: ClaimedHostNotification, b: ClaimedHostNotification) => a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The notification job's side of the host topics. There is no lease column: a claim moves
 * `available_at` past the lease, so a row the job never completes comes back by itself.
 */
export class HostNotificationOutbox {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /** Up to `limit` due rows, oldest first, each claimed for `leaseMs`. Concurrent claimers never share a row. */
  async claimDue(limit: number, leaseMs: number): Promise<ClaimedHostNotification[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new StoreValidationError("limit must be between 1 and 200.");
    if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > HOUR_MS) throw new StoreValidationError("leaseMs must be between 1 second and 1 hour.");
    const result = await this.#pool.query<DbRow>(
      `UPDATE outbox_messages
          SET available_at = clock_timestamp() + $3::integer * interval '1 millisecond',
              attempts = attempts + 1
        WHERE id IN (
          SELECT id FROM outbox_messages
           WHERE processed_at IS NULL
             AND topic = ANY($1::text[])
             AND available_at <= clock_timestamp()
           ORDER BY available_at, id
           LIMIT $2
           FOR UPDATE SKIP LOCKED)
      RETURNING id::text AS id, provider_id, topic, payload, attempts, created_at`,
      [TOPICS, limit, leaseMs],
    );
    return result.rows.map(claimedFromRow).sort(byId);
  }

  /**
   * Sent, skipped or given up: the row is done. A row already closed (a cancelled reminder) stays as it is.
   * `attempts` is the claim's count: once the lease ran out and another run claimed the row again, this claim
   * no longer changes it.
   */
  async complete(id: string, attempts: number): Promise<void> {
    assertRowId(id);
    assertAttempts(attempts);
    await this.#pool.query(
      "UPDATE outbox_messages SET processed_at = clock_timestamp() WHERE id = $1 AND topic = ANY($2::text[]) AND processed_at IS NULL AND attempts = $3",
      [id, TOPICS, attempts],
    );
  }

  /** Try again at `at` (instead of when the lease runs out), for the claim counted `attempts` only. */
  async retryAt(id: string, at: Date, attempts: number): Promise<void> {
    assertRowId(id);
    if (Number.isNaN(at.getTime())) throw new StoreValidationError("at must be a valid time.");
    assertAttempts(attempts);
    await this.#pool.query(
      "UPDATE outbox_messages SET available_at = $2 WHERE id = $1 AND topic = ANY($3::text[]) AND processed_at IS NULL AND attempts = $4",
      [id, at.toISOString(), TOPICS, attempts],
    );
  }
}
