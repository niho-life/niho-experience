import { addMinutes, evaluateAvailability, type AvailabilityResult, type BusyInterval, type Occurrence } from "@niho-experience/experience-domain";
import type { Pool, PoolClient } from "pg";
import { googleCalendarFromRow, isoValue, type DbRow } from "./rows.ts";
import type { BookingMode, InventoryResourceKind } from "./types.ts";
import { effectiveGoogleSyncStatus } from "./validation.ts";

type Queryable = Pool | PoolClient;

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

/** The first lock for every inventory mutation. Keep later locks in idempotency -> product -> occurrence order. */
export async function lockProviderInventory(client: PoolClient, providerId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 31))", [`provider-inventory:${providerId}`]);
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
  const reservations = await client.query<DbRow>(
    `SELECT occurrence_id,
            COALESCE(sum(seats) FILTER (WHERE status='CONFIRMED'),0)::text AS confirmed,
            COALESCE(sum(seats) FILTER (WHERE status='HOLD' AND hold_expires_at>$3),0)::text AS held,
            count(*) FILTER (WHERE status='CONFIRMED' OR (status='HOLD' AND hold_expires_at>$3))::text AS groups
       FROM bookings WHERE provider_id=$1 AND occurrence_id=ANY($2::text[]) GROUP BY occurrence_id`,
    [providerId, occurrenceIds, nowUtc],
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
        AND (b.status='CONFIRMED' OR (b.status='HOLD' AND b.hold_expires_at>$5))`,
    [providerId, resourceIds, addMinutes(overallStart, -1_440), addMinutes(overallEnd, 1_440), nowUtc],
  );
  const activeOccupanciesByResource = new Map<string, DbRow[]>();
  for (const row of activeOccupancies.rows) {
    const resourceId = String(row.resource_id);
    activeOccupanciesByResource.set(resourceId, [...(activeOccupanciesByResource.get(resourceId) ?? []), row]);
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
    const occupancies = resourceRows.map((row): InventoryOccupancySnapshot => ({
      resourceId: String(row.resource_id),
      resourceKind: String(row.kind) as InventoryResourceKind,
      prepareMinutes: Number(row.prepare_minutes),
      cleanupMinutes: Number(row.cleanup_minutes),
      startAtUtc: addMinutes(request.occurrence.startUtc, -Number(row.prepare_minutes)),
      endAtUtc: addMinutes(request.occurrence.endUtc, Number(row.cleanup_minutes)),
    }));
    const reserved = reservationsByOccurrence.get(request.occurrence.id);
    const conflict = occupancies.some((occupancy) => (activeOccupanciesByResource.get(occupancy.resourceId) ?? []).some((row) =>
      !(String(row.product_id) === request.productId && String(row.occurrence_id) === request.occurrence.id)
      && isoValue(row, "end_at") > occupancy.startAtUtc && isoValue(row, "start_at") < occupancy.endAtUtc));
    const rangeStart = addMinutes(request.occurrence.startUtc, -request.occurrence.busyBufferBeforeMinutes);
    const rangeEnd = addMinutes(request.occurrence.endUtc, request.occurrence.busyBufferAfterMinutes);
    const covered = google?.coverageStartUtc !== undefined && google.coverageEndUtc !== undefined
      && google.coverageStartUtc <= rangeStart && google.coverageEndUtc >= rangeEnd;
    const syncStatus = google === undefined ? "STALE" : covered
      ? effectiveGoogleSyncStatus(google.syncStatus, google.freshUntilUtc, nowUtc) : "STALE";
    const bookingMode = modeByProduct.get(request.productId) ?? "SEAT";
    results.set(request.occurrence.id, {
      bookingMode,
      occupancies,
      availability: evaluateAvailability({
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
        },
      }),
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
