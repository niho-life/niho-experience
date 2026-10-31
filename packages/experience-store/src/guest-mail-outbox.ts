import type { Pool } from "pg";
import { BOOKING_ACCESS_LIMITS, BOOKING_LINK_TOPIC } from "./booking-access.ts";
import { StoreError, StoreValidationError } from "./errors.ts";
import type { DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import type { GuestCancellationPolicy } from "./types.ts";

/**
 * The booking emails to a guest who booked on this site (#285, docs/guest-booking.md): the confirmation
 * (slice 5) and the link to the booking page "Find your booking" asks for (slice 6, BOOKING_LINK_TOPIC).
 * `confirmBookingPayment` writes `booking.confirmed` to `outbox_messages`; the mail job claims only the rows
 * of guest bookings (those with a `booking_guests` row). Other bookings' rows and every other topic stay
 * untouched, as `HostNotificationOutbox` leaves this topic alone. Like that consumer, there is no lease
 * column: a claim moves `available_at` past the lease, so a row the job never finishes comes back by itself.
 */
export const GUEST_MAIL_TOPIC = "booking.confirmed";

export const GUEST_MAIL_LIMITS = {
  /** Claims of one confirmation, the first included. Retries wait 2, 4, 8, 16, 32, 60 and 60 minutes (about 3 hours). */
  confirmationAttempts: 8,
  /** Claims of one booking link email, the first included: 2, 4, 8 and 16 minutes (the guest is waiting for it). */
  linkAttempts: 5,
  claimLimitMax: 50,
  leaseSecondsMin: 30,
  leaseSecondsMax: 3600,
} as const;

/** What the confirmation email says. The guest's address and name leave the store only here. */
export interface BookingConfirmationEmail {
  readonly publicBookingId: string;
  readonly guestEmail: string;
  readonly guestName: string;
  readonly experienceTitle: string;
  readonly experienceSlug: string;
  /** The occurrence's own date and start time (a host may have moved it), in `timeZone`. */
  readonly localDate: string;
  readonly localStartTime: string;
  readonly timeZone: string;
  /** Canonical UTC instant of the start, for the end of free cancellation. */
  readonly startUtc: string;
  readonly adultCount: number;
  readonly childCount: number;
  /** What the guest paid, in the currency's smallest unit (yen). */
  readonly totalAmount: number;
  readonly currency: string;
  /** Fixed at booking; null only for a snapshot without one. */
  readonly cancellationPolicy: GuestCancellationPolicy | null;
  /** The seller's name fixed at booking. */
  readonly hostDisplayName: string;
}

/** One claimed `booking.confirmed` row. */
export interface ClaimedBookingConfirmation {
  /** The outbox row's bigint as text. */
  readonly id: string;
  /** Claims so far, this one included. */
  readonly attempts: number;
  /**
   * What to send, or null when nothing should go out: the guest's details were already erased, or the
   * booking is no longer CONFIRMED (cancelled before the job ran). The job completes such a row unsent.
   */
  readonly email: BookingConfirmationEmail | null;
}

export interface BookingConfirmationClaim {
  readonly confirmations: readonly ClaimedBookingConfirmation[];
  /** Rows whose last attempt's lease ran out without a report: closed unsent. */
  readonly abandoned: number;
}

/** What the email with a link to the booking says ("Find your booking"). The job adds the link's grant. */
export interface BookingLinkEmail {
  readonly publicBookingId: string;
  readonly guestEmail: string;
  readonly guestName: string;
  readonly experienceTitle: string;
  readonly localDate: string;
  readonly localStartTime: string;
  readonly timeZone: string;
}

/** One claimed BOOKING_LINK_TOPIC row. */
export interface ClaimedBookingLink {
  readonly id: string;
  readonly attempts: number;
  /**
   * What to send, or null when the page can no longer be opened: the guest's details were erased, the booking
   * was cancelled, or the experience ended more than 30 days ago. The job completes such a row unsent.
   */
  readonly email: BookingLinkEmail | null;
}

export interface BookingLinkClaim {
  readonly links: readonly ClaimedBookingLink[];
  readonly abandoned: number;
}

/** After a transient failure: tried again later, given up (attempts used up), or no longer this claim's row. */
export type BookingConfirmationRetry = "RETRY" | "FAILED" | "STALE";

const ROW_ID = /^[1-9][0-9]{0,18}$/;
const UUID_TEXT = "'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'";
const POLICIES: ReadonlySet<string> = new Set(["FREE_UNTIL_24H", "FREE_UNTIL_48H", "NONE"]);

/**
 * The row's booking, matched through its public ID. `aggregate_id` is text: the cast runs only on a UUID's
 * shape, so a foreign row with another id never fails the query.
 */
const BOOKING_OF = (row: string) =>
  `b.provider_id = ${row}.provider_id
   AND b.public_booking_id = (CASE WHEN ${row}.aggregate_id ~ ${UUID_TEXT} THEN ${row}.aggregate_id::uuid END)`;

/** This consumer's rows: the topic, of a booking that has a guest record. */
const GUEST_ROW = (row: string) =>
  `${row}.topic = $1 AND ${row}.aggregate_type = 'booking' AND ${row}.processed_at IS NULL
   AND EXISTS (SELECT 1 FROM bookings b JOIN booking_guests g ON g.provider_id = b.provider_id AND g.booking_id = b.id
                WHERE ${BOOKING_OF(row)})`;

function boundedInteger(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new StoreValidationError(`${path} must be an integer from ${min} to ${max}.`);
  return value;
}

function assertRowId(id: string): void {
  if (typeof id !== "string" || !ROW_ID.test(id)) throw new StoreValidationError("id must be an outbox row id.");
}

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {});

