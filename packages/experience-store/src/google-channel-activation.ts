import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { StoreAccessDeniedError, StoreConflictError, StoreNotFoundError, StoreValidationError } from "./errors.ts";
import { currentChannelOccurrence } from "./channel-occurrence.ts";
import { evaluateStoredInventory, lockGoogleCalendarUsage, lockProviderInventory } from "./inventory.ts";
import type { HostActor } from "./types.ts";

export type GoogleChannelActivationState = "READY" | "ACTIVE" | "NEEDS_REVIEW";

export interface GoogleChannelActivationInput {
  readonly listingId: string;
  readonly occurrenceId: string;
  readonly expectedMappingVersion: number;
  readonly expectedBindingVersion: number;
  readonly expectedDesiredVersion: number;
  readonly commandId: string;
  readonly connectionConfirmed: true;
}

export interface GoogleChannelActivationStatus {
  readonly listingId: string;
  readonly occurrenceId: string;
  readonly state: GoogleChannelActivationState;
  readonly expectedMappingVersion: number;
  readonly expectedBindingVersion: number;
  readonly expectedDesiredVersion: number;
}

export interface GoogleChannelActivationApplied {
  readonly commandId: string;
  readonly listingId: string;
  readonly occurrenceId: string;
  readonly state: "APPLIED";
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUIRED_GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.app.created",
] as const;

type Row = Record<string, unknown> & {
  account_id: string; product_id: string; opaque_calendar_id: string; granted_scopes: string[];
};

function digest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function scopesDigest(scopes: readonly string[]): string { return digest(JSON.stringify([...scopes].sort())); }
function integer(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new StoreConflictError("Stored Google activation version is invalid.");
  return parsed;
}
function iso(value: unknown): string {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) throw new StoreConflictError("Stored Google activation time is invalid.");
  return parsed.toISOString();
}
function assertActor(actor: HostActor): void {
  if (!actor.providerId || !actor.nihoUserId || actor.calendarScope === "OPERATOR" || actor.calendarRoleCeiling !== "OWNER") {
    throw new StoreAccessDeniedError();
  }
}
function assertTarget(listingId: string, occurrenceId: string): void {
  if (!listingId || listingId.length > 256 || !occurrenceId || occurrenceId.length > 256) {
    throw new StoreValidationError("Invalid Google activation target.");
  }
}
function assertInput(input: GoogleChannelActivationInput): void {
  assertTarget(input.listingId, input.occurrenceId);
  if (![input.expectedMappingVersion, input.expectedBindingVersion, input.expectedDesiredVersion]
      .every((value) => Number.isSafeInteger(value) && value > 0)
    || !UUID_V4.test(input.commandId) || input.connectionConfirmed !== true) {
    throw new StoreValidationError("Invalid Google activation command.");
  }
}
function fingerprint(providerId: string, input: GoogleChannelActivationInput): string {
  return digest(JSON.stringify([
    providerId, input.listingId, input.occurrenceId, input.expectedMappingVersion,
    input.expectedBindingVersion, input.expectedDesiredVersion, input.connectionConfirmed,
  ]));
}

