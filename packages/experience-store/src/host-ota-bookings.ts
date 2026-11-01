import type { Pool, PoolClient } from "pg";
import { StoreAccessDeniedError, StoreNotFoundError, StoreValidationError } from "./errors.ts";
import { EXTERNAL_RESERVATION_PARTY_BANDS, type ExternalReservationPartyCount } from "./external-reservation-guests.ts";
import { calendarMembershipRole } from "./product-calendar-authorization.ts";
import { isoValue, type DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import type { HostActor } from "./types.ts";
import { assertCanonicalInstant, assertStoreIdentifier } from "./validation.ts";

/*
 * 予約 for bookings made on a reservation site (#194, owner decision 2026-11-01): what the product's people read of the
 * external ledger in /host. The provider's OWNER reads every product's; a product operator (docs/product-operators.md)
 * only the products assigned to them, decided here from the grant and never from the request; an EDITOR or VIEWER
 * member without a grant reads none. The guest's details are shown in full to those who may read the booking (the
 * site's own booking reference included, so the host can find it there). The site's account ID, the external
 * reservation ID, the listing, its calendar and every amount stay out. Cancelling, refunding and writing to the guest
 * happen on the site: nothing here changes a reservation.
 */

export const HOST_OTA_BOOKING_LIMITS = { listDefault: 100, listMax: 200, windowDaysMax: 120, attendanceRefsMax: 200 } as const;

/** 出欠 of an OTA booking (#194 PR B, migration 0039): 来た / 来なかった, as this site's bookings (0033). */
export type HostOtaAttendanceStatus = "ATTENDED" | "NO_SHOW";

export interface HostOtaAttendanceResult {
  /** RECORDED: kept (also when it was already this one). NOT_STARTED: the session has not started. NOT_CONFIRMED: cancelled or still PENDING on the site. */
  readonly outcome: "RECORDED" | "NOT_STARTED" | "NOT_CONFIRMED";
  /** The booking's mark as stored now; null while it has none. */
  readonly status: HostOtaAttendanceStatus | null;
}

export interface HostOtaBookingGuest {
  readonly name: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  /** A BCP 47 tag as the site gave it. */
  readonly language: string | null;
  /** What the guest wrote to the site. */
  readonly notes: string | null;
}

export interface HostOtaBooking {
  /** The host's handle for it (links and pushes). Not the site's reservation ID. */
  readonly ref: string;
  /** The reservation site: Airbnb, GetYourGuide, Viator, Jalan, … (CHANNEL_SITES). */
  readonly site: string;
  readonly productId: string;
  readonly productTitle: string;
  /** The session it holds a seat in; null while it waits for staff (its time matched no session). */
  readonly occurrenceId: string | null;
  /** The schedule rule (the offer) of that session; null with no session. */
  readonly offerId: string | null;
  /** The session's own time and zone as the ledger last placed it; null with no session. */
  readonly occurrenceStartUtc: string | null;
  readonly occurrenceEndUtc: string | null;
  readonly timeZone: string | null;
  /** The time the site gave. */
  readonly sourceStartUtc: string;
  readonly sourceEndUtc: string;
  /** PENDING: the site has not confirmed it yet (it still holds the seat). */
  readonly status: "PENDING" | "CONFIRMED" | "CANCELLED";
  readonly seats: number;
  /** By age band, when the site gave it. */
  readonly partyBreakdown: readonly ExternalReservationPartyCount[] | null;
  /** The site's booking reference; null when its reader cannot see one. */
  readonly bookingReference: string | null;
  /** null when the site's reader gave no guest details (or they were erased). */
  readonly guest: HostOtaBookingGuest | null;
  /** The guest's details were erased (a year after the experience). */
  readonly erased: boolean;
  /** Kept for staff: a double booking, or a time that matched no session. */
  readonly needsReview: boolean;
  /** When this site first read it. */
  readonly firstSeenAtUtc: string;
}

export interface HostOtaBookingListOptions {
  /** Sessions starting at or after this (the site's time), canonical UTC. */
  readonly fromUtc: string;
  /** And before this; at most 120 days after `fromUtc`. */
  readonly toUtc: string;
  readonly productId?: string;
  /** One session only (この回). */
  readonly occurrenceId?: string;
  /** 1-200; 100 by default. */
  readonly limit?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;

/** The products the actor may read the OTA bookings of: every one (null) for the OWNER, else the operator's grants. */
async function readableProducts(client: PoolClient, actor: HostActor): Promise<readonly string[] | null> {
  assertStoreIdentifier(actor.providerId, "actor.providerId");
  assertStoreIdentifier(actor.nihoUserId, "actor.nihoUserId");
  if (await calendarMembershipRole(client, actor, ["OWNER"]) === "OWNER") return null;
  const grants = await client.query<DbRow>(
    `SELECT product_id FROM product_operator_grants
      WHERE provider_id=$1 AND niho_user_id=$2 AND active=true AND (expires_at IS NULL OR expires_at>clock_timestamp())
      ORDER BY product_id FOR SHARE`,
    [actor.providerId, actor.nihoUserId],
  );
  if (grants.rows.length === 0) throw new StoreAccessDeniedError();
  return grants.rows.map((row) => String(row.product_id));
}

const SELECT_OTA_BOOKINGS = `
  SELECT e.host_ref::text AS host_ref, e.source_site, e.product_id, p.public_title, e.occurrence_id,
         e.source_start_at, e.source_end_at, e.status, e.seats, e.needs_review, e.created_at,
         s.occurrence_start_at, s.occurrence_end_at, r.id AS rule_id, r.time_zone,
         g.guest_name, g.party_breakdown, g.guest_email, g.guest_phone, g.guest_language, g.booking_reference, g.source_notes,
         g.pii_erased_at IS NOT NULL AS erased
    FROM external_reservations e
    JOIN experience_products p ON p.provider_id=e.provider_id AND p.id=e.product_id
    LEFT JOIN external_reservation_inventory_snapshots s ON s.source_site=e.source_site
     AND s.source_external_account_id=e.source_external_account_id AND s.external_reservation_id=e.external_reservation_id
     AND s.local_revision=e.local_revision AND e.occurrence_id IS NOT NULL
    LEFT JOIN schedule_rules r ON r.provider_id=e.provider_id AND r.product_id=e.product_id
     AND e.occurrence_id IS NOT NULL AND r.id=replace(split_part(e.occurrence_id,'@',1),'%3A',':')
    LEFT JOIN external_reservation_guests g ON g.source_site=e.source_site
     AND g.source_external_account_id=e.source_external_account_id AND g.external_reservation_id=e.external_reservation_id
   WHERE e.provider_id=$1 AND ($2::text[] IS NULL OR e.product_id=ANY($2::text[]))`;

function optionalText(row: DbRow, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function optionalIso(row: DbRow, key: string): string | null {
  return row[key] === null || row[key] === undefined ? null : isoValue(row, key);
}

function breakdownOf(value: unknown): readonly ExternalReservationPartyCount[] | null {
  if (!Array.isArray(value)) return null;
  const counts = value.filter((entry): entry is ExternalReservationPartyCount => typeof entry === "object" && entry !== null
    && (EXTERNAL_RESERVATION_PARTY_BANDS as readonly unknown[]).includes((entry as Record<string, unknown>).band)
    && Number.isInteger((entry as Record<string, unknown>).count));
  return counts.length === value.length && counts.length > 0 ? counts.map(({ band, count }) => ({ band, count })) : null;
}

function hostOtaBookingFromRow(row: DbRow): HostOtaBooking {
  const guest: HostOtaBookingGuest = {
    name: optionalText(row, "guest_name"), email: optionalText(row, "guest_email"), phone: optionalText(row, "guest_phone"),
    language: optionalText(row, "guest_language"), notes: optionalText(row, "source_notes"),
  };
  const hasGuest = Object.values(guest).some((value) => value !== null);
  const status = String(row.status);
  return {
    ref: String(row.host_ref),
    site: String(row.source_site),
    productId: String(row.product_id),
    productTitle: String(row.public_title),
    occurrenceId: optionalText(row, "occurrence_id"),
    offerId: optionalText(row, "rule_id"),
    occurrenceStartUtc: optionalIso(row, "occurrence_start_at"),
    occurrenceEndUtc: optionalIso(row, "occurrence_end_at"),
    timeZone: optionalText(row, "time_zone"),
    sourceStartUtc: isoValue(row, "source_start_at"),
    sourceEndUtc: isoValue(row, "source_end_at"),
    status: status === "PENDING" || status === "CANCELLED" ? status : "CONFIRMED",
    seats: Number(row.seats),
    partyBreakdown: breakdownOf(row.party_breakdown),
    bookingReference: optionalText(row, "booking_reference"),
    guest: hasGuest ? guest : null,
    erased: row.erased === true,
    needsReview: row.needs_review === true,
    firstSeenAtUtc: isoValue(row, "created_at"),
  };
}

function window(options: HostOtaBookingListOptions): { fromUtc: string; toUtc: string; limit: number } {
  if (typeof options.fromUtc !== "string" || typeof options.toUtc !== "string") throw new StoreValidationError("fromUtc and toUtc are required.");
  assertCanonicalInstant(options.fromUtc, "fromUtc");
  assertCanonicalInstant(options.toUtc, "toUtc");
  const span = Date.parse(options.toUtc) - Date.parse(options.fromUtc);
  if (span <= 0 || span > HOST_OTA_BOOKING_LIMITS.windowDaysMax * DAY_MS) {
    throw new StoreValidationError(`toUtc must be after fromUtc, within ${HOST_OTA_BOOKING_LIMITS.windowDaysMax} days.`);
  }
  const limit = options.limit ?? HOST_OTA_BOOKING_LIMITS.listDefault;
  if (!Number.isInteger(limit) || limit < 1 || limit > HOST_OTA_BOOKING_LIMITS.listMax) {
    throw new StoreValidationError(`limit must be an integer from 1 to ${HOST_OTA_BOOKING_LIMITS.listMax}.`);
  }
  if (options.productId !== undefined) assertStoreIdentifier(options.productId, "productId");
  if (options.occurrenceId !== undefined && (typeof options.occurrenceId !== "string" || options.occurrenceId.length < 1 || options.occurrenceId.length > 256)) {
    throw new StoreValidationError("occurrenceId is invalid.");
  }
  return { fromUtc: options.fromUtc, toUtc: options.toUtc, limit };
}

export class HostOtaBookings {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * The OTA bookings the actor may read whose site time starts in [fromUtc, toUtc), the nearest first: every status,
   * cancellations included (they say so), and those waiting for staff. An operator asking for a product not assigned
   * to them gets none of it (StoreAccessDeniedError), as an actor with no product at all does.
   */
  async listForHost(actor: HostActor, options: HostOtaBookingListOptions): Promise<HostOtaBooking[]> {
    const { fromUtc, toUtc, limit } = window(options);
    return withTransaction(this.#pool, async (client) => {
      const products = await readableProducts(client, actor);
      if (products !== null && options.productId !== undefined && !products.includes(options.productId)) throw new StoreAccessDeniedError();
      const scope = options.productId !== undefined ? [options.productId] : products;
      const result = await client.query<DbRow>(
        `${SELECT_OTA_BOOKINGS}
           AND e.source_start_at >= $3 AND e.source_start_at < $4
           AND ($5::text IS NULL OR e.occurrence_id=$5)
         ORDER BY e.source_start_at, e.host_ref
         LIMIT $6`,
        [actor.providerId, scope, fromUtc, toUtc, options.occurrenceId ?? null, limit],
      );
      return result.rows.map(hostOtaBookingFromRow);
    });
  }

  /**
   * この回's 出欠 (#194 PR B): the marks of the OTA bookings `refs` names that the actor may read (any other is left out).
   * Read only with EXPERIENCE_HOST_ATTENDANCE_ENABLED, once 0039 is applied.
   */
  async attendanceForHost(actor: HostActor, refs: readonly string[]): Promise<ReadonlyMap<string, HostOtaAttendanceStatus>> {
    if (!Array.isArray(refs) || refs.length > HOST_OTA_BOOKING_LIMITS.attendanceRefsMax || refs.some((ref) => typeof ref !== "string" || !UUID.test(ref))) {
      throw new StoreValidationError(`refs must be at most ${HOST_OTA_BOOKING_LIMITS.attendanceRefsMax} UUIDs.`);
    }
    if (refs.length === 0) return new Map();
    return withTransaction(this.#pool, async (client) => {
      const products = await readableProducts(client, actor);
      const result = await client.query<DbRow>(
        `SELECT a.host_ref::text AS host_ref, a.status
           FROM external_reservation_attendance a
           JOIN external_reservations e ON e.host_ref = a.host_ref
          WHERE e.provider_id = $1 AND ($2::text[] IS NULL OR e.product_id = ANY($2::text[])) AND a.host_ref = ANY($3::uuid[])`,
        [actor.providerId, products, refs.map((ref) => ref.toLowerCase())],
      );
      return new Map(result.rows.map((row) => [String(row.host_ref), row.status === "NO_SHOW" ? "NO_SHOW" : "ATTENDED"] as const));
    });
  }

  /**
   * 来た / 来なかった by the product's OWNER or its operator for one confirmed OTA booking, once its session has started
   * (the session's own time where the ledger placed it, else the site's; the database's clock). The same mark again changes
   * nothing; another replaces it. The reservation row is held, so the ledger does not pass it halfway. StoreNotFoundError
   * for one the actor may not read.
   */
  async recordAttendanceAsHost(actor: HostActor, ref: string, status: HostOtaAttendanceStatus): Promise<HostOtaAttendanceResult> {
    if (typeof ref !== "string" || !UUID.test(ref)) throw new StoreValidationError("ref must be a UUID.");
    if (status !== "ATTENDED" && status !== "NO_SHOW") throw new StoreValidationError("attendance must be ATTENDED or NO_SHOW.");
    return withTransaction(this.#pool, async (client) => {
      const products = await readableProducts(client, actor);
      const found = await client.query<DbRow>(
        `SELECT e.host_ref::text AS host_ref, e.status,
                COALESCE(s.occurrence_start_at, e.source_start_at) <= clock_timestamp() AS started
           FROM external_reservations e
           LEFT JOIN external_reservation_inventory_snapshots s ON s.source_site=e.source_site
            AND s.source_external_account_id=e.source_external_account_id AND s.external_reservation_id=e.external_reservation_id
            AND s.local_revision=e.local_revision AND e.occurrence_id IS NOT NULL
          WHERE e.provider_id = $1 AND ($2::text[] IS NULL OR e.product_id = ANY($2::text[])) AND e.host_ref = $3::uuid
          FOR SHARE OF e`,
        [actor.providerId, products, ref.toLowerCase()],
      );
      const row = found.rows[0];
      if (!row) throw new StoreNotFoundError("OTA booking");
      const current = async (): Promise<HostOtaAttendanceStatus | null> => {
        const mark = await client.query<DbRow>("SELECT status FROM external_reservation_attendance WHERE host_ref = $1::uuid", [row.host_ref]);
        const value = mark.rows[0]?.status;
        return value === "ATTENDED" || value === "NO_SHOW" ? value : null;
      };
      if (row.status !== "CONFIRMED") return { outcome: "NOT_CONFIRMED", status: await current() };
      if (row.started !== true) return { outcome: "NOT_STARTED", status: await current() };
      await client.query(
        `INSERT INTO external_reservation_attendance (host_ref, provider_id, status, recorded_by)
         VALUES ($1::uuid, $2, $3, $4)
         ON CONFLICT (host_ref) DO UPDATE
           SET status = EXCLUDED.status, recorded_by = EXCLUDED.recorded_by,
               version = external_reservation_attendance.version + 1, updated_at = clock_timestamp()
           WHERE external_reservation_attendance.status <> EXCLUDED.status`,
        [row.host_ref, actor.providerId, status, actor.nihoUserId],
      );
      return { outcome: "RECORDED", status: await current() };
    });
  }

  /** One OTA booking the actor may read. Another provider's, an unassigned product's or none is StoreNotFoundError. */
  async getForHost(actor: HostActor, ref: string): Promise<HostOtaBooking> {
    if (typeof ref !== "string" || !UUID.test(ref)) throw new StoreValidationError("ref must be a UUID.");
    return withTransaction(this.#pool, async (client) => {
      const products = await readableProducts(client, actor);
      const result = await client.query<DbRow>(`${SELECT_OTA_BOOKINGS} AND e.host_ref=$3::uuid`, [actor.providerId, products, ref.toLowerCase()]);
      const row = result.rows[0];
      if (!row) throw new StoreNotFoundError("OTA booking");
      return hostOtaBookingFromRow(row);
    });
  }
}
