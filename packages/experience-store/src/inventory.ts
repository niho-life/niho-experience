import { addMinutes, evaluateAvailability, intervalsOverlap, type AvailabilityResult, type BusyInterval, type Occurrence } from "@niho-experience/experience-domain";
import type { Pool, PoolClient } from "pg";
import { googleCalendarFromRow, isoValue, type DbRow } from "./rows.ts";
import type { BookingMode, InventoryResourceKind } from "./types.ts";
import { effectiveGoogleSyncStatus } from "./validation.ts";

type Queryable = Pool | PoolClient;
// schedule_rules and RESCHEDULE overrides both cap duration at 1,440 minutes.
// Using the domain maximum keeps a boundary closed even when the current rule
// is later shortened while an external reservation still occupies a resource.
const MAX_SOURCE_OCCURRENCE_MINUTES = 1_440;

export interface InventoryOccupancySnapshot {
  readonly resourceId: string;
  readonly resourceKind: InventoryResourceKind;
  readonly prepareMinutes: number;
  readonly cleanupMinutes: number;
  readonly startAtUtc: string;
  readonly endAtUtc: string;
}

export interface InventoryAvailability {
  readonly availability: AvailabilityResult;
  readonly bookingMode: BookingMode;
  readonly occupancies: readonly InventoryOccupancySnapshot[];
}

export interface InventoryEvaluationRequest {
  readonly productId: string;
  readonly occurrence: Occurrence;
  readonly requestedSeats: number;
}

/** The first lock for every inventory mutation. Google usage locks, then idempotency/product/occurrence locks follow. */
export async function lockProviderInventory(client: PoolClient, providerId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 31))", [`provider-inventory:${providerId}`]);
}

/**
 * Serializes Google calendar adoption across providers and across input/output roles.
 * Call only after the provider inventory mutex. Sorting prevents two-calendar
 * connection updates from acquiring the global locks in opposite orders.
 */
export async function lockGoogleCalendarUsage(client: PoolClient, calendarIds: readonly string[]): Promise<void> {
  const ids = [...new Set(calendarIds)];
  if (ids.some((id) => !id || id.length > 512)) throw new TypeError("Invalid Google calendar ID.");
  ids.sort();
  for (const id of ids) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 37))", [`google-calendar-usage:${id}`]);
  }
}

export async function evaluateStoredInventory(
  client: Queryable,
  providerId: string,
  productId: string,
  occurrence: Occurrence,
  nowUtc: string,
  requestedSeats: number,
): Promise<InventoryAvailability> {
  const result = await evaluateStoredInventories(client, providerId, [{ productId, occurrence, requestedSeats }], nowUtc);
  const evaluated = result.get(occurrence.id);
  if (evaluated === undefined) throw new Error("Inventory evaluation did not return the requested occurrence.");
  return evaluated;
}

