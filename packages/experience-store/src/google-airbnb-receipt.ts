import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { StoreConflictError } from "./errors.ts";

const REQUIRED_GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.app.created",
] as const;

export interface GoogleAirbnbReceiptAuthority {
  readonly deliveryId: string;
  readonly jobId: string;
  readonly providerId: string;
  readonly accountId: string;
  readonly listingId: string;
  readonly occurrenceId: string;
  readonly workerId: string;
  readonly leaseEpoch: number;
  readonly assignmentVersion: number;
  readonly accountVersion: number;
  readonly mappingVersion: number;
  readonly desiredVersion: number;
  readonly desiredState: "OPEN" | "CLOSED";
  readonly action: "SET_OPEN" | "SET_CLOSED";
  readonly sourceStartAtUtc: string;
  readonly sourceEndAtUtc: string;
  readonly leaseStartedAtUtc: string;
  readonly observedAtUtc: string;
}

export interface VerifiedGoogleAirbnbReceipt {
  readonly deliveryId: string;
  readonly googleVerifiedAtUtc: string;
}

function digest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function scopesDigest(scopes: readonly string[]): string { return digest(JSON.stringify([...scopes].sort())); }
function integer(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new StoreConflictError("Google Airbnb proof is stale.");
  return parsed;
}
function iso(value: unknown): string {
  const parsed = new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) throw new StoreConflictError("Google Airbnb proof is stale.");
  return parsed.toISOString();
}

/** Validates selected Google metadata without exposing calendar IDs, scopes, or credentials to the worker receipt. */
export async function verifyGoogleAirbnbReceipt(
  client: PoolClient,
  authority: GoogleAirbnbReceiptAuthority,
): Promise<VerifiedGoogleAirbnbReceipt> {
  const result = await client.query<Record<string, unknown>>(
    `SELECT d.*,b.mapping_version AS current_binding_mapping_version,
            b.connection_generation AS current_connection_generation,b.binding_version AS current_binding_version,
            b.opaque_calendar_id,c.granted_scopes
       FROM google_channel_deliveries d
       JOIN google_channel_output_bindings b
         ON b.provider_id=d.provider_id AND b.listing_id=d.listing_id AND b.active=true
       JOIN provider_google_connections c
         ON c.provider_id=d.provider_id AND c.connection_generation=b.connection_generation
       JOIN provider_memberships m
         ON m.provider_id=c.provider_id AND m.niho_user_id=c.connected_by_niho_user_id
        AND m.active=true AND m.role='OWNER'
      WHERE d.id=$1::uuid
      FOR SHARE OF d,b,c,m`,
    [authority.deliveryId],
  );
  const row = result.rows[0];
  const scopes = Array.isArray(row?.granted_scopes) && row.granted_scopes.every((scope) => typeof scope === "string")
    ? row.granted_scopes as string[] : [];
  const verifiedAtUtc = row ? iso(row.updated_at) : "";
  const expectedTransparency = authority.desiredState === "CLOSED" ? "opaque" : "transparent";
  if (!row || row.phase !== "GOOGLE_VERIFIED" || row.operation_kind !== "DISPATCH"
    || row.job_id !== authority.jobId || row.operation_job_id !== authority.jobId
    || row.worker_id !== authority.workerId || row.operation_worker_id !== authority.workerId
    || integer(row.lease_epoch) !== authority.leaseEpoch || integer(row.operation_lease_epoch) !== authority.leaseEpoch
    || integer(row.assignment_version) !== authority.assignmentVersion
    || integer(row.operation_assignment_version) !== authority.assignmentVersion
    || row.provider_id !== authority.providerId || row.account_id !== authority.accountId
    || row.listing_id !== authority.listingId || row.occurrence_id !== authority.occurrenceId
    || row.action !== authority.action || row.desired_state !== authority.desiredState
    || integer(row.account_version) !== authority.accountVersion
    || integer(row.mapping_version) !== authority.mappingVersion
    || integer(row.desired_version) !== authority.desiredVersion
    || iso(row.source_start_at) !== authority.sourceStartAtUtc || iso(row.source_end_at) !== authority.sourceEndAtUtc
    || integer(row.google_mapping_version) !== authority.mappingVersion
    || integer(row.google_desired_version) !== authority.desiredVersion
    || row.google_desired_state !== authority.desiredState || row.google_transparency !== expectedTransparency
    || iso(row.google_start_at) !== authority.sourceStartAtUtc || iso(row.google_end_at) !== authority.sourceEndAtUtc
    || typeof row.event_id !== "string" || typeof row.event_etag !== "string" || typeof row.binding_hash !== "string"
    || integer(row.current_binding_mapping_version) !== authority.mappingVersion
    || integer(row.current_binding_version) !== integer(row.binding_version)
    || integer(row.current_connection_generation) !== integer(row.connection_generation)
    || digest(String(row.opaque_calendar_id)) !== row.binding_calendar_digest
    || scopesDigest(scopes) !== row.granted_scopes_digest
    || !REQUIRED_GOOGLE_SCOPES.every((scope) => scopes.includes(scope))
    || verifiedAtUtc < authority.leaseStartedAtUtc || verifiedAtUtc > authority.observedAtUtc) {
    throw new StoreConflictError("Google Airbnb proof is foreign, stale, or incomplete.");
  }

  const collision = await client.query(
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM provider_google_calendars g WHERE g.opaque_calendar_id=$1)
        OR EXISTS (SELECT 1 FROM resource_google_calendars g WHERE g.opaque_calendar_id=$1)
        OR EXISTS (SELECT 1 FROM provider_google_connections c WHERE c.busy_calendar_id=$1 OR c.booking_calendar_id=$1)`,
    [row.opaque_calendar_id],
  );
  if (collision.rows[0]) throw new StoreConflictError("Google output calendar is also configured as an input calendar.");

  const unresolved = await client.query(
    `SELECT 1 FROM google_channel_deliveries
      WHERE provider_id=$1 AND listing_id=$2 AND occurrence_id=$3 AND id<>$4::uuid
        AND phase IN ('DISPATCHING','UNCERTAIN') LIMIT 1 FOR SHARE`,
    [authority.providerId, authority.listingId, authority.occurrenceId, authority.deliveryId],
  );
  if (unresolved.rows[0]) throw new StoreConflictError("Another Google delivery for this occurrence is unresolved.");
  return { deliveryId: authority.deliveryId, googleVerifiedAtUtc: verifiedAtUtc };
}
