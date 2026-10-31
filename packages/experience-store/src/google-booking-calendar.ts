import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { StoreValidationError } from "./errors.ts";
import type { DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";

/**
 * Confirmed bookings on the provider's booking calendar (#238): the calendar this site created at connect
 * (`provider_google_connections.booking_calendar_id`, the `calendar.app.created` scope). The job compares each
 * booking with what it wrote (`google_booking_calendar_events`) instead of reading `outbox_messages`, whose
 * `booking.confirmed` rows the mail job completes: a confirmed booking whose event is missing or at other times is
 * written, a written one that is no longer confirmed is deleted. Only the current connection is written; a
 * reconnect (a new generation, a new booking calendar) writes every booking again.
 */
export interface BookingCalendarWork {
  readonly claimId: string;
  readonly providerId: string;
  /** The booking's internal ID, as text. */
  readonly bookingId: string;
  /** What the event ID is made from: the same on every attempt and every connection. */
  readonly publicBookingId: string;
  readonly connectionGeneration: number;
  readonly calendarId: string;
  readonly action: "WRITE" | "REMOVE";
  /** The experience's title and the party size: no guest's name, contact or note. */
  readonly title: string;
  readonly startUtc: string;
  readonly endUtc: string;
  /** Claims so far, this one included. */
  readonly attempts: number;
}

export type BookingCalendarOutcome = "WRITTEN" | "REMOVED" | "FAILED";

const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const TITLE_MAX = 200;

/** A booking whose occurrence ended more than a day ago is not written any more. */
const CANDIDATES = `
  WITH connection AS (
    SELECT c.provider_id,c.connection_generation,c.booking_calendar_id
      FROM provider_google_connections c
      JOIN provider_memberships m ON m.provider_id=c.provider_id AND m.niho_user_id=c.connected_by_niho_user_id
        AND m.active=true AND m.role='OWNER'
  ), wanted AS (
    SELECT b.provider_id,b.id AS booking_id,c.connection_generation,c.booking_calendar_id AS calendar_id,'WRITE' AS action,b.updated_at AS changed_at
      FROM bookings b
      JOIN connection c ON c.provider_id=b.provider_id
      LEFT JOIN google_booking_calendar_events e ON e.provider_id=b.provider_id AND e.booking_id=b.id
        AND e.connection_generation=c.connection_generation
     WHERE b.status='CONFIRMED' AND (b.occurrence_snapshot->>'endUtc')::timestamptz>clock_timestamp()-interval '1 day'
       AND (e.provider_id IS NULL OR e.state<>'WRITTEN'
         OR e.written_start_at<>(b.occurrence_snapshot->>'startUtc')::timestamptz
         OR e.written_end_at<>(b.occurrence_snapshot->>'endUtc')::timestamptz)
       AND (e.provider_id IS NULL OR (e.next_attempt_at<=clock_timestamp()
         AND (e.lease_expires_at IS NULL OR e.lease_expires_at<=clock_timestamp())))
    UNION ALL
    SELECT e.provider_id,e.booking_id,e.connection_generation,e.opaque_calendar_id,'REMOVE',b.updated_at
      FROM google_booking_calendar_events e
      JOIN connection c ON c.provider_id=e.provider_id AND c.connection_generation=e.connection_generation
      JOIN bookings b ON b.provider_id=e.provider_id AND b.id=e.booking_id
     WHERE e.state='WRITTEN' AND b.status<>'CONFIRMED' AND e.next_attempt_at<=clock_timestamp()
       AND (e.lease_expires_at IS NULL OR e.lease_expires_at<=clock_timestamp())
  )
  SELECT provider_id,booking_id::text AS booking_id,connection_generation,calendar_id,action
    FROM wanted ORDER BY changed_at,provider_id COLLATE "C",booking_id LIMIT $1`;

function eventTitle(title: string, seats: number): string {
  const clean = title.replace(/\s+/g, " ").trim();
  let clipped = clean;
  if (clean.length > TITLE_MAX) {
    clipped = "";
    for (const character of clean) {
      if (clipped.length + character.length > TITLE_MAX - 1) break;
      clipped += character;
    }
    clipped += "…";
  }
  return `${clipped}（${seats}名）`;
}

export class GoogleBookingCalendarEvents {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /** Up to `limit` bookings to write or delete, oldest change first, each claimed for `leaseMs`. Concurrent runs never share one. */
  async claimDue(limit: number, leaseMs: number): Promise<BookingCalendarWork[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new StoreValidationError("limit must be between 1 and 100.");
    if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 600_000) throw new StoreValidationError("leaseMs must be between 1 second and 10 minutes.");
    const candidates = await this.#pool.query<DbRow>(CANDIDATES, [limit]);
    const claimed: BookingCalendarWork[] = [];
    for (const candidate of candidates.rows) {
      const claimId = randomUUID();
      const row = await this.#pool.query<DbRow>(
        `WITH claimed AS (
           INSERT INTO google_booking_calendar_events
             (provider_id,booking_id,connection_generation,opaque_calendar_id,claim_id,lease_expires_at,attempts)
           VALUES ($1,$2::bigint,$3,$4,$5::uuid,clock_timestamp()+$6::integer*interval '1 millisecond',1)
           ON CONFLICT (provider_id,booking_id,connection_generation) DO UPDATE
             SET claim_id=EXCLUDED.claim_id,lease_expires_at=EXCLUDED.lease_expires_at,
                 attempts=google_booking_calendar_events.attempts+1,updated_at=clock_timestamp()
             WHERE google_booking_calendar_events.next_attempt_at<=clock_timestamp()
               AND (google_booking_calendar_events.lease_expires_at IS NULL
                 OR google_booking_calendar_events.lease_expires_at<=clock_timestamp())
           RETURNING provider_id,booking_id,attempts)
         SELECT claimed.attempts,b.public_booking_id::text AS public_booking_id,b.seats,p.public_title,
             b.occurrence_snapshot->>'startUtc' AS start_utc,b.occurrence_snapshot->>'endUtc' AS end_utc
           FROM claimed
           JOIN bookings b ON b.provider_id=claimed.provider_id AND b.id=claimed.booking_id
           JOIN experience_products p ON p.provider_id=b.provider_id AND p.id=b.product_id`,
        [candidate.provider_id, candidate.booking_id, candidate.connection_generation, candidate.calendar_id, claimId, leaseMs],
      );
      const claim = row.rows[0];
      if (!claim) continue;
      claimed.push({
        claimId,
        providerId: String(candidate.provider_id),
        bookingId: String(candidate.booking_id),
        publicBookingId: String(claim.public_booking_id),
        connectionGeneration: Number(candidate.connection_generation),
        calendarId: String(candidate.calendar_id),
        action: candidate.action === "REMOVE" ? "REMOVE" : "WRITE",
        title: eventTitle(String(claim.public_title), Number(claim.seats)),
        startUtc: new Date(String(claim.start_utc)).toISOString(),
        endUtc: new Date(String(claim.end_utc)).toISOString(),
        attempts: Number(claim.attempts),
      });
    }
    return claimed;
  }

  /**
   * Records what this claim did. A failure is tried again 1, 5, 15 and 60 minutes later (then hourly). False when the
   * lease ran out and another run holds the row: this claim then changes nothing.
   */
  async finish(work: BookingCalendarWork, outcome: BookingCalendarOutcome): Promise<boolean> {
    return withTransaction(this.#pool, async (client) => {
      const current = await client.query<DbRow>(
        `SELECT attempts FROM google_booking_calendar_events
          WHERE provider_id=$1 AND booking_id=$2::bigint AND connection_generation=$3 AND claim_id=$4::uuid FOR UPDATE`,
        [work.providerId, work.bookingId, work.connectionGeneration, work.claimId],
      );
      if (!current.rows[0]) return false;
      if (outcome === "FAILED") {
        const backoff = RETRY_BACKOFF_MS[Math.min(work.attempts, RETRY_BACKOFF_MS.length) - 1] ?? RETRY_BACKOFF_MS[0]!;
        await client.query(
          `UPDATE google_booking_calendar_events SET claim_id=NULL,lease_expires_at=NULL,
             next_attempt_at=clock_timestamp()+$4::integer*interval '1 millisecond',updated_at=clock_timestamp()
            WHERE provider_id=$1 AND booking_id=$2::bigint AND connection_generation=$3`,
          [work.providerId, work.bookingId, work.connectionGeneration, backoff],
        );
        return true;
      }
      await client.query(
        `UPDATE google_booking_calendar_events SET state=$4,written_start_at=$5,written_end_at=$6,attempts=0,
           next_attempt_at=clock_timestamp(),claim_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
          WHERE provider_id=$1 AND booking_id=$2::bigint AND connection_generation=$3`,
        outcome === "WRITTEN"
          ? [work.providerId, work.bookingId, work.connectionGeneration, "WRITTEN", work.startUtc, work.endUtc]
          : [work.providerId, work.bookingId, work.connectionGeneration, "ABSENT", null, null],
      );
      return true;
    });
  }
}
