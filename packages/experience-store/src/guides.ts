import type { Pool, PoolClient } from "pg";
import { StoreValidationError } from "./errors.ts";
import { isoValue, type DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import { assertNonEmptyText } from "./validation.ts";

export type GuidePublicationVisibility = "PUBLIC" | "UNLISTED";
export type GuideMediaAssetState = "UPLOADING" | "READY" | "REVOKED";

export type GuideSubject =
  | { readonly kind: "WRITER" }
  | { readonly kind: "PROVIDER"; readonly providerId: string };

export interface GuideAuthor {
  readonly name: string;
  readonly role: string;
  readonly bio: string;
}

/** Markdown is stored and returned as Markdown. This store never accepts or returns rendered HTML. */
export interface GuideContent {
  readonly markdown: string;
  readonly author?: GuideAuthor;
  readonly checkedOn?: string;
}

export interface GuideCategory {
  readonly slug: string;
  readonly labelEn: string;
  readonly labelJa: string;
  readonly displayOrder: number;
}

export interface GuideMediaAssetRecord {
  readonly id: string;
  readonly articleId: string;
  readonly creatorNihoUserId: string;
  /** Private storage detail. Never serialize this record into a browser response. */
  readonly objectKey: string;
  readonly state: GuideMediaAssetState;
  readonly width?: number;
  readonly height?: number;
  readonly byteSize?: number;
  readonly publicCredit?: string;
  readonly webConfirmedAtUtc?: string;
  readonly webConfirmedByNihoUserId?: string;
}

export interface PublicGuideProductLink {
  readonly providerId: string;
  readonly productId: string;
  /** Current public slug, re-read with the product status for public catalogue intersection. */
  readonly productSlug: string;
}

export interface PublicGuideArticle {
  readonly articleId: string;
  readonly publicationId: number;
  readonly publicationNumber: number;
  readonly sourceRevision: number;
  readonly slug: string;
  readonly subject: GuideSubject;
  readonly category: GuideCategory;
  readonly title: string;
  readonly description: string;
  readonly content: GuideContent;
  readonly visibility: GuidePublicationVisibility;
  readonly indexable: boolean;
  readonly productLinks: readonly PublicGuideProductLink[];
  readonly cover?: PublicGuideCover;
  readonly figures: readonly PublicGuideFigure[];
  /** The first sealed publication time, including an earlier UNLISTED publication. */
  readonly firstPublishedAtUtc: string;
  /** The current publication time; a new publication is an article update. */
  readonly publishedAtUtc: string;
}

export interface PublicGuideCover {
  readonly assetId: string;
  readonly alt: string;
  readonly credit: string;
  readonly width: number;
  readonly height: number;
}

export interface PublicGuideFigure {
  readonly slot: number;
  readonly assetId: string;
  readonly alt: string;
  readonly credit: string;
}

const GUIDE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_MARKDOWN_LENGTH = 500_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLICATION_COLUMNS = `
  p.article_id, p.id AS publication_id, p.publication_number, p.source_revision,
  p.slug, p.subject_kind, p.subject_provider_id, p.category_slug,
  p.category_label_en, p.category_label_ja, p.category_display_order,
  p.title, p.description, p.content,
  p.visibility, p.published_at`;
const FIRST_PUBLICATION_COLUMN = `
  (SELECT min(first_publication.published_at)
     FROM guide_publications first_publication
    WHERE first_publication.article_id=p.article_id AND first_publication.sealed=true) AS first_published_at`;
const MEDIA_ASSET_COLUMNS = `
  id::text AS id, article_id, creator_niho_user_id, object_key, state,
  width, height, byte_size, public_credit, web_confirmed_at,
  web_confirmed_by_niho_user_id`;

function stringValue(row: DbRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new StoreValidationError(`Database returned an invalid ${key}.`);
  return value;
}

function optionalString(row: DbRow, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new StoreValidationError(`Database returned an invalid ${key}.`);
  return value;
}

function integerValue(row: DbRow, key: string): number {
  const value = row[key];
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) throw new StoreValidationError(`Database returned an invalid ${key}.`);
  return parsed;
}

function optionalIsoValue(row: DbRow, key: string): string | undefined {
  return row[key] === null || row[key] === undefined ? undefined : isoValue(row, key);
}

function validateSlug(slug: string): void {
  if (!GUIDE_SLUG.test(slug) || slug.length > 160) {
    throw new StoreValidationError("guide.slug must use 1-160 lower-case letters, digits, and single hyphens.");
  }
}

