import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { StoreAccessDeniedError, StoreConflictError } from "./errors.ts";
import { lockProviderInventory } from "./inventory.ts";
import type { ChannelRuntime, GoogleChannelDeliveryContext, WorkerIdentity } from "./channels.ts";

export type GoogleChannelDeliveryPhase = "DISPATCHING" | "GOOGLE_VERIFIED" | "UNCERTAIN" | "NOT_MATCHED" | "STOPPED";
export type GoogleChannelDeliveryOperation = "dispatch" | "reconcile";

export interface GoogleChannelDeliveryRecord {
  readonly deliveryId: string;
  readonly phase: GoogleChannelDeliveryPhase;
  readonly reason?: string;
  readonly airbnb: "UNVERIFIED";
}

export interface GoogleChannelStoredTarget {
  readonly providerId: string;
  readonly listingId: string;
  readonly occurrenceId: string;
  readonly action: "SET_OPEN" | "SET_CLOSED";
  readonly desiredState: "OPEN" | "CLOSED";
  readonly desiredVersion: number;
  readonly mappingVersion: number;
  readonly sourceStartAtUtc: string;
  readonly sourceEndAtUtc: string;
}

export interface GoogleChannelDeliverySecretSnapshot {
  readonly record: GoogleChannelDeliveryRecord;
  /** Authority of the currently leased job. OBSERVE is never a write authority. */
  readonly context: GoogleChannelDeliveryContext;
  /** Immutable target stored before the original dispatch. */
  readonly storedTarget: GoogleChannelStoredTarget;
  readonly targetAuthority: "CURRENT_JOB" | "STORED_JOURNAL_ONLY";
  readonly operation: GoogleChannelDeliveryOperation;
  readonly operationNonce: string;
  readonly calendarId: string;
  readonly connectionGeneration: number;
  readonly encryptedRefreshToken: string;
  readonly grantedScopes: readonly string[];
  readonly canDispatch: boolean;
}

