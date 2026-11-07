import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import { parseGuideContent, type GuideContent } from "./guides.ts";

const ARTICLE_ID = "legacy-guide-kamakura-after-4-pm";
const IMPORT_LOCK = "niho-experience:legacy-guide:kamakura-after-4-pm";
const INITIAL_CATEGORY = Object.freeze({
  slug: "evenings",
  label_en: "Evenings",
  label_ja: "夕方・夜",
  display_order: 20,
  revision: 1,
});

export interface LegacyGuideSource {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly author: { readonly name: string; readonly role: string; readonly bio?: string };
  readonly publishedAt: string;
  readonly updatedAt: string;
  readonly checkedAt?: string;
  readonly body: string;
  readonly faq?: readonly { readonly question: string; readonly answer: string }[];
  readonly relatedExperienceSlugs: readonly string[];
}

export interface LegacyGuideImportInput {
  readonly providerId: string;
  readonly ownerId: string;
  readonly categorySlug: string;
  readonly source: LegacyGuideSource;
  readonly dryRun: boolean;
}

export interface LegacyGuideImportResult {
  readonly outcome: "imported" | "verified";
  readonly dryRun: boolean;
  readonly linkedPublishedExperienceCount: number;
}

export class LegacyGuideImportError extends Error {
  override readonly name = "LegacyGuideImportError";
}

function requiredIdentifier(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new LegacyGuideImportError(`${name} is missing or invalid.`);
  }
  return normalized;
}

export function legacyGuideContent(source: LegacyGuideSource): GuideContent {
  const faq = source.faq?.length
    ? `\n\n## Frequently asked questions\n\n${source.faq.map(({ question, answer }) => `### ${question}\n\n${answer}`).join("\n\n")}`
    : "";
  return parseGuideContent({
    language: "en",
    markdown: `${source.body.trim()}${faq}`,
    author: {
      name: source.author.name,
      role: source.author.role,
      bio: source.author.bio ?? source.author.role,
    },
    checkedOn: source.checkedAt ?? source.updatedAt,
  });
}

function publicationTime(source: LegacyGuideSource): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(source.publishedAt)) {
    throw new LegacyGuideImportError("The legacy guide publication date is invalid.");
  }
  const value = new Date(`${source.publishedAt}T00:00:00.000Z`);
  if (Number.isNaN(value.valueOf()) || value.toISOString().slice(0, 10) !== source.publishedAt) {
    throw new LegacyGuideImportError("The legacy guide publication date is invalid.");
  }
  return value.toISOString();
}

type ExistingRow = {
  id: string;
  slug: string;
  creator_niho_user_id: string;
  subject_provider_id: string;
  category_slug: string;
  title: string;
  description: string;
  content: unknown;
  status: string;
  revision: string | number;
  current_publication_id: string | number | null;
  publication_number: string | number | null;
  source_revision: string | number | null;
  visibility: string | null;
  published_by_niho_user_id: string | null;
  published_at: Date | string | null;
  sealed: boolean | null;
  publication_count: string | number;
  reservation_count: string | number;
  link_count: string | number;
};

function numberValue(value: string | number | null): number {
  return typeof value === "number" ? value : value === null ? Number.NaN : Number(value);
}

async function existingImport(client: PoolClient, source: LegacyGuideSource): Promise<ExistingRow | undefined> {
  const result = await client.query<ExistingRow>(
    `SELECT a.id,a.slug,a.creator_niho_user_id,a.subject_provider_id,a.category_slug,
            a.title,a.description,a.content,a.status,a.revision,a.current_publication_id,
            p.publication_number,p.source_revision,p.visibility,p.published_by_niho_user_id,
            p.published_at,p.sealed,
            (SELECT count(*) FROM guide_publications all_p WHERE all_p.article_id=a.id) AS publication_count,
            (SELECT count(*) FROM guide_legacy_slug_reservations r WHERE r.slug=$2) AS reservation_count,
            (SELECT count(*) FROM guide_publication_product_links l WHERE l.publication_id=p.id) AS link_count
       FROM guide_articles a
       LEFT JOIN guide_publications p ON p.id=a.current_publication_id AND p.article_id=a.id
      WHERE a.id=$1 OR a.slug=$2
      FOR UPDATE OF a`,
    [ARTICLE_ID, source.slug],
  );
  if (result.rows.length > 1) throw new LegacyGuideImportError("The legacy guide identity conflicts with existing articles.");
  return result.rows[0];
}

