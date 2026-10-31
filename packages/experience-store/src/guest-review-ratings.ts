import type { Pool } from "pg";
import { StoreError } from "./errors.ts";
import { requireOwner } from "./guest-questions.ts";
import type { DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import type { HostActor } from "./types.ts";

/*
 * 体験の一覧's ★ (#108) for the provider's OWNER: each experience's shown reviews (migration 0027) counted and averaged
 * in the database, all of them (レビュー's list reads a page at a time, so it cannot sum them). Read only: the reviews
 * are written by GuestReviewRepository, which checks the OWNER the same way. The average is rounded as the experience
 * page's (GuestReviewRepository.listPublishedReviews).
 */

/** One experience's ★. */
export interface HostProductRating {
  readonly productId: string;
  /** The experience's public path: 体験の一覧 joins NIHO's pages to this site's products by it. */
  readonly slug: string;
  /** Its shown reviews (at least one). */
  readonly count: number;
  /** Their average to one decimal: "4.5". */
  readonly average: string;
}

function ratingFromRow(row: DbRow): HostProductRating {
  const count = Number(row.review_count);
  const average = typeof row.average === "string" ? row.average : "";
  if (typeof row.product_id !== "string" || typeof row.slug !== "string" || !Number.isSafeInteger(count) || count < 1 || !/^[1-5]\.\d$/.test(average)) {
    throw new StoreError("Database returned an invalid review rating.");
  }
  return { productId: row.product_id, slug: row.slug, count, average };
}

export class GuestReviewRatings {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /** Every experience of the provider with a shown review, by product id. OWNER only. */
  async byProduct(actor: HostActor): Promise<readonly HostProductRating[]> {
    return withTransaction(this.#pool, async (client) => {
      await requireOwner(client, actor);
      const result = await client.query<DbRow>(
        `SELECT p.id AS product_id, p.slug, count(*)::int AS review_count, round(avg(r.rating), 1)::text AS average
           FROM guest_reviews r
           JOIN experience_products p ON p.provider_id = r.provider_id AND p.id = r.product_id
          WHERE r.provider_id = $1 AND r.hidden_at IS NULL
          GROUP BY p.id, p.slug
          ORDER BY p.id`,
        [actor.providerId],
      );
      return result.rows.map(ratingFromRow);
    });
  }
}