export interface GoogleChannelSelectedMetadata {
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

const STATIC_REASONS = new Set([
  "ANCHOR_MISSING", "TOMBSTONE", "CANCELLED_EVENT", "STATUS_MISMATCH", "RECURRING_EVENT", "ALL_DAY_EVENT",
  "FOREIGN_EVENT", "MAPPING_MISMATCH", "TIME_MISMATCH", "VISIBILITY_MISMATCH", "STALE_INTENT",
  "PRECONDITION_FAILED", "DESIRED_MISMATCH", "WRITE_UNCERTAIN", "AUTHORITY_CHANGED", "GOOGLE_UNAVAILABLE",
  "GOOGLE_REVOKED", "INVALID_RESPONSE", "NO_JOURNAL",
]);

function digest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function scopesDigest(value: readonly string[]): string { return digest(JSON.stringify([...value].sort())); }
function secureDigestMatch(expectedHex: string, raw: string): boolean {
  const expected = Buffer.from(expectedHex, "hex");
  const actual = Buffer.from(digest(raw), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function integer(value: unknown): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new StoreConflictError("Stored Google delivery version is invalid.");
  return result;
}
function iso(value: unknown): string {
  const parsed = new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) throw new StoreConflictError("Stored Google delivery time is invalid.");
  return parsed.toISOString();
}
function intentFingerprint(context: GoogleChannelDeliveryContext): string {
  return digest(JSON.stringify([context.providerId, context.listingId, context.occurrenceId, context.mappingVersion, context.desiredVersion]));
}
function record(row: Record<string, unknown>): GoogleChannelDeliveryRecord {
  return {
    deliveryId: String(row.id), phase: row.phase as GoogleChannelDeliveryPhase,
    ...(typeof row.reason === "string" ? { reason: row.reason } : {}), airbnb: "UNVERIFIED",
  };
}
function storedTarget(row: Record<string, unknown>): GoogleChannelStoredTarget {
  return {
    providerId: String(row.provider_id), listingId: String(row.listing_id), occurrenceId: String(row.occurrence_id),
    action: row.action as "SET_OPEN" | "SET_CLOSED", desiredState: row.desired_state as "OPEN" | "CLOSED",
    desiredVersion: integer(row.desired_version), mappingVersion: integer(row.mapping_version),
    sourceStartAtUtc: iso(row.source_start_at), sourceEndAtUtc: iso(row.source_end_at),
  };
}
async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

type DeliveryRow = Record<string, unknown> & { id: string; phase: GoogleChannelDeliveryPhase; reason: string | null };
type CurrentRow = Record<string, unknown> & {
  opaque_calendar_id: string; binding_version: string; binding_mapping_version: string;
  binding_connection_generation: string; current_account_version: string;
  encrypted_refresh_token: string; granted_scopes: string[];
};

export class GoogleChannelDeliveryRepository {
  readonly #pool: Pool;
  readonly #runtime: ChannelRuntime;
  constructor(pool: Pool, runtime: ChannelRuntime) { this.#pool = pool; this.#runtime = runtime; }

  async #lockAndVerifyCurrent(
    client: PoolClient,
    identity: WorkerIdentity,
    context: GoogleChannelDeliveryContext,
    leaseToken: string,
    operation: GoogleChannelDeliveryOperation,
  ): Promise<CurrentRow> {
    const worker = await client.query<Record<string, unknown>>(
      "SELECT version,credential_expires_at,revoked_at FROM channel_workers WHERE id=$1 FOR UPDATE", [identity.workerId],
    );
    const workerRow = worker.rows[0];
    if (!workerRow || workerRow.revoked_at !== null || integer(workerRow.version) !== identity.credentialVersion
      || new Date(String(workerRow.credential_expires_at)).toISOString() <= new Date().toISOString()) throw new StoreAccessDeniedError();
    await lockProviderInventory(client, context.providerId);
    const result = await client.query<CurrentRow>(
      `SELECT j.*,d.desired_state,d.desired_version AS current_desired_version,d.mapping_version AS desired_mapping_version,
              d.source_start_at AS desired_start_at,d.source_end_at AS desired_end_at,
              l.active AS listing_active,l.mapping_version AS current_mapping_version,l.adapter,l.adapter_version,l.connection_mode,
              l.can_open,l.can_close,l.can_observe,p.status AS product_status,
              a.active AS account_active,a.version AS current_account_version,a.revoked_at,a.delegated_until,a.quarantined_at,a.site,
              wa.version AS current_assignment_version,b.opaque_calendar_id,b.binding_version,
              b.mapping_version AS binding_mapping_version,b.connection_generation AS binding_connection_generation,
              c.encrypted_refresh_token,c.granted_scopes
         FROM channel_jobs j
         JOIN channel_external_accounts a ON a.id=j.account_id
         JOIN channel_listings l ON l.id=j.listing_id
         JOIN experience_products p ON p.provider_id=l.provider_id AND p.id=l.product_id
         JOIN channel_desired_states d ON d.listing_id=j.listing_id AND d.occurrence_id=j.occurrence_id
         JOIN channel_worker_accounts wa ON wa.worker_id=$2 AND wa.account_id=j.account_id AND wa.revoked_at IS NULL
         JOIN google_channel_output_bindings b ON b.provider_id=j.provider_id AND b.listing_id=j.listing_id AND b.active=true
         JOIN provider_google_connections c ON c.provider_id=j.provider_id AND c.connection_generation=b.connection_generation
         JOIN provider_memberships m ON m.provider_id=c.provider_id AND m.niho_user_id=c.connected_by_niho_user_id AND m.active=true AND m.role='OWNER'
        WHERE j.id=$1::uuid FOR UPDATE OF j,a,l,d,wa,b,c FOR SHARE OF p`,
      [context.jobId, identity.workerId],
    );
    const row = result.rows[0];
    const now = new Date().toISOString();
    const dispatch = operation === "dispatch";
    if (!row || row.status !== "LEASED" || row.leased_worker_id !== identity.workerId || typeof row.lease_digest !== "string"
      || !secureDigestMatch(row.lease_digest, leaseToken) || row.purpose !== "AVAILABILITY" || row.site !== "Airbnb"
      || row.target_site !== "Airbnb" || row.connection_mode !== "GOOGLE" || row.target_connection_mode !== "GOOGLE"
      || row.adapter !== "airbnb-google-busy" || row.target_adapter !== "airbnb-google-busy"
      || row.adapter_version !== "1" || row.target_adapter_version !== "1"
      || (dispatch ? (row.action !== "SET_OPEN" && row.action !== "SET_CLOSED") : row.action !== "OBSERVE")
      || row.account_active !== true || row.listing_active !== true || row.revoked_at !== null
      || row.product_status !== "PUBLISHED"
      || (row.action === "SET_OPEN" ? row.can_open : row.action === "SET_CLOSED" ? row.can_close : row.can_observe) !== true
      || (dispatch && row.quarantined_at !== null)
      || (row.delegated_until !== null && new Date(String(row.delegated_until)).toISOString() <= now)
      || new Date(String(row.lease_expires_at)).toISOString() <= now || new Date(String(row.job_deadline_at)).toISOString() <= now
      || integer(row.lease_epoch) !== context.leaseEpoch || integer(row.lease_assignment_version) !== context.assignmentVersion
      || integer(row.current_assignment_version) !== context.assignmentVersion || integer(row.current_account_version) !== context.accountVersion
      || integer(row.account_version) !== context.accountVersion || integer(row.current_mapping_version) !== context.mappingVersion
      || integer(row.desired_mapping_version) !== context.mappingVersion || integer(row.current_desired_version) !== context.desiredVersion
      || integer(row.mapping_version) !== context.mappingVersion || integer(row.desired_version) !== context.desiredVersion
      || integer(row.binding_version) < 1 || integer(row.binding_mapping_version) !== context.mappingVersion
      || integer(row.binding_connection_generation) < 1
      || String(row.occurrence_id) !== context.occurrenceId || String(row.provider_id) !== context.providerId
      || String(row.account_id) !== context.accountId || String(row.listing_id) !== context.listingId
      || new Date(String(row.source_start_at)).toISOString() !== context.sourceStartAtUtc
      || new Date(String(row.source_end_at)).toISOString() !== context.sourceEndAtUtc
      || new Date(String(row.desired_start_at)).toISOString() !== context.sourceStartAtUtc
      || new Date(String(row.desired_end_at)).toISOString() !== context.sourceEndAtUtc
      || row.desired_state !== context.desiredState) throw new StoreConflictError("Google delivery authority changed.");
    const inputCollision = await client.query(
      `SELECT 1 WHERE EXISTS (SELECT 1 FROM provider_google_calendars g WHERE g.opaque_calendar_id=$1)
          OR EXISTS (SELECT 1 FROM resource_google_calendars g WHERE g.opaque_calendar_id=$1)
          OR EXISTS (SELECT 1 FROM provider_google_connections c WHERE c.busy_calendar_id=$1 OR c.booking_calendar_id=$1)`,
      [row.opaque_calendar_id],
    );
    if (inputCollision.rows[0]) throw new StoreConflictError("Output calendar is configured as an input or booking calendar.");
    return row;
  }

