import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { StoreError, StoreValidationError } from "./errors.ts";
import { HAS_HOST_ACCESS, HOST_ACCOUNT_USABLE, HOST_MAIL_TOPICS, HOST_NOTIFICATION_ADDRESS_LIMITS, type HostBookingMailTopic } from "./host-mail-shared.ts";
import { HOST_NOTIFICATION_TOPICS, type HostNotificationTopic } from "./host-notification-outbox.ts";
import { isoValue, type DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";

/*
 * The mail job's side of ホストへのメール (#194, owner decision 2026-11-01): the emails about a booking (this site's new and
 * cancelled bookings, #285; an OTA booking that is new, cancelled or moved) to each person the push goes to, and the link
 * that confirms a new address. As GuestMailOutbox: no lease column (a claim moves `available_at` past the lease), and only
 * these topics. Every address and name read here leaves only in the email it is for.
 */

/** The push topic whose payload a booking's email row carries, so the job words the email as the push. */
export const HOST_MAIL_NOTIFICATION_TOPICS: Readonly<Record<HostBookingMailTopic, HostNotificationTopic>> = {
  [HOST_MAIL_TOPICS.newBooking]: HOST_NOTIFICATION_TOPICS.newBooking,
  [HOST_MAIL_TOPICS.cancellation]: HOST_NOTIFICATION_TOPICS.cancellation,
  [HOST_MAIL_TOPICS.otaBooking]: HOST_NOTIFICATION_TOPICS.otaBooking,
  [HOST_MAIL_TOPICS.assignmentRequest]: HOST_NOTIFICATION_TOPICS.assignmentRequest,
  [HOST_MAIL_TOPICS.guestMessage]: HOST_NOTIFICATION_TOPICS.guestMessage,
  [HOST_MAIL_TOPICS.guestQuestion]: HOST_NOTIFICATION_TOPICS.guestQuestion,
  [HOST_MAIL_TOPICS.bookingMessage]: HOST_NOTIFICATION_TOPICS.bookingMessage,
  [HOST_MAIL_TOPICS.newReview]: HOST_NOTIFICATION_TOPICS.newReview,
  [HOST_MAIL_TOPICS.guestEmailDeliveryFailed]: HOST_NOTIFICATION_TOPICS.guestEmailDeliveryFailed,
  [HOST_MAIL_TOPICS.dayBeforeSummary]: HOST_NOTIFICATION_TOPICS.dayBeforeSummary,
  [HOST_MAIL_TOPICS.listingSuspension]: HOST_NOTIFICATION_TOPICS.listingSuspension,
};

const BOOKING_TOPICS: readonly string[] = Object.keys(HOST_MAIL_NOTIFICATION_TOPICS);
const CONFIRMATION_TOPICS: readonly string[] = [HOST_MAIL_TOPICS.addressConfirmation];

export const HOST_MAIL_LIMITS = {
  /** Claims of one email, the first included. Retries wait 2, 4, 8, 16, 32, 60 and 60 minutes, as a guest's. */
  attempts: 8,
  claimLimitMax: 50,
  leaseSecondsMin: 30,
  leaseSecondsMax: 3600,
} as const;

/** One claimed email about a booking. */
export interface ClaimedHostBookingMail {
  /** The outbox row's bigint as text. */
  readonly id: string;
  readonly attempts: number;
  readonly providerId: string;
  /** The push's topic: `payload` is that push's payload (without the guest's name). */
  readonly notificationTopic: HostNotificationTopic;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
  /**
   * Where it goes, or null when it should not go: the person has no address any more, or no longer gets this booking (not
   * the provider's OWNER, and for an OTA booking not the product's operator either).
   */
  readonly to: string | null;
  /** An OTA booking's guest name while it is kept (#194), read now; null otherwise. */
  readonly guestName: string | null;
}

export interface HostBookingMailClaim {
  readonly mails: readonly ClaimedHostBookingMail[];
  /** Rows whose last attempt's lease ran out without a report: closed unsent. */
  readonly abandoned: number;
}

/** One claimed confirmation email. */
export interface ClaimedHostAddressConfirmation {
  readonly id: string;
  readonly attempts: number;
  /** What to send, or null when the request is no longer open (used, cancelled, expired, access ended). */
  readonly confirmation: {
    readonly confirmationId: string;
    readonly email: string;
    /** The link stops working at this instant. */
    readonly expiresAt: string;
  } | null;
}

export interface HostAddressConfirmationClaim {
  readonly confirmations: readonly ClaimedHostAddressConfirmation[];
  readonly abandoned: number;
}

/** After a transient failure: tried again later, given up (attempts used up), or no longer this claim's row. */
export type HostMailRetry = "RETRY" | "FAILED" | "STALE";

const ROW_ID = /^[1-9][0-9]{0,18}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_TEXT = "'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'";

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

const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

/** bigint ids as text, in numeric order. */
const byId = (a: { id: string }, b: { id: string }) => a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The person an email row is for: one with a NIHO user ID in the payload. */
const RECIPIENT = (row: string) => `${row}.payload->>'to'`;

/**
 * SQL: the row's person still gets this booking: an active OWNER of its provider (a message addressed to a person, #608, also the
 * person: an active OWNER or COHOST named in the payload), or for an OTA booking an active, unexpired
 * operator of its product. An assignment request (#535) goes to whoever can still take the occurrence (an active OWNER or
 * COHOST, or an active, unexpired operator of the product), and once the occurrence has an assignee only to that person.
 */
const STILL_RECIPIENT = (row: string) =>
  `(${HOST_ACCOUNT_USABLE(RECIPIENT(row))} AND (
    (${row}.topic <> '${HOST_MAIL_TOPICS.assignmentRequest}' AND EXISTS (SELECT 1 FROM provider_memberships rm
             WHERE rm.provider_id = ${row}.provider_id AND rm.niho_user_id = ${RECIPIENT(row)} AND rm.active AND rm.role = 'OWNER'))
    OR (${row}.topic = '${HOST_MAIL_TOPICS.guestQuestion}' AND ${row}.payload->>'toMemberId' = ${RECIPIENT(row)} AND EXISTS (SELECT 1 FROM provider_memberships rm
             WHERE rm.provider_id = ${row}.provider_id AND rm.niho_user_id = ${RECIPIENT(row)} AND rm.active AND rm.role IN ('OWNER', 'COHOST')))
    OR (${row}.topic = '${HOST_MAIL_TOPICS.otaBooking}' AND EXISTS (
          SELECT 1 FROM product_operator_grants rg
           WHERE rg.provider_id = ${row}.provider_id AND rg.product_id = ${row}.payload->>'productId'
             AND rg.niho_user_id = ${RECIPIENT(row)} AND rg.active AND (rg.expires_at IS NULL OR rg.expires_at > clock_timestamp())))
    OR (${row}.topic = '${HOST_MAIL_TOPICS.assignmentRequest}'
        AND (EXISTS (SELECT 1 FROM provider_memberships rm
                      WHERE rm.provider_id = ${row}.provider_id AND rm.niho_user_id = ${RECIPIENT(row)} AND rm.active AND rm.role IN ('OWNER', 'COHOST'))
             OR EXISTS (SELECT 1 FROM product_operator_grants rg
                         WHERE rg.provider_id = ${row}.provider_id AND rg.product_id = ${row}.payload->>'productId'
                           AND rg.niho_user_id = ${RECIPIENT(row)} AND rg.active AND (rg.expires_at IS NULL OR rg.expires_at > clock_timestamp())))
        AND NOT EXISTS (SELECT 1 FROM occurrence_assignments ra
                         WHERE ra.provider_id = ${row}.provider_id AND ra.occurrence_id = ${row}.payload->>'occurrenceId'
                           AND ra.released_at IS NULL AND ra.assignee_niho_user_id <> ${RECIPIENT(row)}))))`;

export class HostMailOutbox {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * Up to `limit` due booking emails, oldest first, each claimed for `leaseSeconds`, with the address in use now and an OTA
   * guest's name while it is kept. Concurrent claimers never share a row. A row whose last attempt's lease ran out is closed.
   */
  async claimBookingMails(options: { limit: number; leaseSeconds: number }): Promise<HostBookingMailClaim> {
    const { rows, abandoned } = await this.#claim(
      BOOKING_TOPICS,
      options,
      `SELECT c.id::text AS id, c.attempts, c.provider_id, c.topic, c.payload, c.created_at,
              CASE WHEN ${STILL_RECIPIENT("c")} THEN COALESCE(a.override_email, a.login_email) END AS recipient_email,
              g.guest_name
         FROM claimed c
         LEFT JOIN host_notification_addresses a ON a.niho_user_id = ${RECIPIENT("c")}
         LEFT JOIN external_reservations e ON c.topic = '${HOST_MAIL_TOPICS.otaBooking}'
               AND e.host_ref = (CASE WHEN c.payload->>'ref' ~ ${UUID_TEXT} THEN (c.payload->>'ref')::uuid END)
         LEFT JOIN external_reservation_guests g ON g.source_site = e.source_site
               AND g.source_external_account_id = e.source_external_account_id
               AND g.external_reservation_id = e.external_reservation_id AND g.pii_erased_at IS NULL`,
    );
    const mails = rows.map((row): ClaimedHostBookingMail => {
      const topic = String(row.topic) as HostBookingMailTopic;
      const notificationTopic = HOST_MAIL_NOTIFICATION_TOPICS[topic];
      if (notificationTopic === undefined || typeof row.provider_id !== "string") throw new StoreError("Database returned an invalid host email row.");
      const raw = typeof row.payload === "object" && row.payload !== null && !Array.isArray(row.payload) ? row.payload as Record<string, unknown> : {};
      const { to: _to, ...payload } = raw;
      return {
        id: String(row.id),
        attempts: count(row.attempts, "attempts"),
        providerId: row.provider_id,
        notificationTopic,
        payload,
        createdAt: isoValue(row, "created_at"),
        to: text(row.recipient_email),
        guestName: topic === HOST_MAIL_TOPICS.otaBooking ? text(row.guest_name) : null,
      };
    }).sort(byId);
    return { mails, abandoned };
  }

  /** Sent, refused for good, or nothing to send: the row is done (a late report too). Only this consumer's rows. */
  async completeBookingMail(id: string): Promise<void> {
    await this.#complete(BOOKING_TOPICS, id);
  }

  /** A transient failure for the claim counted `attempts`: wait 2^attempts minutes (60 at most), or give up. */
  async retryBookingMail(id: string, attempts: number): Promise<HostMailRetry> {
    return this.#retry(BOOKING_TOPICS, id, attempts);
  }

  /** Up to `limit` due confirmation emails, as claimBookingMails. */
  async claimAddressConfirmations(options: { limit: number; leaseSeconds: number }): Promise<HostAddressConfirmationClaim> {
    const { rows, abandoned } = await this.#claim(
      CONFIRMATION_TOPICS,
      options,
      `SELECT c.id::text AS id, c.attempts, k.id::text AS confirmation_id, k.email,
              (k.created_at + make_interval(mins => ${HOST_NOTIFICATION_ADDRESS_LIMITS.confirmationMinutes})) AS expires_at,
              (k.used_at IS NULL AND k.cancelled_at IS NULL
               AND k.created_at > clock_timestamp() - make_interval(mins => ${HOST_NOTIFICATION_ADDRESS_LIMITS.confirmationMinutes})
               AND ${HAS_HOST_ACCESS("k.niho_user_id")}) AS open
         FROM claimed c
         LEFT JOIN host_notification_address_confirmations k
                ON k.id = (CASE WHEN c.aggregate_id ~ ${UUID_TEXT} THEN c.aggregate_id::uuid END)`,
    );
    const confirmations = rows.map((row): ClaimedHostAddressConfirmation => ({
      id: String(row.id),
      attempts: count(row.attempts, "attempts"),
      confirmation: row.open === true && typeof row.confirmation_id === "string" && typeof row.email === "string"
        ? { confirmationId: row.confirmation_id, email: row.email, expiresAt: isoValue(row, "expires_at") }
        : null,
    })).sort(byId);
    return { confirmations, abandoned };
  }

  /**
   * The link's one-time token for an open request, made right before its email goes out: the raw token is returned (for the
   * link's fragment) and only its SHA-256 kept. Each call replaces the last token, so only the newest email's link works.
   * Null when the request is no longer open.
   */
  async issueAddressConfirmationToken(confirmationId: string): Promise<string | null> {
    if (typeof confirmationId !== "string" || !UUID.test(confirmationId)) throw new StoreValidationError("confirmationId must be a UUID.");
    const token = randomBytes(32).toString("base64url");
    const result = await this.#pool.query(
      `UPDATE host_notification_address_confirmations SET token_hash = $2
        WHERE id = $1 AND used_at IS NULL AND cancelled_at IS NULL
          AND created_at > clock_timestamp() - make_interval(mins => $3)`,
      [confirmationId, createHash("sha256").update(token, "utf8").digest(), HOST_NOTIFICATION_ADDRESS_LIMITS.confirmationMinutes],
    );
    return (result.rowCount ?? 0) > 0 ? token : null;
  }

  /** As completeBookingMail, for a confirmation email. */
  async completeAddressConfirmation(id: string): Promise<void> {
    await this.#complete(CONFIRMATION_TOPICS, id);
  }

  /** As retryBookingMail, for a confirmation email. */
  async retryAddressConfirmation(id: string, attempts: number): Promise<HostMailRetry> {
    return this.#retry(CONFIRMATION_TOPICS, id, attempts);
  }

  async #claim(topics: readonly string[], options: { limit: number; leaseSeconds: number }, select: string): Promise<{ rows: DbRow[]; abandoned: number }> {
    const limit = boundedInteger(options?.limit, "limit", 1, HOST_MAIL_LIMITS.claimLimitMax);
    const leaseSeconds = boundedInteger(options?.leaseSeconds, "leaseSeconds", HOST_MAIL_LIMITS.leaseSecondsMin, HOST_MAIL_LIMITS.leaseSecondsMax);
    return withTransaction(this.#pool, async (client) => {
      const abandoned = await client.query(
        `UPDATE outbox_messages m SET processed_at = clock_timestamp()
          WHERE m.topic = ANY($1::text[]) AND m.processed_at IS NULL AND m.attempts >= $2 AND m.available_at <= clock_timestamp()`,
        [[...topics], HOST_MAIL_LIMITS.attempts],
      );
      const claimed = await client.query<DbRow>(
        `WITH due AS (
           SELECT m.id FROM outbox_messages m
            WHERE m.topic = ANY($1::text[]) AND m.processed_at IS NULL AND m.attempts < $2 AND m.available_at <= clock_timestamp()
            ORDER BY m.available_at, m.id
            LIMIT $3
            FOR UPDATE OF m SKIP LOCKED
         ), claimed AS (
           UPDATE outbox_messages o
              SET available_at = clock_timestamp() + make_interval(secs => $4), attempts = o.attempts + 1
             FROM due
            WHERE o.id = due.id
           RETURNING o.id, o.attempts, o.provider_id, o.aggregate_id, o.topic, o.payload, o.created_at
         )
         ${select}`,
        [[...topics], HOST_MAIL_LIMITS.attempts, limit, leaseSeconds],
      );
      return { rows: claimed.rows, abandoned: abandoned.rowCount ?? 0 };
    });
  }

  async #complete(topics: readonly string[], id: string): Promise<void> {
    assertRowId(id);
    await this.#pool.query(
      "UPDATE outbox_messages SET processed_at = clock_timestamp() WHERE id = $2 AND topic = ANY($1::text[]) AND processed_at IS NULL",
      [[...topics], id],
    );
  }

  async #retry(topics: readonly string[], id: string, attempts: number): Promise<HostMailRetry> {
    assertRowId(id);
    boundedInteger(attempts, "attempts", 1, HOST_MAIL_LIMITS.attempts);
    const updated = await this.#pool.query<DbRow>(
      `UPDATE outbox_messages m
          SET available_at = CASE WHEN m.attempts < $3 THEN clock_timestamp() + make_interval(mins => LEAST(power(2, m.attempts), 60)::int) ELSE m.available_at END,
              processed_at = CASE WHEN m.attempts < $3 THEN NULL ELSE clock_timestamp() END
        WHERE m.id = $2 AND m.attempts = $4 AND m.topic = ANY($1::text[]) AND m.processed_at IS NULL
        RETURNING m.processed_at IS NOT NULL AS gave_up`,
      [[...topics], id, HOST_MAIL_LIMITS.attempts, attempts],
    );
    const row = updated.rows[0];
    if (!row) return "STALE";
    return row.gave_up === true ? "FAILED" : "RETRY";
  }
}