function verifyExisting(row: ExistingRow, input: LegacyGuideImportInput, content: GuideContent, publishedAt: string): number {
  const matches = row.id === ARTICLE_ID
    && row.slug === input.source.slug
    && row.creator_niho_user_id === input.ownerId
    && row.subject_provider_id === input.providerId
    && row.category_slug === input.categorySlug
    && row.title === input.source.title
    && row.description === input.source.description
    && isDeepStrictEqual(row.content, content)
    && row.status === "PUBLISHED"
    && numberValue(row.revision) === 2
    && row.current_publication_id !== null
    && numberValue(row.publication_number) === 1
    && numberValue(row.source_revision) === 1
    && row.visibility === "UNLISTED"
    && row.published_by_niho_user_id === input.ownerId
    && row.published_at !== null
    && new Date(row.published_at).toISOString() === publishedAt
    && row.sealed === true
    && numberValue(row.publication_count) === 1
    && numberValue(row.reservation_count) === 0;
  if (!matches) {
    throw new LegacyGuideImportError("An existing guide conflicts with the expected immutable legacy import; nothing was changed.");
  }
  return numberValue(row.link_count);
}

async function requireOwnerAndCategory(client: PoolClient, input: LegacyGuideImportInput): Promise<{
  label_en: string; label_ja: string; display_order: number;
}> {
  const owner = await client.query(
    `SELECT 1 FROM provider_memberships
      WHERE provider_id=$1 AND niho_user_id=$2 AND active=true AND role='OWNER'
      FOR SHARE`,
    [input.providerId, input.ownerId],
  );
  if (owner.rows[0] === undefined) throw new LegacyGuideImportError("The supplied actor is not a current active OWNER of the supplied provider.");
  const category = await client.query<{
    label_en: string; label_ja: string; display_order: number; active: boolean;
  }>(
    `SELECT label_en,label_ja,display_order,active FROM guide_categories
      WHERE slug=$1 FOR UPDATE`,
    [input.categorySlug],
  );
  const existing = category.rows[0];
  if (existing !== undefined) {
    if (!existing.active) {
      throw new LegacyGuideImportError("The supplied guide category exists but is inactive; nothing was changed.");
    }
    return existing;
  }
  if (input.categorySlug !== INITIAL_CATEGORY.slug) {
    throw new LegacyGuideImportError("Only the missing evenings category may be initialized by this legacy import.");
  }
  const initialized = await client.query<{ label_en: string; label_ja: string; display_order: number }>(
    `INSERT INTO guide_categories
       (slug,label_en,label_ja,display_order,active,revision)
     VALUES ($1,$2,$3,$4,true,$5)
     RETURNING label_en,label_ja,display_order`,
    [INITIAL_CATEGORY.slug, INITIAL_CATEGORY.label_en, INITIAL_CATEGORY.label_ja,
      INITIAL_CATEGORY.display_order, INITIAL_CATEGORY.revision],
  );
  return initialized.rows[0]!;
}

async function currentPublishedProducts(
  client: PoolClient,
  input: LegacyGuideImportInput,
): Promise<readonly { id: string; slug: string }[]> {
  if (input.source.relatedExperienceSlugs.length === 0) return [];
  const result = await client.query<{ id: string; slug: string }>(
    `SELECT product.id,publication.slug
       FROM experience_products product
       JOIN experience_product_publication_states state
         ON state.provider_id=product.provider_id AND state.product_id=product.id
       JOIN experience_product_publications publication
         ON publication.id=state.current_publication_id
        AND publication.provider_id=product.provider_id AND publication.product_id=product.id
      WHERE product.provider_id=$1 AND product.status='PUBLISHED'
        AND publication.slug=ANY($2::text[])
        AND state.self_stopped_at IS NULL
        AND state.operations_suspended_at IS NULL
        AND state.owner_resume_required=false
      ORDER BY array_position($2::text[],publication.slug),product.id
      FOR SHARE OF product,state,publication`,
    [input.providerId, [...new Set(input.source.relatedExperienceSlugs)]],
  );
  return result.rows;
}

