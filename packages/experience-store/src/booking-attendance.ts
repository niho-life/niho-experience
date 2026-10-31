import type { Pool, PoolClient } from "pg";
import { StoreError, StoreNotFoundError, StoreValidationError } from "./errors.ts";
import { HOST_GUEST_BOOKING_STATUSES, publicBookingIdOf, requireBookingsOwner, sessionKeyOf, type HostGuestSessionKey } from "./host-guest-bookings.ts";
import { isoValue, type DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import type { HostActor } from "./types.ts";

/*
 * 出欠 (#107, migration 0033, docs/guest-booking.md「ホストの画面」) of the guest bookings made on this site: the
 * provider's OWNER marks each confirmed booking of a session 来た (ATTENDED) or 来なかった (NO_SHOW) from the session's
 * start, and may change the mark afterwards (a mistake put right). The start is the booking's occurrence snapshot
 * and "now" is the database's clock, so the browser's clock cannot open it early. This module also gives この回 the
 * occurrence's capacity now, which a booking does not keep. Kept apart from host-guest-bookings.ts so that 予約 and
 * この回 read as before while EXPERIENCE_HOST_ATTENDANCE_ENABLED is off (and before 0033 is applied).
 */

export const BOOKING_ATTENDANCE_STATUSES = ["ATTENDED", "NO_SHOW"] as const;
export type BookingAttendanceStatus = (typeof BOOKING_ATTENDANCE_STATUSES)[number];

/** A booking's latest mark. */
export interface BookingAttendanceMark {
  readonly publicBookingId: string;
  readonly status: BookingAttendanceStatus;
  /** When it was last changed. */
  readonly recordedAtUtc: string;
}

/** What この回 adds to the session's bookings (GuestBookingRepository.listGuestBookingsForSession). */
export interface HostSessionAttendance {
  /** The occurrence's capacity now; null when the session's bookings name no occurrence, or more than one. */
  readonly capacity: number | null;
  /** The marked bookings of the session; any other is 未記録. */
  readonly marks: readonly BookingAttendanceMark[];
}

export type AttendanceRecordOutcome =
  /** The mark is stored (also when it was already this one). */
  | "RECORDED"
  /** The session has not started: nothing changed. */
  | "NOT_STARTED"
  /** The booking is not confirmed (cancelled, or a payment under review): nothing changed. */
  | "NOT_CONFIRMED";

export interface AttendanceRecordResult {
  readonly outcome: AttendanceRecordOutcome;
  /** The booking's mark as stored now; null while it has none. */
  readonly mark: BookingAttendanceMark | null;
}

const START = "(b.occurrence_snapshot->>'startUtc')::timestamptz";
/** One session as この回's address names it (the snapshot's experience, offer, local day and start), as host-guest-bookings.ts does. */
const IN_SESSION = `b.product_id = $2 AND (b.occurrence_snapshot->>'ruleId') = $3
  AND (b.occurrence_snapshot->>'localDate') = $4 AND (b.occurrence_snapshot->>'localStartTime') = $5`;

function statusOf(value: unknown): BookingAttendanceStatus {
  if (value !== "ATTENDED" && value !== "NO_SHOW") throw new StoreValidationError("attendance must be ATTENDED or NO_SHOW.");
  return value;
}

function markFromRow(row: DbRow): BookingAttendanceMark {
  const status = row.status;
  if (status !== "ATTENDED" && status !== "NO_SHOW") throw new StoreError("Database returned an invalid attendance status.");
  return { publicBookingId: String(row.public_booking_id), status, recordedAtUtc: isoValue(row, "updated_at") };
}

async function markOf(client: PoolClient, providerId: string, bookingId: unknown, publicBookingId: string): Promise<BookingAttendanceMark | null> {
  const found = await client.query<DbRow>(
    "SELECT $3::text AS public_booking_id, status, updated_at FROM booking_attendance WHERE provider_id = $1 AND booking_id = $2",
    [providerId, bookingId, publicBookingId],
  );
  return found.rows[0] ? markFromRow(found.rows[0]) : null;
}

export class BookingAttendance {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * この回 for the provider's OWNER: the marks of the session's bookings made here, and the capacity of the occurrence
   * they were booked on as it is now. Nothing about the guests.
   */
  async readSessionForHost(actor: HostActor, session: HostGuestSessionKey): Promise<HostSessionAttendance> {
    const key = sessionKeyOf(session);
    const params = [actor.providerId, key.productId, key.offerId, key.localDate, key.localStartTime, HOST_GUEST_BOOKING_STATUSES];
    return withTransaction(this.#pool, async (client) => {
      await requireBookingsOwner(client, actor);
      const marks = await client.query<DbRow>(
        `SELECT b.public_booking_id::text AS public_booking_id, a.status, a.updated_at
           FROM booking_attendance a
           JOIN bookings b ON b.provider_id = a.provider_id AND b.id = a.booking_id
           JOIN booking_guests g ON g.provider_id = b.provider_id AND g.booking_id = b.id
          WHERE a.provider_id = $1 AND b.status = ANY($6::text[]) AND ${IN_SESSION}
          ORDER BY b.created_at, b.public_booking_id`,
        params,
      );
      // A session is named by the snapshots, so its bookings normally share one occurrence; a capacity is shown only then.
      const occurrences = await client.query<DbRow>(
        `SELECT min(o.capacity)::int AS capacity, count(DISTINCT o.occurrence_id)::int AS occurrences
           FROM schedule_occurrences o
          WHERE o.provider_id = $1 AND o.occurrence_id IN (
            SELECT b.occurrence_id FROM bookings b
              JOIN booking_guests g ON g.provider_id = b.provider_id AND g.booking_id = b.id
             WHERE b.provider_id = $1 AND b.status = ANY($6::text[]) AND ${IN_SESSION})`,
        params,
      );
      const row = occurrences.rows[0];
      const capacity = row && Number(row.occurrences) === 1 ? Number(row.capacity) : null;
      return { capacity, marks: marks.rows.map(markFromRow) };
    });
  }

  /**
   * 来た / 来なかった by the provider's OWNER for one confirmed booking made here, once its session has started (by
   * the database's clock). The same mark again changes nothing; another replaces it. The booking row is held for the
   * transaction, so a cancellation does not pass it halfway. StoreNotFoundError for a booking that is not the
   * provider's, or not a booking (a hold).
   */
  async recordAsHost(actor: HostActor, publicBookingId: string, attendance: BookingAttendanceStatus): Promise<AttendanceRecordResult> {
    const id = publicBookingIdOf(publicBookingId);
    const status = statusOf(attendance);
    return withTransaction(this.#pool, async (client) => {
      await requireBookingsOwner(client, actor);
      const found = await client.query<DbRow>(
        `SELECT b.id, b.status, ${START} <= clock_timestamp() AS started
           FROM bookings b
           JOIN booking_guests g ON g.provider_id = b.provider_id AND g.booking_id = b.id
          WHERE b.provider_id = $1 AND b.public_booking_id = $2::uuid AND b.status = ANY($3::text[])
          FOR SHARE OF b`,
        [actor.providerId, id, HOST_GUEST_BOOKING_STATUSES],
      );
      const booking = found.rows[0];
      if (!booking) throw new StoreNotFoundError("guest booking");
      if (booking.status !== "CONFIRMED") return { outcome: "NOT_CONFIRMED", mark: await markOf(client, actor.providerId, booking.id, id) };
      if (booking.started !== true) return { outcome: "NOT_STARTED", mark: await markOf(client, actor.providerId, booking.id, id) };
      await client.query(
        `INSERT INTO booking_attendance (provider_id, booking_id, status, recorded_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (provider_id, booking_id) DO UPDATE
           SET status = EXCLUDED.status, recorded_by = EXCLUDED.recorded_by,
               version = booking_attendance.version + 1, updated_at = clock_timestamp()
           WHERE booking_attendance.status <> EXCLUDED.status`,
        [actor.providerId, booking.id, status, actor.nihoUserId],
      );
      return { outcome: "RECORDED", mark: await markOf(client, actor.providerId, booking.id, id) };
    });
  }
}
