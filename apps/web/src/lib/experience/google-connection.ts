import "server-only";
import type { Pool } from "pg";
import { createBookingCalendar, queryGoogleBusy, refreshGoogleToken, type GoogleConfig, type GoogleTokenSet } from "@niho-experience/google-calendar";
import {
  enqueueCalendarRecalculation,
  ExperienceStore,
  lockGoogleCalendarUsage,
  lockProviderInventory,
  StoreAccessDeniedError,
  StoreConflictError,
  type HostActor,
} from "@niho-experience/experience-store";
import { siteOrigin } from "@/lib/host/server";
import { GOOGLE_BUSY_NOTICE_AFTER_MINUTES, googleBusyFailureReason, googleBusyRetryMinutes, noticeGoogleBusyFailure } from "./google-busy-failure";
import { googleTokenKey, openGoogleRefreshToken, sealGoogleRefreshToken } from "./google-token-crypto";

/** The busy jobs read each input every 15 minutes; a read is trusted for 25, so one late run does not close bookings. */
export const GOOGLE_BUSY_DUE_MINUTES = 15;
export const GOOGLE_BUSY_FRESH_MINUTES = 25;

export function googleRuntimeConfig(): { google: GoogleConfig; key: Buffer } | null {
  const clientId = process.env.EXPERIENCE_GOOGLE_CLIENT_ID;
  const clientSecret = process.env.EXPERIENCE_GOOGLE_CLIENT_SECRET;
  const key = googleTokenKey();
  if (!clientId || !clientSecret || !key) return null;
  return { google: { clientId, clientSecret, redirectUri: `${siteOrigin()}/host/calendar/google/callback` }, key };
}