function text(value: unknown, key: string): string {
  if (typeof value !== "string" || value.length === 0) throw new StoreError(`Database returned an invalid ${key}.`);
  return value;
}

function count(value: unknown, key: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new StoreError(`Database returned an invalid ${key}.`);
  return parsed;
}

function emailFromRow(row: DbRow): BookingConfirmationEmail | null {
  if (row.status !== "CONFIRMED" || row.guest_email === null || row.guest_name === null) return null;
  const occurrence = record(row.occurrence_snapshot);
  const pricing = record(row.pricing_snapshot);
  const seller = record(row.seller_snapshot);
  const policy = pricing.cancellationPolicy;
  return {
    publicBookingId: text(row.public_booking_id, "public_booking_id"),
    guestEmail: text(row.guest_email, "guest_email"),
    guestName: text(row.guest_name, "guest_name"),
    experienceTitle: text(row.public_title, "public_title"),
    experienceSlug: text(row.slug, "slug"),
    localDate: text(occurrence.localDate, "occurrence_snapshot.localDate"),
    localStartTime: text(occurrence.localStartTime, "occurrence_snapshot.localStartTime"),
    timeZone: text(occurrence.timeZone, "occurrence_snapshot.timeZone"),
    startUtc: text(occurrence.startUtc, "occurrence_snapshot.startUtc"),
    adultCount: count(row.adult_count, "adult_count"),
    childCount: count(row.child_count, "child_count"),
    totalAmount: count(pricing.totalAmount, "pricing_snapshot.totalAmount"),
    currency: text(pricing.currency, "pricing_snapshot.currency"),
    cancellationPolicy: typeof policy === "string" && POLICIES.has(policy) ? policy as GuestCancellationPolicy : null,
    hostDisplayName: text(seller.displayName, "seller_snapshot.displayName"),
  };
}

function linkEmailFromRow(row: DbRow): BookingLinkEmail | null {
  if ((row.status !== "CONFIRMED" && row.status !== "PAYMENT_REVIEW") || row.link_open !== true || row.guest_email === null || row.guest_name === null) return null;
  const occurrence = record(row.occurrence_snapshot);
  return {
    publicBookingId: text(row.public_booking_id, "public_booking_id"),
    guestEmail: text(row.guest_email, "guest_email"),
    guestName: text(row.guest_name, "guest_name"),
    experienceTitle: text(row.public_title, "public_title"),
    localDate: text(occurrence.localDate, "occurrence_snapshot.localDate"),
    localStartTime: text(occurrence.localStartTime, "occurrence_snapshot.localStartTime"),
    timeZone: text(occurrence.timeZone, "occurrence_snapshot.timeZone"),
  };
}

/** bigint ids as text, in numeric order. */
const byId = (a: { id: string }, b: { id: string }) => a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The mail job's side of `booking.confirmed` and BOOKING_LINK_TOPIC for guest bookings. */
export class GuestMailOutbox {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * Up to `limit` due confirmations of guest bookings, oldest first, each claimed for `leaseSeconds`.
   * Concurrent claimers never share a row. A row whose last attempt's lease ran out is closed first.
   */
  async claimBookingConfirmations(options: { limit: number; leaseSeconds: number }): Promise<BookingConfirmationClaim> {
    const { rows, abandoned } = await this.#claim(GUEST_MAIL_TOPIC, GUEST_MAIL_LIMITS.confirmationAttempts, options);
    const confirmations = rows
      .map((row): ClaimedBookingConfirmation => ({ id: String(row.id), attempts: count(row.attempts, "attempts"), email: emailFromRow(row) }))
      .sort(byId);
    return { confirmations, abandoned };
  }

  /**
   * Sent, refused for good, or nothing to send: the row is done. A late report after the lease ran out
   * still closes it, so a confirmation that went out is not sent again by a later claim. Only this
   * consumer's rows: any other id changes nothing.
   */
  async completeBookingConfirmation(id: string): Promise<void> {
    await this.#complete(GUEST_MAIL_TOPIC, id);
  }

  /**
   * A transient failure for the claim counted `attempts`: wait 2^attempts minutes (60 at most), or give up
   * once the attempts are used up. Once the lease ran out and another run claimed the row, nothing changes.
   */
  async retryBookingConfirmation(id: string, attempts: number): Promise<BookingConfirmationRetry> {
    return this.#retry(GUEST_MAIL_TOPIC, GUEST_MAIL_LIMITS.confirmationAttempts, id, attempts);
  }