function validateAssetId(assetId: string): void {
  if (!UUID_V4.test(assetId)) throw new StoreValidationError("guide media assetId must be a UUID v4.");
}

function isCanonicalIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validateAuthor(value: unknown): GuideAuthor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StoreValidationError("guide.content.author must be an object.");
  }
  const author = value as Record<string, unknown>;
  if (Object.keys(author).some((key) => !["name", "role", "bio"].includes(key))) {
    throw new StoreValidationError("guide.content.author contains an unsupported field.");
  }
  const name = author.name;
  const role = author.role;
  const bio = author.bio;
  if (typeof name !== "string" || typeof role !== "string" || typeof bio !== "string") {
    throw new StoreValidationError("guide.content.author name, role, and bio must be strings.");
  }
  assertNonEmptyText(name, "guide.content.author.name", 120);
  assertNonEmptyText(role, "guide.content.author.role", 160);
  assertNonEmptyText(bio, "guide.content.author.bio", 500);
  return { name, role, bio };
}

export function parseGuideContent(value: unknown): GuideContent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StoreValidationError("guide.content must be a JSON object.");
  }
  const content = value as Record<string, unknown>;
  if (Object.keys(content).some((key) => !["markdown", "author", "checkedOn"].includes(key))) {
    throw new StoreValidationError("guide.content contains an unsupported field.");
  }
  if (typeof content.markdown !== "string" || content.markdown.length > MAX_MARKDOWN_LENGTH) {
    throw new StoreValidationError(`guide.content.markdown must be a string of at most ${MAX_MARKDOWN_LENGTH} characters.`);
  }
  const author = content.author === undefined ? undefined : validateAuthor(content.author);
  const checkedOn = content.checkedOn;
  if (checkedOn !== undefined && (typeof checkedOn !== "string" || !isCanonicalIsoDate(checkedOn))) {
    throw new StoreValidationError("guide.content.checkedOn must be an ISO date (YYYY-MM-DD).");
  }
  return {
    markdown: content.markdown,
    ...(author === undefined ? {} : { author }),
    ...(checkedOn === undefined ? {} : { checkedOn: checkedOn as string }),
  };
}

function subjectFromRow(row: DbRow): GuideSubject {
  const kind = stringValue(row, "subject_kind");
  if (kind === "WRITER") return { kind };
  if (kind === "PROVIDER") return { kind, providerId: stringValue(row, "subject_provider_id") };
  throw new StoreValidationError("Database returned an invalid guide subject.");
}

function publicArticleFromRow(
  row: DbRow,
  productLinks: readonly PublicGuideProductLink[],
  cover?: PublicGuideCover,
  figures: readonly PublicGuideFigure[] = [],
): PublicGuideArticle {
  const visibility = stringValue(row, "visibility") as GuidePublicationVisibility;
  const publishedAtUtc = isoValue(row, "published_at");
  return {
    articleId: stringValue(row, "article_id"),
    publicationId: integerValue(row, "publication_id"),
    publicationNumber: integerValue(row, "publication_number"),
    sourceRevision: integerValue(row, "source_revision"),
    slug: stringValue(row, "slug"),
    subject: subjectFromRow(row),
    category: {
      slug: stringValue(row, "category_slug"),
      labelEn: stringValue(row, "category_label_en"),
      labelJa: stringValue(row, "category_label_ja"),
      displayOrder: integerValue(row, "category_display_order"),
    },
    title: stringValue(row, "title"),
    description: stringValue(row, "description"),
    content: parseGuideContent(row.content),
    visibility,
    indexable: visibility === "PUBLIC",
    productLinks,
    ...(cover === undefined ? {} : { cover }),
    figures,
    firstPublishedAtUtc: optionalIsoValue(row, "first_published_at") ?? publishedAtUtc,
    publishedAtUtc,
  };
}

