import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { StoreAccessDeniedError, StoreConflictError, StoreValidationError } from "./errors.ts";
import { lockGoogleCalendarUsage, lockProviderInventory } from "./inventory.ts";
import type { HostActor } from "./types.ts";

export type GoogleChannelSetupPhase = "PREPARING" | "CREATING" | "READY_FOR_CONNECTION" | "FAILED_BEFORE_CREATE" | "UNCERTAIN";

export interface GoogleChannelSetupRecord {
  readonly commandId: string;
  readonly listingId: string;
  readonly state: GoogleChannelSetupPhase;
  readonly calendarName: string;
  readonly reason?: string;
}

export interface GoogleChannelSetupSecretSnapshot {
  readonly record: GoogleChannelSetupRecord;
  readonly providerId: string;
  readonly accountId: string;
  readonly createdByNihoUserId: string;
  readonly operationNonce: string;
  readonly expectedMappingVersion: number;
  readonly accountVersion: number;
  readonly connectionGeneration: number;
  readonly grantedScopesDigest: string;
  readonly encryptedRefreshToken: string;
  readonly grantedScopes: readonly string[];
  readonly canCreate: boolean;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUIRED_GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.app.created",
] as const;
const STATIC_REASONS = new Set(["CONFIG_UNAVAILABLE", "GOOGLE_REVOKED", "GOOGLE_UNAVAILABLE", "INVALID_RESPONSE", "AUTHORITY_CHANGED", "STORE_FAILED", "PREPARATION_CANCELLED"]);

type JournalRow = Record<string, unknown> & { phase: GoogleChannelSetupPhase; granted_scopes_digest: string };
type AuthorityRow = Record<string, unknown> & {
  account_id: string; account_version: string; mapping_version: string; public_title: string;
  connection_generation: string; encrypted_refresh_token: string; granted_scopes: string[];
};