export async function saveGoogleConnection(
  pool: Pool, actor: HostActor, token: GoogleTokenSet, busyCalendarId: string, bookingCalendarId: string,
): Promise<void> {
  const runtime = googleRuntimeConfig();
  if (!runtime || !token.refreshToken || !busyCalendarId || !bookingCalendarId) throw new Error("Google connection is unavailable");
  const sealed = sealGoogleRefreshToken(runtime.key, actor.providerId, token.refreshToken);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockProviderInventory(client, actor.providerId);
    const member = await client.query<{ role: string }>(
      "SELECT role FROM provider_memberships WHERE provider_id=$1 AND niho_user_id=$2 AND active=true FOR SHARE",
      [actor.providerId, actor.nihoUserId],
    );
    if (member.rows[0]?.role !== "OWNER") throw new StoreAccessDeniedError();
    await lockGoogleCalendarUsage(client, [busyCalendarId, bookingCalendarId]);
    const outputCollision = await client.query(
      `SELECT 1 FROM google_channel_output_bindings
        WHERE opaque_calendar_id=ANY($1::text[]) FOR SHARE`,
      [[busyCalendarId, bookingCalendarId]],
    );
    if (outputCollision.rows[0]) throw new StoreConflictError("An Airbnb output calendar cannot be used as a Google input or booking calendar.");
    await client.query(
      `INSERT INTO provider_google_connections
        (provider_id, connected_by_niho_user_id, encrypted_refresh_token, granted_scopes, busy_calendar_id, booking_calendar_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (provider_id) DO UPDATE SET
         connected_by_niho_user_id=EXCLUDED.connected_by_niho_user_id,
         encrypted_refresh_token=EXCLUDED.encrypted_refresh_token,
         granted_scopes=EXCLUDED.granted_scopes,
         busy_calendar_id=EXCLUDED.busy_calendar_id,
         booking_calendar_id=EXCLUDED.booking_calendar_id,
         connection_generation=nextval('provider_google_connection_generation_seq'),
         updated_at=clock_timestamp()`,
      [actor.providerId, actor.nihoUserId, sealed, [...token.scopes], busyCalendarId, bookingCalendarId],
    );
    await client.query(
      `INSERT INTO provider_google_calendars (provider_id, opaque_calendar_id, blocking_enabled, sync_status)
       VALUES ($1,$2,true,'STALE')
       ON CONFLICT (provider_id) DO UPDATE SET
         opaque_calendar_id=EXCLUDED.opaque_calendar_id, blocking_enabled=true, sync_status='STALE',
         fresh_until=NULL, coverage_start=NULL, coverage_end=NULL,
         next_sync_due_at=clock_timestamp(), sync_lease_expires_at=NULL, failing_since=NULL,
         version=provider_google_calendars.version+1, updated_at=clock_timestamp()`,
      [actor.providerId, busyCalendarId],
    );
    await client.query("DELETE FROM google_busy_intervals WHERE provider_id=$1", [actor.providerId]);
    await client.query(
      `UPDATE resource_google_calendars SET sync_status='STALE',fresh_until=NULL,sync_dirty=true,next_sync_due_at=clock_timestamp(),
         sync_claim_id=NULL,sync_claimed_by=NULL,sync_lease_expires_at=NULL,failing_since=NULL,updated_at=clock_timestamp()
        WHERE provider_id=$1 AND enabled=true`,
      [actor.providerId],
    );
    await enqueueCalendarRecalculation(client, {
      providerId: actor.providerId,
      aggregateType: "google_calendar",
      aggregateId: actor.providerId,
      cause: "google_connection_changed",
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

interface StoredGoogleConnection {
  encrypted_refresh_token: string;
  granted_scopes: string[];
  busy_calendar_id: string;
  booking_calendar_id: string;
  connection_generation: string;
}

async function loadConnection(pool: Pool, providerId: string): Promise<StoredGoogleConnection | null> {
  const result = await pool.query<StoredGoogleConnection>(
    `SELECT c.encrypted_refresh_token,c.granted_scopes,c.busy_calendar_id,c.booking_calendar_id,c.connection_generation
       FROM provider_google_connections c
       JOIN provider_memberships m ON m.provider_id=c.provider_id AND m.niho_user_id=c.connected_by_niho_user_id
        AND m.active=true AND m.role='OWNER'
      WHERE c.provider_id=$1`,
    [providerId],
  );
  return result.rows[0] ?? null;
}

/**
 * Refreshes the cached 90-day busy window of the provider-wide input. Every failed attempt closes new bookings until a
 * read succeeds; the run of failures is told to the OWNER once (google-busy-failure.ts). The host's calendar screen and
 * the Google busy job (#238) both call this.
 */
export async function syncGoogleBusy(pool: Pool, store: ExperienceStore, providerId: string): Promise<void> {
  const runtime = googleRuntimeConfig();
  const connection = await loadConnection(pool, providerId);
  if (!runtime || !connection) throw new Error("Google connection is unavailable");
  const now = new Date();
  try {
    const refreshToken = openGoogleRefreshToken(runtime.key, providerId, connection.encrypted_refresh_token);
    const token = await refreshGoogleToken(runtime.google, refreshToken, connection.granted_scopes);
    if (token.refreshToken) {
      await pool.query(`UPDATE provider_google_connections c SET encrypted_refresh_token=$3,updated_at=clock_timestamp()
        WHERE c.provider_id=$1 AND c.connection_generation=$2 AND EXISTS (SELECT 1 FROM provider_memberships m
          WHERE m.provider_id=c.provider_id AND m.niho_user_id=c.connected_by_niho_user_id AND m.active=true AND m.role='OWNER')`,
      [providerId, connection.connection_generation, sealGoogleRefreshToken(runtime.key, providerId, token.refreshToken)]);
    }
    const fromUtc = new Date(now.getTime() - 86_400_000).toISOString();
    const toUtc = new Date(now.getTime() + 90 * 86_400_000).toISOString();
    const busyIntervals = await queryGoogleBusy(runtime.google, token.accessToken, [connection.busy_calendar_id], fromUtc, toUtc);
    await store.recordGoogleBusySync({ providerId }, {
      connectionGeneration: Number(connection.connection_generation),
      opaqueCalendarId: connection.busy_calendar_id, attemptedAtUtc: now.toISOString(),
      freshUntilUtc: new Date(now.getTime() + GOOGLE_BUSY_FRESH_MINUTES * 60_000).toISOString(),
      coverageStartUtc: fromUtc, coverageEndUtc: toUtc, busyIntervals,
    });
    await pool.query(
      `UPDATE provider_google_calendars SET failing_since=NULL,next_sync_due_at=clock_timestamp()+$3::integer*interval '1 minute'
        WHERE provider_id=$1 AND opaque_calendar_id=$2`,
      [providerId, connection.busy_calendar_id, GOOGLE_BUSY_DUE_MINUTES],
    );
  } catch (error) {
    await store.recordGoogleSyncFailure({ providerId }, { connectionGeneration: Number(connection.connection_generation), opaqueCalendarId: connection.busy_calendar_id, attemptedAtUtc: now.toISOString() });
    await recordProviderBusyFailure(pool, providerId, connection, googleBusyFailureReason(error));
    throw error;
  }
}

/** The run of failures for the provider-wide input, for the connection that failed only (a reconnect starts over). */
async function recordProviderBusyFailure(pool: Pool, providerId: string, connection: StoredGoogleConnection, reason: "REVOKED" | "UNAVAILABLE"): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const failed = await client.query<{ failing_since: Date; long_failing: boolean }>(
      `UPDATE provider_google_calendars g SET failing_since=COALESCE(g.failing_since,clock_timestamp()),
         next_sync_due_at=clock_timestamp()+$4::integer*interval '1 minute'
        WHERE g.provider_id=$1 AND g.opaque_calendar_id=$2 AND EXISTS (SELECT 1 FROM provider_google_connections c
          WHERE c.provider_id=g.provider_id AND c.connection_generation=$3)
        RETURNING g.failing_since,g.failing_since<=clock_timestamp()-$5::integer*interval '1 minute' AS long_failing`,
      [providerId, connection.busy_calendar_id, connection.connection_generation, googleBusyRetryMinutes(reason), GOOGLE_BUSY_NOTICE_AFTER_MINUTES],
    );
    const row = failed.rows[0];
    if (row) await noticeGoogleBusyFailure(client, {
      providerId, input: "PROVIDER", inputId: providerId, reason, connectionGeneration: Number(connection.connection_generation),
      failingSince: row.failing_since, longFailing: row.long_failing,
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The Google busy job's provider-wide step (#238): claims the provider whose input is due longest (a 60-second lease,
 * so an overlapping run skips it) and reads it. Null when none is due.
 */
export async function syncOneDueProviderGoogle(pool: Pool, store: ExperienceStore): Promise<{ applied: boolean } | null> {
  // The lease as text: a JavaScript Date would drop the microseconds that releasing it compares.
  const claimed = await pool.query<{ provider_id: string; lease: string }>(
    `UPDATE provider_google_calendars g SET sync_lease_expires_at=clock_timestamp()+interval '60 seconds'
      WHERE g.provider_id=(
        SELECT d.provider_id FROM provider_google_calendars d
          JOIN provider_google_connections c ON c.provider_id=d.provider_id AND c.busy_calendar_id=d.opaque_calendar_id
          JOIN provider_memberships m ON m.provider_id=c.provider_id AND m.niho_user_id=c.connected_by_niho_user_id
            AND m.active=true AND m.role='OWNER'
         WHERE d.blocking_enabled=true AND d.next_sync_due_at<=clock_timestamp()
           AND (d.sync_lease_expires_at IS NULL OR d.sync_lease_expires_at<=clock_timestamp())
         ORDER BY d.next_sync_due_at,d.provider_id COLLATE "C" LIMIT 1 FOR UPDATE OF d SKIP LOCKED)
      RETURNING g.provider_id,g.sync_lease_expires_at::text AS lease`,
  );
  const claim = claimed.rows[0];
  if (!claim) return null;
  let applied = false;
  try {
    await syncGoogleBusy(pool, store, claim.provider_id);
    applied = true;
  } catch {
    // Recorded by syncGoogleBusy when the read began; the due time moves on either way, so a broken input is not retried at once.
  }
  await pool.query(
    `UPDATE provider_google_calendars SET sync_lease_expires_at=NULL,
       next_sync_due_at=CASE WHEN $3 THEN next_sync_due_at ELSE GREATEST(next_sync_due_at,clock_timestamp()+interval '5 minutes') END
      WHERE provider_id=$1 AND sync_lease_expires_at=$2::timestamptz`,
    [claim.provider_id, claim.lease, applied],
  );
  return { applied };
}

export async function disconnectGoogleCalendar(pool: Pool, actor: HostActor): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockProviderInventory(client, actor.providerId);
    const member = await client.query<{ role: string }>(
      "SELECT role FROM provider_memberships WHERE provider_id=$1 AND niho_user_id=$2 AND active=true FOR SHARE",
      [actor.providerId, actor.nihoUserId],
    );
    if (member.rows[0]?.role !== "OWNER") throw new StoreAccessDeniedError();
    await client.query("DELETE FROM provider_google_connections WHERE provider_id=$1", [actor.providerId]);
    await client.query("DELETE FROM provider_google_calendars WHERE provider_id=$1", [actor.providerId]);
    await client.query(
      `UPDATE resource_google_calendars SET sync_status='STALE',fresh_until=NULL,sync_dirty=true,
         next_sync_due_at=clock_timestamp(),sync_claim_id=NULL,sync_claimed_by=NULL,sync_lease_expires_at=NULL,failing_since=NULL,updated_at=clock_timestamp()
        WHERE provider_id=$1 AND enabled=true`,
      [actor.providerId],
    );
    await enqueueCalendarRecalculation(client, {
      providerId: actor.providerId,
      aggregateType: "google_calendar",
      aggregateId: actor.providerId,
      cause: "google_connection_disconnected",
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Creates the isolated booking calendar using the granted app.created scope. */
export async function initializeBookingCalendar(token: GoogleTokenSet): Promise<string> {
  const runtime = googleRuntimeConfig();
  if (!runtime) throw new Error("Google connection is unavailable");
  return createBookingCalendar(runtime.google, token.accessToken);
}

export async function connectedCalendarId(pool: Pool, providerId: string): Promise<string | null> {
  return (await loadConnection(pool, providerId))?.busy_calendar_id ?? null;
}

/**
 * An access token for one connection generation, or null once the OWNER reconnected or left (the work is then for a
 * calendar this site no longer writes). A rotated refresh token is kept for that generation only.
 */
export async function googleAccessTokenForConnection(pool: Pool, providerId: string, generation: number): Promise<string | null> {
  const runtime = googleRuntimeConfig();
  if (!runtime) throw new Error("Google connection is unavailable");
  const connection = await loadConnection(pool, providerId);
  if (!connection || Number(connection.connection_generation) !== generation) return null;
  const token = await refreshGoogleToken(runtime.google, openGoogleRefreshToken(runtime.key, providerId, connection.encrypted_refresh_token), connection.granted_scopes);
  if (token.refreshToken) {
    await pool.query(`UPDATE provider_google_connections c SET encrypted_refresh_token=$3,updated_at=clock_timestamp()
      WHERE c.provider_id=$1 AND c.connection_generation=$2 AND EXISTS (SELECT 1 FROM provider_memberships m
        WHERE m.provider_id=c.provider_id AND m.niho_user_id=c.connected_by_niho_user_id AND m.active=true AND m.role='OWNER')`,
    [providerId, generation, sealGoogleRefreshToken(runtime.key, providerId, token.refreshToken)]);
  }
  return token.accessToken;
}
