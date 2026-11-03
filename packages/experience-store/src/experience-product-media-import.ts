import type { Pool } from "pg";
import { StoreConflictError, StoreNotFoundError, StoreValidationError } from "./errors.ts";
import { lockProviderInventory } from "./inventory.ts";
import { withTransaction } from "./transaction.ts";
import { assertStoreIdentifier } from "./validation.ts";

export interface ImportedExperienceProductMedia {
  readonly assetId: string;
  readonly sourcePosition: number;
  /** Private bucket key for a normalized JPEG under experience-products/. */
  readonly objectKey: string;
  /** Keyed hash of the source media reference; never the raw source object key. */
  readonly sourceRefHash: string;
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
  readonly altText: string;
  readonly publicCredit: string | null;
  readonly rightsConfirmed: true;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OBJECT_KEY = /^experience-products\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$/i;
const SHA256 = /^[0-9a-f]{64}$/;

function validate(input: ImportedExperienceProductMedia): ImportedExperienceProductMedia {
  if (!input || typeof input !== "object") throw new StoreValidationError("media must be an object.");
  if (!UUID_V4.test(input.assetId)) throw new StoreValidationError("media.assetId must be a UUID v4.");
  if (!Number.isInteger(input.sourcePosition) || input.sourcePosition < 0 || input.sourcePosition > 19) throw new StoreValidationError("media.sourcePosition must be between 0 and 19.");
  if (!OBJECT_KEY.test(input.objectKey)) throw new StoreValidationError("media.objectKey must be an opaque normalized JPEG key.");
  if (!SHA256.test(input.sourceRefHash)) throw new StoreValidationError("media.sourceRefHash must be a keyed SHA-256 digest.");
  if (!Number.isInteger(input.width) || input.width < 1 || input.width > 2400
      || !Number.isInteger(input.height) || input.height < 1 || input.height > 2400
      || !Number.isInteger(input.byteSize) || input.byteSize < 1 || input.byteSize > 10 * 1024 * 1024) {
    throw new StoreValidationError("media dimensions or size are invalid.");
  }
  if (typeof input.altText !== "string" || input.altText.length > 500 || /[\u0000-\u001f\u007f]/.test(input.altText)) {
    throw new StoreValidationError("media.altText is invalid.");
  }
  if (input.publicCredit !== null && (typeof input.publicCredit !== "string" || input.publicCredit.trim().length < 1
      || input.publicCredit.length > 300 || /[\u0000-\u001f\u007f]/.test(input.publicCredit))) {
    throw new StoreValidationError("media.publicCredit is invalid.");
  }
  if (input.rightsConfirmed !== true) throw new StoreValidationError("media rights must be confirmed before import.");
  return input;
}

/** Migration-identity writer; the runtime cannot import or replace source media. */
export class ExperienceProductMediaImport {
  readonly #pool: Pool;

  constructor(pool: Pool) { this.#pool = pool; }

  async register(input: {
    readonly providerId: string;
    readonly productId: string;
    readonly expectedProductVersion: number;
    readonly media: readonly ImportedExperienceProductMedia[];
  }): Promise<readonly string[]> {
    assertStoreIdentifier(input.providerId, "providerId");
    assertStoreIdentifier(input.productId, "productId");
    if (!Number.isSafeInteger(input.expectedProductVersion) || input.expectedProductVersion < 1) {
      throw new StoreValidationError("expectedProductVersion must be positive.");
    }
    if (!Array.isArray(input.media) || input.media.length < 1 || input.media.length > 20) {
      throw new StoreValidationError("media must contain 1-20 assets.");
    }
    const assets = input.media.map(validate).sort((left, right) => left.sourcePosition - right.sourcePosition);
    if (new Set(assets.map(({ sourcePosition }) => sourcePosition)).size !== assets.length
        || new Set(assets.map(({ assetId }) => assetId)).size !== assets.length
        || new Set(assets.map(({ sourceRefHash }) => sourceRefHash)).size !== assets.length
        || assets.some((asset, index) => asset.sourcePosition !== index)) {
      throw new StoreValidationError("media positions must be contiguous from zero, and asset IDs and source hashes must be unique.");
    }
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, input.providerId);
      const product = await client.query<{ version: string | number }>(
        "SELECT version FROM experience_products WHERE provider_id=$1 AND id=$2 FOR SHARE",
        [input.providerId, input.productId],
      );
      if (!product.rows[0]) throw new StoreNotFoundError("product");
      if (Number(product.rows[0].version) !== input.expectedProductVersion) throw new StoreConflictError("Product draft version changed before media import.");
      const existing = await client.query(
        `SELECT 1 FROM experience_product_publication_states
          WHERE provider_id=$1 AND product_id=$2 AND current_publication_id IS NOT NULL`,
        [input.providerId, input.productId],
      );
      if (existing.rows.length > 0) throw new StoreConflictError("Media must be imported before the first publication.");
      for (const asset of assets) {
        await client.query(
          `INSERT INTO experience_product_media_assets
             (id,provider_id,product_id,source_position,object_key,source_ref_hash,width,height,byte_size,
              alt_text,public_credit,rights_confirmed_at)
           VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp())`,
          [asset.assetId, input.providerId, input.productId, asset.sourcePosition, asset.objectKey,
            asset.sourceRefHash, asset.width, asset.height, asset.byteSize, asset.altText, asset.publicCredit],
        );
      }
      return assets.map(({ assetId }) => assetId);
    });
  }
}
