import type { Pool } from "pg";
import { StoreError, StoreValidationError } from "./errors.ts";
import { withTransaction } from "./transaction.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ClaimedProviderMediaCleanup {
  readonly assetId: string;
  readonly objectKey: string;
}

function boundedLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new StoreValidationError("provider media cleanup limit must be an integer from 1 to 20.");
  }
  return limit;
}

function claimedRow(row: Record<string, unknown>): ClaimedProviderMediaCleanup {
  if (typeof row.asset_id !== "string" || !UUID.test(row.asset_id) || typeof row.object_key !== "string") {
    throw new StoreError("Database returned an invalid provider media cleanup claim.");
  }
  return { assetId: row.asset_id, objectKey: row.object_key };
}

/** Durable cleanup state for revoked provider media. Audit rows are never removed. */
export class ProviderMediaCleanupRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) { this.#pool = pool; }

  /**
   * Records the attempt in the same transaction that claims the rows. A crashed worker can claim them again;
   * `cleanup_attempted_at NULLS FIRST` keeps a repeatedly failing row from starving never-attempted rows.
   */
  async claim(limit = 20): Promise<readonly ClaimedProviderMediaCleanup[]> {
    const count = boundedLimit(limit);
    return withTransaction(this.#pool, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `WITH candidates AS (
           SELECT asset.id
             FROM experience_provider_media_assets asset
            WHERE asset.state='REVOKED'
              AND asset.object_deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM experience_provider_media_selection selection
                 WHERE selection.asset_id=asset.id
              )
            ORDER BY asset.cleanup_attempted_at NULLS FIRST,asset.imported_at,asset.id
            LIMIT $1
            FOR UPDATE OF asset SKIP LOCKED
         )
         UPDATE experience_provider_media_assets asset
            SET cleanup_attempted_at=clock_timestamp()
           FROM candidates
          WHERE asset.id=candidates.id
            AND asset.state='REVOKED'
            AND asset.object_deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM experience_provider_media_selection selection
               WHERE selection.asset_id=asset.id
            )
         RETURNING asset.id::text AS asset_id,asset.object_key`,
        [count],
      );
      return result.rows.map(claimedRow);
    });
  }

  /** Marks the physical deletion complete only while the same revoked, unselected asset is still eligible. */
  async complete(claim: ClaimedProviderMediaCleanup): Promise<boolean> {
    if (!UUID.test(claim.assetId) || typeof claim.objectKey !== "string" || claim.objectKey.length === 0) {
      throw new StoreValidationError("provider media cleanup claim is invalid.");
    }
    const result = await this.#pool.query(
      `UPDATE experience_provider_media_assets asset
          SET object_deleted_at=clock_timestamp()
        WHERE asset.id=$1::uuid
          AND asset.object_key=$2
          AND asset.state='REVOKED'
          AND asset.cleanup_attempted_at IS NOT NULL
          AND asset.object_deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM experience_provider_media_selection selection
             WHERE selection.asset_id=asset.id
          )`,
      [claim.assetId, claim.objectKey],
    );
    return result.rowCount === 1;
  }
}
