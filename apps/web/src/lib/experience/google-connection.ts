import "server-only";
import type { Pool } from "pg";
import { createBookingCalendar, queryGoogleBusy, refreshGoogleToken, type GoogleConfig, type GoogleTokenSet } from "@niho-experience/google-calendar";
import { ExperienceStore, StoreAccessDeniedError, type HostActor } from "@niho-experience/experience-store";
import { siteOrigin } from "@/lib/host/server";
import { googleTokenKey, openGoogleRefreshToken, sealGoogleRefreshToken } from "./google-token-crypto";

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
    const member = await client.query<{ role: string }>(
      "SELECT role FROM provider_memberships WHERE provider_id=$1 AND niho_user_id=$2 AND active=true FOR SHARE",
      [actor.providerId, actor.nihoUserId],
    );
    if (member.rows[0]?.role !== "OWNER") throw new StoreAccessDeniedError();
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
         updated_at=clock_timestamp()`,
      [actor.providerId, actor.nihoUserId, sealed, [...token.scopes], busyCalendarId, bookingCalendarId],
    );
    await client.query(
      `INSERT INTO provider_google_calendars (provider_id, opaque_calendar_id, blocking_enabled, sync_status)
       VALUES ($1,$2,true,'STALE')
       ON CONFLICT (provider_id) DO UPDATE SET
         opaque_calendar_id=EXCLUDED.opaque_calendar_id, blocking_enabled=true, sync_status='STALE',
         fresh_until=NULL, coverage_start=NULL, coverage_end=NULL,
         version=provider_google_calendars.version+1, updated_at=clock_timestamp()`,
      [actor.providerId, busyCalendarId],
    );
    await client.query("DELETE FROM google_busy_intervals WHERE provider_id=$1", [actor.providerId]);
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
}

async function loadConnection(pool: Pool, providerId: string): Promise<StoredGoogleConnection | null> {
  const result = await pool.query<StoredGoogleConnection>(
    "SELECT encrypted_refresh_token, granted_scopes, busy_calendar_id, booking_calendar_id FROM provider_google_connections WHERE provider_id=$1",
    [providerId],
  );
  return result.rows[0] ?? null;
}

/** Refreshes the cached 90-day busy window. Every failed attempt closes new bookings. */
export async function syncGoogleBusy(pool: Pool, store: ExperienceStore, providerId: string): Promise<void> {
  const runtime = googleRuntimeConfig();
  const connection = await loadConnection(pool, providerId);
  if (!runtime || !connection) throw new Error("Google connection is unavailable");
  const now = new Date();
  try {
    const refreshToken = openGoogleRefreshToken(runtime.key, providerId, connection.encrypted_refresh_token);
    const token = await refreshGoogleToken(runtime.google, refreshToken, connection.granted_scopes);
    if (token.refreshToken) {
      await pool.query("UPDATE provider_google_connections SET encrypted_refresh_token=$2, updated_at=clock_timestamp() WHERE provider_id=$1", [providerId, sealGoogleRefreshToken(runtime.key, providerId, token.refreshToken)]);
    }
    const fromUtc = new Date(now.getTime() - 86_400_000).toISOString();
    const toUtc = new Date(now.getTime() + 90 * 86_400_000).toISOString();
    const busyIntervals = await queryGoogleBusy(runtime.google, token.accessToken, [connection.busy_calendar_id], fromUtc, toUtc);
    await store.recordGoogleBusySync({ providerId }, {
      opaqueCalendarId: connection.busy_calendar_id, attemptedAtUtc: now.toISOString(),
      freshUntilUtc: new Date(now.getTime() + 2 * 60_000).toISOString(),
      coverageStartUtc: fromUtc, coverageEndUtc: toUtc, busyIntervals,
    });
  } catch (error) {
    await store.recordGoogleSyncFailure({ providerId }, { opaqueCalendarId: connection.busy_calendar_id, attemptedAtUtc: now.toISOString() });
    throw error;
  }
}

export async function disconnectGoogleCalendar(pool: Pool, actor: HostActor): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const member = await client.query<{ role: string }>(
      "SELECT role FROM provider_memberships WHERE provider_id=$1 AND niho_user_id=$2 AND active=true FOR SHARE",
      [actor.providerId, actor.nihoUserId],
    );
    if (member.rows[0]?.role !== "OWNER") throw new StoreAccessDeniedError();
    await client.query("DELETE FROM provider_google_connections WHERE provider_id=$1", [actor.providerId]);
    await client.query("DELETE FROM provider_google_calendars WHERE provider_id=$1", [actor.providerId]);
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
