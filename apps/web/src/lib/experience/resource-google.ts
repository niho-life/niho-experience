import "server-only";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { listGoogleCalendars, queryGoogleBusyByCalendar, refreshGoogleToken, watchGoogleCalendar } from "@niho-experience/google-calendar";
import { enqueueCalendarRecalculation, ResourceGoogleRepository, StoreConflictError, type HostActor, type WorkerIdentity } from "@niho-experience/experience-store";
import { openGoogleRefreshToken, sealGoogleRefreshToken } from "./google-token-crypto";
import { googleRuntimeConfig } from "./google-connection";

export const resourceGoogleEnabled = () => process.env.EXPERIENCE_RESOURCE_GOOGLE_ENABLED === "true";
export const resourceGoogleWatchEnabled = () => resourceGoogleEnabled()
  && process.env.EXPERIENCE_RESOURCE_GOOGLE_WATCH_ENABLED === "true"
  && typeof process.env.EXPERIENCE_RESOURCE_GOOGLE_WEBHOOK_URL === "string";

interface ConnectionSnapshot {
  encrypted_refresh_token: string;
  granted_scopes: string[];
  booking_calendar_id: string;
  connection_generation: string;
}

async function connection(pool: Pool, providerId: string): Promise<ConnectionSnapshot | null> {
  return (await pool.query<ConnectionSnapshot>(
    `SELECT c.encrypted_refresh_token,c.granted_scopes,c.booking_calendar_id,c.connection_generation
       FROM provider_google_connections c
       JOIN provider_memberships m ON m.provider_id=c.provider_id AND m.niho_user_id=c.connected_by_niho_user_id
        AND m.active=true AND m.role='OWNER'
      WHERE c.provider_id=$1`, [providerId],
  )).rows[0] ?? null;
}

export async function refreshResourceGoogleOwnerSnapshot(pool: Pool, actor: HostActor) {
  if (!resourceGoogleEnabled()) throw new StoreConflictError("Resource Google is disabled.");
  const runtime = googleRuntimeConfig();
  const snapshot = await connection(pool, actor.providerId);
  const repository = new ResourceGoogleRepository(pool);
  if (!snapshot) return repository.ownerSnapshot(actor);
  const cachedStale = async () => {
    const cached = await repository.ownerSnapshot(actor);
    return { ...cached, resources: cached.resources.map((resource) => resource.enabled ? { ...resource, syncStatus: "STALE" as const } : resource) };
  };
  if (!runtime) return cachedStale();
  try {
    const refreshToken = openGoogleRefreshToken(runtime.key, actor.providerId, snapshot.encrypted_refresh_token);
    const token = await refreshGoogleToken(runtime.google, refreshToken, snapshot.granted_scopes);
    if (token.refreshToken) {
      await pool.query(
        `UPDATE provider_google_connections c SET encrypted_refresh_token=$3,updated_at=clock_timestamp()
          WHERE c.provider_id=$1 AND c.connection_generation=$2 AND EXISTS (SELECT 1 FROM provider_memberships m
            WHERE m.provider_id=c.provider_id AND m.niho_user_id=c.connected_by_niho_user_id AND m.active=true AND m.role='OWNER')`,
        [actor.providerId, snapshot.connection_generation, sealGoogleRefreshToken(runtime.key, actor.providerId, token.refreshToken)],
      );
    }
    const calendars = await listGoogleCalendars(runtime.google, token.accessToken);
    await repository.replaceCalendarInventory(actor, {
      connectionGeneration: Number(snapshot.connection_generation), calendars, fetchedAtUtc: new Date().toISOString(),
    });
    return repository.ownerSnapshot(actor);
  } catch {
    return cachedStale();
  }
}

