import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { StoreConflictError, StoreNotFoundError, StoreValidationError } from "./errors.ts";
import { lockProviderInventory } from "./inventory.ts";
import { materializeAndLockOccurrence } from "./repository.ts";
import type { DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import { assertStoreIdentifier } from "./validation.ts";

export interface LegacyConfirmedReservationInput {
  /** A keyed SHA-256 of the legacy reservation identity. Raw reservation IDs and guest data are forbidden. */
  readonly sourceRefHash: string;
  readonly sourceRevision: number;
  readonly occurrenceId: string;
  readonly seats: number;
}

export interface ExperienceProductCutoverState {
  readonly providerId: string;
  readonly productId: string;
  readonly phase: "LEGACY_STOPPED" | "HOLDS_DRAINED" | "INVENTORY_IMPORTED" | "EXPERIENCE_ACTIVE" | "EXPERIENCE_STOPPED";
  readonly legacySalesStoppedAtUtc: string;
  readonly legacyHoldsDrainedAtUtc: string | null;
  readonly inventoryImportBatchId: string | null;
  readonly importedReservationCount: number | null;
  readonly importedSeatCount: number | null;
  readonly inventoryImportManifestSha256: string | null;
  readonly experienceSalesStartedAtUtc: string | null;
  readonly experienceSalesStoppedAtUtc: string | null;
  readonly version: number;
  readonly updatedAtUtc: string;
}

const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RESERVATIONS = 20_000;

function integer(value: unknown, field: string, minimum = 0): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new StoreValidationError(`${field} must be an integer of at least ${minimum}.`);
  return parsed;
}

function iso(row: DbRow, field: string): string | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (date === null || !Number.isFinite(date.getTime())) throw new StoreValidationError(`Database returned an invalid ${field}.`);
  return date.toISOString();
}

function stateFromRow(row: DbRow): ExperienceProductCutoverState {
  const started = iso(row, "experience_sales_started_at");
  const stopped = iso(row, "experience_sales_stopped_at");
  const holdsDrained = iso(row, "legacy_holds_drained_at");
  const batchId = row.inventory_import_batch_id === null ? null : String(row.inventory_import_batch_id);
  const phase = stopped !== null ? "EXPERIENCE_STOPPED"
    : started !== null ? "EXPERIENCE_ACTIVE"
      : batchId !== null ? "INVENTORY_IMPORTED"
        : holdsDrained !== null ? "HOLDS_DRAINED"
          : "LEGACY_STOPPED";
  return {
    providerId: String(row.provider_id),
    productId: String(row.product_id),
    phase,
    legacySalesStoppedAtUtc: iso(row, "legacy_sales_stopped_at")!,
    legacyHoldsDrainedAtUtc: holdsDrained,
    inventoryImportBatchId: batchId,
    importedReservationCount: row.imported_reservation_count === null ? null : integer(row.imported_reservation_count, "imported_reservation_count"),
    importedSeatCount: row.imported_seat_count === null ? null : integer(row.imported_seat_count, "imported_seat_count"),
    inventoryImportManifestSha256: row.inventory_import_manifest_sha256 === null ? null : String(row.inventory_import_manifest_sha256),
    experienceSalesStartedAtUtc: started,
    experienceSalesStoppedAtUtc: stopped,
    version: integer(row.version, "version", 1),
    updatedAtUtc: iso(row, "updated_at")!,
  };
}

function validateIdentity(providerId: string, productId: string): void {
  assertStoreIdentifier(providerId, "providerId");
  assertStoreIdentifier(productId, "productId");
}

function normalizedReservations(input: readonly LegacyConfirmedReservationInput[]): LegacyConfirmedReservationInput[] {
  if (!Array.isArray(input) || input.length > MAX_RESERVATIONS) throw new StoreValidationError(`reservations must have at most ${MAX_RESERVATIONS} rows.`);
  const rows = input.map((reservation, index) => {
    if (!reservation || typeof reservation !== "object") throw new StoreValidationError(`reservations[${index}] must be an object.`);
    assertStoreIdentifier(reservation.occurrenceId, `reservations[${index}].occurrenceId`);
    if (!HASH.test(reservation.sourceRefHash)) throw new StoreValidationError(`reservations[${index}].sourceRefHash must be a keyed SHA-256 hex digest.`);
    const sourceRevision = integer(reservation.sourceRevision, `reservations[${index}].sourceRevision`, 1);
    const seats = integer(reservation.seats, `reservations[${index}].seats`, 1);
    if (seats > 1000) throw new StoreValidationError(`reservations[${index}].seats exceeds the supported inventory range.`);
    return { sourceRefHash: reservation.sourceRefHash, sourceRevision, occurrenceId: reservation.occurrenceId, seats };
  }).sort((left, right) => left.sourceRefHash.localeCompare(right.sourceRefHash));
  if (new Set(rows.map((row) => row.sourceRefHash)).size !== rows.length) throw new StoreValidationError("reservations must not repeat a sourceRefHash.");
  return rows;
}

