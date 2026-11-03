import type { Pool } from "pg";
import { StoreError, StoreValidationError } from "./errors.ts";
import type { DbRow } from "./rows.ts";

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const GUIDE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ArticleAuthorityCategory {
  readonly slug: string;
  readonly labelEn: string;
  readonly labelJa: string;
  readonly displayOrder: number;
  readonly revision: number;
}

export interface ArticleAuthorityCandidate {
  readonly providerId: string;
  readonly slug: string;
  readonly title: string;
  readonly providerName: string;
}

function stringValue(row: DbRow, key: string, max = 512): string {
  const value = row[key];
  if (typeof value !== "string" || !value || value.length > max) throw new StoreError(`Database returned an invalid ${key}.`);
  return value;
}

function integerValue(row: DbRow, key: string): number {
  const value = row[key];
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) throw new StoreError(`Database returned an invalid ${key}.`);
  return parsed;
}

function assertProviderId(value: string): void {
  if (!PROVIDER_ID.test(value)) throw new StoreValidationError("providerId is invalid.");
}

function assertUserId(value: string): void {
  if (!value || value.length > 256) throw new StoreValidationError("niho user id is invalid.");
}

function assertSlug(value: string): void {
  if (!GUIDE_SLUG.test(value) || value.length > 160) throw new StoreValidationError("slug is invalid.");
}

/** Current Store facts used by the article authority. It never reads the legacy guide grant tables. */
export class ArticleAuthorityRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async providerNameForOwner(providerId: string, ownerNihoUserId: string): Promise<string | null> {
    assertProviderId(providerId);
    assertUserId(ownerNihoUserId);
    const result = await this.pool.query<DbRow>(
      `SELECT min(p.seller_display_name) AS provider_name
         FROM experience_products p
         JOIN provider_memberships m
           ON m.provider_id=p.provider_id
          AND m.niho_user_id=$2
          AND m.role='OWNER'
          AND m.active
        WHERE p.provider_id=$1
          AND p.status='PUBLISHED'
        HAVING count(*) > 0`,
      [providerId, ownerNihoUserId],
    );
    return result.rows[0] ? stringValue(result.rows[0], "provider_name", 300) : null;
  }

  async listActiveCategories(): Promise<readonly ArticleAuthorityCategory[]> {
    const result = await this.pool.query<DbRow>(
      `SELECT slug, label_en, label_ja, display_order, revision
         FROM guide_categories
        WHERE active
        ORDER BY display_order, slug`,
    );
    return result.rows.map((row) => {
      const slug = stringValue(row, "slug", 160);
      const displayOrder = integerValue(row, "display_order");
      const revision = integerValue(row, "revision");
      assertSlug(slug);
      if (displayOrder < 0 || revision < 1) throw new StoreError("Database returned invalid category metadata.");
      return {
        slug,
        labelEn: stringValue(row, "label_en", 120),
        labelJa: stringValue(row, "label_ja", 120),
        displayOrder,
        revision,
      };
    });
  }

  async ownedProviderIds(ownerNihoUserId: string): Promise<readonly string[]> {
    assertUserId(ownerNihoUserId);
    const result = await this.pool.query<DbRow>(
      `SELECT DISTINCT m.provider_id
         FROM provider_memberships m
         JOIN experience_products p ON p.provider_id=m.provider_id AND p.status='PUBLISHED'
        WHERE m.niho_user_id=$1 AND m.role='OWNER' AND m.active
        ORDER BY m.provider_id`,
      [ownerNihoUserId],
    );
    return result.rows.map((row) => stringValue(row, "provider_id", 256));
  }

  async activeOwnerIds(providerIds: readonly string[]): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
    if (!providerIds.length) return new Map();
    if (providerIds.length > 32) throw new StoreValidationError("providerIds has too many entries.");
    providerIds.forEach(assertProviderId);
    const result = await this.pool.query<DbRow>(
      `SELECT provider_id, niho_user_id
         FROM provider_memberships
        WHERE provider_id=ANY($1::text[]) AND role='OWNER' AND active`,
      [providerIds],
    );
    const owners = new Map<string, Set<string>>();
    for (const row of result.rows) {
      const providerId = stringValue(row, "provider_id", 256);
      const nihoUserId = stringValue(row, "niho_user_id", 256);
      const current = owners.get(providerId) ?? new Set<string>();
      current.add(nihoUserId);
      owners.set(providerId, current);
    }
    return owners;
  }

  async listPublishedCandidates(input: Readonly<{ query?: string; afterSlug?: string; limit: number }>): Promise<readonly ArticleAuthorityCandidate[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 96) throw new StoreValidationError("limit is invalid.");
    if (input.afterSlug !== undefined) assertSlug(input.afterSlug);
    const query = input.query?.trim() ?? "";
    if (query.length > 100) throw new StoreValidationError("query is too long.");
    const result = await this.pool.query<DbRow>(
      `SELECT p.provider_id, p.slug, p.public_title, p.seller_display_name
         FROM experience_products p
        WHERE p.status='PUBLISHED'
          AND ($1::text='' OR p.public_title ILIKE '%' || $1 || '%' OR p.seller_display_name ILIKE '%' || $1 || '%')
          AND ($2::text IS NULL OR p.slug > $2)
          AND NOT EXISTS (
            SELECT 1
              FROM experience_products duplicate
             WHERE duplicate.status='PUBLISHED'
               AND duplicate.slug=p.slug
               AND duplicate.id<>p.id
          )
        ORDER BY p.slug, p.provider_id, p.id
        LIMIT $3`,
      [query, input.afterSlug ?? null, input.limit],
    );
    return result.rows.map((row) => {
      const providerId = stringValue(row, "provider_id", 256);
      const slug = stringValue(row, "slug", 160);
      assertProviderId(providerId);
      assertSlug(slug);
      return {
        providerId,
        slug,
        title: stringValue(row, "public_title", 300),
        providerName: stringValue(row, "seller_display_name", 300),
      };
    });
  }

  async publishedProductsBySlugs(slugs: readonly string[]): Promise<readonly ArticleAuthorityCandidate[]> {
    if (!slugs.length) return [];
    if (slugs.length > 32 || new Set(slugs).size !== slugs.length) throw new StoreValidationError("slugs is invalid.");
    slugs.forEach(assertSlug);
    const result = await this.pool.query<DbRow>(
      `SELECT p.provider_id, p.slug, p.public_title, p.seller_display_name
         FROM experience_products p
        WHERE p.status='PUBLISHED' AND p.slug=ANY($1::text[])
        ORDER BY p.slug, p.provider_id, p.id`,
      [slugs],
    );
    return result.rows.map((row) => {
      const providerId = stringValue(row, "provider_id", 256);
      const slug = stringValue(row, "slug", 160);
      assertProviderId(providerId);
      assertSlug(slug);
      return {
        providerId,
        slug,
        title: stringValue(row, "public_title", 300),
        providerName: stringValue(row, "seller_display_name", 300),
      };
    });
  }
}
