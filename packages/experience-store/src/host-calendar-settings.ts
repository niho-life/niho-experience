import type { GoogleSyncStatus } from "@niho-experience/experience-domain";
import type { Pool, PoolClient } from "pg";
import { StoreAccessDeniedError, StoreError, StoreValidationError } from "./errors.ts";
import { calendarMembershipRole } from "./product-calendar-authorization.ts";
import { isoValue, type DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import type { HostActor } from "./types.ts";
import { assertCanonicalInstant, assertStoreIdentifier } from "./validation.ts";

/*
 * 設定 › カレンダー (#109) for the provider's OWNER: where the Google Calendar connection stands (the connection itself
 * is made and removed by the host calendar routes) and the bookings feed other calendars read (migration 0035). NIHO
 * proves the account and that it is the provider's OWNER; the experience DB checks its own OWNER membership as well
 * (ADR 0002), as 設定 › 通知 does. The feed answers this site's confirmed bookings with their session and party size
 * only: never a guest's name, contact, note or booking link.
 */

/** The Google Calendar connection as 設定 shows it. No Google account email is kept here. */
export interface HostGoogleConnectionState {
  /** Google refused the connection's token (the OWNER took the access away): told once per connection, until a read succeeds. */
  readonly revoked: boolean;
  /** 予定がある時間は予約を受け付けない. */
  readonly blockingEnabled: boolean;
  readonly syncStatus: GoogleSyncStatus;
  /** The last busy read that succeeded; null before the first one. */
  readonly lastSucceededAtUtc: string | null;
}

/** The feed's secret part as stored: the salt its address is derived from. */
export interface HostCalendarFeedRecord {
  readonly salt: Buffer;
  readonly issuedAtUtc: string;
}

/** One booking in the feed: what a calendar event needs, nothing about the guest. */
export interface HostCalendarFeedBooking {
  /** Internal: only a digest of it reaches the event (its UID). */
  readonly bookingId: string;
  readonly productId: string;
  /** The schedule rule (the offer) of the occurrence. */
  readonly offerId: string;
  readonly productTitle: string;
  readonly startUtc: string;
  readonly endUtc: string;
  /** The occurrence's own day and start (この回's address). */
  readonly localDate: string;
  readonly localStartTime: string;
  /** Adults and children. */
  readonly seats: number;
}

export interface HostCalendarFeed {
  readonly providerId: string;
  /** The nearest first, at most FEED_BOOKING_LIMIT. */
  readonly bookings: readonly HostCalendarFeedBooking[];
}

const FEED_BOOKING_LIMIT = 1000;
const FEED_BYTES = 32;
const START = "(b.occurrence_snapshot->>'startUtc')::timestamptz";
const END = "(b.occurrence_snapshot->>'endUtc')::timestamptz";

/** A current OWNER, not capped below OWNER by NIHO and not a product operator. */
async function requireOwner(client: PoolClient, actor: HostActor): Promise<void> {
  assertStoreIdentifier(actor.providerId, "actor.providerId");
  assertStoreIdentifier(actor.nihoUserId, "actor.nihoUserId");
  if (await calendarMembershipRole(client, actor, ["OWNER"]) !== "OWNER") throw new StoreAccessDeniedError();
}

function assertFeedBytes(value: unknown, path: string): asserts value is Buffer {
  if (!Buffer.isBuffer(value) || value.byteLength !== FEED_BYTES) throw new StoreValidationError(`${path} must be ${FEED_BYTES} bytes.`);
}

function text(row: DbRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) throw new StoreError(`Database returned an invalid ${key}.`);
  return value;
}

function bytes(row: DbRow, key: string): Buffer {
  const value = row[key];
  if (!Buffer.isBuffer(value)) throw new StoreError(`Database returned an invalid ${key}.`);
  return value;
}

const SYNC_STATUSES: ReadonlySet<string> = new Set(["FRESH", "STALE", "FAILED"]);