async function transaction<T>(pool: Pool, providerId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockProviderInventory(client, providerId);
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export class GoogleChannelActivationRepository {
  readonly #pool: Pool;
  constructor(pool: Pool) { this.#pool = pool; }

  async #assertCurrentOwner(client: PoolClient, actor: HostActor): Promise<void> {
    assertActor(actor);
    const found = await client.query(
      `SELECT 1 FROM provider_google_connections c
        JOIN provider_memberships m ON m.provider_id=c.provider_id AND m.niho_user_id=c.connected_by_niho_user_id
          AND m.active=true AND m.role='OWNER'
       WHERE c.provider_id=$1 AND c.connected_by_niho_user_id=$2 FOR SHARE OF c,m`,
      [actor.providerId, actor.nihoUserId],
    );
    if (!found.rows[0]) throw new StoreAccessDeniedError();
  }

  async #assertCurrentGoogleScopes(client: PoolClient, actor: HostActor): Promise<void> {
    const row = (await client.query<{ granted_scopes: string[] }>(
      "SELECT granted_scopes FROM provider_google_connections WHERE provider_id=$1 AND connected_by_niho_user_id=$2",
      [actor.providerId, actor.nihoUserId],
    )).rows[0];
    if (!row || !Array.isArray(row.granted_scopes)
      || !REQUIRED_GOOGLE_SCOPES.every((scope) => row.granted_scopes.includes(scope))) {
      throw new StoreConflictError("The current Google grant is insufficient.");
    }
  }

  async #authority(
    client: PoolClient,
    actor: HostActor,
    listingId: string,
    occurrenceId: string,
    expectedMappingVersion: number,
    expectedBindingVersion: number,
    expectedDesiredVersion: number,
    requireInactive: boolean,
    lock: boolean,
  ): Promise<Row> {
    const result = await client.query<Row>(
      `SELECT l.account_id,l.product_id,l.mapping_version,l.active AS listing_active,l.adapter,l.adapter_version,
              l.connection_mode,l.external_product_id,l.external_option_id,a.external_account_id,a.site,
              a.active AS account_active,a.revoked_at,a.delegated_until,a.quarantined_at,a.version AS account_version,
              d.desired_state,d.desired_version,d.mapping_version AS desired_mapping_version,d.source_start_at,d.source_end_at,
              b.opaque_calendar_id,b.binding_version,b.mapping_version AS binding_mapping_version,
              b.connection_generation,b.active AS binding_active,b.initialize_missing_open_anchor,
              c.granted_scopes,c.connected_by_niho_user_id,c.connection_generation AS current_connection_generation,
              s.command_id AS setup_command_id,s.account_version AS setup_account_version,
              s.granted_scopes_digest AS setup_scopes_digest,
              h.command_id AS anchor_command_id,h.account_version AS anchor_account_version,
              h.mapping_version AS anchor_mapping_version,h.binding_version AS anchor_binding_version,
              h.connection_generation AS anchor_connection_generation,h.binding_calendar_digest AS anchor_calendar_digest,
              h.granted_scopes_digest AS anchor_scopes_digest,h.desired_state AS anchor_desired_state,
              h.desired_version AS anchor_desired_version,h.source_start_at AS anchor_start_at,h.source_end_at AS anchor_end_at,
              h.google_mapping_version,h.google_desired_version,h.google_start_at,h.google_end_at,
              h.google_desired_state,h.google_transparency,ac.command_id AS activation_command_id,
              ac.account_id AS activation_account_id,ac.mapping_version AS activation_mapping_version,
              ac.binding_version_before AS activation_binding_version_before,
              ac.binding_version_after AS activation_binding_version_after,
              ac.desired_version AS activation_desired_version,
              ac.connection_generation AS activation_connection_generation,
              ac.binding_calendar_digest AS activation_calendar_digest,
              ac.granted_scopes_digest AS activation_scopes_digest,
              ac.setup_command_id AS activation_setup_command_id
         FROM channel_listings l
         JOIN channel_external_accounts a ON a.provider_id=l.provider_id AND a.id=l.account_id
         JOIN channel_desired_states d ON d.provider_id=l.provider_id AND d.listing_id=l.id AND d.occurrence_id=$4
         JOIN google_channel_output_bindings b ON b.provider_id=l.provider_id AND b.listing_id=l.id
         JOIN provider_google_connections c ON c.provider_id=l.provider_id AND c.connection_generation=b.connection_generation
         JOIN provider_memberships m ON m.provider_id=l.provider_id AND m.niho_user_id=$3
          AND m.active=true AND m.role='OWNER'
         JOIN google_channel_setup_journals s ON s.provider_id=l.provider_id AND s.listing_id=l.id
          AND s.phase='READY_FOR_CONNECTION' AND s.created_calendar_id=b.opaque_calendar_id
          AND s.account_id=l.account_id AND s.expected_mapping_version=b.mapping_version
          AND s.connection_generation=b.connection_generation AND s.created_by_niho_user_id=c.connected_by_niho_user_id
         JOIN google_channel_anchor_journals h ON h.provider_id=l.provider_id AND h.listing_id=l.id
          AND h.occurrence_id=d.occurrence_id AND h.phase='GOOGLE_VERIFIED' AND h.account_id=l.account_id
          AND h.actor_niho_user_id=c.connected_by_niho_user_id AND h.mapping_version=b.mapping_version
          AND (h.binding_version=b.binding_version OR (b.active=true AND h.binding_version=b.binding_version-1))
          AND h.connection_generation=b.connection_generation
          AND h.desired_state=d.desired_state AND h.desired_version=d.desired_version
          AND h.source_start_at=d.source_start_at AND h.source_end_at=d.source_end_at
         LEFT JOIN google_channel_activation_commands ac ON ac.provider_id=l.provider_id AND ac.listing_id=l.id
          AND ac.occurrence_id=d.occurrence_id AND ac.actor_niho_user_id=c.connected_by_niho_user_id
          AND ac.binding_version_after=b.binding_version AND ac.anchor_command_id=h.command_id
        WHERE l.provider_id=$1 AND l.id=$2
        ORDER BY h.created_at DESC,s.created_at DESC LIMIT 1
        ${lock ? "FOR UPDATE OF l,a,d,b,c FOR SHARE OF m,s,h" : ""}`,
      [actor.providerId, listingId, actor.nihoUserId, occurrenceId],
    );
    const row = result.rows[0];
    if (!row) throw new StoreConflictError("Google activation authority is not ready.");
    if (row.connected_by_niho_user_id !== actor.nihoUserId) throw new StoreAccessDeniedError();
    if (lock) await lockGoogleCalendarUsage(client, [row.opaque_calendar_id]);
    const now = new Date().toISOString();
    if (!Array.isArray(row.granted_scopes)) throw new StoreConflictError("The current Google grant is invalid.");
    const scopeDigest = scopesDigest(row.granted_scopes);
    const calendarDigest = digest(row.opaque_calendar_id);
    const anchorBindingVersion = row.binding_active === true ? expectedBindingVersion - 1 : expectedBindingVersion;
    if (row.site !== "Airbnb" || row.adapter !== "airbnb-google-busy" || row.adapter_version !== "1"
      || row.connection_mode !== "GOOGLE" || row.account_active !== true || row.listing_active !== true
      || (requireInactive && row.binding_active !== false)
      || row.initialize_missing_open_anchor !== (row.binding_active === true)
      || row.revoked_at !== null || row.quarantined_at !== null
      || (row.delegated_until !== null && iso(row.delegated_until) <= now)
      || typeof row.external_account_id !== "string" || !/^[1-9]\d{0,127}$/.test(row.external_account_id)
      || typeof row.external_product_id !== "string" || !/^[1-9]\d{0,127}$/.test(row.external_product_id)
      || row.external_option_id !== ""
      || integer(row.mapping_version) !== expectedMappingVersion
      || integer(row.binding_mapping_version) !== expectedMappingVersion
      || integer(row.desired_mapping_version) !== expectedMappingVersion
      || integer(row.binding_version) !== expectedBindingVersion
      || integer(row.desired_version) !== expectedDesiredVersion
      || integer(row.current_connection_generation) !== integer(row.connection_generation)
      || !REQUIRED_GOOGLE_SCOPES.every((scope) => row.granted_scopes.includes(scope))
      || (row.binding_active === true && row.activation_command_id === null)
      || (row.binding_active === true && (row.activation_account_id !== row.account_id
        || integer(row.activation_mapping_version) !== expectedMappingVersion
        || integer(row.activation_binding_version_before) !== anchorBindingVersion
        || integer(row.activation_binding_version_after) !== expectedBindingVersion
        || integer(row.activation_desired_version) !== expectedDesiredVersion
        || integer(row.activation_connection_generation) !== integer(row.connection_generation)
        || row.activation_calendar_digest !== calendarDigest || row.activation_scopes_digest !== scopeDigest
        || row.activation_setup_command_id !== row.setup_command_id))
      || integer(row.setup_account_version) !== integer(row.account_version) || row.setup_scopes_digest !== scopeDigest
      || integer(row.anchor_account_version) !== integer(row.account_version)
      || integer(row.anchor_mapping_version) !== expectedMappingVersion
      || integer(row.anchor_binding_version) !== anchorBindingVersion
      || integer(row.anchor_connection_generation) !== integer(row.connection_generation)
      || row.anchor_calendar_digest !== calendarDigest || row.anchor_scopes_digest !== scopeDigest
      || row.anchor_desired_state !== row.desired_state || integer(row.anchor_desired_version) !== expectedDesiredVersion
      || iso(row.anchor_start_at) !== iso(row.source_start_at) || iso(row.anchor_end_at) !== iso(row.source_end_at)
      || integer(row.google_mapping_version) !== expectedMappingVersion
      || integer(row.google_desired_version) !== expectedDesiredVersion
      || iso(row.google_start_at) !== iso(row.source_start_at) || iso(row.google_end_at) !== iso(row.source_end_at)
      || row.google_desired_state !== row.desired_state
      || row.google_transparency !== (row.desired_state === "OPEN" ? "transparent" : "opaque")) {
      throw new StoreConflictError("Google activation authority changed.");
    }
    const collision = await client.query(
      `SELECT 1 WHERE EXISTS (SELECT 1 FROM provider_google_calendars WHERE opaque_calendar_id=$1)
        OR EXISTS (SELECT 1 FROM resource_google_calendars WHERE opaque_calendar_id=$1)
        OR EXISTS (SELECT 1 FROM provider_google_connections WHERE busy_calendar_id=$1 OR booking_calendar_id=$1)`,
      [row.opaque_calendar_id],
    );
    if (collision.rows[0]) throw new StoreConflictError("Output calendar is configured as an input or booking calendar.");
    const unresolved = await client.query(
      `SELECT 1 WHERE EXISTS (
         SELECT 1 FROM channel_jobs WHERE account_id=$1 AND status='LEASED'
       ) OR EXISTS (
         SELECT 1 FROM google_channel_deliveries WHERE provider_id=$2 AND listing_id=$3
          AND phase IN ('DISPATCHING','UNCERTAIN')
       ) OR EXISTS (
         SELECT 1 FROM google_channel_anchor_journals WHERE provider_id=$2 AND listing_id=$3
          AND phase IN ('PREPARING','INITIALIZING','UNCERTAIN')
       )`,
      [row.account_id, actor.providerId, listingId],
    );
    if (unresolved.rows[0]) throw new StoreConflictError("Google output work is unresolved.");
    const occurrence = await currentChannelOccurrence(client, actor.providerId, listingId, occurrenceId).catch((error: unknown) => {
      if (error instanceof StoreNotFoundError) throw new StoreConflictError("Canonical occurrence is missing.");
      throw error;
    });
    if (occurrence.startUtc !== iso(row.source_start_at) || occurrence.endUtc !== iso(row.source_end_at)) {
      throw new StoreConflictError("Canonical occurrence time changed.");
    }
    const availability = await evaluateStoredInventory(client, actor.providerId, row.product_id, occurrence, now, 1);
    if ((availability.availability.bookable ? "OPEN" : "CLOSED") !== row.desired_state) {
      throw new StoreConflictError("Live inventory changed.");
    }
    return row;
  }

  // Activation verifies one initial anchor. Once connected, ordinary changes
  // and other occurrences must not invalidate the connection's read model.
  // This is configuration state only; it never proves a slot is synchronized.
  async #assertActiveConfiguration(client: PoolClient, actor: HostActor, listingId: string, occurrenceId: string): Promise<void> {
    const row = (await client.query<Row>(
      `SELECT l.account_id,l.mapping_version,l.external_product_id,l.external_option_id,l.adapter,l.adapter_version,
              l.connection_mode,l.active AS listing_active,a.site,a.external_account_id,a.active AS account_active,
              a.revoked_at,a.quarantined_at,a.delegated_until,a.version AS account_version,
              b.opaque_calendar_id,b.mapping_version AS binding_mapping_version,b.connection_generation,
              c.connection_generation AS current_generation,c.granted_scopes,
              ac.account_version AS activation_account_version,ac.binding_calendar_digest,ac.granted_scopes_digest,
              d.mapping_version AS desired_mapping_version,d.source_start_at,d.source_end_at
         FROM channel_listings l
         JOIN channel_external_accounts a ON a.provider_id=l.provider_id AND a.id=l.account_id
         JOIN channel_desired_states d ON d.provider_id=l.provider_id AND d.listing_id=l.id AND d.occurrence_id=$4
         JOIN google_channel_output_bindings b ON b.provider_id=l.provider_id AND b.listing_id=l.id
          AND b.active=true AND b.initialize_missing_open_anchor=true
         JOIN provider_google_connections c ON c.provider_id=l.provider_id AND c.connected_by_niho_user_id=$3
         JOIN google_channel_activation_commands ac ON ac.provider_id=l.provider_id AND ac.listing_id=l.id
          AND ac.account_id=l.account_id AND ac.actor_niho_user_id=$3 AND ac.binding_version_after=b.binding_version
          AND ac.mapping_version=b.mapping_version AND ac.connection_generation=b.connection_generation
         JOIN google_channel_setup_journals s ON s.provider_id=ac.provider_id AND s.command_id=ac.setup_command_id
          AND s.phase='READY_FOR_CONNECTION' AND s.created_calendar_id=b.opaque_calendar_id
          AND s.created_by_niho_user_id=$3
        WHERE l.provider_id=$1 AND l.id=$2 LIMIT 1`,
      [actor.providerId, listingId, actor.nihoUserId, occurrenceId],
    )).rows[0];
    if (!row || row.site !== "Airbnb" || row.adapter !== "airbnb-google-busy" || row.adapter_version !== "1"
      || row.connection_mode !== "GOOGLE" || row.listing_active !== true || row.account_active !== true
      || row.revoked_at !== null || row.quarantined_at !== null
      || (row.delegated_until !== null && iso(row.delegated_until) <= new Date().toISOString())
      || typeof row.external_account_id !== "string" || !/^[1-9]\d{0,127}$/.test(row.external_account_id)
      || typeof row.external_product_id !== "string" || !/^[1-9]\d{0,127}$/.test(row.external_product_id)
      || row.external_option_id !== ""
      || integer(row.mapping_version) !== integer(row.binding_mapping_version)
      || integer(row.mapping_version) !== integer(row.desired_mapping_version)
      || integer(row.connection_generation) !== integer(row.current_generation)
      || integer(row.account_version) !== integer(row.activation_account_version)
      || !Array.isArray(row.granted_scopes) || !REQUIRED_GOOGLE_SCOPES.every((scope) => row.granted_scopes.includes(scope))
      || row.granted_scopes_digest !== scopesDigest(row.granted_scopes)
      || row.binding_calendar_digest !== digest(row.opaque_calendar_id)) {
      throw new StoreConflictError("Active Google configuration changed.");
    }
    await lockGoogleCalendarUsage(client, [row.opaque_calendar_id]);
    const collision = await client.query(
      `SELECT 1 WHERE EXISTS (SELECT 1 FROM provider_google_calendars WHERE opaque_calendar_id=$1)
        OR EXISTS (SELECT 1 FROM resource_google_calendars WHERE opaque_calendar_id=$1)
        OR EXISTS (SELECT 1 FROM provider_google_connections WHERE busy_calendar_id=$1 OR booking_calendar_id=$1)`,
      [row.opaque_calendar_id],
    );
    if (collision.rows[0]) throw new StoreConflictError("Output calendar is configured as an input or booking calendar.");
    const occurrence = await currentChannelOccurrence(client, actor.providerId, listingId, occurrenceId).catch((error: unknown) => {
      if (error instanceof StoreNotFoundError) throw new StoreConflictError("Canonical occurrence is missing.");
      throw error;
    });
    if (occurrence.startUtc !== iso(row.source_start_at) || occurrence.endUtc !== iso(row.source_end_at)) {
      throw new StoreConflictError("Canonical occurrence time changed.");
    }
  }

  async get(actor: HostActor, listingId: string, occurrenceId: string): Promise<GoogleChannelActivationStatus> {
    assertActor(actor);
    assertTarget(listingId, occurrenceId);
    return transaction(this.#pool, actor.providerId, async (client) => {
      await this.#assertCurrentOwner(client, actor);
      const current = (await client.query<Record<string, unknown>>(
        `SELECT l.mapping_version,b.binding_version,b.active,d.desired_version
           FROM channel_listings l
           JOIN google_channel_output_bindings b ON b.provider_id=l.provider_id AND b.listing_id=l.id
           JOIN channel_desired_states d ON d.provider_id=l.provider_id AND d.listing_id=l.id AND d.occurrence_id=$3
          WHERE l.provider_id=$1 AND l.id=$2`,
        [actor.providerId, listingId, occurrenceId],
      )).rows[0];
      if (!current) throw new StoreConflictError("Google activation state is absent.");
      const expectedMappingVersion = integer(current.mapping_version);
      const expectedBindingVersion = integer(current.binding_version);
      const expectedDesiredVersion = integer(current.desired_version);
      let state: GoogleChannelActivationState = current.active === true ? "ACTIVE" : "READY";
      try {
        if (current.active === true) await this.#assertActiveConfiguration(client, actor, listingId, occurrenceId);
        else await this.#authority(client, actor, listingId, occurrenceId, expectedMappingVersion, expectedBindingVersion, expectedDesiredVersion, true, false);
      } catch (error) {
        if (error instanceof StoreConflictError) state = "NEEDS_REVIEW";
        else throw error;
      }
      return { listingId, occurrenceId, state, expectedMappingVersion, expectedBindingVersion, expectedDesiredVersion };
    });
  }

  async activate(actor: HostActor, input: GoogleChannelActivationInput): Promise<GoogleChannelActivationApplied> {
    assertActor(actor);
    assertInput(input);
    const requestFingerprint = fingerprint(actor.providerId, input);
    return transaction(this.#pool, actor.providerId, async (client) => {
      await this.#assertCurrentOwner(client, actor);
      const prior = (await client.query<Record<string, unknown>>(
        "SELECT request_fingerprint,actor_niho_user_id,listing_id,occurrence_id FROM google_channel_activation_commands WHERE provider_id=$1 AND command_id=$2::uuid",
        [actor.providerId, input.commandId],
      )).rows[0];
      if (prior) {
        if (prior.request_fingerprint !== requestFingerprint || prior.actor_niho_user_id !== actor.nihoUserId
          || prior.listing_id !== input.listingId || prior.occurrence_id !== input.occurrenceId) {
          throw new StoreConflictError("Command ID was reused with different activation input.");
        }
        await this.#assertCurrentGoogleScopes(client, actor);
        return { commandId: input.commandId, listingId: input.listingId, occurrenceId: input.occurrenceId, state: "APPLIED" };
      }
      const row = await this.#authority(
        client, actor, input.listingId, input.occurrenceId, input.expectedMappingVersion,
        input.expectedBindingVersion, input.expectedDesiredVersion, true, true,
      );
      const updated = await client.query(
        `UPDATE google_channel_output_bindings
            SET active=true,initialize_missing_open_anchor=true,binding_version=binding_version+1,updated_at=clock_timestamp()
          WHERE provider_id=$1 AND listing_id=$2 AND active=false AND binding_version=$3
            AND mapping_version=$4 AND connection_generation=$5`,
        [actor.providerId, input.listingId, input.expectedBindingVersion,
          input.expectedMappingVersion, row.connection_generation],
      );
      if (updated.rowCount !== 1) throw new StoreConflictError("Google activation binding fence was lost.");
      await client.query(
        `INSERT INTO google_channel_activation_commands
          (provider_id,command_id,account_id,listing_id,occurrence_id,actor_niho_user_id,request_fingerprint,
           account_version,mapping_version,binding_version_before,binding_version_after,desired_version,
           connection_generation,binding_calendar_digest,granted_scopes_digest,setup_command_id,anchor_command_id)
         VALUES ($1,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::uuid,$17::uuid)`,
        [actor.providerId, input.commandId, row.account_id, input.listingId, input.occurrenceId, actor.nihoUserId,
          requestFingerprint, row.account_version, input.expectedMappingVersion, input.expectedBindingVersion,
          input.expectedBindingVersion + 1, input.expectedDesiredVersion, row.connection_generation,
          digest(row.opaque_calendar_id), scopesDigest(row.granted_scopes), row.setup_command_id, row.anchor_command_id],
      );
      return { commandId: input.commandId, listingId: input.listingId, occurrenceId: input.occurrenceId, state: "APPLIED" };
    });
  }
}