/** Batch read used by host calendar; channel and booking paths use the same evaluator with one item. */
export async function evaluateStoredInventories(
  client: Queryable,
  providerId: string,
  requests: readonly InventoryEvaluationRequest[],
  nowUtc: string,
): Promise<ReadonlyMap<string, InventoryAvailability>> {
  if (requests.length === 0) return new Map();
  const productIds = [...new Set(requests.map((request) => request.productId))];
  const occurrenceIds = requests.map((request) => request.occurrence.id);
  const settings = await client.query<DbRow>(
    `SELECT p.id AS product_id,COALESCE(s.booking_mode,'SEAT') AS booking_mode
       FROM experience_products p
       LEFT JOIN product_inventory_settings s ON s.provider_id=p.provider_id AND s.product_id=p.id
      WHERE p.provider_id=$1 AND p.id=ANY($2::text[])`,
    [providerId, productIds],
  );
  const modeByProduct = new Map(settings.rows.map((row) => [String(row.product_id), String(row.booking_mode) as BookingMode]));
  const resources = await client.query<DbRow>(
    `SELECT a.product_id,a.resource_id,a.prepare_minutes,a.cleanup_minutes,r.kind,r.active
       FROM product_inventory_resources a
       JOIN inventory_resources r ON r.provider_id=a.provider_id AND r.id=a.resource_id
      WHERE a.provider_id=$1 AND a.product_id=ANY($2::text[])
      ORDER BY a.product_id COLLATE "C",a.resource_id COLLATE "C"`,
    [providerId, productIds],
  );
  const resourcesByProduct = new Map<string, DbRow[]>();
  for (const row of resources.rows) {
    const productId = String(row.product_id);
    resourcesByProduct.set(productId, [...(resourcesByProduct.get(productId) ?? []), row]);
  }
  const reservationReadRequirements = await client.query<DbRow>(
    `SELECT l.id AS listing_id,l.account_id,l.product_id,l.mapping_version,l.can_observe,
            a.version AS account_version,a.active AS account_active,a.revoked_at,a.delegated_until,
            h.account_id AS health_account_id,h.account_version AS health_account_version,
            h.mapping_version AS health_mapping_version,h.coverage_from,h.coverage_to,h.fresh_until,
            pr.resource_id,pr.prepare_minutes AS source_prepare_minutes,pr.cleanup_minutes AS source_cleanup_minutes
       FROM channel_listings l
       JOIN channel_external_accounts a ON a.provider_id=l.provider_id AND a.id=l.account_id
       LEFT JOIN external_reservation_listing_health h ON h.provider_id=l.provider_id AND h.listing_id=l.id
       LEFT JOIN product_inventory_resources pr ON pr.provider_id=l.provider_id AND pr.product_id=l.product_id
      WHERE l.provider_id=$1 AND l.active=true AND l.can_read_reservations=true
      ORDER BY l.id COLLATE "C",pr.resource_id COLLATE "C" NULLS FIRST`,
    [providerId],
  );
  const reservationReadRequirementsByListing = new Map<string, DbRow[]>();
  for (const row of reservationReadRequirements.rows) {
    const listingId = String(row.listing_id);
    reservationReadRequirementsByListing.set(listingId, [...(reservationReadRequirementsByListing.get(listingId) ?? []), row]);
  }
  const reservations = await client.query<DbRow>(
    `WITH active_reservations AS (
       SELECT occurrence_id,seats,status,hold_expires_at FROM bookings
        WHERE provider_id=$1 AND occurrence_id=ANY($2::text[])
       UNION ALL
       SELECT occurrence_id,seats,'CONFIRMED'::text AS status,NULL::timestamptz AS hold_expires_at
         FROM external_reservations
        WHERE provider_id=$1 AND occurrence_id=ANY($2::text[]) AND status IN ('PENDING','CONFIRMED')
     )
     SELECT occurrence_id,
            COALESCE(sum(seats) FILTER (WHERE status='CONFIRMED'),0)::text AS confirmed,
            COALESCE(sum(seats) FILTER (WHERE status='HOLD' AND hold_expires_at>$3),0)::text AS held,
            count(*) FILTER (WHERE status='CONFIRMED' OR (status='HOLD' AND hold_expires_at>$3))::text AS groups
       FROM active_reservations GROUP BY occurrence_id`,
    [providerId, occurrenceIds, nowUtc],
  );
  // A mismatched source may belong to another time/resource. Do not infer an
  // empty calendar from it. This provider-wide fence lasts until an exact read
  // resolves the fact; it does not invent a canonical occurrence or booking.
  const unresolved = await client.query(
    `SELECT 1 FROM external_reservations WHERE provider_id=$1 AND needs_review=true
       AND review_reason IN ('TARGET_MISMATCH','CONFLICTING_SOURCE_VERSION') LIMIT 1`,
    [providerId],
  );
  const reservationsByOccurrence = new Map(reservations.rows.map((row) => [String(row.occurrence_id), row]));
  const resourceIds = [...new Set(resources.rows.map((row) => String(row.resource_id)))];
  const overallStart = requests.reduce((value, request) => request.occurrence.startUtc < value ? request.occurrence.startUtc : value, requests[0]!.occurrence.startUtc);
  const overallEnd = requests.reduce((value, request) => request.occurrence.endUtc > value ? request.occurrence.endUtc : value, requests[0]!.occurrence.endUtc);
  const activeOccupancies = resourceIds.length === 0 ? { rows: [] as DbRow[] } : await client.query<DbRow>(
    `SELECT o.resource_id,o.start_at,o.end_at,b.product_id,b.occurrence_id
       FROM booking_resource_occupancies o
       JOIN bookings b ON b.provider_id=o.provider_id AND b.id=o.booking_id
      WHERE o.provider_id=$1 AND o.resource_id=ANY($2::text[])
        AND o.end_at>$3 AND o.start_at<$4
        AND (b.status='CONFIRMED' OR (b.status='HOLD' AND b.hold_expires_at>$5))
     UNION ALL
     SELECT o.resource_id,o.start_at,o.end_at,o.product_id,o.occurrence_id
       FROM external_reservation_resource_occupancies o
       JOIN external_reservations e ON e.source_site=o.source_site
        AND e.source_external_account_id=o.source_external_account_id
        AND e.external_reservation_id=o.external_reservation_id AND e.local_revision=o.local_revision
      WHERE o.provider_id=$1 AND o.resource_id=ANY($2::text[])
        AND o.end_at>$3 AND o.start_at<$4 AND e.status IN ('PENDING','CONFIRMED')`,
    [providerId, resourceIds, addMinutes(overallStart, -1_440), addMinutes(overallEnd, 1_440), nowUtc],
  );
  const activeOccupanciesByResource = new Map<string, DbRow[]>();
  for (const row of activeOccupancies.rows) {
    const resourceId = String(row.resource_id);
    activeOccupanciesByResource.set(resourceId, [...(activeOccupanciesByResource.get(resourceId) ?? []), row]);
  }
  const resourceGoogle = resourceIds.length === 0 ? { rows: [] as DbRow[] } : await client.query<DbRow>(
    `SELECT g.*,c.connection_generation AS current_connection_generation
       FROM resource_google_calendars g
       LEFT JOIN provider_google_connections c ON c.provider_id=g.provider_id
        AND EXISTS (SELECT 1 FROM provider_memberships m WHERE m.provider_id=c.provider_id
          AND m.niho_user_id=c.connected_by_niho_user_id AND m.active=true AND m.role='OWNER')
      WHERE g.provider_id=$1 AND g.resource_id=ANY($2::text[])`,
    [providerId, resourceIds],
  );
  const resourceGoogleById = new Map(resourceGoogle.rows.map((row) => [String(row.resource_id), row]));
  const resourceBusy = resourceIds.length === 0 ? { rows: [] as DbRow[] } : await client.query<DbRow>(
    `SELECT b.resource_id,b.settings_version,b.connection_generation,b.start_at,b.end_at
       FROM resource_google_busy_intervals b
       JOIN resource_google_calendars g ON g.provider_id=b.provider_id AND g.resource_id=b.resource_id
      WHERE b.provider_id=$1 AND b.resource_id=ANY($2::text[])
        AND b.settings_version=g.settings_version AND b.connection_generation=g.connection_generation
        AND b.end_at>$3 AND b.start_at<$4
      ORDER BY b.resource_id COLLATE "C",b.start_at`,
    [providerId, resourceIds, addMinutes(overallStart, -1_440), addMinutes(overallEnd, 1_440)],
  );
  const resourceBusyById = new Map<string, BusyInterval[]>();
  for (const row of resourceBusy.rows) {
    const resourceId = String(row.resource_id);
    resourceBusyById.set(resourceId, [...(resourceBusyById.get(resourceId) ?? []), { startUtc: isoValue(row, "start_at"), endUtc: isoValue(row, "end_at") }]);
  }
  const googleResult = await client.query<DbRow>("SELECT * FROM provider_google_calendars WHERE provider_id=$1", [providerId]);
  const google = googleResult.rows[0] === undefined ? undefined : googleCalendarFromRow(googleResult.rows[0]);
  let allBusyIntervals: BusyInterval[] = [];
  if (google?.blockingEnabled === true && effectiveGoogleSyncStatus(google.syncStatus, google.freshUntilUtc, nowUtc) === "FRESH") {
    const googleStart = requests.reduce((value, request) => {
      const start = addMinutes(request.occurrence.startUtc, -request.occurrence.busyBufferBeforeMinutes);
      return start < value ? start : value;
    }, requests[0]!.occurrence.startUtc);
    const googleEnd = requests.reduce((value, request) => {
      const end = addMinutes(request.occurrence.endUtc, request.occurrence.busyBufferAfterMinutes);
      return end > value ? end : value;
    }, requests[0]!.occurrence.endUtc);
    const busy = await client.query<DbRow>(
      `SELECT start_at,end_at FROM google_busy_intervals
        WHERE provider_id=$1 AND opaque_calendar_id=$2 AND end_at>$3 AND start_at<$4 ORDER BY start_at`,
      [providerId, google.opaqueCalendarId, googleStart, googleEnd],
    );
    allBusyIntervals = busy.rows.map((row) => ({ startUtc: isoValue(row, "start_at"), endUtc: isoValue(row, "end_at") }));
  }

  const results = new Map<string, InventoryAvailability>();
  for (const request of requests) {
    const resourceRows = resourcesByProduct.get(request.productId) ?? [];
    const requestedResourceIds = new Set(resourceRows.map((row) => String(row.resource_id)));
    const occupancies = resourceRows.map((row): InventoryOccupancySnapshot => ({
      resourceId: String(row.resource_id),
      resourceKind: String(row.kind) as InventoryResourceKind,
      prepareMinutes: Number(row.prepare_minutes),
      cleanupMinutes: Number(row.cleanup_minutes),
      startAtUtc: addMinutes(request.occurrence.startUtc, -Number(row.prepare_minutes)),
      endAtUtc: addMinutes(request.occurrence.endUtc, Number(row.cleanup_minutes)),
    }));
    const reservationReadUnavailable = [...reservationReadRequirementsByListing.values()].some((listingRows) => {
      const row = listingRows[0]!;
      const sharedRows = listingRows.filter((item) => item.resource_id !== null
        && requestedResourceIds.has(String(item.resource_id)));
      const relevant = String(row.product_id) === request.productId || sharedRows.length > 0;
      if (!relevant) return false;
      let requiredCoverageFromUtc = request.occurrence.startUtc;
      let requiredCoverageToUtc = request.occurrence.endUtc;
      for (const sourceResource of sharedRows) {
        const requestedOccupancy = occupancies.find((item) => item.resourceId === String(sourceResource.resource_id));
        if (!requestedOccupancy) continue;
        const sourceFromUtc = addMinutes(requestedOccupancy.startAtUtc,
          -(MAX_SOURCE_OCCURRENCE_MINUTES + Number(sourceResource.source_cleanup_minutes)));
        const sourceToUtc = addMinutes(requestedOccupancy.endAtUtc, Number(sourceResource.source_prepare_minutes));
        if (sourceFromUtc < requiredCoverageFromUtc) requiredCoverageFromUtc = sourceFromUtc;
        if (sourceToUtc > requiredCoverageToUtc) requiredCoverageToUtc = sourceToUtc;
      }
      return row.can_observe !== true || row.account_active !== true || row.revoked_at !== null
        || (row.delegated_until !== null && isoValue(row, "delegated_until") <= nowUtc)
        || row.health_account_id !== row.account_id
        || Number(row.health_account_version) !== Number(row.account_version)
        || Number(row.health_mapping_version) !== Number(row.mapping_version)
        || row.coverage_from === null || row.coverage_to === null || row.fresh_until === null
        || isoValue(row, "coverage_from") > requiredCoverageFromUtc
        || isoValue(row, "coverage_to") < requiredCoverageToUtc
        || isoValue(row, "fresh_until") <= nowUtc;
    });
    const reserved = reservationsByOccurrence.get(request.occurrence.id);
    const conflict = occupancies.some((occupancy) => (activeOccupanciesByResource.get(occupancy.resourceId) ?? []).some((row) =>
      !(String(row.product_id) === request.productId && String(row.occurrence_id) === request.occurrence.id)
      && isoValue(row, "end_at") > occupancy.startAtUtc && isoValue(row, "start_at") < occupancy.endAtUtc));
    let resourceGoogleUnavailable = false;
    let resourceGoogleBusy = false;
    for (const occupancy of occupancies) {
      const configured = resourceGoogleById.get(occupancy.resourceId);
      if (!configured || configured.enabled !== true) continue;
      const sameGeneration = configured.current_connection_generation !== null
        && Number(configured.current_connection_generation) === Number(configured.connection_generation);
      const covered = configured.coverage_start !== null && configured.coverage_end !== null
        && isoValue(configured, "coverage_start") <= occupancy.startAtUtc
        && isoValue(configured, "coverage_end") >= occupancy.endAtUtc;
      const fresh = sameGeneration && covered
        && effectiveGoogleSyncStatus(String(configured.sync_status) as "FRESH" | "STALE" | "FAILED",
          configured.fresh_until === null ? undefined : isoValue(configured, "fresh_until"), nowUtc) === "FRESH";
      if (!fresh) { resourceGoogleUnavailable = true; continue; }
      if ((resourceBusyById.get(occupancy.resourceId) ?? []).some((busy) => intervalsOverlap(
        { startUtc: occupancy.startAtUtc, endUtc: occupancy.endAtUtc }, busy,
      ))) resourceGoogleBusy = true;
    }
    const rangeStart = addMinutes(request.occurrence.startUtc, -request.occurrence.busyBufferBeforeMinutes);
    const rangeEnd = addMinutes(request.occurrence.endUtc, request.occurrence.busyBufferAfterMinutes);
    const covered = google?.coverageStartUtc !== undefined && google.coverageEndUtc !== undefined
      && google.coverageStartUtc <= rangeStart && google.coverageEndUtc >= rangeEnd;
    const syncStatus = google === undefined ? "STALE" : covered
      ? effectiveGoogleSyncStatus(google.syncStatus, google.freshUntilUtc, nowUtc) : "STALE";
    const bookingMode = modeByProduct.get(request.productId) ?? "SEAT";
    const availability = evaluateAvailability({
      occurrence: request.occurrence,
      requestedSeats: request.requestedSeats,
      confirmedSeats: Number(reserved?.confirmed ?? 0),
      heldSeats: Number(reserved?.held ?? 0),
      nowUtc,
      googleCalendar: { blockingEnabled: google?.blockingEnabled ?? false, syncStatus, busyIntervals: allBusyIntervals },
      sharedInventory: {
        bookingMode,
        activeGroupCount: Number(reserved?.groups ?? 0),
        hasInactiveResource: resourceRows.some((row) => row.active !== true),
        hasResourceConflict: conflict,
        hasResourceGoogleUnavailable: resourceGoogleUnavailable,
        hasResourceGoogleBusy: resourceGoogleBusy,
      },
    });
    results.set(request.occurrence.id, {
      bookingMode, occupancies,
      availability: unresolved.rows.length > 0 && availability.bookable
        ? { ...availability, bookable: false, availableSeats: 0, reason: "EXTERNAL_RESERVATION_UNRESOLVED" }
        : reservationReadUnavailable && availability.bookable
          ? { ...availability, bookable: false, availableSeats: 0, reason: "EXTERNAL_RESERVATION_READ_UNAVAILABLE" }
        : availability,
    });
  }
  return results;
}

export async function persistBookingInventorySnapshot(
  client: PoolClient,
  input: {
    readonly providerId: string;
    readonly bookingId: number;
    readonly occurrence: Occurrence;
    readonly bookingMode: BookingMode;
    readonly occupancies: readonly InventoryOccupancySnapshot[];
  },
): Promise<void> {
  await client.query(
    `INSERT INTO booking_inventory_snapshots
       (provider_id,booking_id,booking_mode,occurrence_start_at,occurrence_end_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [input.providerId, input.bookingId, input.bookingMode, input.occurrence.startUtc, input.occurrence.endUtc],
  );
  for (const occupancy of input.occupancies) {
    await client.query(
      `INSERT INTO booking_resource_occupancies
         (provider_id,booking_id,resource_id,resource_kind,prepare_minutes,cleanup_minutes,start_at,end_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [input.providerId, input.bookingId, occupancy.resourceId, occupancy.resourceKind,
        occupancy.prepareMinutes, occupancy.cleanupMinutes, occupancy.startAtUtc, occupancy.endAtUtc],
    );
  }
}