function feedBookingFromRow(row: DbRow): HostCalendarFeedBooking {
  const seats = Number(row.seats);
  if (!Number.isSafeInteger(seats) || seats < 0) throw new StoreError("Database returned an invalid seats.");
  return {
    bookingId: text(row, "booking_id"),
    productId: text(row, "product_id"),
    offerId: text(row, "offer_id"),
    productTitle: text(row, "public_title"),
    startUtc: isoValue(row, "start_utc"),
    endUtc: isoValue(row, "end_utc"),
    localDate: text(row, "local_date"),
    localStartTime: text(row, "local_start_time"),
    seats,
  };
}

export class HostCalendarSettings {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * The provider's Google Calendar connection, or null when there is none (or whoever made it is no longer an active
   * OWNER, so it is not read any more). Revoked is Google's refusal noticed for this connection while reads still fail.
   */
  async googleConnection(actor: HostActor): Promise<HostGoogleConnectionState | null> {
    return withTransaction(this.#pool, async (client) => {
      await requireOwner(client, actor);
      const result = await client.query<DbRow>(
        `SELECT g.blocking_enabled, g.sync_status, g.last_succeeded_at,
                EXISTS (SELECT 1 FROM outbox_messages o
                         WHERE o.provider_id = c.provider_id
                           AND o.deduplication_key = 'host-push:google-calendar:revoked:' || c.connection_generation::text) AS revoked_notice
           FROM provider_google_connections c
           JOIN provider_memberships m ON m.provider_id = c.provider_id AND m.niho_user_id = c.connected_by_niho_user_id
            AND m.active = true AND m.role = 'OWNER'
           LEFT JOIN provider_google_calendars g ON g.provider_id = c.provider_id
          WHERE c.provider_id = $1`,
        [actor.providerId],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      const syncStatus = typeof row.sync_status === "string" && SYNC_STATUSES.has(row.sync_status) ? (row.sync_status as GoogleSyncStatus) : "STALE";
      return {
        revoked: syncStatus === "FAILED" && row.revoked_notice === true,
        blockingEnabled: row.blocking_enabled === true,
        syncStatus,
        lastSucceededAtUtc: row.last_succeeded_at === null || row.last_succeeded_at === undefined ? null : isoValue(row, "last_succeeded_at"),
      };
    });
  }

  /** The experiences' public paths by id (体験の一覧 joins NIHO's pages to this site's products by slug). OWNER only. */
  async productSlugs(actor: HostActor): Promise<Readonly<Record<string, string>>> {
    return withTransaction(this.#pool, async (client) => {
      await requireOwner(client, actor);
      const result = await client.query<DbRow>("SELECT id, slug FROM experience_products WHERE provider_id = $1", [actor.providerId]);
      return Object.fromEntries(result.rows.map((row) => [text(row, "id"), text(row, "slug")]));
    });
  }

  /** The feed's salt, or null while the provider has none. OWNER only. */
  async getFeed(actor: HostActor): Promise<HostCalendarFeedRecord | null> {
    return withTransaction(this.#pool, async (client) => {
      await requireOwner(client, actor);
      const result = await client.query<DbRow>("SELECT feed_salt, issued_at FROM provider_calendar_feeds WHERE provider_id = $1", [actor.providerId]);
      const row = result.rows[0];
      return row === undefined ? null : { salt: bytes(row, "feed_salt"), issuedAtUtc: isoValue(row, "issued_at") };
    });
  }

  /**
   * Issues the feed at the address `salt` gives (`tokenHash` is the SHA-256 of that address's secret part). Issuing
   * again replaces the old one, which stops working at once. `replaced` says whether there was one. OWNER only.
   */
  async issueFeed(actor: HostActor, input: { readonly salt: Buffer; readonly tokenHash: Buffer }): Promise<{ issuedAtUtc: string; replaced: boolean }> {
    assertFeedBytes(input?.salt, "salt");
    assertFeedBytes(input?.tokenHash, "tokenHash");
    return withTransaction(this.#pool, async (client) => {
      await requireOwner(client, actor);
      const current = await client.query<DbRow>("SELECT provider_id FROM provider_calendar_feeds WHERE provider_id = $1 FOR UPDATE", [actor.providerId]);
      const issued = await client.query<DbRow>(
        `INSERT INTO provider_calendar_feeds (provider_id, issued_by_niho_user_id, feed_salt, token_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (provider_id) DO UPDATE
            SET issued_by_niho_user_id = EXCLUDED.issued_by_niho_user_id,
                feed_salt = EXCLUDED.feed_salt,
                token_hash = EXCLUDED.token_hash,
                issued_at = clock_timestamp()
         RETURNING issued_at`,
        [actor.providerId, actor.nihoUserId, input.salt, input.tokenHash],
      );
      return { issuedAtUtc: isoValue(issued.rows[0]!, "issued_at"), replaced: current.rows.length > 0 };
    });
  }

  /** Stops the feed: its address answers nothing from now on. Whether there was one. OWNER only. */
  async revokeFeed(actor: HostActor): Promise<boolean> {
    return withTransaction(this.#pool, async (client) => {
      await requireOwner(client, actor);
      const result = await client.query("DELETE FROM provider_calendar_feeds WHERE provider_id = $1", [actor.providerId]);
      return (result.rowCount ?? 0) > 0;
    });
  }

  /**
   * For the feed's address (no session: the secret is the address): the provider's confirmed bookings made on this
   * site whose session overlaps [fromUtc, toUtc), the nearest first. Null for an unknown or replaced address, and once
   * whoever issued it is no longer the provider's active OWNER.
   */
  async readFeed(tokenHash: Buffer, window: { readonly fromUtc: string; readonly toUtc: string }): Promise<HostCalendarFeed | null> {
    assertFeedBytes(tokenHash, "tokenHash");
    assertCanonicalInstant(window?.fromUtc, "fromUtc");
    assertCanonicalInstant(window.toUtc, "toUtc");
    if (Date.parse(window.toUtc) <= Date.parse(window.fromUtc)) throw new StoreValidationError("toUtc must be after fromUtc.");
    return withTransaction(this.#pool, async (client) => {
      const feed = await client.query<DbRow>(
        `SELECT f.provider_id
           FROM provider_calendar_feeds f
           JOIN provider_memberships m ON m.provider_id = f.provider_id AND m.niho_user_id = f.issued_by_niho_user_id
            AND m.active = true AND m.role = 'OWNER'
          WHERE f.token_hash = $1`,
        [tokenHash],
      );
      const row = feed.rows[0];
      if (row === undefined) return null;
      const providerId = text(row, "provider_id");
      const bookings = await client.query<DbRow>(
        `SELECT b.id::text AS booking_id, b.product_id, (b.occurrence_snapshot->>'ruleId') AS offer_id, p.public_title,
                ${START} AS start_utc, ${END} AS end_utc,
                (b.occurrence_snapshot->>'localDate') AS local_date, (b.occurrence_snapshot->>'localStartTime') AS local_start_time,
                (g.adult_count + g.child_count)::int AS seats
           FROM bookings b
           JOIN booking_guests g ON g.provider_id = b.provider_id AND g.booking_id = b.id
           JOIN experience_products p ON p.provider_id = b.provider_id AND p.id = b.product_id
          WHERE b.provider_id = $1 AND b.status = 'CONFIRMED'
            AND ${START} < $3::timestamptz AND ${END} > $2::timestamptz
          ORDER BY ${START}, b.id
          LIMIT ${FEED_BOOKING_LIMIT}`,
        [providerId, window.fromUtc, window.toUtc],
      );
      return { providerId, bookings: bookings.rows.map(feedBookingFromRow) };
    });
  }
}
