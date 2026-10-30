import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { DbRow } from "./rows.ts";

export const GOOGLE_PROPAGATION_PENDING = "GOOGLE_PROPAGATION_PENDING";
export const GOOGLE_PROPAGATION_REVIEW = "GOOGLE_PROPAGATION_NEEDS_REVIEW";

export const REQUIRED_GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.app.created",
] as const;

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function googleScopesDigest(scopes: readonly string[]): string {
  return digest(JSON.stringify([...scopes].sort()));
}

export function nextGooglePropagationDue(nowUtc: string, deadlineAtUtc: string): string {
  return new Date(Math.min(Date.parse(nowUtc) + 5 * 60_000, Date.parse(deadlineAtUtc))).toISOString();
}

export function isExactGoogleAirbnbMismatch(
  desiredState: "OPEN" | "CLOSED",
  observedState: unknown,
  observedBookable: unknown,
): boolean {
  return observedState === (desiredState === "OPEN" ? "CLOSED" : "OPEN")
    && observedBookable === (observedState === "OPEN");
}

/**
 * Selects only authority metadata. Calendar IDs and scopes remain inside the
 * store transaction and are used solely to compare their saved digests.
 */
export async function loadGooglePropagationAuthority(
  client: PoolClient,
  deliveryId: string,
  lockWait: boolean,
): Promise<DbRow | undefined> {
  const result = await client.query<DbRow>(
    `SELECT w.*,
            gd.provider_id AS delivery_provider_id,gd.account_id AS delivery_account_id,
            gd.listing_id AS delivery_listing_id,gd.occurrence_id AS delivery_occurrence_id,
            gd.action AS delivery_action,gd.desired_state AS delivery_desired_state,
            gd.desired_version AS delivery_desired_version,gd.mapping_version AS delivery_mapping_version,
            gd.account_version AS delivery_account_version,gd.source_start_at AS delivery_source_start_at,
            gd.source_end_at AS delivery_source_end_at,gd.binding_version AS delivery_binding_version,
            gd.connection_generation AS delivery_connection_generation,
            gd.binding_calendar_digest AS delivery_calendar_digest,
            gd.granted_scopes_digest AS delivery_scopes_digest,gd.first_verified_at AS delivery_first_verified_at,
            gd.phase AS delivery_phase,gd.operation_worker_id AS delivery_operation_worker_id,
            gd.operation_assignment_version AS delivery_operation_assignment_version,
            a.active AS account_active,a.revoked_at,a.delegated_until,a.quarantined_at,a.version AS current_account_version,
            a.site AS current_site,a.external_account_id AS current_external_account_id,
            l.active AS listing_active,l.product_id,l.mapping_version AS current_mapping_version,
            l.external_product_id AS current_external_product_id,l.external_option_id AS current_external_option_id,
            l.adapter AS current_adapter,l.adapter_version AS current_adapter_version,
            l.connection_mode AS current_connection_mode,l.can_observe,p.status AS product_status,
            ds.desired_state AS current_desired_state,ds.desired_version AS current_desired_version,
            ds.mapping_version AS current_desired_mapping_version,ds.source_start_at AS current_source_start_at,
            ds.source_end_at AS current_source_end_at,
            wa.version AS current_assignment_version,
            b.mapping_version AS current_binding_mapping_version,b.connection_generation AS current_connection_generation,
            b.binding_version AS current_binding_version,b.opaque_calendar_id,c.granted_scopes,
            (m.niho_user_id IS NOT NULL) AS current_owner,
            EXISTS (SELECT 1 FROM provider_google_calendars pgc WHERE pgc.opaque_calendar_id=b.opaque_calendar_id)
              OR EXISTS (SELECT 1 FROM resource_google_calendars rgc WHERE rgc.opaque_calendar_id=b.opaque_calendar_id)
              OR EXISTS (SELECT 1 FROM provider_google_connections pic
                WHERE pic.busy_calendar_id=b.opaque_calendar_id OR pic.booking_calendar_id=b.opaque_calendar_id)
              AS input_collision,
            EXISTS (SELECT 1 FROM google_channel_deliveries other
              WHERE other.provider_id=w.provider_id AND other.listing_id=w.listing_id
                AND other.occurrence_id=w.occurrence_id AND other.id<>w.delivery_id
                AND other.phase IN ('DISPATCHING','UNCERTAIN')) AS unresolved_write
       FROM google_airbnb_propagation_waits w
       JOIN google_channel_deliveries gd ON gd.id=w.delivery_id
       LEFT JOIN channel_external_accounts a ON a.id=w.account_id AND a.provider_id=w.provider_id
       LEFT JOIN channel_listings l ON l.id=w.listing_id AND l.provider_id=w.provider_id AND l.account_id=w.account_id
       LEFT JOIN experience_products p ON p.provider_id=w.provider_id AND p.id=l.product_id
       LEFT JOIN channel_desired_states ds ON ds.listing_id=w.listing_id AND ds.occurrence_id=w.occurrence_id
       LEFT JOIN channel_worker_accounts wa ON wa.worker_id=w.dispatched_worker_id AND wa.account_id=w.account_id
         AND wa.revoked_at IS NULL
       LEFT JOIN google_channel_output_bindings b ON b.provider_id=w.provider_id AND b.listing_id=w.listing_id AND b.active=true
       LEFT JOIN provider_google_connections c ON c.provider_id=w.provider_id
         AND c.connection_generation=b.connection_generation
       LEFT JOIN provider_memberships m ON m.provider_id=c.provider_id
         AND m.niho_user_id=c.connected_by_niho_user_id AND m.active=true AND m.role='OWNER'
      WHERE w.delivery_id=$1::uuid ${lockWait ? "FOR UPDATE OF w" : ""}`,
    [deliveryId],
  );
  return result.rows[0];
}