  /** Up to `limit` due booking link emails ("Find your booking"), as claimBookingConfirmations. */
  async claimBookingLinks(options: { limit: number; leaseSeconds: number }): Promise<BookingLinkClaim> {
    const { rows, abandoned } = await this.#claim(BOOKING_LINK_TOPIC, GUEST_MAIL_LIMITS.linkAttempts, options);
    const links = rows
      .map((row): ClaimedBookingLink => ({ id: String(row.id), attempts: count(row.attempts, "attempts"), email: linkEmailFromRow(row) }))
      .sort(byId);
    return { links, abandoned };
  }

  /** As completeBookingConfirmation, for a booking link email. */
  async completeBookingLink(id: string): Promise<void> {
    await this.#complete(BOOKING_LINK_TOPIC, id);
  }

  /** As retryBookingConfirmation, for a booking link email (GUEST_MAIL_LIMITS.linkAttempts). */
  async retryBookingLink(id: string, attempts: number): Promise<BookingConfirmationRetry> {
    return this.#retry(BOOKING_LINK_TOPIC, GUEST_MAIL_LIMITS.linkAttempts, id, attempts);
  }

  async #claim(topic: string, maxAttempts: number, options: { limit: number; leaseSeconds: number }): Promise<{ rows: DbRow[]; abandoned: number }> {
    const limit = boundedInteger(options?.limit, "limit", 1, GUEST_MAIL_LIMITS.claimLimitMax);
    const leaseSeconds = boundedInteger(options?.leaseSeconds, "leaseSeconds", GUEST_MAIL_LIMITS.leaseSecondsMin, GUEST_MAIL_LIMITS.leaseSecondsMax);
    return withTransaction(this.#pool, async (client) => {
      const abandoned = await client.query(
        `UPDATE outbox_messages m SET processed_at = clock_timestamp()
          WHERE ${GUEST_ROW("m")} AND m.attempts >= $2 AND m.available_at <= clock_timestamp()`,
        [topic, maxAttempts],
      );
      const claimed = await client.query<DbRow>(
        `WITH due AS (
           SELECT m.id FROM outbox_messages m
            WHERE ${GUEST_ROW("m")} AND m.attempts < $2 AND m.available_at <= clock_timestamp()
            ORDER BY m.available_at, m.id
            LIMIT $3
            FOR UPDATE OF m SKIP LOCKED
         ), claimed AS (
           UPDATE outbox_messages o
              SET available_at = clock_timestamp() + make_interval(secs => $4), attempts = o.attempts + 1
             FROM due
            WHERE o.id = due.id
           RETURNING o.id, o.attempts, o.provider_id, o.aggregate_id
         )
         SELECT c.id::text AS id, c.attempts, b.public_booking_id::text AS public_booking_id, b.status,
                b.occurrence_snapshot, b.pricing_snapshot, b.seller_snapshot,
                (b.occurrence_snapshot->>'endUtc')::timestamptz + make_interval(days => $5) > clock_timestamp() AS link_open,
                g.guest_email, g.guest_name, g.adult_count, g.child_count, p.public_title, p.slug
           FROM claimed c
           JOIN bookings b ON ${BOOKING_OF("c")}
           JOIN booking_guests g ON g.provider_id = b.provider_id AND g.booking_id = b.id
           JOIN experience_products p ON p.provider_id = b.provider_id AND p.id = b.product_id`,
        [topic, maxAttempts, limit, leaseSeconds, BOOKING_ACCESS_LIMITS.daysAfterExperience],
      );
      return { rows: claimed.rows, abandoned: abandoned.rowCount ?? 0 };
    });
  }

  async #complete(topic: string, id: string): Promise<void> {
    assertRowId(id);
    await this.#pool.query(
      `UPDATE outbox_messages m SET processed_at = clock_timestamp() WHERE m.id = $2 AND ${GUEST_ROW("m")}`,
      [topic, id],
    );
  }

  async #retry(topic: string, maxAttempts: number, id: string, attempts: number): Promise<BookingConfirmationRetry> {
    assertRowId(id);
    boundedInteger(attempts, "attempts", 1, maxAttempts);
    const updated = await this.#pool.query<DbRow>(
      `UPDATE outbox_messages m
          SET available_at = CASE WHEN m.attempts < $3 THEN clock_timestamp() + make_interval(mins => LEAST(power(2, m.attempts), 60)::int) ELSE m.available_at END,
              processed_at = CASE WHEN m.attempts < $3 THEN NULL ELSE clock_timestamp() END
        WHERE m.id = $2 AND m.attempts = $4 AND ${GUEST_ROW("m")}
        RETURNING m.processed_at IS NOT NULL AS gave_up`,
      [topic, id, maxAttempts, attempts],
    );
    const row = updated.rows[0];
    if (!row) return "STALE";
    return row.gave_up === true ? "FAILED" : "RETRY";
  }
}
