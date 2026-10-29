import { createHash } from "node:crypto";
import type { Occurrence } from "@niho-experience/experience-domain";
import type { PoolClient } from "pg";
import type { ExternalReservationObservation } from "./channels.ts";
import { StoreConflictError } from "./errors.ts";
import { evaluateStoredInventory } from "./inventory.ts";
import { enqueueCalendarRecalculation } from "./inventory-outbox.ts";
import { isoValue, type DbRow } from "./rows.ts";

export interface ExternalReservationReadAuthority {
  readonly readId: string;
  readonly generation: number;
  readonly providerId: string;
  readonly accountId: string;
  readonly listingId: string;
  readonly productId: string;
  readonly targetSite: string;
  readonly targetExternalAccountId: string;
  readonly targetExternalProductId: string;
  readonly targetExternalOptionId: string;
}

export interface ExternalReservationCanonicalTarget {
  readonly occurrence: Occurrence;
}

export interface ExternalReservationApplyResult {
  readonly applied: number;
  readonly duplicates: number;
  readonly stale: number;
  readonly needsReview: number;
  readonly affectedOccurrences: ReadonlySet<string>;
}

function integer(row: DbRow, key: string): number {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value)) throw new StoreConflictError(`Database returned an invalid ${key}.`);
  return value;
}

function text(row: DbRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new StoreConflictError(`Database returned an invalid ${key}.`);
  return value;
}

export function externalReservationObservationFingerprint(observation: ExternalReservationObservation): string {
  return createHash("sha256").update(JSON.stringify(observation), "utf8").digest("hex");
}

/**
 * Applies already validated canonical reservation facts inside the caller's
 * provider-inventory transaction. Both occurrence and window reads use this
 * single ledger/inventory implementation.
 */
