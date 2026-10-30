import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { StoreAccessDeniedError, StoreConflictError, StoreNotFoundError, StoreValidationError } from "./errors.ts";
import { currentChannelOccurrence } from "./channel-occurrence.ts";
import { evaluateStoredInventory, lockProviderInventory } from "./inventory.ts";
import type { HostActor } from "./types.ts";

export type GoogleChannelAnchorPhase =
  | "PREPARING"
  | "INITIALIZING"
  | "GOOGLE_VERIFIED"
  | "UNCERTAIN"
  | "FAILED_BEFORE_INITIALIZE";
export type GoogleChannelAnchorOperation = "initialize" | "inspect";

export interface GoogleChannelAnchorRecord {
  readonly commandId: string;
  readonly listingId: string;
  readonly occurrenceId: string;
  readonly state: GoogleChannelAnchorPhase;
  readonly reason?: string;
}

export interface GoogleChannelAnchorInput {
  readonly listingId: string;
  readonly occurrenceId: string;
  readonly expectedMappingVersion: number;
  readonly expectedDesiredVersion: number;
  readonly commandId: string;
  readonly operation: GoogleChannelAnchorOperation;
}

export interface GoogleChannelAnchorMetadata {
  readonly eventId: string;
  readonly etag: string;
  readonly bindingHash: string;
  readonly mappingVersion: number;
  readonly desiredVersion: number;
  readonly startAtUtc: string;
  readonly endAtUtc: string;
  readonly desiredState: "OPEN" | "CLOSED";
  readonly transparency: "opaque" | "transparent";
}

export interface GoogleChannelAnchorSecretSnapshot {
  readonly record: GoogleChannelAnchorRecord;
  readonly providerId: string;
  readonly accountId: string;
  readonly actorNihoUserId: string;
  readonly operation: GoogleChannelAnchorOperation;
  readonly operationNonce: string;
  readonly operationEpoch: number;
  readonly accountVersion: number;
  readonly mappingVersion: number;
  readonly bindingVersion: number;
  readonly connectionGeneration: number;
  readonly bindingCalendarDigest: string;
  readonly grantedScopesDigest: string;
  readonly desiredState: "OPEN" | "CLOSED";
  readonly desiredVersion: number;
  readonly sourceStartAtUtc: string;
  readonly sourceEndAtUtc: string;
  readonly calendarId: string;
  readonly encryptedRefreshToken: string;
  readonly grantedScopes: readonly string[];
  readonly canPerform: boolean;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUIRED_GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.app.created",
] as const;
const STATIC_REASONS = new Set([
  "ANCHOR_MISSING", "ANCHOR_CONFLICT", "TOMBSTONE", "CANCELLED_EVENT", "STATUS_MISMATCH", "RECURRING_EVENT",
  "ALL_DAY_EVENT", "FOREIGN_EVENT", "MAPPING_MISMATCH", "TIME_MISMATCH", "VISIBILITY_MISMATCH",
  "STALE_INTENT", "WRITE_UNCERTAIN", "DESIRED_MISMATCH", "AUTHORITY_CHANGED", "CONFIG_UNAVAILABLE",
  "GOOGLE_REVOKED", "GOOGLE_UNAVAILABLE", "INVALID_RESPONSE",
]);

type JournalRow = Record<string, unknown> & { phase: GoogleChannelAnchorPhase; operation: "INITIALIZE" | "INSPECT" };
type AuthorityRow = Record<string, unknown> & {
  account_id: string;
  product_id: string;
  opaque_calendar_id: string;
  encrypted_refresh_token: string;
  granted_scopes: string[];
};

