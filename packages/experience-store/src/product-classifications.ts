import type { Pool } from "pg";
import { EMPTY_EXPERIENCE_CLASSIFICATION, parseExperienceClassification, type ExperienceClassification } from "@niho-experience/experience-domain";
import { StoreAccessDeniedError, StoreConflictError, StoreNotFoundError, StoreValidationError } from "./errors.ts";
import { VISIBLE_PUBLICATIONS_CTE } from "./public-publication-scope.ts";
import { calendarMembershipRole } from "./product-calendar-authorization.ts";
import type { DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import type { HostActor } from "./types.ts";
import { assertStoreIdentifier } from "./validation.ts";

/*
 * 商品の分類 (#529): category, area, だれと and こんな日に of a product, kept apart from the publication (it can be changed
 * at once by the product's OWNER or NIHO's office, and an unclassified product simply has no row). docs/product-classification.md.
 */

const BULK_LIMIT = 300;

export interface AdminProductClassificationRow {
  readonly providerId: string;
  readonly productId: string;
  readonly slug: string;
  readonly title: string;
  readonly status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  readonly classification: ExperienceClassification;
}

/** The public site's read: a published product's classification by its slug (only slugs that belong to one product). */
export type PublicClassificationBySlug = ReadonlyMap<string, ExperienceClassification>;

function fromRow(row: DbRow | undefined): ExperienceClassification {
  if (!row || row.category === undefined) return EMPTY_EXPERIENCE_CLASSIFICATION;
  const parsed = parseExperienceClassification({
    category: row.category ?? null, area: row.area ?? null,
    companions: Array.isArray(row.companions) ? row.companions : [], occasions: Array.isArray(row.occasions) ? row.occasions : [],
  });
  return parsed ?? EMPTY_EXPERIENCE_CLASSIFICATION;
}

function checked(value: unknown): ExperienceClassification {
  const parsed = parseExperienceClassification(value);
  if (!parsed) throw new StoreValidationError("classification is invalid.");
  return parsed;
}

export class ProductClassificationRepository {
  readonly #pool: Pool;
  constructor(pool: Pool) { this.#pool = pool; }

  /** The product's OWNER reads it. */
  async readForOwner(actor: HostActor, productId: string): Promise<ExperienceClassification> {
    assertStoreIdentifier(actor?.providerId, "actor.providerId");
    assertStoreIdentifier(actor?.nihoUserId, "actor.nihoUserId");
    assertStoreIdentifier(productId, "productId");
    return withTransaction(this.#pool, async (client) => {
      if (await calendarMembershipRole(client, actor, ["OWNER"]) !== "OWNER") throw new StoreAccessDeniedError();
      const found = await client.query<DbRow>(
        `SELECT p.id, c.category, c.area, c.companions, c.occasions
           FROM experience_products p
           LEFT JOIN experience_product_classifications c ON c.provider_id = p.provider_id AND c.product_id = p.id
          WHERE p.provider_id = $1 AND p.id = $2`,
        [actor.providerId, productId],
      );
      if (!found.rows[0]) throw new StoreNotFoundError("product");
      return fromRow(found.rows[0]);
    });
  }

  /** The product's OWNER sets it (a whole value, not a patch). */
  async saveForOwner(actor: HostActor, productId: string, value: unknown): Promise<ExperienceClassification> {
    assertStoreIdentifier(actor?.providerId, "actor.providerId");
    assertStoreIdentifier(actor?.nihoUserId, "actor.nihoUserId");
    assertStoreIdentifier(productId, "productId");
    const classification = checked(value);
    return withTransaction(this.#pool, async (client) => {
      if (await calendarMembershipRole(client, actor, ["OWNER"]) !== "OWNER") throw new StoreAccessDeniedError();
      await this.#lock(client, actor.providerId, productId);
      await this.#upsert(client, actor.providerId, productId, classification, actor.nihoUserId, false);
      return classification;
    });
  }

  /** The office reads every product that is not archived, to set them together. */
  async adminList(actor: { readonly nihoUserId: string }): Promise<readonly AdminProductClassificationRow[]> {
    assertStoreIdentifier(actor?.nihoUserId, "actor.nihoUserId");
    const rows = await this.#pool.query<DbRow>(
      `SELECT p.provider_id, p.id, p.slug, p.public_title, p.status, c.category, c.area, c.companions, c.occasions
         FROM experience_products p
         LEFT JOIN experience_product_classifications c ON c.provider_id = p.provider_id AND c.product_id = p.id
        WHERE p.status <> 'ARCHIVED'
        ORDER BY (p.status = 'PUBLISHED') DESC, p.provider_id COLLATE "C", p.slug COLLATE "C"
        LIMIT 1000`,
    );
    return rows.rows.map((row) => ({
      providerId: String(row.provider_id), productId: String(row.id), slug: String(row.slug), title: String(row.public_title),
      status: row.status as AdminProductClassificationRow["status"], classification: fromRow(row),
    }));
  }

  /** The office reads one product's. */
  async adminRead(actor: { readonly nihoUserId: string }, providerId: string, productId: string): Promise<ExperienceClassification> {
    assertStoreIdentifier(actor?.nihoUserId, "actor.nihoUserId");
    assertStoreIdentifier(providerId, "providerId");
    assertStoreIdentifier(productId, "productId");
    const found = await this.#pool.query<DbRow>(
      `SELECT p.id, c.category, c.area, c.companions, c.occasions
         FROM experience_products p
         LEFT JOIN experience_product_classifications c ON c.provider_id = p.provider_id AND c.product_id = p.id
        WHERE p.provider_id = $1 AND p.id = $2 AND p.status <> 'ARCHIVED'`,
      [providerId, productId],
    );
    if (!found.rows[0]) throw new StoreNotFoundError("product");
    return fromRow(found.rows[0]);
  }

  /**
   * The office sets many products at once, all or none. An item may carry `expected`: the value the caller read (運営の CLI,
   * #576). The product's current value must still be that, or nothing is saved (StoreConflictError): somebody changed it
   * meanwhile. Without `expected` the value is simply set, as the Admin screens do.
   */
  async adminSave(actor: { readonly nihoUserId: string }, items: readonly { readonly providerId: string; readonly productId: string; readonly classification: unknown; readonly expected?: unknown }[]): Promise<number> {
    assertStoreIdentifier(actor?.nihoUserId, "actor.nihoUserId");
    if (!Array.isArray(items) || items.length === 0 || items.length > BULK_LIMIT) throw new StoreValidationError(`items must hold 1-${BULK_LIMIT} products.`);
    const seen = new Set<string>();
    const prepared = items.map((item) => {
      assertStoreIdentifier(item?.providerId, "providerId");
      assertStoreIdentifier(item?.productId, "productId");
      const key = `${item.providerId}\u0000${item.productId}`;
      if (seen.has(key)) throw new StoreValidationError("a product appears twice.");
      seen.add(key);
      return { providerId: item.providerId, productId: item.productId, classification: checked(item.classification), expected: item.expected === undefined ? undefined : checked(item.expected) };
    // The same order every time, so two saves that share products cannot wait for each other.
    }).sort((a, b) => (a.providerId + "\u0000" + a.productId < b.providerId + "\u0000" + b.productId ? -1 : 1));
    return withTransaction(this.#pool, async (client) => {
      for (const item of prepared) {
        await this.#lock(client, item.providerId, item.productId);
        const found = await client.query<DbRow>(
          `SELECT p.id, c.category, c.area, c.companions, c.occasions
             FROM experience_products p
             LEFT JOIN experience_product_classifications c ON c.provider_id = p.provider_id AND c.product_id = p.id
            WHERE p.provider_id = $1 AND p.id = $2 AND p.status <> 'ARCHIVED'`,
          [item.providerId, item.productId],
        );
        if (!found.rows[0]) throw new StoreNotFoundError("product");
        if (item.expected !== undefined && JSON.stringify(fromRow(found.rows[0])) !== JSON.stringify(item.expected)) throw new StoreConflictError("The classification changed after it was read.");
        await this.#upsert(client, item.providerId, item.productId, item.classification, actor.nihoUserId, true);
      }
      return prepared.length;
    });
  }

  /** Serializes the writers of one product's classification for the transaction (a compare-and-set must not interleave with another save). */
  async #lock(client: { query: Pool["query"] }, providerId: string, productId: string): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`product-classification|${providerId}|${productId}`]);
  }

  async #upsert(client: { query: Pool["query"] }, providerId: string, productId: string, value: ExperienceClassification, by: string, admin: boolean): Promise<void> {
    await client.query(
      `INSERT INTO experience_product_classifications (provider_id, product_id, category, area, companions, occasions, updated_by, updated_by_admin)
       VALUES ($1, $2, $3, $4, $5::text[], $6::text[], $7, $8)
       ON CONFLICT (provider_id, product_id) DO UPDATE
          SET category = EXCLUDED.category, area = EXCLUDED.area, companions = EXCLUDED.companions, occasions = EXCLUDED.occasions,
              updated_by = EXCLUDED.updated_by, updated_by_admin = EXCLUDED.updated_by_admin, updated_at = clock_timestamp()`,
      [providerId, productId, value.category, value.area, [...value.companions], [...value.occasions], by, admin],
    );
  }

  /**
   * The classification of what the public catalog shows, by slug: the same visible publications every anonymous reader uses
   * (a stopped, suspended or unpublished product is not there, whatever its product status says). A slug of two is left out.
   */
  async listPublic(): Promise<PublicClassificationBySlug> {
    const rows = await this.#pool.query<DbRow>(
      `WITH ${VISIBLE_PUBLICATIONS_CTE}
       SELECT v.slug, c.category, c.area, c.companions, c.occasions,
              (SELECT count(*) FROM visible_publications d WHERE d.slug = v.slug) AS same_slug
         FROM visible_publications v
         JOIN experience_product_classifications c ON c.provider_id = v.provider_id AND c.product_id = v.product_id`,
    );
    const map = new Map<string, ExperienceClassification>();
    for (const row of rows.rows) if (Number(row.same_slug) === 1) map.set(String(row.slug), fromRow(row));
    return map;
  }
}