  #assertBindingSnapshot(delivery: DeliveryRow, current: CurrentRow, context: GoogleChannelDeliveryContext): void {
    if (String(delivery.provider_id) !== context.providerId || String(delivery.account_id) !== context.accountId
      || String(delivery.listing_id) !== context.listingId || String(delivery.occurrence_id) !== context.occurrenceId
      || integer(delivery.account_version) !== integer(current.current_account_version)
      || integer(delivery.binding_version) !== integer(current.binding_version)
      || integer(delivery.connection_generation) !== integer(current.binding_connection_generation)
      || String(delivery.binding_calendar_digest) !== digest(current.opaque_calendar_id)
      || String(delivery.granted_scopes_digest) !== scopesDigest(current.granted_scopes)) {
      throw new StoreConflictError("Google delivery binding identity changed.");
    }
  }

  #snapshot(
    delivery: DeliveryRow,
    current: CurrentRow,
    context: GoogleChannelDeliveryContext,
    operation: GoogleChannelDeliveryOperation,
    canDispatch: boolean,
  ): GoogleChannelDeliverySecretSnapshot {
    return {
      record: record(delivery), context, storedTarget: storedTarget(delivery),
      targetAuthority: operation === "dispatch" ? "CURRENT_JOB" : "STORED_JOURNAL_ONLY",
      operation, operationNonce: String(delivery.operation_nonce), calendarId: current.opaque_calendar_id,
      connectionGeneration: integer(current.binding_connection_generation), encryptedRefreshToken: current.encrypted_refresh_token,
      grantedScopes: current.granted_scopes, canDispatch,
    };
  }

  async prepareDispatch(identity: WorkerIdentity, jobId: string, leaseToken: string): Promise<GoogleChannelDeliverySecretSnapshot> {
    const context = await this.#runtime.googleDeliveryContext(identity, jobId, leaseToken, "dispatch");
    return transaction(this.#pool, async (client) => {
      const current = await this.#lockAndVerifyCurrent(client, identity, context, leaseToken, "dispatch");
      const fingerprint = intentFingerprint(context);
      const unresolved = await client.query<DeliveryRow>(
        `SELECT * FROM google_channel_deliveries WHERE provider_id=$1 AND listing_id=$2 AND occurrence_id=$3
          AND phase IN ('DISPATCHING','UNCERTAIN') ORDER BY created_at FOR UPDATE`,
        [context.providerId, context.listingId, context.occurrenceId],
      );
      if (unresolved.rows.length > 1) throw new StoreConflictError("Multiple unresolved Google delivery intents require manual review.");
      const unresolvedDelivery = unresolved.rows[0];
      if (unresolvedDelivery) {
        if (unresolvedDelivery.intent_fingerprint !== fingerprint) {
          throw new StoreConflictError("A prior Google delivery intent is unresolved.");
        }
        this.#assertBindingSnapshot(unresolvedDelivery, current, context);
        return this.#snapshot(unresolvedDelivery, current, context, "dispatch", false);
      }
      const prior = await client.query<DeliveryRow>(
        "SELECT * FROM google_channel_deliveries WHERE intent_fingerprint=$1 FOR UPDATE", [fingerprint],
      );
      const existing = prior.rows[0];
      if (existing) {
        this.#assertBindingSnapshot(existing, current, context);
        return this.#snapshot(existing, current, context, "dispatch", false);
      }
      const id = randomUUID();
      const operationNonce = randomUUID();
      const inserted = await client.query<DeliveryRow>(
        `INSERT INTO google_channel_deliveries
          (id,intent_fingerprint,job_id,provider_id,account_id,listing_id,occurrence_id,action,desired_state,desired_version,
           mapping_version,source_start_at,source_end_at,worker_id,lease_epoch,assignment_version,account_version,
           binding_version,connection_generation,binding_calendar_digest,granted_scopes_digest,operation_nonce,operation_kind,operation_job_id,
           operation_worker_id,operation_lease_epoch,operation_assignment_version,phase)
         VALUES ($1::uuid,$2,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
           $21,$22::uuid,'DISPATCH',$3::uuid,$14,$15,$16,'DISPATCHING') RETURNING *`,
        [id, fingerprint, context.jobId, context.providerId, context.accountId, context.listingId, context.occurrenceId,
          context.action, context.desiredState, context.desiredVersion, context.mappingVersion, context.sourceStartAtUtc,
          context.sourceEndAtUtc, identity.workerId, context.leaseEpoch, context.assignmentVersion, context.accountVersion,
          current.binding_version, current.binding_connection_generation, digest(current.opaque_calendar_id),
          scopesDigest(current.granted_scopes), operationNonce],
      );
      return this.#snapshot(inserted.rows[0]!, current, context, "dispatch", true);
    });
  }

  async prepareReconcile(identity: WorkerIdentity, jobId: string, leaseToken: string): Promise<GoogleChannelDeliverySecretSnapshot | null> {
    const context = await this.#runtime.googleDeliveryContext(identity, jobId, leaseToken, "reconcile");
    return transaction(this.#pool, async (client) => {
      const current = await this.#lockAndVerifyCurrent(client, identity, context, leaseToken, "reconcile");
      const prior = await client.query<DeliveryRow>(
        `SELECT d.* FROM google_channel_deliveries d
          JOIN channel_jobs original ON original.id=d.job_id
         WHERE d.provider_id=$1 AND d.listing_id=$2 AND d.occurrence_id=$3
           AND d.phase IN ('DISPATCHING','UNCERTAIN') AND original.status='FINISHED' AND original.outcome='NEEDS_REVIEW'
         ORDER BY d.created_at FOR UPDATE OF d`,
        [context.providerId, context.listingId, context.occurrenceId],
      );
      if (prior.rows.length === 0) return null;
      if (prior.rows.length > 1 || current.quarantined_at === null) {
        throw new StoreConflictError("Google delivery recovery requires manual review.");
      }
      let delivery = prior.rows[0]!;
      this.#assertBindingSnapshot(delivery, current, context);
      const target = storedTarget(delivery);
      if (target.mappingVersion !== context.mappingVersion || target.sourceStartAtUtc !== context.sourceStartAtUtc
        || target.sourceEndAtUtc !== context.sourceEndAtUtc) {
        throw new StoreConflictError("Stored Google target no longer matches the recovery authority.");
      }
      const sameOperation = delivery.operation_kind === "RECONCILE" && delivery.operation_job_id === context.jobId
        && delivery.operation_worker_id === identity.workerId
        && integer(delivery.operation_lease_epoch) === context.leaseEpoch
        && integer(delivery.operation_assignment_version) === context.assignmentVersion;
      if (!sameOperation) {
        const operationNonce = randomUUID();
        const updated = await client.query<DeliveryRow>(
          `UPDATE google_channel_deliveries SET operation_nonce=$2::uuid,operation_epoch=operation_epoch+1,
             operation_kind='RECONCILE',operation_job_id=$3::uuid,operation_worker_id=$4,
             operation_lease_epoch=$5,operation_assignment_version=$6,updated_at=clock_timestamp()
           WHERE id=$1::uuid AND phase IN ('DISPATCHING','UNCERTAIN') RETURNING *`,
          [delivery.id, operationNonce, context.jobId, identity.workerId, context.leaseEpoch, context.assignmentVersion],
        );
        delivery = updated.rows[0]!;
      }
      return this.#snapshot(delivery, current, context, "reconcile", false);
    });
  }

  async #authorizedOperation(
    client: PoolClient,
    identity: WorkerIdentity,
    context: GoogleChannelDeliveryContext,
    leaseToken: string,
    deliveryId: string,
    operationNonce: string,
    operation: GoogleChannelDeliveryOperation,
  ): Promise<{ delivery: DeliveryRow; context: GoogleChannelDeliveryContext }> {
    const current = await this.#lockAndVerifyCurrent(client, identity, context, leaseToken, operation);
    const result = await client.query<DeliveryRow>("SELECT * FROM google_channel_deliveries WHERE id=$1::uuid FOR UPDATE", [deliveryId]);
    const delivery = result.rows[0];
    if (!delivery || delivery.operation_nonce !== operationNonce
      || delivery.operation_kind !== operation.toUpperCase() || delivery.operation_job_id !== context.jobId
      || delivery.operation_worker_id !== identity.workerId
      || integer(delivery.operation_lease_epoch) !== context.leaseEpoch
      || integer(delivery.operation_assignment_version) !== context.assignmentVersion
      || (operation === "dispatch" ? delivery.phase !== "DISPATCHING" : !["DISPATCHING", "UNCERTAIN"].includes(delivery.phase))) {
      throw new StoreConflictError("Google delivery operation was fenced.");
    }
    this.#assertBindingSnapshot(delivery, current, context);
    if (operation === "dispatch" && delivery.intent_fingerprint !== intentFingerprint(context)) {
      throw new StoreConflictError("Google delivery intent changed.");
    }
    if (operation === "reconcile") {
      const original = await client.query(
        "SELECT 1 FROM channel_jobs WHERE id=$1::uuid AND status='FINISHED' AND outcome='NEEDS_REVIEW' FOR SHARE",
        [delivery.job_id],
      );
      if (!original.rows[0] || current.quarantined_at === null) throw new StoreConflictError("Google delivery recovery authority changed.");
    }
    return { delivery, context };
  }

  async assertCurrent(
    identity: WorkerIdentity,
    jobId: string,
    leaseToken: string,
    deliveryId: string,
    operationNonce: string,
    operation: GoogleChannelDeliveryOperation,
  ): Promise<void> {
    const context = await this.#runtime.googleDeliveryContext(identity, jobId, leaseToken, operation);
    await transaction(this.#pool, async (client) => {
      await this.#authorizedOperation(client, identity, context, leaseToken, deliveryId, operationNonce, operation);
    });
  }

  async saveResult(
    identity: WorkerIdentity,
    jobId: string,
    leaseToken: string,
    deliveryId: string,
    operationNonce: string,
    operation: GoogleChannelDeliveryOperation,
    result: { phase: Exclude<GoogleChannelDeliveryPhase, "DISPATCHING">; reason?: string; metadata?: GoogleChannelSelectedMetadata; changed?: boolean | null; writeAcknowledged?: boolean },
  ): Promise<GoogleChannelDeliveryRecord> {
    if (result.reason !== undefined && !STATIC_REASONS.has(result.reason)) throw new StoreConflictError("Invalid Google delivery reason.");
    const context = await this.#runtime.googleDeliveryContext(identity, jobId, leaseToken, operation);
    return transaction(this.#pool, async (client) => {
      const authorized = await this.#authorizedOperation(
        client, identity, context, leaseToken, deliveryId, operationNonce, operation,
      );
      const expected = storedTarget(authorized.delivery);
      if (result.phase === "GOOGLE_VERIFIED" && (!result.metadata
        || result.metadata.mappingVersion !== expected.mappingVersion
        || result.metadata.desiredVersion !== expected.desiredVersion
        || result.metadata.startAtUtc !== expected.sourceStartAtUtc
        || result.metadata.endAtUtc !== expected.sourceEndAtUtc
        || result.metadata.desiredState !== expected.desiredState
        || result.metadata.transparency !== (expected.desiredState === "CLOSED" ? "opaque" : "transparent"))) {
        throw new StoreConflictError("Google verification does not match the immutable stored target.");
      }
      const updated = await client.query<DeliveryRow>(
        `UPDATE google_channel_deliveries SET phase=$2,reason=$3,event_id=$4,event_etag=$5,binding_hash=$6,
           google_mapping_version=$7,google_desired_version=$8,google_start_at=$9,google_end_at=$10,
           google_desired_state=$11,google_transparency=$12,changed=$13,write_acknowledged=$14,updated_at=clock_timestamp()
         WHERE id=$1::uuid AND operation_nonce=$15::uuid AND operation_job_id=$16::uuid
           AND operation_worker_id=$17 AND operation_lease_epoch=$18 AND operation_assignment_version=$19
           AND phase=$20 RETURNING *`,
        [deliveryId, result.phase, result.reason ?? null, result.metadata?.eventId ?? null, result.metadata?.etag ?? null,
          result.metadata?.bindingHash ?? null, result.metadata?.mappingVersion ?? null, result.metadata?.desiredVersion ?? null,
          result.metadata?.startAtUtc ?? null, result.metadata?.endAtUtc ?? null, result.metadata?.desiredState ?? null,
          result.metadata?.transparency ?? null, result.changed ?? null, result.writeAcknowledged ?? null,
          operationNonce, authorized.context.jobId, identity.workerId, authorized.context.leaseEpoch,
          authorized.context.assignmentVersion, authorized.delivery.phase],
      );
      if (!updated.rows[0]) throw new StoreConflictError("Google delivery result lost its operation fence.");
      return record(updated.rows[0]);
    });
  }

  async saveRotatedRefreshToken(providerId: string, generation: number, encryptedRefreshToken: string): Promise<boolean> {
    const updated = await this.#pool.query(
      `UPDATE provider_google_connections c SET encrypted_refresh_token=$3,updated_at=clock_timestamp()
        WHERE c.provider_id=$1 AND c.connection_generation=$2 AND EXISTS (
          SELECT 1 FROM provider_memberships m WHERE m.provider_id=c.provider_id
            AND m.niho_user_id=c.connected_by_niho_user_id AND m.active=true AND m.role='OWNER')`,
      [providerId, generation, encryptedRefreshToken],
    );
    return updated.rowCount === 1;
  }
}