function sameInteger(left: unknown, right: unknown): boolean {
  const a = Number(left);
  const b = Number(right);
  return Number.isSafeInteger(a) && a > 0 && a === b;
}

function sameInstant(left: unknown, right: unknown): boolean {
  const a = new Date(String(left)).getTime();
  const b = new Date(String(right)).getTime();
  return Number.isFinite(a) && a === b;
}

export function googlePropagationAuthorityCurrent(row: DbRow, nowUtc: string): boolean {
  const scopes = Array.isArray(row.granted_scopes) && row.granted_scopes.every((value) => typeof value === "string")
    ? row.granted_scopes as string[] : [];
  const expectedAction = row.desired_state === "OPEN" ? "SET_OPEN" : "SET_CLOSED";
  return row.delivery_id !== undefined
    && row.delivery_provider_id === row.provider_id && row.delivery_account_id === row.account_id
    && row.delivery_listing_id === row.listing_id && row.delivery_occurrence_id === row.occurrence_id
    && row.delivery_action === expectedAction && row.delivery_desired_state === row.desired_state
    && sameInteger(row.delivery_desired_version, row.desired_version)
    && sameInteger(row.delivery_mapping_version, row.mapping_version)
    && sameInteger(row.delivery_account_version, row.account_version)
    && sameInstant(row.delivery_source_start_at, row.source_start_at)
    && sameInstant(row.delivery_source_end_at, row.source_end_at)
    && sameInteger(row.delivery_binding_version, row.binding_version)
    && sameInteger(row.delivery_connection_generation, row.connection_generation)
    && row.delivery_calendar_digest === row.binding_calendar_digest
    && row.delivery_scopes_digest === row.granted_scopes_digest
    && sameInstant(row.delivery_first_verified_at, row.first_verified_at)
    && row.delivery_phase === "GOOGLE_VERIFIED"
    && row.delivery_operation_worker_id === row.dispatched_worker_id
    && sameInteger(row.delivery_operation_assignment_version, row.dispatched_assignment_version)
    && row.account_active === true && row.revoked_at === null && row.quarantined_at === null
    && (row.delegated_until === null || new Date(String(row.delegated_until)).toISOString() > nowUtc)
    && sameInteger(row.current_account_version, row.account_version)
    && row.current_site === row.target_site && row.current_external_account_id === row.target_external_account_id
    && row.listing_active === true && row.product_status === "PUBLISHED" && row.can_observe === true
    && sameInteger(row.current_mapping_version, row.mapping_version)
    && row.current_external_product_id === row.target_external_product_id
    && row.current_external_option_id === row.target_external_option_id
    && row.current_adapter === row.target_adapter && row.current_adapter_version === row.target_adapter_version
    && row.current_connection_mode === row.target_connection_mode
    && row.current_desired_state === row.desired_state
    && sameInteger(row.current_desired_version, row.desired_version)
    && sameInteger(row.current_desired_mapping_version, row.mapping_version)
    && sameInstant(row.current_source_start_at, row.source_start_at)
    && sameInstant(row.current_source_end_at, row.source_end_at)
    && sameInteger(row.current_assignment_version, row.dispatched_assignment_version)
    && sameInteger(row.current_binding_mapping_version, row.mapping_version)
    && sameInteger(row.current_binding_version, row.binding_version)
    && sameInteger(row.current_connection_generation, row.connection_generation)
    && typeof row.opaque_calendar_id === "string" && digest(row.opaque_calendar_id) === row.binding_calendar_digest
    && googleScopesDigest(scopes) === row.granted_scopes_digest
    && REQUIRED_GOOGLE_SCOPES.every((scope) => scopes.includes(scope))
    && row.current_owner === true && row.input_collision === false && row.unresolved_write === false;
}

export function googlePropagationJobMatches(row: DbRow, job: DbRow): boolean {
  return row.pending_job_id === job.id && job.google_propagation_delivery_id === row.delivery_id
    && job.purpose === "AVAILABILITY" && job.action === "OBSERVE"
    && job.provider_id === row.provider_id && job.account_id === row.account_id
    && job.listing_id === row.listing_id && job.occurrence_id === row.occurrence_id
    && sameInteger(job.account_version, row.account_version)
    && sameInteger(job.desired_version, row.desired_version)
    && sameInteger(job.mapping_version, row.mapping_version)
    && sameInstant(job.source_start_at, row.source_start_at)
    && sameInstant(job.source_end_at, row.source_end_at)
    && job.target_site === row.target_site
    && job.target_external_account_id === row.target_external_account_id
    && job.target_external_product_id === row.target_external_product_id
    && job.target_external_option_id === row.target_external_option_id
    && job.target_adapter === row.target_adapter && job.target_adapter_version === row.target_adapter_version
    && job.target_connection_mode === row.target_connection_mode
    && job.dispatch_worker_id === row.dispatched_worker_id
    && sameInteger(job.dispatch_assignment_version, row.dispatched_assignment_version);
}