export async function importLegacyGuide(pool: Pool, rawInput: LegacyGuideImportInput): Promise<LegacyGuideImportResult> {
  const input: LegacyGuideImportInput = {
    ...rawInput,
    providerId: requiredIdentifier(rawInput.providerId, "GUIDE_IMPORT_PROVIDER_ID"),
    ownerId: requiredIdentifier(rawInput.ownerId, "GUIDE_IMPORT_OWNER_ID"),
    categorySlug: requiredIdentifier(rawInput.categorySlug, "GUIDE_IMPORT_CATEGORY_SLUG"),
  };
  if (input.source.slug !== "kamakura-after-4-pm") {
    throw new LegacyGuideImportError("This importer accepts only the reserved legacy guide.");
  }
  if (input.categorySlug !== INITIAL_CATEGORY.slug) {
    throw new LegacyGuideImportError("This legacy guide import requires GUIDE_IMPORT_CATEGORY_SLUG=evenings.");
  }
  const content = legacyGuideContent(input.source);
  const publishedAt = publicationTime(input.source);
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [IMPORT_LOCK]);
    const category = await requireOwnerAndCategory(client, input);
    const existing = await existingImport(client, input.source);
    if (existing !== undefined) {
      const count = verifyExisting(existing, input, content, publishedAt);
      await client.query("ROLLBACK");
      return { outcome: "verified", dryRun: input.dryRun, linkedPublishedExperienceCount: count };
    }

    const reservation = await client.query(
      "DELETE FROM guide_legacy_slug_reservations WHERE slug=$1 RETURNING slug",
      [input.source.slug],
    );
    if (reservation.rows[0] === undefined) {
      throw new LegacyGuideImportError("The reserved legacy slug is missing; nothing was imported.");
    }
    const products = await currentPublishedProducts(client, input);
    await client.query(
      `INSERT INTO guide_articles (
         id,slug,creator_niho_user_id,subject_kind,subject_provider_id,category_slug,
         title,description,content,status,revision,created_at,updated_at
       ) VALUES ($1,$2,$3,'PROVIDER',$4,$5,$6,$7,$8::jsonb,'DRAFT',1,$9::timestamptz,$9::timestamptz)`,
      [ARTICLE_ID, input.source.slug, input.ownerId, input.providerId, input.categorySlug,
        input.source.title, input.source.description, JSON.stringify(content), publishedAt],
    );
    for (const [index, product] of products.entries()) {
      await client.query(
        `INSERT INTO guide_draft_product_links (article_id,provider_id,product_id,display_order)
         VALUES ($1,$2,$3,$4)`,
        [ARTICLE_ID, input.providerId, product.id, index + 1],
      );
    }
    const publication = await client.query<{ id: string | number }>(
      `INSERT INTO guide_publications (
         article_id,publication_number,source_revision,slug,subject_kind,subject_provider_id,
         category_slug,category_label_en,category_label_ja,category_display_order,
         title,description,content,visibility,published_by_niho_user_id,published_at
       ) VALUES ($1,1,1,$2,'PROVIDER',$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'UNLISTED',$11,$12::timestamptz)
       RETURNING id`,
      [ARTICLE_ID, input.source.slug, input.providerId, input.categorySlug, category.label_en,
        category.label_ja, category.display_order, input.source.title, input.source.description,
        JSON.stringify(content), input.ownerId, publishedAt],
    );
    const publicationId = publication.rows[0]!.id;
    for (const [index, product] of products.entries()) {
      await client.query(
        `INSERT INTO guide_publication_product_links (
           article_id,publication_id,provider_id,product_id,display_order,
           link_created_by_niho_user_id,permission_basis
         ) VALUES ($1,$2,$3,$4,$5,$6,'PROVIDER_MEMBERSHIP')`,
        [ARTICLE_ID, publicationId, input.providerId, product.id, index + 1, input.ownerId],
      );
    }
    await client.query("UPDATE guide_publications SET sealed=true WHERE id=$1", [publicationId]);
    await client.query(
      `UPDATE guide_articles
          SET status='PUBLISHED',current_publication_id=$2,revision=2,updated_at=$3::timestamptz
        WHERE id=$1`,
      [ARTICLE_ID, publicationId, publishedAt],
    );
    if (input.dryRun) await client.query("ROLLBACK");
    else await client.query("COMMIT");
    return { outcome: "imported", dryRun: input.dryRun, linkedPublishedExperienceCount: products.length };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* the original safe error is more useful */ }
    if (error instanceof LegacyGuideImportError) throw error;
    throw new LegacyGuideImportError("The legacy guide import failed; no changes were committed.");
  } finally {
    client.release();
  }
}
