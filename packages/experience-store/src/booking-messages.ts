import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { sessionBookingRef } from "./booking-access.ts";
import { BookingMessagesClosedError, StoreConflictError, StoreRateLimitedError, StoreValidationError } from "./errors.ts";
import {
  bookingMessagesOpenSql,
  createBookingThread,
  enqueueBookingGuestMessage,
  GUEST_QUESTION_LIMITS,
  lockBookingMessages,
  lockedBookingThread,
  type GuestQuestionLanguage,
} from "./guest-questions.ts";
import { isoValue, type DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";

/*
 * 予約ごとのメッセージ (#285 slice 6b, migration 0032, docs/guest-booking.md): the guest's side of the messages of one
 * booking made on this site. The guest reads and writes on their booking page with the session of that booking
 * (slice 6a, booking-access.ts); there is no other identity. The host answers in メッセージ (GuestQuestionRepository).
 * The guest reads their own words and the host's English, never the Japanese the host wrote, and nothing here
 * returns the guest's address or takes an IP address.
 */

/** One message as the guest's booking page shows it. */
export interface GuestBookingMessage {
  readonly id: string;
  readonly from: "guest" | "host";
  readonly atUtc: string;
  /** The guest's own words, or the host's English. */
  readonly body: string;
}

export interface GuestBookingConversation {
  /**
   * The guest may write: the booking is confirmed or under payment review, and its experience ended less than 30
   * days ago. A cancelled booking, or one long over, shows its history only.
   */
  readonly open: boolean;
  /** Oldest first; none before anyone wrote. */
  readonly messages: readonly GuestBookingMessage[];
}

export interface SendGuestBookingMessageInput {
  readonly message: string;
  /** The page's key for this message: the same key again is the same message. */
  readonly clientRequestKey: string;
}

const REQUEST_KEY = /^[A-Za-z0-9._:-]{8,120}$/;
/** Control characters other than tab and line breaks. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function validMessage(input: SendGuestBookingMessageInput): { message: string; key: string } {
  const message = typeof input?.message === "string" && !CONTROL.test(input.message) ? input.message.trim() : null;
  if (message === null || message.length < 1 || message.length > GUEST_QUESTION_LIMITS.guestMessageMaxLength) {
    throw new StoreValidationError(`message must contain 1-${GUEST_QUESTION_LIMITS.guestMessageMaxLength} characters.`);
  }
  const key = input.clientRequestKey;
  if (typeof key !== "string" || !REQUEST_KEY.test(key)) throw new StoreValidationError("clientRequestKey must be 8-120 letters, digits or ._:-");
  return { message, key };
}

/** The session's booking with what a message needs; null when the session does not open this booking. */
async function sessionBooking(client: PoolClient, sessionId: string, publicBookingId: string) {
  const ref = await sessionBookingRef(client, sessionId, publicBookingId);
  if (!ref) return null;
  const found = await client.query<DbRow>(
    `SELECT b.product_id, p.public_title, g.guest_language, g.adult_count + g.child_count AS seats,
            b.occurrence_snapshot->>'startUtc' AS start_utc, ${bookingMessagesOpenSql("b")} AS open
       FROM bookings b
       JOIN booking_guests g ON g.provider_id = b.provider_id AND g.booking_id = b.id
       JOIN experience_products p ON p.provider_id = b.provider_id AND p.id = b.product_id
      WHERE b.provider_id = $1 AND b.id = $2::bigint`,
    [ref.providerId, ref.bookingId],
  );
  const row = found.rows[0];
  if (!row) return null;
  return {
    providerId: ref.providerId,
    bookingRowId: ref.bookingId,
    productId: String(row.product_id),
    experienceTitle: String(row.public_title),
    language: String(row.guest_language) as GuestQuestionLanguage,
    seats: Number(row.seats),
    startsAt: new Date(String(row.start_utc)).toISOString(),
    open: row.open === true,
  };
}

/** The guest's side of a booking's messages: read and write with the booking's session. */
export class GuestBookingMessages {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * The booking's messages, oldest first, and whether the guest may write. null when the session does not open this
   * booking (the same checks as readBookingSession: unknown, ended, revoked, another booking, erased).
   */
  async readConversation(sessionId: string, publicBookingId: string): Promise<GuestBookingConversation | null> {
    return withTransaction(this.#pool, async (client) => {
      const booking = await sessionBooking(client, sessionId, publicBookingId);
      if (!booking) return null;
      const messages = await client.query<DbRow>(
        `SELECT m.id, m.author, m.body, m.created_at
           FROM guest_question_threads t
           JOIN guest_question_messages m ON m.provider_id = t.provider_id AND m.thread_id = t.id
          WHERE t.provider_id = $1 AND t.booking_id = $2::bigint
          ORDER BY m.created_at, m.id`,
        [booking.providerId, booking.bookingRowId],
      );
      return {
        open: booking.open,
        // The host's English only: the Japanese they wrote is for the host console.
        messages: messages.rows.map((row) => ({ id: String(row.id), from: row.author === "HOST" ? "host" : "guest", atUtc: isoValue(row, "created_at"), body: String(row.body) })),
      };
    });
  }

  /**
   * The guest's message to the host: the booking's thread (started by the first message), the message, its
   * translation row and the host's push, in one transaction. The same clientRequestKey with the same words answers
   * `repeated` without a second message; with other words, StoreConflictError. null when the session does not open
   * this booking. BookingMessagesClosedError once the booking takes no messages (cancelled, or 30 days after the
   * experience); StoreRateLimitedError past 10 messages an hour; StoreValidationError for an empty or long message.
   */
  async sendMessage(sessionId: string, publicBookingId: string, input: SendGuestBookingMessageInput): Promise<{ status: "received"; repeated: boolean } | null> {
    const { message, key } = validMessage(input);
    return withTransaction(this.#pool, async (client) => {
      const booking = await sessionBooking(client, sessionId, publicBookingId);
      if (!booking) return null;
      await lockBookingMessages(client, booking.providerId, booking.bookingRowId);
      let threadId = await lockedBookingThread(client, booking.providerId, booking.bookingRowId);
      if (threadId) {
        const sent = await client.query<DbRow>(
          "SELECT body FROM guest_question_messages WHERE provider_id = $1 AND thread_id = $2::uuid AND client_request_key = $3",
          [booking.providerId, threadId, key],
        );
        if (sent.rows[0]) {
          if (sent.rows[0].body === message) return { status: "received", repeated: true };
          throw new StoreConflictError("The message key was already used with another message.");
        }
      }
      if (!booking.open) throw new BookingMessagesClosedError();
      if (threadId) {
        const counted = await client.query<DbRow>(
          `SELECT count(*)::int AS count,
                  GREATEST(1, ceil(extract(epoch FROM min(created_at) + interval '60 minutes' - clock_timestamp())))::int AS retry
             FROM guest_question_messages
            WHERE provider_id = $1 AND thread_id = $2::uuid AND author = 'GUEST' AND created_at > clock_timestamp() - interval '60 minutes'`,
          [booking.providerId, threadId],
        );
        const count = counted.rows[0]!;
        if (Number(count.count) >= GUEST_QUESTION_LIMITS.bookingMessagesPerHour) throw new StoreRateLimitedError(Number(count.retry));
      } else {
        threadId = await createBookingThread(client, booking);
      }
      const inserted = await client.query<DbRow>(
        `INSERT INTO guest_question_messages (id, provider_id, thread_id, author, source, body, client_request_key, created_at)
         VALUES ($1::uuid, $2, $3::uuid, 'GUEST', 'BOOKING_PAGE', $4, $5, clock_timestamp())
         RETURNING id`,
        [randomUUID(), booking.providerId, threadId, message, key],
      );
      const messageId = String(inserted.rows[0]!.id);
      await client.query(
        `UPDATE guest_question_threads t SET needs_reply = true, host_read_at = NULL, last_message_at = m.created_at
           FROM guest_question_messages m
          WHERE t.provider_id = $1 AND t.id = $2::uuid AND m.provider_id = $1 AND m.id = $3::uuid`,
        [booking.providerId, threadId, messageId],
      );
      await enqueueBookingGuestMessage(client, {
        providerId: booking.providerId,
        threadId,
        messageId,
        experienceTitle: booking.experienceTitle,
        startsAt: booking.startsAt,
        seats: booking.seats,
      });
      return { status: "received", repeated: false };
    });
  }
}