interface DueClaim {
  claimId: string;
  leaseEpoch: number;
  providerId: string;
  generation: number;
  assignmentAccountId: string;
  assignmentVersion: number;
  refreshToken: string;
  scopes: string[];
  resources: readonly { resourceId: string; calendarId: string; settingsVersion: number; needsWatch: boolean }[];
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const value = await work(client); await client.query("COMMIT"); return value; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

async function claimDue(pool: Pool, worker: WorkerIdentity): Promise<DueClaim | null> {
  return transaction(pool, async (client) => {
    const currentWorker = await client.query<{ version: string }>(
      `SELECT version FROM channel_workers WHERE id=$1 AND revoked_at IS NULL AND credential_expires_at>clock_timestamp() FOR UPDATE`,
      [worker.workerId],
    );
    if (!currentWorker.rows[0] || Number(currentWorker.rows[0].version) !== worker.credentialVersion) return null;
    const due = await client.query<{
      provider_id: string; connection_generation: string; encrypted_refresh_token: string; granted_scopes: string[];
      assignment_account_id: string; assignment_version: string;
    }>(
      `SELECT g.provider_id,c.connection_generation,c.encrypted_refresh_token,c.granted_scopes,
          assignment.account_id AS assignment_account_id,assignment.version AS assignment_version
         FROM resource_google_calendars g
         JOIN provider_google_connections c ON c.provider_id=g.provider_id AND c.connection_generation=g.connection_generation
         JOIN provider_memberships owner_membership ON owner_membership.provider_id=c.provider_id
          AND owner_membership.niho_user_id=c.connected_by_niho_user_id AND owner_membership.active=true AND owner_membership.role='OWNER'
         JOIN LATERAL (
           SELECT wa.account_id,wa.version FROM channel_worker_accounts wa
           JOIN channel_external_accounts a ON a.id=wa.account_id
           WHERE wa.worker_id=$1 AND wa.revoked_at IS NULL AND a.provider_id=g.provider_id
             AND a.active=true AND a.revoked_at IS NULL
           ORDER BY wa.account_id COLLATE "C" LIMIT 1
         ) assignment ON true
        WHERE g.enabled=true AND g.next_sync_due_at<=clock_timestamp()
          AND (g.sync_claim_id IS NULL OR g.sync_lease_expires_at<=clock_timestamp())
        ORDER BY g.next_sync_due_at,g.provider_id COLLATE "C" LIMIT 1 FOR UPDATE OF g SKIP LOCKED`,
      [worker.workerId],
    );
    const selected = due.rows[0];
    if (!selected) return null;
    const claimId = randomUUID();
    const rows = await client.query<{ resource_id: string; opaque_calendar_id: string; settings_version: string; sync_lease_epoch: string; needs_watch: boolean }>(
      `SELECT g.resource_id,g.opaque_calendar_id,g.settings_version,g.sync_lease_epoch,
          NOT EXISTS (SELECT 1 FROM resource_google_watch_channels w WHERE w.provider_id=g.provider_id AND w.resource_id=g.resource_id
            AND w.connection_generation=g.connection_generation AND w.settings_version=g.settings_version AND w.stopped_at IS NULL
            AND w.expires_at>clock_timestamp()+interval '24 hours') AS needs_watch
         FROM resource_google_calendars g
        WHERE g.provider_id=$1 AND g.enabled=true AND g.connection_generation=$2
          AND g.next_sync_due_at<=clock_timestamp()
          AND (g.sync_claim_id IS NULL OR g.sync_lease_expires_at<=clock_timestamp())
        ORDER BY g.next_sync_due_at,g.resource_id COLLATE "C" LIMIT 1 FOR UPDATE OF g SKIP LOCKED`,
      [selected.provider_id, selected.connection_generation],
    );
    if (!rows.rows.length) return null;
    const leaseEpoch = Math.max(...rows.rows.map((row) => Number(row.sync_lease_epoch))) + 1;
    await client.query(
      `UPDATE resource_google_calendars SET sync_claim_id=$3::uuid,sync_claimed_by=$4,
         sync_lease_epoch=$5,sync_lease_expires_at=clock_timestamp()+interval '45 seconds',last_attempted_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE provider_id=$1 AND resource_id=ANY($2::text[])`,
      [selected.provider_id, rows.rows.map((row) => row.resource_id), claimId, worker.workerId, leaseEpoch],
    );
    return {
      claimId, leaseEpoch, providerId: selected.provider_id, generation: Number(selected.connection_generation),
      assignmentAccountId: selected.assignment_account_id, assignmentVersion: Number(selected.assignment_version),
      refreshToken: selected.encrypted_refresh_token, scopes: selected.granted_scopes,
      resources: rows.rows.map((row) => ({ resourceId: row.resource_id, calendarId: row.opaque_calendar_id, settingsVersion: Number(row.settings_version), needsWatch: row.needs_watch })),
    };
  });
}

async function finishClaim(pool: Pool, worker: WorkerIdentity, claim: DueClaim, input: {
  outcome: "APPLIED" | "FAILED" | "SUPERSEDED";
  fromUtc: string;
  toUtc: string;
  busyByCalendar?: ReadonlyMap<string, readonly { startUtc: string; endUtc: string }[]>;
  watches?: ReadonlyMap<string, { channelId: string; googleResourceId: string; tokenDigest: string; expiresAtUtc: string }>;
}): Promise<boolean> {
  return transaction(pool, async (client) => {
    const currentWorker = await client.query<{ version: string; authorized: boolean }>(
      `SELECT version,revoked_at IS NULL AND credential_expires_at>clock_timestamp() AS authorized
         FROM channel_workers WHERE id=$1 FOR UPDATE`,
      [worker.workerId],
    );
    const workerRow = currentWorker.rows[0];
    const workerCurrent = workerRow !== undefined && workerRow.authorized && Number(workerRow.version) === worker.credentialVersion;
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,31))", [`provider-inventory:${claim.providerId}`]);
    const assignment = await client.query(
      `SELECT 1 FROM channel_worker_accounts wa
        JOIN channel_external_accounts a ON a.id=wa.account_id
       WHERE wa.worker_id=$1 AND wa.account_id=$2 AND wa.version=$3 AND wa.revoked_at IS NULL
         AND a.provider_id=$4 AND a.active=true AND a.revoked_at IS NULL
       FOR SHARE OF wa,a`,
      [worker.workerId, claim.assignmentAccountId, claim.assignmentVersion, claim.providerId],
    );
    const current = await client.query<{ connection_generation: string }>(
      `SELECT c.connection_generation FROM provider_google_connections c
        JOIN provider_memberships m ON m.provider_id=c.provider_id AND m.niho_user_id=c.connected_by_niho_user_id
          AND m.active=true AND m.role='OWNER'
       WHERE c.provider_id=$1 FOR SHARE OF c,m`, [claim.providerId],
    );
    const currentGeneration = Number(current.rows[0]?.connection_generation);
    const settings: { resource: DueClaim["resources"][number]; current: boolean }[] = [];
    for (const resource of claim.resources) {
      const row = await client.query<{
        settings_version: string; opaque_calendar_id: string; connection_generation: string;
        sync_lease_epoch: string; enabled: boolean; lease_current: boolean;
      }>(
        `SELECT settings_version,opaque_calendar_id,connection_generation,sync_lease_epoch,enabled,
            sync_lease_expires_at>clock_timestamp() AS lease_current
           FROM resource_google_calendars
          WHERE provider_id=$1 AND resource_id=$2 AND sync_claim_id=$3::uuid AND sync_claimed_by=$4 FOR UPDATE`,
        [claim.providerId, resource.resourceId, claim.claimId, worker.workerId],
      );
      const setting = row.rows[0];
      settings.push({ resource, current: setting !== undefined && setting.enabled && setting.lease_current
        && Number(setting.settings_version) === resource.settingsVersion && setting.opaque_calendar_id === resource.calendarId
        && Number(setting.connection_generation) === claim.generation && Number(setting.sync_lease_epoch) === claim.leaseEpoch });
    }
    const claimCurrent = workerCurrent && assignment.rowCount === 1 && currentGeneration === claim.generation
      && input.outcome !== "SUPERSEDED" && settings.length === claim.resources.length && settings.every((setting) => setting.current);
    if (!claimCurrent) {
      await client.query(
        `UPDATE resource_google_calendars SET sync_claim_id=NULL,sync_claimed_by=NULL,sync_lease_expires_at=NULL,updated_at=clock_timestamp()
          WHERE provider_id=$1 AND sync_claim_id=$2::uuid AND sync_claimed_by=$3`,
        [claim.providerId, claim.claimId, worker.workerId],
      );
      await client.query(
        `INSERT INTO resource_google_sync_receipts (claim_id,provider_id,worker_id,lease_epoch,outcome,calendars_attempted)
         VALUES ($1,$2,$3,$4,'SUPERSEDED',$5) ON CONFLICT (claim_id) DO NOTHING`,
        [claim.claimId, claim.providerId, worker.workerId, claim.leaseEpoch, claim.resources.length],
      );
      return false;
    }
    const completedAt = Date.now();
    const freshUntilUtc = new Date(completedAt + 25 * 60_000).toISOString();
    const nextDueUtc = new Date(completedAt + 15 * 60_000).toISOString();
    for (const { resource } of settings) {
      if (input.outcome === "APPLIED" && input.busyByCalendar) {
        await client.query("DELETE FROM resource_google_busy_intervals WHERE provider_id=$1 AND resource_id=$2", [claim.providerId, resource.resourceId]);
        const busy = input.busyByCalendar.get(resource.calendarId);
        if (!busy) throw new StoreConflictError("A selected calendar is missing from the busy response.");
        if (busy.length > 0) {
          await client.query(
            `INSERT INTO resource_google_busy_intervals
               (provider_id,resource_id,settings_version,connection_generation,start_at,end_at)
             SELECT $1,$2,$3,$4,b.start_at,b.end_at
               FROM unnest($5::timestamptz[],$6::timestamptz[]) AS b(start_at,end_at)
             ON CONFLICT (provider_id,resource_id,start_at,end_at) DO NOTHING`,
            [claim.providerId, resource.resourceId, resource.settingsVersion, claim.generation,
              busy.map((interval) => interval.startUtc), busy.map((interval) => interval.endUtc)],
          );
        }
        await client.query(
          `UPDATE resource_google_calendars SET sync_status='FRESH',last_succeeded_at=clock_timestamp(),
             fresh_until=$6,coverage_start=$4,coverage_end=$5,sync_dirty=false,
             next_sync_due_at=$7,sync_claim_id=NULL,sync_claimed_by=NULL,sync_lease_expires_at=NULL,updated_at=clock_timestamp()
            WHERE provider_id=$1 AND resource_id=$2 AND settings_version=$3`,
          [claim.providerId, resource.resourceId, resource.settingsVersion, input.fromUtc, input.toUtc, freshUntilUtc, nextDueUtc],
        );
        const watch = input.watches?.get(resource.resourceId);
        if (watch) await client.query(
          `INSERT INTO resource_google_watch_channels
             (channel_id,provider_id,resource_id,connection_generation,settings_version,google_resource_id,token_digest,expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [watch.channelId, claim.providerId, resource.resourceId, claim.generation, resource.settingsVersion,
            watch.googleResourceId, watch.tokenDigest, watch.expiresAtUtc],
        );
        await enqueueCalendarRecalculation(client, { providerId: claim.providerId, aggregateType: "resource_google_calendar", aggregateId: resource.resourceId, cause: "resource_google_busy_changed" });
        await enqueueCalendarRecalculation(client, { providerId: claim.providerId, aggregateType: "resource_google_calendar", aggregateId: resource.resourceId, cause: "resource_google_freshness_expired", availableAtUtc: freshUntilUtc });
      } else if (input.outcome === "FAILED") {
        await client.query(
          `UPDATE resource_google_calendars SET sync_status='FAILED',fresh_until=NULL,sync_dirty=true,
             next_sync_due_at=clock_timestamp()+interval '5 minutes',sync_claim_id=NULL,sync_claimed_by=NULL,sync_lease_expires_at=NULL,updated_at=clock_timestamp()
            WHERE provider_id=$1 AND resource_id=$2 AND settings_version=$3`,
          [claim.providerId, resource.resourceId, resource.settingsVersion],
        );
        await enqueueCalendarRecalculation(client, { providerId: claim.providerId, aggregateType: "resource_google_calendar", aggregateId: resource.resourceId, cause: "resource_google_sync_failed" });
      }
    }
    await client.query(
      `INSERT INTO resource_google_sync_receipts (claim_id,provider_id,worker_id,lease_epoch,outcome,calendars_attempted)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (claim_id) DO NOTHING`,
      [claim.claimId, claim.providerId, worker.workerId, claim.leaseEpoch,
        input.outcome === "FAILED" ? "FAILED" : "APPLIED", settings.length],
    );
    return input.outcome === "APPLIED";
  });
}

/** A calendar's permission failure must not invalidate another resource. */
export async function syncOneDueResourceGoogle(pool: Pool, worker: WorkerIdentity): Promise<{ processed: boolean; applied: boolean }> {
  if (!resourceGoogleEnabled()) return { processed: false, applied: false };
  const claim = await claimDue(pool, worker);
  if (!claim) return { processed: false, applied: false };
  const runtime = googleRuntimeConfig();
  const now = Date.now();
  const fromUtc = new Date(now - 86_400_000).toISOString();
  const toUtc = new Date(now + 90 * 86_400_000).toISOString();
  if (!runtime) {
    await finishClaim(pool, worker, claim, { outcome: "FAILED", fromUtc, toUtc });
    return { processed: true, applied: false };
  }
  try {
    const token = await refreshGoogleToken(runtime.google, openGoogleRefreshToken(runtime.key, claim.providerId, claim.refreshToken), claim.scopes);
    if (token.refreshToken) await pool.query(
      `UPDATE provider_google_connections c SET encrypted_refresh_token=$3,updated_at=clock_timestamp()
        WHERE c.provider_id=$1 AND c.connection_generation=$2 AND EXISTS (SELECT 1 FROM provider_memberships m
          WHERE m.provider_id=c.provider_id AND m.niho_user_id=c.connected_by_niho_user_id AND m.active=true AND m.role='OWNER')`,
      [claim.providerId, claim.generation, sealGoogleRefreshToken(runtime.key, claim.providerId, token.refreshToken)],
    );
    const uniqueIds = [...new Set(claim.resources.map((resource) => resource.calendarId))];
    const watches = new Map<string, { channelId: string; googleResourceId: string; tokenDigest: string; expiresAtUtc: string }>();
    const watchWork = resourceGoogleWatchEnabled() ? Promise.all(claim.resources.filter((item) => item.needsWatch).map(async (resource) => {
      const address = process.env.EXPERIENCE_RESOURCE_GOOGLE_WEBHOOK_URL!;
      const channelId = randomUUID();
      const channelToken = randomBytes(32).toString("base64url");
      const requestedExpiry = new Date(Date.now() + 6 * 86_400_000).toISOString();
      try {
        const watched = await watchGoogleCalendar(runtime.google, token.accessToken, {
          id: channelId, calendarId: resource.calendarId, address, token: channelToken, expiresAtUtc: requestedExpiry,
        });
        watches.set(resource.resourceId, { channelId, googleResourceId: watched.resourceId,
          tokenDigest: createHash("sha256").update(channelToken).digest("hex"), expiresAtUtc: watched.expiresAtUtc });
      } catch { /* Poll remains the completeness mechanism. */ }
    })) : Promise.resolve([]);
    const [keyed] = await Promise.all([
      queryGoogleBusyByCalendar(runtime.google, token.accessToken, uniqueIds, fromUtc, toUtc), watchWork,
    ]);
    const applied = await finishClaim(pool, worker, claim, {
      outcome: "APPLIED", fromUtc, toUtc,
      busyByCalendar: new Map(keyed.map((calendar) => [calendar.id, calendar.busyIntervals])),
      watches,
    });
    return { processed: true, applied };
  } catch {
    await finishClaim(pool, worker, claim, { outcome: "FAILED", fromUtc, toUtc });
    return { processed: true, applied: false };
  }
}

function safeDigestMatch(expected: string, token: string): boolean {
  const actual = createHash("sha256").update(token).digest("hex");
  return expected.length === actual.length && timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

/** Verifies only the bounded Google channel headers; the notification body is ignored. */
export async function acceptResourceGoogleWatch(pool: Pool, headers: Headers): Promise<boolean> {
  if (!resourceGoogleWatchEnabled()) return false;
  const channelId = headers.get("x-goog-channel-id") ?? "";
  const resourceId = headers.get("x-goog-resource-id") ?? "";
  const token = headers.get("x-goog-channel-token") ?? "";
  const message = headers.get("x-goog-message-number") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(channelId) || resourceId.length < 1 || resourceId.length > 512 || token.length < 32 || token.length > 256 || !/^[0-9]{1,20}$/.test(message)) return false;
  return transaction(pool, async (client) => {
    const current = await client.query<{
      provider_id: string; resource_id: string; google_resource_id: string; token_digest: string; expires_at: Date;
      last_message_number: string; connection_generation: string; settings_version: string;
    }>(
      `SELECT * FROM resource_google_watch_channels WHERE channel_id=$1::uuid AND stopped_at IS NULL FOR UPDATE`, [channelId],
    );
    const watch = current.rows[0];
    if (!watch || watch.google_resource_id !== resourceId || watch.expires_at.getTime() <= Date.now() || !safeDigestMatch(watch.token_digest, token)) return false;
    const messageNumber = BigInt(message);
    if (messageNumber <= BigInt(watch.last_message_number)) return true;
    const updated = await client.query(
      `UPDATE resource_google_calendars SET sync_dirty=true,next_sync_due_at=LEAST(next_sync_due_at,clock_timestamp()),updated_at=clock_timestamp()
        WHERE provider_id=$1 AND resource_id=$2 AND enabled=true AND connection_generation=$3 AND settings_version=$4
          AND EXISTS (SELECT 1 FROM provider_google_connections c
            JOIN provider_memberships m ON m.provider_id=c.provider_id AND m.niho_user_id=c.connected_by_niho_user_id AND m.active=true AND m.role='OWNER'
            WHERE c.provider_id=$1 AND c.connection_generation=$3)`,
      [watch.provider_id, watch.resource_id, watch.connection_generation, watch.settings_version],
    );
    if (updated.rowCount !== 1) return false;
    await client.query("UPDATE resource_google_watch_channels SET last_message_number=$2,updated_at=clock_timestamp() WHERE channel_id=$1::uuid", [channelId, message]);
    return true;
  });
}
