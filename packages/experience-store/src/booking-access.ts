import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { StoreError, StoreValidationError } from "./errors.ts";
import { isoValue, type DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import type { GuestCancellationPolicy } from "./types.ts";

/*
 * 予約者の予約ページ (#285 slice 6, migration 0028, docs/guest-booking.md): a guest opens their booking on this
 * site from a link in an email. The link carries a one-time grant; opening it starts a session for that one
 * booking on that device (the web layer keeps the session id in an HttpOnly cookie). Neither is an account and
 * neither proves who the guest is: the link is a bearer credential for one booking. Only the SHA-256 of a grant
 * token or a session id is stored; the raw values leave this module in the return values only. Nothing here
 * returns the guest's email address, and nothing takes an IP address.
 */

export const BOOKING_ACCESS_LIMITS = {
  /** A grant opens a session within this many days of being issued. */
  grantTtlDays: 30,
  /** Grants and sessions end this many days after the experience ends, whatever else. */
  daysAfterExperience: 30,
  /** A session nobody used for this long ends. */
  sessionIdleDays: 30,
  /** A session's last use is written at most once in this many seconds. */
  touchIntervalSeconds: 3_600,
  /** Link emails one booking gets in an hour through "Find your booking". */
  linkEmailsPerBookingPerHour: 3,
  /** Bookings one "Find your booking" request sends a link for. */
  linkBookingsPerRequest: 10,
  purgeLimitMax: 5_000,
} as const;

/** "Find your booking" puts one row per booking to email in `outbox_messages`; the mail job sends them. */
export const BOOKING_LINK_TOPIC = "booking.access_link";

/** A booking whose page a guest may open: never a hold or an abandoned one. */
export const GUEST_BOOKING_VIEW_STATUSES = ["CONFIRMED", "PAYMENT_REVIEW", "CANCELLED"] as const;
export type GuestBookingViewStatus = (typeof GUEST_BOOKING_VIEW_STATUSES)[number];

/** Bookings "Find your booking" sends a link for: paid and not cancelled. */
const LINK_STATUSES = ["CONFIRMED", "PAYMENT_REVIEW"] as const;

export interface BookingAccessGrant {
  /** For `/bookings/open#g=<token>`: in the URL fragment only, never in a path, a query, a log or the outbox. */
  readonly token: string;
  readonly expiresAtUtc: string;
}

export interface OpenedBookingSession {
  /** The cookie's value. It exists only here and in the guest's HttpOnly cookie. */
  readonly sessionId: string;
  readonly publicBookingId: string;
  /** When the session ends at the latest (30 days after the experience): the cookie lives no longer. */
  readonly expiresAtUtc: string;
}

/** What the guest's booking page shows. The guest's own name, never their address. */
export interface GuestBookingView {
  readonly publicBookingId: string;
  readonly status: GuestBookingViewStatus;
  readonly experienceTitle: string;
  readonly experienceSlug: string;
  /** The occurrence as booked (the snapshot), in its own time zone. */
  readonly localDate: string;
  readonly localStartTime: string;
  readonly timeZone: string;
  readonly startUtc: string;
  readonly endUtc: string;
  readonly adultCount: number;
  readonly childCount: number;
  /** What the guest paid, in the currency's smallest unit. */
  readonly totalAmount: number;
  readonly currency: string;
  /** Fixed at booking; null only for a snapshot without one. */
  readonly cancellationPolicy: GuestCancellationPolicy | null;
  /** When free cancellation ends (24 or 48 hours before the start); null when there is none. */
  readonly freeCancellationUntilUtc: string | null;
  /** The seller's name fixed at booking. */
  readonly hostDisplayName: string;
  readonly guestName: string;
  readonly bookedAtUtc: string;
  readonly cancelledAtUtc: string | null;
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ANY_CONTROL = /[\u0000-\u001F\u007F]/;
const POLICIES: ReadonlySet<string> = new Set(["FREE_UNTIL_24H", "FREE_UNTIL_48H", "NONE"]);
const FREE_HOURS: Readonly<Record<string, number>> = { FREE_UNTIL_24H: 24, FREE_UNTIL_48H: 48 };
const END = "(b.occurrence_snapshot->>'endUtc')::timestamptz";

/** A grant token or a session id: 32 random bytes, base64url. */
const isSecret = (value: unknown): value is string => typeof value === "string" && TOKEN.test(value);
const isBookingId = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const digest = (secret: string): Buffer => createHash("sha256").update(secret, "utf8").digest();
const newSecret = (): string => randomBytes(32).toString("base64url");

function boundedInteger(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new StoreValidationError(`${path} must be an integer from ${min} to ${max}.`);
  return value;
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

function viewFromRow(row: DbRow): GuestBookingView {
  const occurrence = record(row.occurrence_snapshot);
  const pricing = record(row.pricing_snapshot);
  const seller = record(row.seller_snapshot);
  const policy = typeof pricing.cancellationPolicy === "string" && POLICIES.has(pricing.cancellationPolicy) ? pricing.cancellationPolicy as GuestCancellationPolicy : null;
  const startUtc = text(occurrence.startUtc, "occurrence_snapshot.startUtc");
  const hours = policy ? FREE_HOURS[policy] : undefined;
  const status = text(row.status, "status");
  if (!(GUEST_BOOKING_VIEW_STATUSES as readonly string[]).includes(status)) throw new StoreError("Database returned an invalid status.");
  return {
    publicBookingId: text(row.public_booking_id, "public_booking_id"),
    status: status as GuestBookingViewStatus,
    experienceTitle: text(row.public_title, "public_title"),
    experienceSlug: text(row.slug, "slug"),
    localDate: text(occurrence.localDate, "occurrence_snapshot.localDate"),
    localStartTime: text(occurrence.localStartTime, "occurrence_snapshot.localStartTime"),
    timeZone: text(occurrence.timeZone, "occurrence_snapshot.timeZone"),
    startUtc,
    endUtc: text(occurrence.endUtc, "occurrence_snapshot.endUtc"),
    adultCount: count(row.adult_count, "adult_count"),
    childCount: count(row.child_count, "child_count"),
    totalAmount: count(pricing.totalAmount, "pricing_snapshot.totalAmount"),
    currency: text(pricing.currency, "pricing_snapshot.currency"),
    cancellationPolicy: policy,
    freeCancellationUntilUtc: hours === undefined ? null : new Date(Date.parse(startUtc) - hours * 3_600_000).toISOString(),
    hostDisplayName: text(seller.displayName, "seller_snapshot.displayName"),
    guestName: text(row.guest_name, "guest_name"),
    bookedAtUtc: isoValue(row, "created_at"),
    cancelledAtUtc: row.cancelled_at === null || row.cancelled_at === undefined ? null : isoValue(row, "cancelled_at"),
  };
}

/** The guest's side of a booking made on this site: links, sessions and "Find your booking". */
export class GuestBookingAccess {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * A one-time grant for an email that links to the booking: 30 days, and never past 30 days after the
   * experience. null when the booking has no page to open (no guest record, a hold or an abandoned one,
   * erased guest data, or more than 30 days after the experience). The raw token is in the result only.
   */
  async issueBookingAccessGrant(publicBookingId: string): Promise<BookingAccessGrant | null> {
    if (!isBookingId(publicBookingId)) throw new StoreValidationError("publicBookingId must be a UUID.");
    const token = newSecret();
    const issued = await this.#pool.query<DbRow>(
      `WITH now AS (SELECT clock_timestamp() AS at)
       INSERT INTO booking_access_grants (token_hash, provider_id, booking_id, access_version, created_at, expires_at)
       SELECT $1, g.provider_id, g.booking_id, g.access_version, now.at,
              LEAST(now.at + make_interval(days => $3), ${END} + make_interval(days => $4))
         FROM now, bookings b
         JOIN booking_guests g ON g.provider_id = b.provider_id AND g.booking_id = b.id
        WHERE b.public_booking_id = $2::uuid AND b.status = ANY($5::text[]) AND g.pii_erased_at IS NULL
          AND ${END} + make_interval(days => $4) > now.at
       RETURNING expires_at`,
      [digest(token), publicBookingId.toLowerCase(), BOOKING_ACCESS_LIMITS.grantTtlDays, BOOKING_ACCESS_LIMITS.daysAfterExperience, GUEST_BOOKING_VIEW_STATUSES],
    );
    const row = issued.rows[0];
    return row ? { token, expiresAtUtc: isoValue(row, "expires_at") } : null;
  }

  /**
   * Opens a session from a grant and marks the grant used, at once: a grant opens one session. null for a
   * token that is unknown, used, expired or issued before the booking's access was revoked, and for a
   * booking whose page cannot be opened (see issueBookingAccessGrant); the caller cannot tell which.
   */
  async openBookingSession(token: string): Promise<OpenedBookingSession | null> {
    if (!isSecret(token)) return null;
    return withTransaction(this.#pool, async (client) => {
      const found = await client.query<DbRow>(
        `SELECT a.provider_id, a.booking_id, a.access_version, b.public_booking_id::text AS public_booking_id,
                ${END} + make_interval(days => $2) AS absolute_expires_at
           FROM booking_access_grants a
           JOIN booking_guests g ON g.provider_id = a.provider_id AND g.booking_id = a.booking_id
           JOIN bookings b ON b.provider_id = a.provider_id AND b.id = a.booking_id
          WHERE a.token_hash = $1 AND a.used_at IS NULL AND a.expires_at > clock_timestamp()
            AND a.access_version = g.access_version AND g.pii_erased_at IS NULL AND b.status = ANY($3::text[])
            AND ${END} + make_interval(days => $2) > clock_timestamp()
          FOR UPDATE OF a`,
        [digest(token), BOOKING_ACCESS_LIMITS.daysAfterExperience, GUEST_BOOKING_VIEW_STATUSES],
      );
      const grant = found.rows[0];
      if (!grant) return null;
      await client.query("UPDATE booking_access_grants SET used_at = clock_timestamp() WHERE token_hash = $1", [digest(token)]);
      const sessionId = newSecret();
      const opened = await client.query<DbRow>(
        `WITH now AS (SELECT clock_timestamp() AS at)
         INSERT INTO booking_sessions (session_hash, provider_id, booking_id, access_version, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
         SELECT $1, $2, $3, $4, now.at, now.at, LEAST(now.at + make_interval(days => $5), $6::timestamptz), $6::timestamptz FROM now
         RETURNING absolute_expires_at`,
        [digest(sessionId), grant.provider_id, grant.booking_id, grant.access_version, BOOKING_ACCESS_LIMITS.sessionIdleDays, grant.absolute_expires_at],
      );
      return { sessionId, publicBookingId: text(grant.public_booking_id, "public_booking_id"), expiresAtUtc: isoValue(opened.rows[0]!, "absolute_expires_at") };
    });
  }

  /**
   * The booking a session reads, or null: a session reads the one booking it was opened for, until 30 idle
   * days, 30 days after the experience, a sign-out on the device or a revocation. Another booking's ID, an
   * unknown session, erased guest data and a booking that cannot be opened are all null alike. Its last use
   * is written at most once an hour, which moves the idle end.
   */
  async readBookingSession(sessionId: string, publicBookingId: string): Promise<GuestBookingView | null> {
    if (!isSecret(sessionId) || !isBookingId(publicBookingId)) return null;
    const found = await this.#pool.query<DbRow>(
      `SELECT b.public_booking_id::text AS public_booking_id, b.status, b.occurrence_snapshot, b.pricing_snapshot, b.seller_snapshot,
              b.created_at, b.cancelled_at, g.guest_name, g.adult_count, g.child_count, p.public_title, p.slug,
              s.last_seen_at <= clock_timestamp() - make_interval(secs => $4) AS stale
         FROM booking_sessions s
         JOIN booking_guests g ON g.provider_id = s.provider_id AND g.booking_id = s.booking_id
         JOIN bookings b ON b.provider_id = s.provider_id AND b.id = s.booking_id
         JOIN experience_products p ON p.provider_id = b.provider_id AND p.id = b.product_id
        WHERE s.session_hash = $1 AND b.public_booking_id = $2::uuid
          AND s.revoked_at IS NULL AND s.idle_expires_at > clock_timestamp() AND s.absolute_expires_at > clock_timestamp()
          AND s.access_version = g.access_version AND g.pii_erased_at IS NULL AND b.status = ANY($3::text[])`,
      [digest(sessionId), publicBookingId.toLowerCase(), GUEST_BOOKING_VIEW_STATUSES, BOOKING_ACCESS_LIMITS.touchIntervalSeconds],
    );
    const row = found.rows[0];
    if (!row) return null;
    if (row.stale === true) {
      await this.#pool.query(
        `WITH now AS (SELECT clock_timestamp() AS at)
         UPDATE booking_sessions s
            SET last_seen_at = now.at, idle_expires_at = LEAST(now.at + make_interval(days => $2), s.absolute_expires_at)
           FROM now
          WHERE s.session_hash = $1 AND s.revoked_at IS NULL AND s.last_seen_at <= now.at - make_interval(secs => $3)`,
        [digest(sessionId), BOOKING_ACCESS_LIMITS.sessionIdleDays, BOOKING_ACCESS_LIMITS.touchIntervalSeconds],
      );
    }
    return viewFromRow(row);
  }

  /** Signs out on the device: the session reads nothing more. An unknown or ended session changes nothing. */
  async endBookingSession(sessionId: string): Promise<void> {
    if (!isSecret(sessionId)) return;
    await this.#pool.query("UPDATE booking_sessions SET revoked_at = clock_timestamp() WHERE session_hash = $1 AND revoked_at IS NULL", [digest(sessionId)]);
  }

  /**
   * For support: every grant and session of the booking issued so far stops working (its access_version
   * moves on). Links emailed afterwards work again. false when there is no guest booking with this ID.
   */
  async revokeBookingAccess(publicBookingId: string): Promise<boolean> {
    if (!isBookingId(publicBookingId)) throw new StoreValidationError("publicBookingId must be a UUID.");
    const revoked = await this.#pool.query(
      `UPDATE booking_guests g SET access_version = g.access_version + 1
         FROM bookings b
        WHERE b.provider_id = g.provider_id AND b.id = g.booking_id AND b.public_booking_id = $1::uuid`,
      [publicBookingId.toLowerCase()],
    );
    return (revoked.rowCount ?? 0) > 0;
  }

  /**
   * "Find your booking": queues one link email (BOOKING_LINK_TOPIC, IDs only) for each paid, uncancelled
   * booking with this address whose experience ends in the future or ended within 30 days, nearest first, at
   * most 10, and at most 3 an hour per booking. Resolves the same whether anything matched, was limited or
   * not: the caller answers alike. The mail job issues each email's grant when it builds the email.
   * StoreValidationError only for something that is not an address.
   */
  async requestBookingLink(input: { readonly email: string }): Promise<void> {
    const email = typeof input?.email === "string" ? input.email.trim() : "";
    if (email.length < 3 || email.length > 254 || ANY_CONTROL.test(email) || !EMAIL.test(email)) throw new StoreValidationError("email must be an email address.");
    await withTransaction(this.#pool, async (client) => {
      // Requests for one address take turns, so the hourly count holds under concurrency.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('booking-link:' || lower($1::text), 41))", [email]);
      await client.query(
        `WITH due AS (
           SELECT b.provider_id, b.public_booking_id::text AS public_booking_id
             FROM booking_guests g
             JOIN bookings b ON b.provider_id = g.provider_id AND b.id = g.booking_id
            WHERE g.guest_email_key = lower($1::text) AND g.pii_erased_at IS NULL AND b.status = ANY($2::text[])
              AND ${END} + make_interval(days => $3) > clock_timestamp()
              AND (SELECT count(*) FROM outbox_messages m
                    WHERE m.topic = $4 AND m.provider_id = b.provider_id AND m.aggregate_id = b.public_booking_id::text
                      AND m.created_at > clock_timestamp() - interval '1 hour') < $5
            ORDER BY ${END} <= clock_timestamp(), abs(extract(epoch FROM ${END} - clock_timestamp())), b.id
            LIMIT $6
         )
         INSERT INTO outbox_messages (provider_id, aggregate_type, aggregate_id, topic, deduplication_key, payload)
         SELECT due.provider_id, 'booking', due.public_booking_id, $4, 'booking-link:' || due.public_booking_id || ':' || $7::text, '{}'::jsonb
           FROM due`,
        [
          email, LINK_STATUSES, BOOKING_ACCESS_LIMITS.daysAfterExperience, BOOKING_LINK_TOPIC,
          BOOKING_ACCESS_LIMITS.linkEmailsPerBookingPerHour, BOOKING_ACCESS_LIMITS.linkBookingsPerRequest, randomUUID(),
        ],
      );
    });
  }

  /**
   * Deletes up to `limit` grants that can no longer open anything (used or expired) and as many sessions
   * that can no longer read anything (signed out, idle or past their end); returns how many in all.
   * A session of a revoked booking goes once it is idle or past its end.
   */
  async purgeExpiredAccess(options: { readonly limit: number }): Promise<number> {
    const limit = boundedInteger(options?.limit, "limit", 1, BOOKING_ACCESS_LIMITS.purgeLimitMax);
    const grants = await this.#pool.query(
      `WITH due AS (
         SELECT token_hash FROM booking_access_grants
          WHERE used_at IS NOT NULL OR expires_at <= clock_timestamp()
          ORDER BY expires_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       DELETE FROM booking_access_grants a USING due WHERE a.token_hash = due.token_hash`,
      [limit],
    );
    const sessions = await this.#pool.query(
      `WITH due AS (
         SELECT session_hash FROM booking_sessions
          WHERE revoked_at IS NOT NULL OR idle_expires_at <= clock_timestamp() OR absolute_expires_at <= clock_timestamp()
          ORDER BY absolute_expires_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       DELETE FROM booking_sessions s USING due WHERE s.session_hash = due.session_hash`,
      [limit],
    );
    return (grants.rowCount ?? 0) + (sessions.rowCount ?? 0);
  }
}
