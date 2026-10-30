import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { StoreAccessDeniedError, StoreConflictError, StoreValidationError } from "./errors.ts";
import { enqueueCalendarRecalculation } from "./inventory-outbox.ts";
import { lockProviderInventory } from "./inventory.ts";
import type { HostActor } from "./types.ts";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ResourceGoogleSetting {
  readonly resourceId: string;
  readonly resourceName: string;
  readonly resourceKind: "VENUE" | "INSTRUCTOR" | "EQUIPMENT";
  readonly enabled: boolean;
  readonly opaqueCalendarId?: string;
  readonly version: number | null;
  readonly syncStatus: "FRESH" | "STALE" | "FAILED";
  readonly freshUntilUtc?: string;
}

export interface ResourceGoogleOwnerSnapshot {
  readonly resources: readonly ResourceGoogleSetting[];
  readonly calendars: readonly { id: string; name: string; primary: boolean }[];
  readonly connectionGeneration: number | null;
  readonly inventoryFetchedAtUtc?: string;
}

function iso(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) throw new StoreConflictError("Stored Google timestamp is invalid.");
  return parsed.toISOString();
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

async function requireOwner(client: PoolClient, actor: HostActor): Promise<void> {
  if (actor.calendarScope === "OPERATOR" || actor.calendarRoleCeiling !== "OWNER") throw new StoreAccessDeniedError();
  const owner = await client.query(
    "SELECT 1 FROM provider_memberships WHERE provider_id=$1 AND niho_user_id=$2 AND active=true AND role='OWNER' FOR SHARE",
    [actor.providerId, actor.nihoUserId],
  );
  if (!owner.rows[0]) throw new StoreAccessDeniedError();
}