export async function applyExternalReservationObservations(
  client: PoolClient,
  authority: ExternalReservationReadAuthority,
  observations: readonly ExternalReservationObservation[],
  resolveTarget: (observation: ExternalReservationObservation) => Promise<ExternalReservationCanonicalTarget | null>,
  nowIso: () => string,
): Promise<ExternalReservationApplyResult> {
  const affectedOccurrences = new Set<string>();
  let applied = 0;
  let duplicates = 0;
  let stale = 0;
  let needsReview = 0;

  for (const observation of observations) {
    const externalOptionId = observation.externalOptionId ?? "";
    const observationFingerprint = externalReservationObservationFingerprint(observation);
    const key: [string, string, string] = [authority.targetSite, authority.targetExternalAccountId, observation.externalReservationId];
    const ledgerResult = await client.query<DbRow>(
      `SELECT * FROM external_reservations
        WHERE source_site=$1 AND source_external_account_id=$2 AND external_reservation_id=$3 FOR UPDATE`, key,
    );
    let ledger = ledgerResult.rows[0];
    let disposition: "APPLIED" | "DUPLICATE" | "STALE" | "NEEDS_REVIEW" = "APPLIED";
    let reviewReason: string | null = null;
    if (ledger && integer(ledger, "last_read_generation") >= authority.generation) disposition = "STALE";
    if (disposition === "APPLIED" && ledger?.source_updated_at !== null && ledger?.source_updated_at !== undefined
      && observation.sourceUpdatedAtUtc !== undefined) {
      const previousUpdated = isoValue(ledger, "source_updated_at");
      if (observation.sourceUpdatedAtUtc < previousUpdated) disposition = "STALE";
      else if (observation.sourceUpdatedAtUtc === previousUpdated) {
        disposition = ledger.current_fingerprint === observationFingerprint ? "DUPLICATE" : "NEEDS_REVIEW";
        if (disposition === "NEEDS_REVIEW") reviewReason = "CONFLICTING_SOURCE_VERSION";
      }
    }
    if (disposition === "APPLIED" && ledger?.current_fingerprint === observationFingerprint) disposition = "DUPLICATE";
    if (disposition === "APPLIED" && observation.sourceRevision !== undefined
      && ledger?.source_revision === observation.sourceRevision) {
      disposition = "NEEDS_REVIEW";
      reviewReason = "CONFLICTING_SOURCE_VERSION";
    }
    const target = observation.externalProductId === authority.targetExternalProductId
      && externalOptionId === authority.targetExternalOptionId ? await resolveTarget(observation) : null;
    // A fresh exact read can resolve a previous bad target/source observation.
    if (disposition === "DUPLICATE" && target && (ledger?.occurrence_id === null
      || (ledger?.needs_review === true && ["TARGET_MISMATCH", "CONFLICTING_SOURCE_VERSION"].includes(String(ledger.review_reason))))) disposition = "APPLIED";
    if (disposition !== "STALE" && !target) {
      disposition = "NEEDS_REVIEW";
      reviewReason = "TARGET_MISMATCH";
    }

    if (disposition === "STALE" || disposition === "DUPLICATE") {
      if (!ledger) throw new StoreConflictError("Reservation ordering state is invalid.");
      if (disposition === "DUPLICATE") {
        await client.query(
          `UPDATE external_reservations SET last_read_generation=GREATEST(last_read_generation,$4),updated_at=$5
            WHERE source_site=$1 AND source_external_account_id=$2 AND external_reservation_id=$3`,
          [...key, authority.generation, nowIso()],
        );
        duplicates += 1;
      } else stale += 1;
      await client.query(
        `INSERT INTO external_reservation_revisions
          (source_site,source_external_account_id,external_reservation_id,read_id,read_generation,local_revision,
           external_product_id,external_option_id,source_start_at,source_end_at,seats,status,source_updated_at,source_revision,
           observation_fingerprint,disposition,review_reason)
         VALUES ($1,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NULL)`,
        [...key, authority.readId, authority.generation, integer(ledger, "local_revision"), observation.externalProductId, externalOptionId,
          observation.sourceStartAtUtc, observation.sourceEndAtUtc, observation.seats, observation.status,
          observation.sourceUpdatedAtUtc ?? null, observation.sourceRevision ?? null, observationFingerprint, disposition],
      );
      continue;
    }

    if (disposition === "NEEDS_REVIEW") {
      if (!ledger) {
        const inserted = await client.query<DbRow>(
          `INSERT INTO external_reservations
            (source_site,source_external_account_id,external_reservation_id,provider_id,account_id,listing_id,product_id,occurrence_id,
             external_product_id,external_option_id,source_start_at,source_end_at,seats,status,local_revision,source_updated_at,
             source_revision,last_read_generation,current_fingerprint,needs_review,review_reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9,$10,$11,$12,$13,1,$14,$15,$16,$17,true,$18)
           RETURNING *`,
          [...key, authority.providerId, authority.accountId, authority.listingId, authority.productId, observation.externalProductId, externalOptionId,
            observation.sourceStartAtUtc, observation.sourceEndAtUtc, observation.seats, observation.status,
            observation.sourceUpdatedAtUtc ?? null, observation.sourceRevision ?? null, authority.generation, observationFingerprint, reviewReason],
        );
        ledger = inserted.rows[0]!;
      } else {
        await client.query(
          `UPDATE external_reservations SET needs_review=true,review_reason=$4,updated_at=$5,
             last_read_generation=GREATEST(last_read_generation,$6)
            WHERE source_site=$1 AND source_external_account_id=$2 AND external_reservation_id=$3`,
          [...key, reviewReason, nowIso(), authority.generation],
        );
      }
      await client.query(
        `INSERT INTO external_reservation_revisions
          (source_site,source_external_account_id,external_reservation_id,read_id,read_generation,local_revision,
           external_product_id,external_option_id,source_start_at,source_end_at,seats,status,source_updated_at,source_revision,
           observation_fingerprint,disposition,review_reason)
         VALUES ($1,$2,$3,$4::uuid,$5,NULL,$6,$7,$8,$9,$10,$11,$12,$13,$14,'NEEDS_REVIEW',$15)`,
        [...key, authority.readId, authority.generation, observation.externalProductId, externalOptionId, observation.sourceStartAtUtc,
          observation.sourceEndAtUtc, observation.seats, observation.status, observation.sourceUpdatedAtUtc ?? null,
          observation.sourceRevision ?? null, observationFingerprint, reviewReason],
      );
      needsReview += 1;
      continue;
    }

    if (!target) throw new StoreConflictError("Reservation target resolution is invalid.");
    const occurrence = target.occurrence;
    const oldOccurrenceId = ledger?.occurrence_id === null || ledger?.occurrence_id === undefined ? undefined : text(ledger, "occurrence_id");
    const localRevision = ledger === undefined ? 1 : integer(ledger, "local_revision") + 1;
    const inventory = await evaluateStoredInventory(client, authority.providerId, authority.productId, occurrence, nowIso(), observation.seats);
    const active = observation.status === "PENDING" || observation.status === "CONFIRMED";
    let inventoryConflict = false;
    if (active) {
      const direct = await client.query<DbRow>(
        `SELECT COALESCE(sum(seats),0)::text AS seats,count(*)::text AS groups FROM bookings
          WHERE provider_id=$1 AND occurrence_id=$2
            AND (status='CONFIRMED' OR (status='HOLD' AND hold_expires_at>$3))`,
        [authority.providerId, occurrence.id, nowIso()],
      );
      const external = await client.query<DbRow>(
        `SELECT COALESCE(sum(seats),0)::text AS seats,count(*)::text AS groups FROM external_reservations
          WHERE provider_id=$1 AND occurrence_id=$2 AND status IN ('PENDING','CONFIRMED')
            AND NOT (source_site=$3 AND source_external_account_id=$4 AND external_reservation_id=$5)`,
        [authority.providerId, occurrence.id, ...key],
      );
      const directSeats = Number(direct.rows[0]?.seats ?? 0);
      const externalSeats = Number(external.rows[0]?.seats ?? 0);
      const otherGroups = Number(direct.rows[0]?.groups ?? 0) + Number(external.rows[0]?.groups ?? 0);
      inventoryConflict = inventory.bookingMode === "PRIVATE_GROUP"
        ? otherGroups > 0
        : directSeats + externalSeats + observation.seats > occurrence.capacity;
      const resourceIds = inventory.occupancies.map((occupancy) => occupancy.resourceId);
      if (!inventoryConflict && resourceIds.length > 0) {
        const collision = await client.query(
          `WITH requested AS (
             SELECT * FROM unnest($2::text[],$3::timestamptz[],$4::timestamptz[]) AS r(resource_id,start_at,end_at)
           )
           SELECT 1 FROM booking_resource_occupancies o
             JOIN requested r ON r.resource_id=o.resource_id AND o.end_at>r.start_at AND o.start_at<r.end_at
             JOIN bookings b ON b.provider_id=o.provider_id AND b.id=o.booking_id
            WHERE o.provider_id=$1
              AND (b.status='CONFIRMED' OR (b.status='HOLD' AND b.hold_expires_at>$5))
              AND NOT (b.product_id=$9 AND b.occurrence_id=$10)
           UNION ALL
           SELECT 1 FROM external_reservation_resource_occupancies o
             JOIN requested r ON r.resource_id=o.resource_id AND o.end_at>r.start_at AND o.start_at<r.end_at
             JOIN external_reservations e ON e.source_site=o.source_site
              AND e.source_external_account_id=o.source_external_account_id AND e.external_reservation_id=o.external_reservation_id
              AND e.local_revision=o.local_revision
            WHERE o.provider_id=$1 AND e.status IN ('PENDING','CONFIRMED')
              AND NOT (e.source_site=$6 AND e.source_external_account_id=$7 AND e.external_reservation_id=$8)
              AND NOT (e.product_id=$9 AND e.occurrence_id=$10)
           LIMIT 1`,
          [authority.providerId, resourceIds, inventory.occupancies.map((item) => item.startAtUtc),
            inventory.occupancies.map((item) => item.endAtUtc), nowIso(), ...key, authority.productId, occurrence.id],
        );
        inventoryConflict = collision.rows[0] !== undefined;
      }
    }
    const ledgerValues = [...key, authority.providerId, authority.accountId, authority.listingId, authority.productId, occurrence.id,
      observation.externalProductId, externalOptionId, observation.sourceStartAtUtc, observation.sourceEndAtUtc,
      observation.seats, observation.status, localRevision, observation.sourceUpdatedAtUtc ?? null,
      observation.sourceRevision ?? null, authority.generation, observationFingerprint, inventoryConflict, inventoryConflict ? "INVENTORY_CONFLICT" : null];
    await client.query(
      `INSERT INTO external_reservations
        (source_site,source_external_account_id,external_reservation_id,provider_id,account_id,listing_id,product_id,occurrence_id,
         external_product_id,external_option_id,source_start_at,source_end_at,seats,status,local_revision,source_updated_at,
         source_revision,last_read_generation,current_fingerprint,needs_review,review_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       ON CONFLICT (source_site,source_external_account_id,external_reservation_id) DO UPDATE SET
         provider_id=EXCLUDED.provider_id,account_id=EXCLUDED.account_id,listing_id=EXCLUDED.listing_id,product_id=EXCLUDED.product_id,
         occurrence_id=EXCLUDED.occurrence_id,external_product_id=EXCLUDED.external_product_id,external_option_id=EXCLUDED.external_option_id,
         source_start_at=EXCLUDED.source_start_at,source_end_at=EXCLUDED.source_end_at,seats=EXCLUDED.seats,status=EXCLUDED.status,
         local_revision=EXCLUDED.local_revision,source_updated_at=EXCLUDED.source_updated_at,source_revision=EXCLUDED.source_revision,
         last_read_generation=EXCLUDED.last_read_generation,current_fingerprint=EXCLUDED.current_fingerprint,
         needs_review=EXCLUDED.needs_review,review_reason=EXCLUDED.review_reason,updated_at=clock_timestamp()`, ledgerValues,
    );
    await client.query(
      `INSERT INTO external_reservation_inventory_snapshots
        (source_site,source_external_account_id,external_reservation_id,local_revision,provider_id,product_id,occurrence_id,
         booking_mode,occurrence_start_at,occurrence_end_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [...key, localRevision, authority.providerId, authority.productId, occurrence.id, inventory.bookingMode, occurrence.startUtc, occurrence.endUtc],
    );
    for (const occupancy of inventory.occupancies) {
      await client.query(
        `INSERT INTO external_reservation_resource_occupancies
          (source_site,source_external_account_id,external_reservation_id,local_revision,provider_id,product_id,occurrence_id,
           resource_id,resource_kind,prepare_minutes,cleanup_minutes,start_at,end_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [...key, localRevision, authority.providerId, authority.productId, occurrence.id, occupancy.resourceId, occupancy.resourceKind,
          occupancy.prepareMinutes, occupancy.cleanupMinutes, occupancy.startAtUtc, occupancy.endAtUtc],
      );
    }
    await client.query(
      `INSERT INTO external_reservation_revisions
        (source_site,source_external_account_id,external_reservation_id,read_id,read_generation,local_revision,
         external_product_id,external_option_id,source_start_at,source_end_at,seats,status,source_updated_at,source_revision,
         observation_fingerprint,disposition,review_reason)
       VALUES ($1,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'APPLIED',$16)`,
      [...key, authority.readId, authority.generation, localRevision, observation.externalProductId, externalOptionId,
        observation.sourceStartAtUtc, observation.sourceEndAtUtc, observation.seats, observation.status,
        observation.sourceUpdatedAtUtc ?? null, observation.sourceRevision ?? null, observationFingerprint,
        inventoryConflict ? "INVENTORY_CONFLICT" : null],
    );
    if (oldOccurrenceId) affectedOccurrences.add(oldOccurrenceId);
    affectedOccurrences.add(occurrence.id);
    applied += 1;
    if (inventoryConflict) needsReview += 1;
  }

  for (const occurrenceId of affectedOccurrences) {
    await enqueueCalendarRecalculation(client, {
      providerId: authority.providerId, aggregateType: "schedule_occurrence", aggregateId: occurrenceId, cause: "external_reservation_changed",
    });
  }
  if (needsReview > 0) {
    await enqueueCalendarRecalculation(client, {
      providerId: authority.providerId, aggregateType: "provider_inventory", aggregateId: authority.providerId, cause: "external_reservation_review",
    });
  }
  return { applied, duplicates, stale, needsReview, affectedOccurrences };
}