function digest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function scopesDigest(value: readonly string[]): string { return digest(JSON.stringify([...value].sort())); }
function integer(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new StoreConflictError("Stored Google setup version is invalid.");
  return parsed;
}
function calendarName(productTitle: string): string {
  const plain = productTitle.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  const suffix = plain || "Experience";
  let name = "";
  for (const character of `NIHO Airbnb | ${suffix}`) {
    if (name.length + character.length > 200) break;
    name += character;
  }
  return name;
}
function fingerprint(providerId: string, listingId: string, expectedMappingVersion: number): string {
  return digest(JSON.stringify({ providerId, listingId, expectedMappingVersion }));
}
function record(row: JournalRow, override?: GoogleChannelSetupPhase): GoogleChannelSetupRecord {
  return {
    commandId: String(row.command_id), listingId: String(row.listing_id),
    state: override ?? row.phase, calendarName: String(row.calendar_summary),
    ...(typeof row.failure_reason === "string" ? { reason: row.failure_reason } : {}),
  };
}
function assertActor(actor: HostActor): void {
  if (!actor.providerId || !actor.nihoUserId || actor.calendarScope === "OPERATOR" || actor.calendarRoleCeiling !== "OWNER") {
    throw new StoreAccessDeniedError();
  }
}
function assertReason(reason: string): void {
  if (!STATIC_REASONS.has(reason)) throw new StoreValidationError("Invalid Google setup reason.");
}
function sameSnapshot(row: JournalRow, snapshot: GoogleChannelSetupSecretSnapshot): boolean {
  return String(row.provider_id) === snapshot.providerId
    && String(row.listing_id) === snapshot.record.listingId
    && String(row.account_id) === snapshot.accountId
    && String(row.command_id) === snapshot.record.commandId
    && String(row.created_by_niho_user_id) === snapshot.createdByNihoUserId
    && String(row.operation_nonce) === snapshot.operationNonce
    && integer(row.expected_mapping_version) === snapshot.expectedMappingVersion
    && integer(row.account_version) === snapshot.accountVersion
    && integer(row.connection_generation) === snapshot.connectionGeneration
    && row.granted_scopes_digest === snapshot.grantedScopesDigest;
}
async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const value = await work(client); await client.query("COMMIT"); return value; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export class GoogleChannelSetupRepository {
  readonly #pool: Pool;
  constructor(pool: Pool) { this.#pool = pool; }

  async #assertCurrentOwner(client: PoolClient, actor: HostActor): Promise<void> {
    assertActor(actor);
    const allowed = await client.query(
      `SELECT 1 FROM provider_google_connections c
        JOIN provider_memberships m ON m.provider_id=c.provider_id AND m.niho_user_id=c.connected_by_niho_user_id
          AND m.active=true AND m.role='OWNER'
       WHERE c.provider_id=$1 AND c.connected_by_niho_user_id=$2 FOR SHARE OF c,m`,
      [actor.providerId, actor.nihoUserId],
    );
    if (!allowed.rows[0]) throw new StoreAccessDeniedError();
  }

  async #authority(client: PoolClient, actor: HostActor, listingId: string, lock: boolean): Promise<AuthorityRow> {
    assertActor(actor);
    const result = await client.query<AuthorityRow>(
      `SELECT l.account_id,l.mapping_version,l.active AS listing_active,l.adapter,l.adapter_version,l.connection_mode,
              a.site,a.external_account_id,l.external_product_id,l.external_option_id,
              a.active AS account_active,a.revoked_at,a.delegated_until,a.version AS account_version,
              p.public_title,c.connection_generation,c.encrypted_refresh_token,c.granted_scopes,c.connected_by_niho_user_id
         FROM channel_listings l
         JOIN channel_external_accounts a ON a.provider_id=l.provider_id AND a.id=l.account_id
         JOIN experience_products p ON p.provider_id=l.provider_id AND p.id=l.product_id
         JOIN provider_google_connections c ON c.provider_id=l.provider_id
         JOIN provider_memberships actor_membership ON actor_membership.provider_id=l.provider_id
          AND actor_membership.niho_user_id=$3 AND actor_membership.active=true AND actor_membership.role='OWNER'
        WHERE l.provider_id=$1 AND l.id=$2${lock ? " FOR UPDATE OF l,a,c FOR SHARE OF p,actor_membership" : ""}`,
      [actor.providerId, listingId, actor.nihoUserId],
    );
    const row = result.rows[0];
    if (!row || row.connected_by_niho_user_id !== actor.nihoUserId) throw new StoreAccessDeniedError();
    if (row.site !== "Airbnb" || row.adapter !== "airbnb-google-busy" || row.adapter_version !== "1"
      || row.connection_mode !== "GOOGLE" || row.account_active !== true || row.listing_active !== true
      || typeof row.external_account_id !== "string" || !/^[1-9]\d{0,127}$/.test(row.external_account_id)
      || typeof row.external_product_id !== "string" || !/^[1-9]\d{0,127}$/.test(row.external_product_id)
      || row.external_option_id !== ""
      || row.revoked_at !== null || (row.delegated_until !== null && new Date(String(row.delegated_until)) <= new Date())) {
      throw new StoreConflictError("Airbnb Google setup authority is not current.");
    }
    if (!Array.isArray(row.granted_scopes) || !REQUIRED_GOOGLE_SCOPES.every((scope) => row.granted_scopes.includes(scope))) {
      throw new StoreConflictError("The current Google grant is insufficient.");
    }
    return row;
  }

  #snapshot(row: JournalRow, authority: AuthorityRow, canCreate: boolean): GoogleChannelSetupSecretSnapshot {
    return {
      record: record(row), providerId: String(row.provider_id), accountId: String(row.account_id),
      createdByNihoUserId: String(row.created_by_niho_user_id), operationNonce: String(row.operation_nonce),
      expectedMappingVersion: integer(row.expected_mapping_version), accountVersion: integer(row.account_version),
      connectionGeneration: integer(row.connection_generation), grantedScopesDigest: row.granted_scopes_digest,
      encryptedRefreshToken: authority.encrypted_refresh_token, grantedScopes: authority.granted_scopes, canCreate,
    };
  }

  #authorityMatches(row: JournalRow, authority: AuthorityRow, actor: HostActor): boolean {
    return String(row.account_id) === authority.account_id
      && String(row.created_by_niho_user_id) === actor.nihoUserId
      && integer(row.expected_mapping_version) === integer(authority.mapping_version)
      && integer(row.account_version) === integer(authority.account_version)
      && integer(row.connection_generation) === integer(authority.connection_generation)
      && row.granted_scopes_digest === scopesDigest(authority.granted_scopes);
  }

  async prepare(actor: HostActor, input: { listingId: string; expectedMappingVersion: number; commandId: string }): Promise<GoogleChannelSetupSecretSnapshot> {
    assertActor(actor);
    if (!input.listingId || input.listingId.length > 256 || !Number.isSafeInteger(input.expectedMappingVersion)
      || input.expectedMappingVersion < 1 || !UUID_V4.test(input.commandId)) throw new StoreValidationError("Invalid Google setup command.");
    const requestFingerprint = fingerprint(actor.providerId, input.listingId, input.expectedMappingVersion);
    return transaction(this.#pool, async (client) => {
      await lockProviderInventory(client, actor.providerId);
      const authority = await this.#authority(client, actor, input.listingId, true);
      const prior = await client.query<JournalRow>(
        "SELECT * FROM google_channel_setup_journals WHERE provider_id=$1 AND command_id=$2::uuid FOR UPDATE",
        [actor.providerId, input.commandId],
      );
      if (prior.rows[0]) {
        const row = prior.rows[0];
        if (String(row.request_fingerprint) !== requestFingerprint || String(row.listing_id) !== input.listingId
          || String(row.created_by_niho_user_id) !== actor.nihoUserId) throw new StoreConflictError("Command ID was reused with different setup input.");
        const currentReady = row.phase !== "READY_FOR_CONNECTION" || (this.#authorityMatches(row, authority, actor)
          && Boolean((await client.query(
            `SELECT 1 FROM google_channel_output_bindings
              WHERE provider_id=$1 AND listing_id=$2 AND mapping_version=$3 AND connection_generation=$4
                AND opaque_calendar_id=$5`,
            [actor.providerId, input.listingId, row.expected_mapping_version, row.connection_generation, row.created_calendar_id],
          )).rows[0]));
        if (!currentReady) return { ...this.#snapshot(row, authority, false), record: record(row, "UNCERTAIN") };
        return this.#snapshot(row, authority, false);
      }
      if (integer(authority.mapping_version) !== input.expectedMappingVersion) throw new StoreConflictError("Listing mapping version changed.");
      const blocked = await client.query(
        `SELECT 1 WHERE EXISTS (
           SELECT 1 FROM google_channel_output_bindings WHERE provider_id=$1 AND listing_id=$2
         ) OR EXISTS (
           SELECT 1 FROM google_channel_setup_journals
            WHERE provider_id=$1 AND listing_id=$2 AND phase IN ('PREPARING','CREATING','UNCERTAIN')
         )`,
        [actor.providerId, input.listingId],
      );
      if (blocked.rows[0]) throw new StoreConflictError("Google output setup already exists or is unresolved.");
      const summary = calendarName(authority.public_title);
      const operationNonce = randomUUID();
      const inserted = await client.query<JournalRow>(
        `INSERT INTO google_channel_setup_journals
          (provider_id,command_id,listing_id,account_id,request_fingerprint,created_by_niho_user_id,operation_nonce,
           expected_mapping_version,account_version,connection_generation,granted_scopes_digest,calendar_summary,phase)
         VALUES ($1,$2::uuid,$3,$4,$5,$6,$7::uuid,$8,$9,$10,$11,$12,'PREPARING') RETURNING *`,
        [actor.providerId, input.commandId, input.listingId, authority.account_id, requestFingerprint, actor.nihoUserId,
          operationNonce, input.expectedMappingVersion, authority.account_version, authority.connection_generation,
          scopesDigest(authority.granted_scopes), summary],
      );
      return this.#snapshot(inserted.rows[0]!, authority, true);
    });
  }

  /** Fences a pre-create execution; CREATING and UNCERTAIN are never cleared. */
  async cancelPreparing(actor: HostActor, input: { listingId: string; expectedMappingVersion: number; commandId: string }): Promise<GoogleChannelSetupRecord> {
    assertActor(actor);
    if (!input.listingId || input.listingId.length > 256 || !Number.isSafeInteger(input.expectedMappingVersion)
      || input.expectedMappingVersion < 1 || !UUID_V4.test(input.commandId)) throw new StoreValidationError("Invalid Google setup command.");
    return transaction(this.#pool, async (client) => {
      await lockProviderInventory(client, actor.providerId);
      await this.#assertCurrentOwner(client, actor);
      const row = (await client.query<JournalRow>(
        "SELECT * FROM google_channel_setup_journals WHERE provider_id=$1 AND command_id=$2::uuid FOR UPDATE",
        [actor.providerId, input.commandId],
      )).rows[0];
      if (!row || row.listing_id !== input.listingId || row.created_by_niho_user_id !== actor.nihoUserId
        || row.request_fingerprint !== fingerprint(actor.providerId, input.listingId, input.expectedMappingVersion)) {
        throw new StoreConflictError("Google setup preparation does not match the command.");
      }
      if (row.phase === "FAILED_BEFORE_CREATE" && row.failure_reason === "PREPARATION_CANCELLED") return record(row);
      if (row.phase !== "PREPARING") throw new StoreConflictError("Google setup may already have created a calendar.");
      const updated = await client.query<JournalRow>(
        `UPDATE google_channel_setup_journals
            SET operation_nonce=$3::uuid,phase='FAILED_BEFORE_CREATE',failure_reason='PREPARATION_CANCELLED',updated_at=clock_timestamp()
          WHERE provider_id=$1 AND command_id=$2::uuid AND operation_nonce=$4::uuid AND phase='PREPARING'
            AND listing_id=$5 AND created_by_niho_user_id=$6 AND request_fingerprint=$7 RETURNING *`,
        [actor.providerId, input.commandId, randomUUID(), row.operation_nonce, input.listingId, actor.nihoUserId, row.request_fingerprint],
      );
      if (!updated.rows[0]) throw new StoreConflictError("Google setup preparation recovery was fenced.");
      return record(updated.rows[0]);
    });
  }

  async get(actor: HostActor, listingId: string): Promise<GoogleChannelSetupRecord | null> {
    assertActor(actor);
    if (!listingId || listingId.length > 256) throw new StoreValidationError("Invalid listing ID.");
    return transaction(this.#pool, async (client) => {
      await lockProviderInventory(client, actor.providerId);
      await this.#assertCurrentOwner(client, actor);
      const found = await client.query<JournalRow>(
        `SELECT * FROM google_channel_setup_journals WHERE provider_id=$1 AND listing_id=$2
          ORDER BY created_at DESC,command_id DESC LIMIT 1`, [actor.providerId, listingId],
      );
      const row = found.rows[0];
      if (!row) return null;
      if (row.phase === "PREPARING" || (row.phase === "FAILED_BEFORE_CREATE" && row.failure_reason === "PREPARATION_CANCELLED")) {
        if (row.created_by_niho_user_id !== actor.nihoUserId) throw new StoreAccessDeniedError();
        return record(row);
      }
      const authority = await this.#authority(client, actor, listingId, false);
      if (row.phase !== "READY_FOR_CONNECTION") return record(row);
      const binding = await client.query(
        `SELECT 1 FROM google_channel_output_bindings
          WHERE provider_id=$1 AND listing_id=$2 AND mapping_version=$3 AND connection_generation=$4
            AND opaque_calendar_id=$5`,
        [actor.providerId, listingId, row.expected_mapping_version, row.connection_generation, row.created_calendar_id],
      );
      return this.#authorityMatches(row, authority, actor) && binding.rows[0] ? record(row) : record(row, "UNCERTAIN");
    });
  }

  async markCreating(snapshot: GoogleChannelSetupSecretSnapshot): Promise<void> {
    await transaction(this.#pool, async (client) => {
      await lockProviderInventory(client, snapshot.providerId);
      const actor: HostActor = { providerId: snapshot.providerId, nihoUserId: snapshot.createdByNihoUserId, calendarRoleCeiling: "OWNER" };
      const authority = await this.#authority(client, actor, snapshot.record.listingId, true);
      const journal = await client.query<JournalRow>(
        "SELECT * FROM google_channel_setup_journals WHERE provider_id=$1 AND command_id=$2::uuid FOR UPDATE",
        [snapshot.providerId, snapshot.record.commandId],
      );
      const row = journal.rows[0];
      if (!row || row.phase !== "PREPARING" || !sameSnapshot(row, snapshot) || !this.#authorityMatches(row, authority, actor)) {
        throw new StoreConflictError("Google setup authority changed before create.");
      }
      const updated = await client.query(
        `UPDATE google_channel_setup_journals SET phase='CREATING',updated_at=clock_timestamp()
          WHERE provider_id=$1 AND listing_id=$2 AND command_id=$3::uuid AND created_by_niho_user_id=$4
            AND operation_nonce=$5::uuid AND phase='PREPARING' AND expected_mapping_version=$6
            AND account_version=$7 AND connection_generation=$8 AND granted_scopes_digest=$9`,
        [snapshot.providerId, snapshot.record.listingId, snapshot.record.commandId, snapshot.createdByNihoUserId,
          snapshot.operationNonce, snapshot.expectedMappingVersion, snapshot.accountVersion,
          snapshot.connectionGeneration, snapshot.grantedScopesDigest],
      );
      if (updated.rowCount !== 1) throw new StoreConflictError("Google setup create fence was lost.");
    });
  }

  async finish(snapshot: GoogleChannelSetupSecretSnapshot, calendarId: string): Promise<GoogleChannelSetupRecord> {
    if (!calendarId || calendarId.length > 512) throw new StoreValidationError("Invalid created Google calendar ID.");
    return transaction(this.#pool, async (client) => {
      await lockProviderInventory(client, snapshot.providerId);
      await lockGoogleCalendarUsage(client, [calendarId]);
      const actor: HostActor = { providerId: snapshot.providerId, nihoUserId: snapshot.createdByNihoUserId, calendarRoleCeiling: "OWNER" };
      const authority = await this.#authority(client, actor, snapshot.record.listingId, true);
      const journal = await client.query<JournalRow>(
        "SELECT * FROM google_channel_setup_journals WHERE provider_id=$1 AND command_id=$2::uuid FOR UPDATE",
        [snapshot.providerId, snapshot.record.commandId],
      );
      const row = journal.rows[0];
      if (!row || row.phase !== "CREATING" || !sameSnapshot(row, snapshot) || !this.#authorityMatches(row, authority, actor)) {
        throw new StoreConflictError("Google setup authority changed after create.");
      }
      const collision = await client.query(
        `SELECT 1 WHERE EXISTS (SELECT 1 FROM provider_google_calendars WHERE opaque_calendar_id=$1)
          OR EXISTS (SELECT 1 FROM resource_google_calendars WHERE opaque_calendar_id=$1)
          OR EXISTS (SELECT 1 FROM provider_google_connections WHERE busy_calendar_id=$1 OR booking_calendar_id=$1)
          OR EXISTS (SELECT 1 FROM google_channel_output_bindings WHERE opaque_calendar_id=$1)
          OR EXISTS (SELECT 1 FROM google_channel_output_bindings WHERE provider_id=$2 AND listing_id=$3)`,
        [calendarId, snapshot.providerId, snapshot.record.listingId],
      );
      if (collision.rows[0]) throw new StoreConflictError("Created Google calendar is already in use.");
      await client.query(
        `INSERT INTO google_channel_output_bindings
          (provider_id,listing_id,mapping_version,connection_generation,opaque_calendar_id,active)
         VALUES ($1,$2,$3,$4,$5,false)`,
        [snapshot.providerId, snapshot.record.listingId, snapshot.expectedMappingVersion, snapshot.connectionGeneration, calendarId],
      );
      const updated = await client.query<JournalRow>(
        `UPDATE google_channel_setup_journals
            SET phase='READY_FOR_CONNECTION',created_calendar_id=$10,failure_reason=NULL,updated_at=clock_timestamp()
          WHERE provider_id=$1 AND listing_id=$2 AND command_id=$3::uuid AND created_by_niho_user_id=$4
            AND operation_nonce=$5::uuid AND phase='CREATING' AND expected_mapping_version=$6
            AND account_version=$7 AND connection_generation=$8 AND granted_scopes_digest=$9 RETURNING *`,
        [snapshot.providerId, snapshot.record.listingId, snapshot.record.commandId, snapshot.createdByNihoUserId,
          snapshot.operationNonce, snapshot.expectedMappingVersion, snapshot.accountVersion,
          snapshot.connectionGeneration, snapshot.grantedScopesDigest, calendarId],
      );
      if (!updated.rows[0]) throw new StoreConflictError("Google setup completion fence was lost.");
      return record(updated.rows[0]);
    });
  }

  async failBeforeCreate(snapshot: GoogleChannelSetupSecretSnapshot, reason: string): Promise<GoogleChannelSetupRecord> {
    assertReason(reason);
    return this.#transition(snapshot, "PREPARING", "FAILED_BEFORE_CREATE", reason);
  }

  async markUncertain(snapshot: GoogleChannelSetupSecretSnapshot, reason: string): Promise<GoogleChannelSetupRecord> {
    assertReason(reason);
    return this.#transition(snapshot, "CREATING", "UNCERTAIN", reason);
  }

  async #transition(snapshot: GoogleChannelSetupSecretSnapshot, from: "PREPARING" | "CREATING", to: "FAILED_BEFORE_CREATE" | "UNCERTAIN", reason: string): Promise<GoogleChannelSetupRecord> {
    return transaction(this.#pool, async (client) => {
      await lockProviderInventory(client, snapshot.providerId);
      const updated = await client.query<JournalRow>(
        `UPDATE google_channel_setup_journals SET phase=$10,failure_reason=$11,updated_at=clock_timestamp()
          WHERE provider_id=$1 AND listing_id=$2 AND command_id=$3::uuid AND created_by_niho_user_id=$4
            AND operation_nonce=$5::uuid AND phase=$6 AND expected_mapping_version=$7
            AND account_version=$8 AND connection_generation=$9 AND granted_scopes_digest=$12 RETURNING *`,
        [snapshot.providerId, snapshot.record.listingId, snapshot.record.commandId, snapshot.createdByNihoUserId,
          snapshot.operationNonce, from, snapshot.expectedMappingVersion, snapshot.accountVersion,
          snapshot.connectionGeneration, to, reason, snapshot.grantedScopesDigest],
      );
      if (!updated.rows[0]) throw new StoreConflictError("Google setup transition fence was lost.");
      return record(updated.rows[0]);
    });
  }

  async assertCurrentOwnerAccess(actor: HostActor): Promise<void> {
    assertActor(actor);
    await transaction(this.#pool, async (client) => {
      await lockProviderInventory(client, actor.providerId);
      await this.#assertCurrentOwner(client, actor);
    });
  }

  async saveRotatedRefreshToken(snapshot: GoogleChannelSetupSecretSnapshot, encryptedRefreshToken: string): Promise<boolean> {
    const updated = await this.#pool.query(
      `UPDATE provider_google_connections c SET encrypted_refresh_token=$4,updated_at=clock_timestamp()
        WHERE c.provider_id=$1 AND c.connection_generation=$2 AND c.connected_by_niho_user_id=$3
          AND EXISTS (SELECT 1 FROM provider_memberships m WHERE m.provider_id=c.provider_id
            AND m.niho_user_id=$3 AND m.active=true AND m.role='OWNER')`,
      [snapshot.providerId, snapshot.connectionGeneration, snapshot.createdByNihoUserId, encryptedRefreshToken],
    );
    return updated.rowCount === 1;
  }
}