function mediaAssetFromRow(row: DbRow): GuideMediaAssetRecord {
  const width = row.width === null || row.width === undefined ? undefined : integerValue(row, "width");
  const height = row.height === null || row.height === undefined ? undefined : integerValue(row, "height");
  const byteSize = row.byte_size === null || row.byte_size === undefined ? undefined : integerValue(row, "byte_size");
  const publicCredit = optionalString(row, "public_credit");
  const webConfirmedAtUtc = optionalIsoValue(row, "web_confirmed_at");
  const webConfirmedByNihoUserId = optionalString(row, "web_confirmed_by_niho_user_id");
  return {
    id: stringValue(row, "id"),
    articleId: stringValue(row, "article_id"),
    creatorNihoUserId: stringValue(row, "creator_niho_user_id"),
    objectKey: stringValue(row, "object_key"),
    state: stringValue(row, "state") as GuideMediaAssetState,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...(byteSize === undefined ? {} : { byteSize }),
    ...(publicCredit === undefined ? {} : { publicCredit }),
    ...(webConfirmedAtUtc === undefined ? {} : { webConfirmedAtUtc }),
    ...(webConfirmedByNihoUserId === undefined ? {} : { webConfirmedByNihoUserId }),
  };
}

async function activePublicLinksByPublication(
  client: PoolClient,
  publicationIds: readonly number[],
): Promise<ReadonlyMap<number, readonly PublicGuideProductLink[]>> {
  const links = new Map<number, PublicGuideProductLink[]>();
  for (const publicationId of publicationIds) links.set(publicationId, []);
  if (publicationIds.length === 0) return links;
  const result = await client.query<DbRow>(
    `SELECT l.publication_id, l.provider_id, l.product_id, product.slug AS product_slug
       FROM guide_publication_product_links l
       JOIN experience_products product
         ON product.provider_id=l.provider_id AND product.id=l.product_id AND product.status='PUBLISHED'
      WHERE l.publication_id=ANY($1::bigint[])
        -- The public experience API exposes only a slug. If another product can
        -- resolve to that slug, the caller cannot prove which product its card
        -- represents. Hide the link until the slug identifies this exact product.
        AND NOT EXISTS (
          SELECT 1 FROM experience_products other_product
           WHERE other_product.slug=product.slug
             AND (other_product.provider_id, other_product.id)<>(l.provider_id, l.product_id)
        )
        AND (
          (l.permission_basis='PROVIDER_MEMBERSHIP' AND EXISTS (
            SELECT 1 FROM provider_memberships m
             WHERE m.provider_id=l.provider_id
               AND m.niho_user_id=l.link_created_by_niho_user_id
               AND m.active=true AND m.role IN ('OWNER','EDITOR')
          ))
          OR
          (l.permission_basis='GUIDE_PRODUCT_LINK_MEMBERSHIP' AND EXISTS (
            SELECT 1 FROM guide_product_link_memberships gm
             WHERE gm.provider_id=l.provider_id
               AND gm.niho_user_id=l.link_created_by_niho_user_id
               AND gm.active=true
          ) AND EXISTS (
            SELECT 1 FROM guide_product_link_invitations invitation
             WHERE invitation.provider_id=l.provider_id
               AND invitation.writer_niho_user_id=l.link_created_by_niho_user_id
               AND invitation.state='ACCEPTED'
          ) AND EXISTS (
            SELECT 1 FROM guide_writer_grants wg
             WHERE wg.niho_user_id=l.link_created_by_niho_user_id
               AND wg.active=true
          ))
        )
      ORDER BY l.publication_id, l.display_order NULLS LAST, l.provider_id, l.product_id`,
    [publicationIds],
  );
  for (const row of result.rows) {
    links.get(integerValue(row, "publication_id"))!.push({
      providerId: stringValue(row, "provider_id"),
      productId: stringValue(row, "product_id"),
      productSlug: stringValue(row, "product_slug"),
    });
  }
  return links;
}

type PublicGuideMedia = Readonly<{ cover?: PublicGuideCover; figures: readonly PublicGuideFigure[] }>;

async function activePublicMediaByPublication(
  client: PoolClient,
  publicationIds: readonly number[],
): Promise<ReadonlyMap<number, PublicGuideMedia>> {
  const mutable = new Map<number, { cover?: PublicGuideCover; figures: PublicGuideFigure[] }>();
  for (const publicationId of publicationIds) mutable.set(publicationId, { figures: [] });
  if (publicationIds.length === 0) return mutable;
  const result = await client.query<DbRow>(
    `SELECT media.publication_id, media.slot, media.placement,
            media.asset_id::text AS asset_id, media.alt_text, media.public_credit,
            asset.width, asset.height
       FROM guide_publication_media media
       JOIN guide_media_assets asset ON asset.id=media.asset_id AND asset.state='READY'
      WHERE media.publication_id=ANY($1::bigint[])
      ORDER BY media.publication_id, media.slot`,
    [publicationIds],
  );
  for (const row of result.rows) {
    const media = mutable.get(integerValue(row, "publication_id"))!;
    const placement = stringValue(row, "placement");
    if (placement === "COVER") {
      media.cover = {
        assetId: stringValue(row, "asset_id"),
        alt: stringValue(row, "alt_text"),
        credit: stringValue(row, "public_credit"),
        width: integerValue(row, "width"),
        height: integerValue(row, "height"),
      };
    } else if (placement === "FIGURE") {
      media.figures.push({
        slot: integerValue(row, "slot"),
        assetId: stringValue(row, "asset_id"),
        alt: stringValue(row, "alt_text"),
        credit: stringValue(row, "public_credit"),
      });
    } else {
      throw new StoreValidationError("Database returned an invalid guide media placement.");
    }
  }
  return mutable;
}