export class ResourceGoogleRepository {
  private readonly pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }

  async replaceCalendarInventory(
    actor: HostActor,
    input: { connectionGeneration: number; calendars: readonly { id: string; name: string; primary: boolean }[]; fetchedAtUtc: string },
  ): Promise<void> {
    if (input.calendars.length > 1_000 || !Number.isSafeInteger(input.connectionGeneration) || input.connectionGeneration < 1) throw new StoreValidationError("Invalid Google calendar inventory.");
    await transaction(this.pool, async (client) => {
      await lockProviderInventory(client, actor.providerId);
      await requireOwner(client, actor);
      const connection = await client.query<{ connection_generation: string; booking_calendar_id: string }>(
        `SELECT c.connection_generation,c.booking_calendar_id FROM provider_google_connections c
          JOIN provider_memberships m ON m.provider_id=c.provider_id AND m.niho_user_id=c.connected_by_niho_user_id
            AND m.active=true AND m.role='OWNER'
         WHERE c.provider_id=$1 FOR UPDATE OF c`,
        [actor.providerId],
      );
      const current = connection.rows[0];
      if (!current || Number(current.connection_generation) !== input.connectionGeneration) throw new StoreConflictError("Google connection changed.");
      const unique = new Map(input.calendars.map((item) => [item.id, item]));
      if (unique.size !== input.calendars.length || input.calendars.some((item) => !item.id || item.id.length > 512 || !item.name || item.name.length > 300)) throw new StoreValidationError("Invalid Google calendar inventory.");
      await client.query("DELETE FROM provider_google_calendar_inventory WHERE provider_id=$1", [actor.providerId]);
      const outputCalendars = await client.query<{ opaque_calendar_id: string }>(
        "SELECT opaque_calendar_id FROM google_channel_output_bindings FOR SHARE",
      );
      const excludedOutputIds = new Set(outputCalendars.rows.map((row) => row.opaque_calendar_id));
      for (const calendar of input.calendars) {
        if (calendar.id === current.booking_calendar_id || excludedOutputIds.has(calendar.id)) continue;
        await client.query(
          `INSERT INTO provider_google_calendar_inventory
             (provider_id,connection_generation,opaque_calendar_id,display_name,is_primary,fetched_at)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [actor.providerId, input.connectionGeneration, calendar.id, calendar.name, calendar.primary, input.fetchedAtUtc],
        );
      }
      await client.query(
        `UPDATE resource_google_calendars g SET connection_generation=$2,sync_status='STALE',fresh_until=NULL,
           coverage_start=NULL,coverage_end=NULL,sync_dirty=true,next_sync_due_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE g.provider_id=$1 AND g.enabled=true AND g.connection_generation<>$2
            AND EXISTS (SELECT 1 FROM provider_google_calendar_inventory i
              WHERE i.provider_id=g.provider_id AND i.connection_generation=$2 AND i.opaque_calendar_id=g.opaque_calendar_id)`,
        [actor.providerId, input.connectionGeneration],
      );
    });
  }

  async ownerSnapshot(actor: HostActor): Promise<ResourceGoogleOwnerSnapshot> {
    return transaction(this.pool, async (client) => {
      await requireOwner(client, actor);
      const connection = await client.query<{ connection_generation: string }>(
        `SELECT c.connection_generation FROM provider_google_connections c
          JOIN provider_memberships m ON m.provider_id=c.provider_id AND m.niho_user_id=c.connected_by_niho_user_id
            AND m.active=true AND m.role='OWNER'
         WHERE c.provider_id=$1`,
        [actor.providerId],
      );
      const generation = connection.rows[0] ? Number(connection.rows[0].connection_generation) : null;
      const calendars = await client.query<{ opaque_calendar_id: string; display_name: string; is_primary: boolean; fetched_at: Date }>(
        `SELECT opaque_calendar_id,display_name,is_primary,fetched_at FROM provider_google_calendar_inventory
          WHERE provider_id=$1 AND ($2::bigint IS NULL OR connection_generation=$2)
          ORDER BY is_primary DESC,display_name COLLATE "C",opaque_calendar_id COLLATE "C"`,
        [actor.providerId, generation],
      );
      const resources = await client.query<{
        id: string; display_name: string; kind: ResourceGoogleSetting["resourceKind"]; enabled: boolean | null;
        opaque_calendar_id: string | null; settings_version: string | null; sync_status: ResourceGoogleSetting["syncStatus"] | null; fresh_until: Date | null;
      }>(
        `SELECT r.id,r.display_name,r.kind,g.enabled,g.opaque_calendar_id,g.settings_version,g.sync_status,g.fresh_until
           FROM inventory_resources r
           LEFT JOIN resource_google_calendars g ON g.provider_id=r.provider_id AND g.resource_id=r.id
          WHERE r.provider_id=$1 ORDER BY r.kind,r.display_name COLLATE "C",r.id COLLATE "C"`,
        [actor.providerId],
      );
      return {
        connectionGeneration: generation,
        ...(calendars.rows[0] ? { inventoryFetchedAtUtc: calendars.rows[0].fetched_at.toISOString() } : {}),
        calendars: calendars.rows.map((row) => ({ id: row.opaque_calendar_id, name: row.display_name, primary: row.is_primary })),
        resources: resources.rows.map((row) => {
          const freshUntilUtc = iso(row.fresh_until);
          return {
            resourceId: row.id, resourceName: row.display_name, resourceKind: row.kind,
            enabled: row.enabled === true, ...(row.opaque_calendar_id ? { opaqueCalendarId: row.opaque_calendar_id } : {}),
            version: row.settings_version === null ? null : Number(row.settings_version),
            syncStatus: generation === null && row.enabled === true ? "STALE" : row.sync_status ?? "STALE",
            ...(generation !== null && freshUntilUtc ? { freshUntilUtc } : {}),
          };
        }),
      };
    });
  }

  async save(
    actor: HostActor,
    input: { resourceId: string; calendarId: string; enabled: boolean },
    expectedVersion: number | null,
    commandId: string,
  ): Promise<{ version: number; repeated: boolean }> {
    if (!UUID_V4.test(commandId) || !input.resourceId || input.resourceId.length > 256 || !input.calendarId || input.calendarId.length > 512
      || typeof input.enabled !== "boolean" || (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1))) throw new StoreValidationError("Invalid resource Google command.");
    const fingerprint = `sha256:${createHash("sha256").update(JSON.stringify({ input, expectedVersion })).digest("hex")}`;
    return transaction(this.pool, async (client) => {
      await lockProviderInventory(client, actor.providerId);
      await requireOwner(client, actor);
      const prior = await client.query<{ action: string; request_fingerprint: string; result: { version?: unknown } }>(
        "SELECT action,request_fingerprint,result FROM calendar_commands WHERE provider_id=$1 AND command_id=$2::uuid FOR UPDATE",
        [actor.providerId, commandId],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].action !== "resource_google.save" || prior.rows[0].request_fingerprint !== fingerprint || !Number.isSafeInteger(prior.rows[0].result.version)) throw new StoreConflictError("Command ID was reused with different input.");
        return { version: Number(prior.rows[0].result.version), repeated: true };
      }
      const resource = await client.query("SELECT 1 FROM inventory_resources WHERE provider_id=$1 AND id=$2 FOR SHARE", [actor.providerId, input.resourceId]);
      if (!resource.rows[0]) throw new StoreConflictError("Inventory resource was not found.");
      const connection = await client.query<{ connection_generation: string; booking_calendar_id: string }>(
        `SELECT c.connection_generation,c.booking_calendar_id FROM provider_google_connections c
          JOIN provider_memberships m ON m.provider_id=c.provider_id AND m.niho_user_id=c.connected_by_niho_user_id
            AND m.active=true AND m.role='OWNER'
         WHERE c.provider_id=$1 FOR SHARE OF c`,
        [actor.providerId],
      );
      const currentConnection = connection.rows[0];
      const current = await client.query<{ settings_version: string; opaque_calendar_id: string }>(
        "SELECT settings_version,opaque_calendar_id FROM resource_google_calendars WHERE provider_id=$1 AND resource_id=$2 FOR UPDATE",
        [actor.providerId, input.resourceId],
      );
      const row = current.rows[0];
      if ((row === undefined) !== (expectedVersion === null) || (row && Number(row.settings_version) !== expectedVersion)) throw new StoreConflictError("Resource Google setting version mismatch.");
      if (!currentConnection && input.enabled) throw new StoreConflictError("Google is not connected.");
      const calendarId = input.enabled ? input.calendarId : (row?.opaque_calendar_id ?? input.calendarId);
      if (input.enabled) {
        if (calendarId === currentConnection!.booking_calendar_id) throw new StoreConflictError("The booking calendar cannot be used as busy input.");
        const output = await client.query(
          "SELECT 1 FROM google_channel_output_bindings WHERE opaque_calendar_id=$1 FOR SHARE",
          [calendarId],
        );
        if (output.rows[0]) throw new StoreConflictError("An Airbnb output calendar cannot be used as busy input.");
        const selectable = await client.query(
          `SELECT 1 FROM provider_google_calendar_inventory
            WHERE provider_id=$1 AND connection_generation=$2 AND opaque_calendar_id=$3
              AND fetched_at>clock_timestamp()-interval '10 minutes' FOR SHARE`,
          [actor.providerId, currentConnection!.connection_generation, calendarId],
        );
        if (!selectable.rows[0]) throw new StoreConflictError("Calendar inventory is not fresh.");
      }
      const generation = currentConnection ? Number(currentConnection.connection_generation) : 1;
      const version = row ? Number(row.settings_version) + 1 : 1;
      if (row) {
        await client.query(
          `UPDATE resource_google_calendars SET opaque_calendar_id=$3,enabled=$4,settings_version=settings_version+1,
             connection_generation=$5,sync_status='STALE',fresh_until=NULL,coverage_start=NULL,coverage_end=NULL,
             sync_dirty=true,next_sync_due_at=clock_timestamp(),sync_claim_id=NULL,sync_claimed_by=NULL,sync_lease_expires_at=NULL,updated_at=clock_timestamp()
            WHERE provider_id=$1 AND resource_id=$2`,
          [actor.providerId, input.resourceId, calendarId, input.enabled, generation],
        );
        await client.query("DELETE FROM resource_google_busy_intervals WHERE provider_id=$1 AND resource_id=$2", [actor.providerId, input.resourceId]);
      } else {
        await client.query(
          `INSERT INTO resource_google_calendars
             (provider_id,resource_id,opaque_calendar_id,enabled,connection_generation)
           VALUES ($1,$2,$3,$4,$5)`,
          [actor.providerId, input.resourceId, calendarId, input.enabled, generation],
        );
      }
      const result = { resourceId: input.resourceId, version };
      await client.query(
        `INSERT INTO calendar_commands (provider_id,command_id,action,request_fingerprint,result)
         VALUES ($1,$2::uuid,'resource_google.save',$3,$4::jsonb)`,
        [actor.providerId, commandId, fingerprint, JSON.stringify(result)],
      );
      await enqueueCalendarRecalculation(client, {
        providerId: actor.providerId, aggregateType: "resource_google_calendar", aggregateId: input.resourceId,
        cause: "resource_google_configuration_changed", commandId: randomUUID(),
      });
      return { version, repeated: false };
    });
  }
}