export function legacyInventoryManifestSha256(reservations: readonly LegacyConfirmedReservationInput[]): string {
  const canonical = normalizedReservations(reservations);
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

export class ExperienceSalesCutover {
  readonly #pool: Pool;

  constructor(pool: Pool) { this.#pool = pool; }

  /** Call only after NIHO has stopped this product's legacy sale. */
  async recordLegacySalesStopped(providerId: string, productId: string): Promise<ExperienceProductCutoverState> {
    validateIdentity(providerId, productId);
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, providerId);
      const result = await client.query<DbRow>(
        `INSERT INTO experience_product_cutovers (provider_id,product_id,legacy_sales_stopped_at)
         VALUES ($1,$2,clock_timestamp())
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [providerId, productId],
      );
      if (!result.rows[0]) throw new StoreConflictError("The product already has a cutover record.");
      return stateFromRow(result.rows[0]);
    });
  }

  /** Call only after every pending legacy hold has expired or been reconciled. */
  async recordLegacyHoldsDrained(providerId: string, productId: string, expectedVersion: number): Promise<ExperienceProductCutoverState> {
    validateIdentity(providerId, productId);
    integer(expectedVersion, "expectedVersion", 1);
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, providerId);
      const result = await client.query<DbRow>(
        `UPDATE experience_product_cutovers
            SET legacy_holds_drained_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
          WHERE provider_id=$1 AND product_id=$2 AND version=$3 AND legacy_holds_drained_at IS NULL
            AND inventory_import_batch_id IS NULL
          RETURNING *`,
        [providerId, productId, expectedVersion],
      );
      if (!result.rows[0]) throw new StoreConflictError("Cutover version mismatch or legacy holds are not in the expected phase.");
      return stateFromRow(result.rows[0]);
    });
  }

  /**
   * Imports only confirmed future seat counts, with no guest data. The batch and
   * its hash are immutable so a rerun must first reread the cutover state.
   */
  async importConfirmedInventory(input: {
    readonly providerId: string;
    readonly productId: string;
    readonly expectedVersion: number;
    readonly reservations: readonly LegacyConfirmedReservationInput[];
  }): Promise<ExperienceProductCutoverState> {
    validateIdentity(input.providerId, input.productId);
    integer(input.expectedVersion, "expectedVersion", 1);
    const reservations = normalizedReservations(input.reservations);
    const manifest = legacyInventoryManifestSha256(reservations);
    const batchId = randomUUID();
    const seatCount = reservations.reduce((sum, row) => sum + row.seats, 0);
    if (!Number.isSafeInteger(seatCount)) throw new StoreValidationError("Imported seat count exceeds the supported range.");
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, input.providerId);
      const cutover = await client.query<DbRow>(
        "SELECT * FROM experience_product_cutovers WHERE provider_id=$1 AND product_id=$2 FOR UPDATE",
        [input.providerId, input.productId],
      );
      const current = cutover.rows[0];
      if (!current) throw new StoreNotFoundError("product cutover");
      if (Number(current.version) !== input.expectedVersion || current.legacy_holds_drained_at === null || current.inventory_import_batch_id !== null) {
        throw new StoreConflictError("Cutover version mismatch or confirmed inventory import is not in the expected phase.");
      }
      const occurrenceIds = [...new Set(reservations.map((row) => row.occurrenceId))];
      if (occurrenceIds.length > 0) {
        // A newly migrated schedule may not have materialized calendar rows
        // yet. Derive each imported future occurrence from its stored rule and
        // overrides inside this transaction before checking its identity.
        for (const occurrenceId of occurrenceIds) {
          await materializeAndLockOccurrence(client, input.providerId, input.productId, occurrenceId);
        }
        const occurrences = await client.query(
          `SELECT occurrence_id FROM schedule_occurrences
            WHERE provider_id=$1 AND product_id=$2 AND occurrence_id=ANY($3::text[])
              AND end_at > clock_timestamp()`,
          [input.providerId, input.productId, occurrenceIds],
        );
        if (occurrences.rows.length !== occurrenceIds.length) throw new StoreValidationError("Every imported reservation must reference a future occurrence of this product.");
      }
      for (const reservation of reservations) {
        await client.query(
          `INSERT INTO experience_legacy_reservation_inventory
             (provider_id,product_id,occurrence_id,source_ref_hash,source_revision,seats,status,import_batch_id)
           VALUES ($1,$2,$3,$4,$5,$6,'CONFIRMED',$7)`,
          [input.providerId, input.productId, reservation.occurrenceId, reservation.sourceRefHash,
            reservation.sourceRevision, reservation.seats, batchId],
        );
        await client.query(
          `INSERT INTO experience_legacy_reservation_inventory_current (provider_id,source_ref_hash,source_revision)
           VALUES ($1,$2,$3)`,
          [input.providerId, reservation.sourceRefHash, reservation.sourceRevision],
        );
      }
      const updated = await client.query<DbRow>(
        `UPDATE experience_product_cutovers
            SET inventory_import_batch_id=$4::uuid,imported_reservation_count=$5,imported_seat_count=$6,
                inventory_import_manifest_sha256=$7,version=version+1,updated_at=clock_timestamp()
          WHERE provider_id=$1 AND product_id=$2 AND version=$3
          RETURNING *`,
        [input.providerId, input.productId, input.expectedVersion, batchId, reservations.length, seatCount, manifest],
      );
      if (!updated.rows[0]) throw new StoreConflictError("Cutover version changed during inventory import.");
      return stateFromRow(updated.rows[0]);
    });
  }

  /** New checkout opens last, after publication, readiness and the imported inventory are all current. */
  async enableExperienceSales(providerId: string, productId: string, expectedVersion: number): Promise<ExperienceProductCutoverState> {
    validateIdentity(providerId, productId);
    integer(expectedVersion, "expectedVersion", 1);
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, providerId);
      const result = await client.query<DbRow>(
        `UPDATE experience_product_cutovers cut
            SET experience_sales_started_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
          WHERE cut.provider_id=$1 AND cut.product_id=$2 AND cut.version=$3
            AND cut.legacy_holds_drained_at IS NOT NULL AND cut.inventory_import_batch_id IS NOT NULL
            AND cut.experience_sales_started_at IS NULL AND cut.experience_sales_stopped_at IS NULL
            AND EXISTS (
              SELECT 1 FROM experience_product_publication_states s
              JOIN experience_product_publications p ON p.id=s.current_publication_id
              JOIN provider_publication_readiness r ON r.provider_id=s.provider_id
              WHERE s.provider_id=cut.provider_id AND s.product_id=cut.product_id
                AND s.self_stopped_at IS NULL AND s.operations_suspended_at IS NULL
                AND s.owner_resume_required=false AND r.account_usable=true AND r.connect_ready=true
                AND r.seller_display_ready=true AND r.observed_at <= clock_timestamp()
                AND r.valid_until > clock_timestamp()
                AND r.valid_until <= r.observed_at + interval '10 minutes'
                AND r.required_consent_version=p.consent_version
                AND r.seller_niho_account_ref=p.seller_niho_account_ref
                AND r.stripe_connect_account_ref=p.stripe_connect_account_ref
                AND r.seller_display_name=p.seller_display_name
                AND EXISTS (SELECT 1 FROM provider_memberships m WHERE m.provider_id=r.provider_id
                  AND m.niho_user_id=r.owner_niho_user_id AND m.role='OWNER' AND m.active=true)
            )
          RETURNING *`,
        [providerId, productId, expectedVersion],
      );
      if (!result.rows[0]) throw new StoreConflictError("Cutover cannot open Experience sales until publication, readiness and inventory are complete.");
      return stateFromRow(result.rows[0]);
    });
  }

  /** Rollback closes Experience checkout first; it never reopens NIHO sales. */
  async stopExperienceSales(providerId: string, productId: string, expectedVersion: number): Promise<ExperienceProductCutoverState> {
    validateIdentity(providerId, productId);
    integer(expectedVersion, "expectedVersion", 1);
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, providerId);
      const result = await client.query<DbRow>(
        `UPDATE experience_product_cutovers
            SET experience_sales_stopped_at=COALESCE(experience_sales_stopped_at,clock_timestamp()),
                version=version+1,updated_at=clock_timestamp()
          WHERE provider_id=$1 AND product_id=$2 AND version=$3 AND experience_sales_started_at IS NOT NULL
          RETURNING *`,
        [providerId, productId, expectedVersion],
      );
      if (!result.rows[0]) throw new StoreConflictError("Cutover version mismatch or Experience sales are not active.");
      return stateFromRow(result.rows[0]);
    });
  }

  async getState(providerId: string, productId: string): Promise<ExperienceProductCutoverState | null> {
    validateIdentity(providerId, productId);
    const result = await this.#pool.query<DbRow>(
      "SELECT * FROM experience_product_cutovers WHERE provider_id=$1 AND product_id=$2",
      [providerId, productId],
    );
    return result.rows[0] ? stateFromRow(result.rows[0]) : null;
  }
}