function digest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function scopesDigest(scopes: readonly string[]): string { return digest(JSON.stringify([...scopes].sort())); }
function integer(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new StoreConflictError("Stored Google anchor version is invalid.");
  return parsed;
}
function iso(value: unknown): string {
  const parsed = new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) throw new StoreConflictError("Stored Google anchor time is invalid.");
  return parsed.toISOString();
}
function assertActor(actor: HostActor): void {
  if (!actor.providerId || !actor.nihoUserId || actor.calendarScope === "OPERATOR" || actor.calendarRoleCeiling !== "OWNER") {
    throw new StoreAccessDeniedError();
  }
}
function assertInput(input: GoogleChannelAnchorInput): void {
  if (!input.listingId || input.listingId.length > 256 || !input.occurrenceId || input.occurrenceId.length > 256
    || !Number.isSafeInteger(input.expectedMappingVersion) || input.expectedMappingVersion < 1
    || !Number.isSafeInteger(input.expectedDesiredVersion) || input.expectedDesiredVersion < 1
    || !UUID_V4.test(input.commandId) || (input.operation !== "initialize" && input.operation !== "inspect")) {
    throw new StoreValidationError("Invalid Google anchor command.");
  }
}
function fingerprint(providerId: string, input: GoogleChannelAnchorInput): string {
  return digest(JSON.stringify([
    providerId, input.listingId, input.occurrenceId,
    input.expectedMappingVersion, input.expectedDesiredVersion,
  ]));
}
function record(row: JournalRow): GoogleChannelAnchorRecord {
  return {
    commandId: String(row.command_id), listingId: String(row.listing_id), occurrenceId: String(row.occurrence_id),
    state: row.phase, ...(typeof row.reason === "string" ? { reason: row.reason } : {}),
  };
}
function sameSnapshot(row: JournalRow, snapshot: GoogleChannelAnchorSecretSnapshot): boolean {
  return String(row.provider_id) === snapshot.providerId
    && String(row.command_id) === snapshot.record.commandId
    && String(row.account_id) === snapshot.accountId
    && String(row.listing_id) === snapshot.record.listingId
    && String(row.occurrence_id) === snapshot.record.occurrenceId
    && String(row.actor_niho_user_id) === snapshot.actorNihoUserId
    && String(row.operation_nonce) === snapshot.operationNonce
    && integer(row.operation_epoch) === snapshot.operationEpoch
    && row.operation === snapshot.operation.toUpperCase()
    && integer(row.account_version) === snapshot.accountVersion
    && integer(row.mapping_version) === snapshot.mappingVersion
    && integer(row.binding_version) === snapshot.bindingVersion
    && integer(row.connection_generation) === snapshot.connectionGeneration
    && String(row.binding_calendar_digest) === snapshot.bindingCalendarDigest
    && String(row.granted_scopes_digest) === snapshot.grantedScopesDigest
    && row.desired_state === snapshot.desiredState
    && integer(row.desired_version) === snapshot.desiredVersion
    && iso(row.source_start_at) === snapshot.sourceStartAtUtc
    && iso(row.source_end_at) === snapshot.sourceEndAtUtc;
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

export class GoogleChannelAnchorRepository {
  readonly #pool: Pool;
  constructor(pool: Pool) { this.#pool = pool; }

  async #authority(
    client: PoolClient,
    actor: HostActor,
    listingId: string,
    occurrenceId: string,
    expectedMappingVersion: number,
    expectedDesiredVersion: number,
    lock: boolean,
  ): Promise<AuthorityRow> {
    assertActor(actor);
    const owner = await client.query(
      `SELECT 1 FROM provider_google_connections c
        JOIN provider_memberships m ON m.provider_id=c.provider_id AND m.niho_user_id=c.connected_by_niho_user_id
          AND m.active=true AND m.role='OWNER'
       WHERE c.provider_id=$1 AND c.connected_by_niho_user_id=$2 FOR SHARE OF c,m`,
      [actor.providerId, actor.nihoUserId],
    );
    if (!owner.rows[0]) throw new StoreAccessDeniedError();
    const desiredExists = await client.query(
      "SELECT 1 FROM channel_desired_states WHERE provider_id=$1 AND listing_id=$2 AND occurrence_id=$3",
      [actor.providerId, listingId, occurrenceId],
    );
    if (!desiredExists.rows[0]) throw new StoreConflictError("Google anchor desired state is missing.");
    const result = await client.query<AuthorityRow>(
      `SELECT l.account_id,l.product_id,l.mapping_version,l.active AS listing_active,l.adapter,l.adapter_version,l.connection_mode,
              l.external_product_id,l.external_option_id,a.external_account_id,a.site,a.active AS account_active,
              a.revoked_at,a.delegated_until,a.quarantined_at,a.version AS account_version,
              d.desired_state,d.desired_version,d.mapping_version AS desired_mapping_version,
              d.source_start_at,d.source_end_at,b.opaque_calendar_id,b.binding_version,
              b.mapping_version AS binding_mapping_version,b.connection_generation,b.active AS binding_active,
              c.encrypted_refresh_token,c.granted_scopes,c.connected_by_niho_user_id,
              s.command_id AS setup_command_id
         FROM channel_listings l
         JOIN channel_external_accounts a ON a.provider_id=l.provider_id AND a.id=l.account_id
         JOIN channel_desired_states d ON d.provider_id=l.provider_id AND d.listing_id=l.id AND d.occurrence_id=$4
         JOIN google_channel_output_bindings b ON b.provider_id=l.provider_id AND b.listing_id=l.id
         JOIN provider_google_connections c ON c.provider_id=l.provider_id AND c.connection_generation=b.connection_generation
         JOIN google_channel_setup_journals s ON s.provider_id=l.provider_id AND s.listing_id=l.id
          AND s.phase='READY_FOR_CONNECTION' AND s.created_calendar_id=b.opaque_calendar_id
          AND s.created_by_niho_user_id=c.connected_by_niho_user_id AND s.account_id=l.account_id
          AND s.expected_mapping_version=b.mapping_version AND s.connection_generation=b.connection_generation
         JOIN provider_memberships m ON m.provider_id=l.provider_id AND m.niho_user_id=$3
          AND m.active=true AND m.role='OWNER'
        WHERE l.provider_id=$1 AND l.id=$2${lock ? " FOR UPDATE OF l,a,d,b,c FOR SHARE OF s,m" : ""}`,
      [actor.providerId, listingId, actor.nihoUserId, occurrenceId],
    );
    const row = result.rows[0];
    const now = new Date().toISOString();
    if (!row) throw new StoreConflictError("Google anchor target is not provisioned.");
    if (row.connected_by_niho_user_id !== actor.nihoUserId) throw new StoreAccessDeniedError();
    if (row.site !== "Airbnb" || row.adapter !== "airbnb-google-busy" || row.adapter_version !== "1"
      || row.connection_mode !== "GOOGLE" || row.account_active !== true || row.listing_active !== true
      || row.binding_active !== false || row.revoked_at !== null || row.quarantined_at !== null
      || (row.delegated_until !== null && iso(row.delegated_until) <= now)
      || typeof row.external_account_id !== "string" || !/^[1-9]\d{0,127}$/.test(row.external_account_id)
      || typeof row.external_product_id !== "string" || !/^[1-9]\d{0,127}$/.test(row.external_product_id)
      || row.external_option_id !== ""
      || integer(row.mapping_version) !== expectedMappingVersion
      || integer(row.binding_mapping_version) !== expectedMappingVersion
      || integer(row.desired_mapping_version) !== expectedMappingVersion
      || integer(row.desired_version) !== expectedDesiredVersion
      || !Array.isArray(row.granted_scopes)
      || !REQUIRED_GOOGLE_SCOPES.every((scope) => row.granted_scopes.includes(scope))) {
      throw new StoreConflictError("Google anchor authority is not current.");
    }
    const collision = await client.query(
      `SELECT 1 WHERE EXISTS (SELECT 1 FROM provider_google_calendars WHERE opaque_calendar_id=$1)
        OR EXISTS (SELECT 1 FROM resource_google_calendars WHERE opaque_calendar_id=$1)
        OR EXISTS (SELECT 1 FROM provider_google_connections WHERE busy_calendar_id=$1 OR booking_calendar_id=$1)`,
      [row.opaque_calendar_id],
    );
    if (collision.rows[0]) throw new StoreConflictError("Output calendar is configured as an input or booking calendar.");
    const inflight = await client.query(
      `SELECT 1 WHERE EXISTS (
         SELECT 1 FROM google_channel_deliveries WHERE provider_id=$1 AND listing_id=$2 AND occurrence_id=$3
          AND phase IN ('DISPATCHING','UNCERTAIN')
       ) OR EXISTS (
         SELECT 1 FROM channel_jobs WHERE provider_id=$1 AND listing_id=$2 AND occurrence_id=$3
          AND purpose='AVAILABILITY' AND status='LEASED'
       )`,
      [actor.providerId, listingId, occurrenceId],
    );
    if (inflight.rows[0]) throw new StoreConflictError("Regular Google delivery is unresolved.");
    const occurrence = await currentChannelOccurrence(client, actor.providerId, listingId, occurrenceId).catch((error: unknown) => {
      if (error instanceof StoreNotFoundError) throw new StoreConflictError("Canonical occurrence is missing.");
      throw error;
    });
    if (occurrence.startUtc !== iso(row.source_start_at) || occurrence.endUtc !== iso(row.source_end_at)) {
      throw new StoreConflictError("Canonical occurrence time changed.");
    }
    const availability = await evaluateStoredInventory(client, actor.providerId, row.product_id, occurrence, now, 1);
    const liveState = availability.availability.bookable ? "OPEN" : "CLOSED";
    if (row.desired_state !== liveState) throw new StoreConflictError("Live inventory changed.");
    return row;
  }

  #snapshot(row: JournalRow, authority: AuthorityRow, canPerform: boolean): GoogleChannelAnchorSecretSnapshot {
    return {
      record: record(row), providerId: String(row.provider_id), accountId: String(row.account_id),
      actorNihoUserId: String(row.actor_niho_user_id), operation: row.operation.toLowerCase() as GoogleChannelAnchorOperation,
      operationNonce: String(row.operation_nonce), operationEpoch: integer(row.operation_epoch),
      accountVersion: integer(row.account_version), mappingVersion: integer(row.mapping_version),
      bindingVersion: integer(row.binding_version), connectionGeneration: integer(row.connection_generation),
      bindingCalendarDigest: String(row.binding_calendar_digest), grantedScopesDigest: String(row.granted_scopes_digest),
      desiredState: row.desired_state as "OPEN" | "CLOSED", desiredVersion: integer(row.desired_version),
      sourceStartAtUtc: iso(row.source_start_at), sourceEndAtUtc: iso(row.source_end_at),
      calendarId: authority.opaque_calendar_id, encryptedRefreshToken: authority.encrypted_refresh_token,
      grantedScopes: authority.granted_scopes, canPerform,
    };
  }

  #authorityMatches(row: JournalRow, authority: AuthorityRow, actor: HostActor): boolean {
    return String(row.account_id) === authority.account_id
      && String(row.actor_niho_user_id) === actor.nihoUserId
      && integer(row.account_version) === integer(authority.account_version)
      && integer(row.mapping_version) === integer(authority.mapping_version)
      && integer(row.binding_version) === integer(authority.binding_version)
      && integer(row.connection_generation) === integer(authority.connection_generation)
      && String(row.binding_calendar_digest) === digest(authority.opaque_calendar_id)
      && String(row.granted_scopes_digest) === scopesDigest(authority.granted_scopes)
      && row.desired_state === authority.desired_state
      && integer(row.desired_version) === integer(authority.desired_version)
      && iso(row.source_start_at) === iso(authority.source_start_at)
      && iso(row.source_end_at) === iso(authority.source_end_at);
  }

  async prepare(actor: HostActor, input: GoogleChannelAnchorInput): Promise<GoogleChannelAnchorSecretSnapshot> {
    assertActor(actor);
    assertInput(input);
    const requestFingerprint = fingerprint(actor.providerId, input);
    return transaction(this.#pool, actor.providerId, async (client) => {
      const authority = await this.#authority(
        client, actor, input.listingId, input.occurrenceId,
        input.expectedMappingVersion, input.expectedDesiredVersion, true,
      );
      const prior = await client.query<JournalRow>(
        "SELECT * FROM google_channel_anchor_journals WHERE provider_id=$1 AND command_id=$2::uuid FOR UPDATE",
        [actor.providerId, input.commandId],
      );
      let row = prior.rows[0];
      if (row) {
        if (String(row.request_fingerprint) !== requestFingerprint || String(row.actor_niho_user_id) !== actor.nihoUserId
          || !this.#authorityMatches(row, authority, actor)) {
          throw new StoreConflictError("Command ID was reused or Google anchor authority changed.");
        }
        if (input.operation === "initialize") return this.#snapshot(row, authority, false);
        if (row.phase !== "INITIALIZING" && row.phase !== "UNCERTAIN") {
          throw new StoreConflictError("Google anchor inspection requires an unresolved initialization.");
        }
        const operationNonce = randomUUID();
        const updated = await client.query<JournalRow>(
          `UPDATE google_channel_anchor_journals SET operation='INSPECT',operation_nonce=$3::uuid,
             operation_epoch=operation_epoch+1,phase='UNCERTAIN',reason=COALESCE(reason,'WRITE_UNCERTAIN'),updated_at=clock_timestamp()
           WHERE provider_id=$1 AND command_id=$2::uuid AND operation_nonce=$4::uuid AND operation_epoch=$5
             AND phase IN ('INITIALIZING','UNCERTAIN') AND account_id=$6 AND listing_id=$7 AND occurrence_id=$8
             AND actor_niho_user_id=$9 AND request_fingerprint=$10 AND account_version=$11 AND mapping_version=$12
             AND binding_version=$13 AND connection_generation=$14 AND binding_calendar_digest=$15
             AND granted_scopes_digest=$16 AND desired_state=$17 AND desired_version=$18
             AND source_start_at=$19 AND source_end_at=$20 RETURNING *`,
          [actor.providerId, input.commandId, operationNonce, row.operation_nonce, row.operation_epoch,
            row.account_id, row.listing_id, row.occurrence_id, row.actor_niho_user_id, row.request_fingerprint,
            row.account_version, row.mapping_version, row.binding_version, row.connection_generation,
            row.binding_calendar_digest, row.granted_scopes_digest, row.desired_state, row.desired_version,
            iso(row.source_start_at), iso(row.source_end_at)],
        );
        row = updated.rows[0];
        if (!row) throw new StoreConflictError("Google anchor inspection fence was lost.");
        return this.#snapshot(row, authority, true);
      }
      if (input.operation === "inspect") throw new StoreConflictError("No unresolved Google anchor initialization exists.");
      const unresolved = await client.query(
        `SELECT 1 FROM google_channel_anchor_journals WHERE provider_id=$1 AND listing_id=$2 AND occurrence_id=$3
          AND phase IN ('PREPARING','INITIALIZING','UNCERTAIN') FOR UPDATE`,
        [actor.providerId, input.listingId, input.occurrenceId],
      );
      if (unresolved.rows[0]) throw new StoreConflictError("Google anchor initialization is unresolved.");
      const inserted = await client.query<JournalRow>(
        `INSERT INTO google_channel_anchor_journals
          (provider_id,command_id,account_id,listing_id,occurrence_id,actor_niho_user_id,request_fingerprint,
           operation,operation_nonce,account_version,mapping_version,binding_version,connection_generation,
           binding_calendar_digest,granted_scopes_digest,desired_state,desired_version,source_start_at,source_end_at,phase)
         VALUES ($1,$2::uuid,$3,$4,$5,$6,$7,'INITIALIZE',$8::uuid,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'PREPARING')
         RETURNING *`,
        [actor.providerId, input.commandId, authority.account_id, input.listingId, input.occurrenceId,
          actor.nihoUserId, requestFingerprint, randomUUID(), authority.account_version, authority.mapping_version,
          authority.binding_version, authority.connection_generation, digest(authority.opaque_calendar_id),
          scopesDigest(authority.granted_scopes), authority.desired_state, authority.desired_version,
          iso(authority.source_start_at), iso(authority.source_end_at)],
      );
      return this.#snapshot(inserted.rows[0]!, authority, true);
    });
  }

  async get(actor: HostActor, listingId: string, occurrenceId: string): Promise<GoogleChannelAnchorRecord | null> {
    assertActor(actor);
    if (!listingId || listingId.length > 256 || !occurrenceId || occurrenceId.length > 256) {
      throw new StoreValidationError("Invalid Google anchor target.");
    }
    return transaction(this.#pool, actor.providerId, async (client) => {
      const found = await client.query<JournalRow>(
        `SELECT * FROM google_channel_anchor_journals WHERE provider_id=$1 AND listing_id=$2 AND occurrence_id=$3
          ORDER BY created_at DESC,command_id DESC LIMIT 1`,
        [actor.providerId, listingId, occurrenceId],
      );
      const row = found.rows[0];
      if (!row) return null;
      const authority = await this.#authority(
        client, actor, listingId, occurrenceId, integer(row.mapping_version), integer(row.desired_version), false,
      );
      if (!this.#authorityMatches(row, authority, actor)) throw new StoreConflictError("Google anchor authority changed.");
      return record(row);
    });
  }

  async markInitializing(snapshot: GoogleChannelAnchorSecretSnapshot): Promise<void> {
    await transaction(this.#pool, snapshot.providerId, async (client) => {
      const actor: HostActor = {
        providerId: snapshot.providerId, nihoUserId: snapshot.actorNihoUserId, calendarRoleCeiling: "OWNER",
      };
      const authority = await this.#authority(
        client, actor, snapshot.record.listingId, snapshot.record.occurrenceId,
        snapshot.mappingVersion, snapshot.desiredVersion, true,
      );
      const row = (await client.query<JournalRow>(
        "SELECT * FROM google_channel_anchor_journals WHERE provider_id=$1 AND command_id=$2::uuid FOR UPDATE",
        [snapshot.providerId, snapshot.record.commandId],
      )).rows[0];
      if (!row || row.phase !== "PREPARING" || snapshot.operation !== "initialize"
        || !sameSnapshot(row, snapshot) || !this.#authorityMatches(row, authority, actor)) {
        throw new StoreConflictError("Google anchor initialize authority changed.");
      }
      const updated = await client.query(
        `UPDATE google_channel_anchor_journals SET phase='INITIALIZING',updated_at=clock_timestamp()
          WHERE provider_id=$1 AND command_id=$2::uuid AND operation='INITIALIZE' AND operation_nonce=$3::uuid
            AND operation_epoch=$4 AND phase='PREPARING' AND account_version=$5 AND mapping_version=$6
            AND binding_version=$7 AND connection_generation=$8 AND binding_calendar_digest=$9
            AND granted_scopes_digest=$10 AND desired_version=$11 AND account_id=$12 AND listing_id=$13
            AND occurrence_id=$14 AND actor_niho_user_id=$15 AND desired_state=$16
            AND source_start_at=$17 AND source_end_at=$18`,
        [snapshot.providerId, snapshot.record.commandId, snapshot.operationNonce, snapshot.operationEpoch,
          snapshot.accountVersion, snapshot.mappingVersion, snapshot.bindingVersion, snapshot.connectionGeneration,
          snapshot.bindingCalendarDigest, snapshot.grantedScopesDigest, snapshot.desiredVersion, snapshot.accountId,
          snapshot.record.listingId, snapshot.record.occurrenceId, snapshot.actorNihoUserId, snapshot.desiredState,
          snapshot.sourceStartAtUtc, snapshot.sourceEndAtUtc],
      );
      if (updated.rowCount !== 1) throw new StoreConflictError("Google anchor initialize fence was lost.");
    });
  }

  async assertCurrent(snapshot: GoogleChannelAnchorSecretSnapshot): Promise<void> {
    await transaction(this.#pool, snapshot.providerId, async (client) => {
      const actor: HostActor = {
        providerId: snapshot.providerId, nihoUserId: snapshot.actorNihoUserId, calendarRoleCeiling: "OWNER",
      };
      const authority = await this.#authority(
        client, actor, snapshot.record.listingId, snapshot.record.occurrenceId,
        snapshot.mappingVersion, snapshot.desiredVersion, true,
      );
      const row = (await client.query<JournalRow>(
        "SELECT * FROM google_channel_anchor_journals WHERE provider_id=$1 AND command_id=$2::uuid FOR UPDATE",
        [snapshot.providerId, snapshot.record.commandId],
      )).rows[0];
      const expectedPhase = snapshot.operation === "initialize" ? "INITIALIZING" : "UNCERTAIN";
      if (!row || row.phase !== expectedPhase || !sameSnapshot(row, snapshot) || !this.#authorityMatches(row, authority, actor)) {
        throw new StoreConflictError("Google anchor operation was fenced.");
      }
    });
  }

  async saveVerified(snapshot: GoogleChannelAnchorSecretSnapshot, metadata: GoogleChannelAnchorMetadata, changed: boolean, writeAcknowledged: boolean): Promise<GoogleChannelAnchorRecord> {
    if (metadata.mappingVersion !== snapshot.mappingVersion || metadata.desiredVersion !== snapshot.desiredVersion
      || metadata.startAtUtc !== snapshot.sourceStartAtUtc || metadata.endAtUtc !== snapshot.sourceEndAtUtc
      || metadata.desiredState !== snapshot.desiredState
      || metadata.transparency !== (snapshot.desiredState === "CLOSED" ? "opaque" : "transparent")) {
      throw new StoreConflictError("Google anchor verification does not match the immutable target.");
    }
    return transaction(this.#pool, snapshot.providerId, async (client) => {
      const actor: HostActor = {
        providerId: snapshot.providerId, nihoUserId: snapshot.actorNihoUserId, calendarRoleCeiling: "OWNER",
      };
      const authority = await this.#authority(
        client, actor, snapshot.record.listingId, snapshot.record.occurrenceId,
        snapshot.mappingVersion, snapshot.desiredVersion, true,
      );
      const row = (await client.query<JournalRow>(
        "SELECT * FROM google_channel_anchor_journals WHERE provider_id=$1 AND command_id=$2::uuid FOR UPDATE",
        [snapshot.providerId, snapshot.record.commandId],
      )).rows[0];
      const expectedPhase = snapshot.operation === "initialize" ? "INITIALIZING" : "UNCERTAIN";
      if (!row || row.phase !== expectedPhase || !sameSnapshot(row, snapshot) || !this.#authorityMatches(row, authority, actor)) {
        throw new StoreConflictError("Google anchor verify commit was fenced.");
      }
      const updated = await client.query<JournalRow>(
        `UPDATE google_channel_anchor_journals SET phase='GOOGLE_VERIFIED',reason=NULL,event_id=$5,event_etag=$6,
           google_binding_hash=$7,google_mapping_version=$8,google_desired_version=$9,google_start_at=$10,
           google_end_at=$11,google_desired_state=$12,google_transparency=$13,changed=$14,
           write_acknowledged=$15,updated_at=clock_timestamp()
         WHERE provider_id=$1 AND command_id=$2::uuid AND operation_nonce=$3::uuid AND operation_epoch=$4
           AND phase=$16 AND account_version=$17 AND mapping_version=$18 AND binding_version=$19
           AND connection_generation=$20 AND binding_calendar_digest=$21 AND granted_scopes_digest=$22
           AND desired_version=$23 AND account_id=$24 AND listing_id=$25 AND occurrence_id=$26
           AND actor_niho_user_id=$27 AND desired_state=$28 AND source_start_at=$29 AND source_end_at=$30
           RETURNING *`,
        [snapshot.providerId, snapshot.record.commandId, snapshot.operationNonce, snapshot.operationEpoch,
          metadata.eventId, metadata.etag, metadata.bindingHash, metadata.mappingVersion, metadata.desiredVersion,
          metadata.startAtUtc, metadata.endAtUtc, metadata.desiredState, metadata.transparency, changed,
          writeAcknowledged, expectedPhase, snapshot.accountVersion, snapshot.mappingVersion, snapshot.bindingVersion,
          snapshot.connectionGeneration, snapshot.bindingCalendarDigest, snapshot.grantedScopesDigest, snapshot.desiredVersion,
          snapshot.accountId, snapshot.record.listingId, snapshot.record.occurrenceId, snapshot.actorNihoUserId,
          snapshot.desiredState, snapshot.sourceStartAtUtc, snapshot.sourceEndAtUtc],
      );
      if (!updated.rows[0]) throw new StoreConflictError("Google anchor verify commit lost its capability.");
      return record(updated.rows[0]);
    });
  }

  async failBeforeInitialize(snapshot: GoogleChannelAnchorSecretSnapshot, reason: string): Promise<GoogleChannelAnchorRecord> {
    return this.#saveTerminal(snapshot, "PREPARING", "FAILED_BEFORE_INITIALIZE", reason);
  }

  async saveStopped(snapshot: GoogleChannelAnchorSecretSnapshot, reason: string): Promise<GoogleChannelAnchorRecord> {
    return this.#saveTerminal(snapshot, "INITIALIZING", "FAILED_BEFORE_INITIALIZE", reason);
  }

  async saveUncertain(snapshot: GoogleChannelAnchorSecretSnapshot, reason: string): Promise<GoogleChannelAnchorRecord> {
    const from = snapshot.operation === "initialize" ? "INITIALIZING" : "UNCERTAIN";
    return this.#saveTerminal(snapshot, from, "UNCERTAIN", reason);
  }

  async #saveTerminal(
    snapshot: GoogleChannelAnchorSecretSnapshot,
    from: "PREPARING" | "INITIALIZING" | "UNCERTAIN",
    to: "FAILED_BEFORE_INITIALIZE" | "UNCERTAIN",
    reason: string,
  ): Promise<GoogleChannelAnchorRecord> {
    if (!STATIC_REASONS.has(reason)) throw new StoreValidationError("Invalid Google anchor reason.");
    return transaction(this.#pool, snapshot.providerId, async (client) => {
      const updated = await client.query<JournalRow>(
        `UPDATE google_channel_anchor_journals SET phase=$5,reason=$6,updated_at=clock_timestamp()
          WHERE provider_id=$1 AND command_id=$2::uuid AND operation_nonce=$3::uuid AND operation_epoch=$4
            AND phase=$7 AND account_id=$8 AND listing_id=$9 AND occurrence_id=$10 AND actor_niho_user_id=$11
            AND account_version=$12 AND mapping_version=$13 AND binding_version=$14 AND connection_generation=$15
            AND binding_calendar_digest=$16 AND granted_scopes_digest=$17 AND desired_state=$18
            AND desired_version=$19 AND source_start_at=$20 AND source_end_at=$21 RETURNING *`,
        [snapshot.providerId, snapshot.record.commandId, snapshot.operationNonce, snapshot.operationEpoch,
          to, reason, from, snapshot.accountId, snapshot.record.listingId, snapshot.record.occurrenceId,
          snapshot.actorNihoUserId, snapshot.accountVersion, snapshot.mappingVersion, snapshot.bindingVersion,
          snapshot.connectionGeneration, snapshot.bindingCalendarDigest, snapshot.grantedScopesDigest,
          snapshot.desiredState, snapshot.desiredVersion, snapshot.sourceStartAtUtc, snapshot.sourceEndAtUtc],
      );
      if (!updated.rows[0]) throw new StoreConflictError("Google anchor terminal transition was fenced.");
      return record(updated.rows[0]);
    });
  }

  async assertCurrentOwnerAccess(actor: HostActor): Promise<void> {
    assertActor(actor);
    await transaction(this.#pool, actor.providerId, async (client) => {
      const allowed = await client.query(
        `SELECT 1 FROM provider_google_connections c
          JOIN provider_memberships m ON m.provider_id=c.provider_id AND m.niho_user_id=c.connected_by_niho_user_id
            AND m.active=true AND m.role='OWNER'
         WHERE c.provider_id=$1 AND c.connected_by_niho_user_id=$2 FOR SHARE OF c,m`,
        [actor.providerId, actor.nihoUserId],
      );
      if (!allowed.rows[0]) throw new StoreAccessDeniedError();
    });
  }

  async saveRotatedRefreshToken(snapshot: GoogleChannelAnchorSecretSnapshot, encryptedRefreshToken: string): Promise<boolean> {
    return transaction(this.#pool, snapshot.providerId, async (client) => {
      const updated = await client.query(
        `UPDATE provider_google_connections c SET encrypted_refresh_token=$4,updated_at=clock_timestamp()
          WHERE c.provider_id=$1 AND c.connection_generation=$2 AND c.connected_by_niho_user_id=$3
            AND EXISTS (SELECT 1 FROM provider_memberships m WHERE m.provider_id=c.provider_id
              AND m.niho_user_id=$3 AND m.active=true AND m.role='OWNER')`,
        [snapshot.providerId, snapshot.connectionGeneration, snapshot.actorNihoUserId, encryptedRefreshToken],
      );
      return updated.rowCount === 1;
    });
  }
}