export class GuideRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async listActiveCategories(): Promise<readonly GuideCategory[]> {
    const result = await this.#pool.query<DbRow>(
      `SELECT slug, label_en, label_ja, display_order
         FROM guide_categories WHERE active=true ORDER BY display_order, slug`,
    );
    return result.rows.map((row) => ({
      slug: stringValue(row, "slug"),
      labelEn: stringValue(row, "label_en"),
      labelJa: stringValue(row, "label_ja"),
      displayOrder: integerValue(row, "display_order"),
    }));
  }

  async getPublicArticleBySlug(slug: string): Promise<PublicGuideArticle | null> {
    validateSlug(slug);
    return withTransaction(this.#pool, async (client) => {
      const result = await client.query<DbRow>(
        `SELECT ${PUBLICATION_COLUMNS}, ${FIRST_PUBLICATION_COLUMN}
           FROM guide_articles a
           JOIN guide_publications p ON p.id=a.current_publication_id AND p.article_id=a.id AND p.sealed=true
          WHERE a.status='PUBLISHED' AND p.slug=$1`,
        [slug],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      const publicationId = integerValue(row, "publication_id");
      const [links, media] = await Promise.all([
        activePublicLinksByPublication(client, [publicationId]),
        activePublicMediaByPublication(client, [publicationId]),
      ]);
      const articleMedia = media.get(publicationId)!;
      return publicArticleFromRow(
        row,
        links.get(publicationId)!,
        articleMedia.cover,
        articleMedia.figures,
      );
    });
  }

  async listPublicArticles(): Promise<readonly PublicGuideArticle[]> {
    return withTransaction(this.#pool, async (client) => {
      const result = await client.query<DbRow>(
        `SELECT ${PUBLICATION_COLUMNS}, ${FIRST_PUBLICATION_COLUMN}
           FROM guide_articles a
           JOIN guide_publications p ON p.id=a.current_publication_id AND p.article_id=a.id AND p.sealed=true
          WHERE a.status='PUBLISHED' AND p.visibility='PUBLIC'
          ORDER BY p.published_at DESC, p.id DESC`,
      );
      const publicationIds = result.rows.map((row) => integerValue(row, "publication_id"));
      const [links, media] = await Promise.all([
        activePublicLinksByPublication(client, publicationIds),
        activePublicMediaByPublication(client, publicationIds),
      ]);
      return result.rows.map((row) => {
        const publicationId = integerValue(row, "publication_id");
        const articleMedia = media.get(publicationId)!;
        return publicArticleFromRow(
          row,
          links.get(publicationId)!,
          articleMedia.cover,
          articleMedia.figures,
        );
      });
    });
  }

  /** Server-only lookup for the JPEG relay. Old publications and revoked assets deliberately return null. */
  async getPublicMediaAsset(assetId: string): Promise<GuideMediaAssetRecord | null> {
    validateAssetId(assetId);
    const result = await this.#pool.query<DbRow>(
      `SELECT ${MEDIA_ASSET_COLUMNS}
         FROM guide_media_assets
        WHERE id=$1::uuid AND state='READY'
          AND EXISTS (
            SELECT 1
              FROM guide_articles article
              JOIN guide_publications publication
                ON publication.id=article.current_publication_id
               AND publication.article_id=article.id
               AND publication.sealed=true
              JOIN guide_publication_media media
                ON media.publication_id=publication.id
               AND media.article_id=article.id
               AND media.asset_id=guide_media_assets.id
             WHERE article.id=guide_media_assets.article_id
               AND article.status='PUBLISHED'
          )
        LIMIT 1`,
      [assetId],
    );
    return result.rows[0] === undefined ? null : mediaAssetFromRow(result.rows[0]);
  }
}
