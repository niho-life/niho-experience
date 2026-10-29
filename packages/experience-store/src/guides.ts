import type { Pool, PoolClient } from "pg";
import {
  StoreAccessDeniedError,
  StoreConflictError,
  StoreNotFoundError,
  StoreValidationError,
} from "./errors.ts";
import { isoValue, type DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import { assertNonEmptyText, assertStoreIdentifier } from "./validation.ts";

export type GuideArticleStatus = "DRAFT" | "PUBLISHED" | "STOPPED";
export type GuidePublicationVisibility = "PUBLIC" | "UNLISTED";
export type GuideLinkPermissionBasis = "PROVIDER_MEMBERSHIP" | "GUIDE_PRODUCT_LINK_MEMBERSHIP";

export interface GuideActor {
  readonly nihoUserId: string;
}

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

export interface CreateGuideArticleInput {
  readonly id: string;
  readonly slug: string;
  readonly subject: GuideSubject;
  readonly title: string;
  readonly description?: string;
  readonly categorySlug?: string;
  readonly content?: GuideContent;
}

export interface SaveGuideDraftInput {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly categorySlug?: string;
  readonly content: GuideContent;
}

export interface GuideArticleRecord {
  readonly id: string;
  readonly slug: string;
  readonly creatorNihoUserId: string;
  readonly subject: GuideSubject;
  readonly title: string;
  readonly description: string;
  readonly categorySlug?: string;
  readonly content: GuideContent;
  readonly status: GuideArticleStatus;
  readonly revision: number;
  readonly currentPublication?: {
    readonly id: number;
    readonly number: number;
    readonly visibility: GuidePublicationVisibility;
    readonly publishedAtUtc: string;
  };
  readonly createdAtUtc: string;
  readonly updatedAtUtc: string;
}

export interface GuideProductLinkInput {
  readonly providerId: string;
  readonly productId: string;
}

export interface CommitGuidePublicationInput {
  readonly expectedRevision: number;
  readonly visibility: GuidePublicationVisibility;
  readonly productLinks: readonly GuideProductLinkInput[];
}

export interface PublicGuideProductLink {
  readonly providerId: string;
  readonly productId: string;
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
  readonly publishedAtUtc: string;
}

const GUIDE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_MARKDOWN_LENGTH = 500_000;
const ARTICLE_COLUMNS = `
  a.id, a.slug, a.creator_niho_user_id, a.subject_kind, a.subject_provider_id,
  a.category_slug, a.title, a.description, a.content, a.status, a.revision,
  a.created_at, a.updated_at, p.id AS current_publication_id,
  p.publication_number AS current_publication_number,
  p.visibility AS current_publication_visibility,
  p.published_at AS current_publication_published_at`;
const PUBLICATION_COLUMNS = `
  p.article_id, p.id AS publication_id, p.publication_number, p.source_revision,
  p.slug, p.subject_kind, p.subject_provider_id, p.category_slug,
  p.category_label_en, p.category_label_ja, p.category_display_order,
  p.title, p.description, p.content,
  p.visibility, p.published_at`;

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

function validateActor(actor: GuideActor): void {
  assertStoreIdentifier(actor.nihoUserId, "actor.nihoUserId");
}

function validateSlug(slug: string): void {
  if (!GUIDE_SLUG.test(slug) || slug.length > 160) {
    throw new StoreValidationError("guide.slug must use 1-160 lower-case letters, digits, and single hyphens.");
  }
}

function validateRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new StoreValidationError("expectedRevision must be a positive integer.");
  }
}

function validateCategorySlug(slug: string): void {
  if (!GUIDE_SLUG.test(slug) || slug.length > 80) {
    throw new StoreValidationError("guide.categorySlug must be a stable 1-80 character slug.");
  }
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

function validateDraft(input: SaveGuideDraftInput): SaveGuideDraftInput {
  validateSlug(input.slug);
  assertNonEmptyText(input.title, "guide.title", 110);
  if (input.description.length > 160) throw new StoreValidationError("guide.description must be at most 160 characters.");
  if (input.categorySlug !== undefined) validateCategorySlug(input.categorySlug);
  return { ...input, content: parseGuideContent(input.content) };
}

function validateSubject(subject: GuideSubject): void {
  if (subject.kind === "WRITER") return;
  if (subject.kind === "PROVIDER") {
    assertStoreIdentifier(subject.providerId, "guide.subject.providerId");
    return;
  }
  throw new StoreValidationError("guide.subject is invalid.");
}

function subjectFromRow(row: DbRow): GuideSubject {
  const kind = stringValue(row, "subject_kind");
  if (kind === "WRITER") return { kind };
  if (kind === "PROVIDER") return { kind, providerId: stringValue(row, "subject_provider_id") };
  throw new StoreValidationError("Database returned an invalid guide subject.");
}

function articleFromRow(row: DbRow): GuideArticleRecord {
  const categorySlug = optionalString(row, "category_slug");
  const currentPublicationId = row.current_publication_id === null || row.current_publication_id === undefined
    ? undefined
    : integerValue(row, "current_publication_id");
  return {
    id: stringValue(row, "id"),
    slug: stringValue(row, "slug"),
    creatorNihoUserId: stringValue(row, "creator_niho_user_id"),
    subject: subjectFromRow(row),
    title: stringValue(row, "title"),
    description: stringValue(row, "description"),
    ...(categorySlug === undefined ? {} : { categorySlug }),
    content: parseGuideContent(row.content),
    status: stringValue(row, "status") as GuideArticleStatus,
    revision: integerValue(row, "revision"),
    ...(currentPublicationId === undefined
      ? {}
      : {
          currentPublication: {
            id: currentPublicationId,
            number: integerValue(row, "current_publication_number"),
            visibility: stringValue(row, "current_publication_visibility") as GuidePublicationVisibility,
            publishedAtUtc: isoValue(row, "current_publication_published_at"),
          },
        }),
    createdAtUtc: isoValue(row, "created_at"),
    updatedAtUtc: isoValue(row, "updated_at"),
  };
}

function publicArticleFromRow(row: DbRow, productLinks: readonly PublicGuideProductLink[]): PublicGuideArticle {
  const visibility = stringValue(row, "visibility") as GuidePublicationVisibility;
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
    publishedAtUtc: isoValue(row, "published_at"),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

async function requireSubjectAuthority(client: PoolClient, actor: GuideActor, subject: GuideSubject): Promise<void> {
  const result = subject.kind === "WRITER"
    ? await client.query(
        "SELECT 1 FROM guide_writer_grants WHERE niho_user_id=$1 AND active=true FOR SHARE",
        [actor.nihoUserId],
      )
    : await client.query(
        `SELECT 1 FROM provider_memberships
          WHERE provider_id=$1 AND niho_user_id=$2 AND active=true AND role IN ('OWNER','EDITOR')
          FOR SHARE`,
        [subject.providerId, actor.nihoUserId],
      );
  if (result.rows[0] === undefined) throw new StoreAccessDeniedError();
}

async function getOwnedArticleForUpdate(
  client: PoolClient,
  actor: GuideActor,
  articleId: string,
): Promise<GuideArticleRecord> {
  const result = await client.query<DbRow>(
    `SELECT ${ARTICLE_COLUMNS}
       FROM guide_articles a
       LEFT JOIN guide_publications p ON p.id=a.current_publication_id
      WHERE a.id=$1 AND a.creator_niho_user_id=$2
      FOR UPDATE OF a`,
    [articleId, actor.nihoUserId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new StoreAccessDeniedError();
  const article = articleFromRow(row);
  await requireSubjectAuthority(client, actor, article.subject);
  return article;
}

async function selectOwnedArticle(
  client: PoolClient,
  actor: GuideActor,
  articleId: string,
): Promise<GuideArticleRecord> {
  const result = await client.query<DbRow>(
    `SELECT ${ARTICLE_COLUMNS}
       FROM guide_articles a
       LEFT JOIN guide_publications p ON p.id=a.current_publication_id
      WHERE a.id=$1 AND a.creator_niho_user_id=$2`,
    [articleId, actor.nihoUserId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new StoreAccessDeniedError();
  return articleFromRow(row);
}

async function activePublicLinks(client: PoolClient, publicationId: number): Promise<readonly PublicGuideProductLink[]> {
  const result = await client.query<DbRow>(
    `SELECT l.provider_id, l.product_id
       FROM guide_publication_product_links l
       JOIN experience_products product
         ON product.provider_id=l.provider_id AND product.id=l.product_id AND product.status='PUBLISHED'
      WHERE l.publication_id=$1
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
          ))
        )
      ORDER BY l.provider_id, l.product_id`,
    [publicationId],
  );
  return result.rows.map((row) => ({
    providerId: stringValue(row, "provider_id"),
    productId: stringValue(row, "product_id"),
  }));
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

  async createArticle(actor: GuideActor, input: CreateGuideArticleInput): Promise<GuideArticleRecord> {
    validateActor(actor);
    assertStoreIdentifier(input.id, "guide.id");
    validateSlug(input.slug);
    validateSubject(input.subject);
    assertNonEmptyText(input.title, "guide.title", 110);
    const description = input.description ?? "";
    if (description.length > 160) throw new StoreValidationError("guide.description must be at most 160 characters.");
    if (input.categorySlug !== undefined) validateCategorySlug(input.categorySlug);
    const content = parseGuideContent(input.content ?? { markdown: "" });
    try {
      return await withTransaction(this.#pool, async (client) => {
        await requireSubjectAuthority(client, actor, input.subject);
        const result = await client.query<DbRow>(
          `INSERT INTO guide_articles (
             id, slug, creator_niho_user_id, subject_kind, subject_provider_id,
             category_slug, title, description, content
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [
            input.id,
            input.slug,
            actor.nihoUserId,
            input.subject.kind,
            input.subject.kind === "PROVIDER" ? input.subject.providerId : null,
            input.categorySlug ?? null,
            input.title,
            description,
            JSON.stringify(content),
          ],
        );
        if (result.rows[0] === undefined) throw new StoreConflictError("The guide ID or global slug is already in use.");
        return selectOwnedArticle(client, actor, input.id);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new StoreConflictError("The guide ID or global slug is already in use.");
      throw error;
    }
  }

  async listArticles(actor: GuideActor): Promise<readonly GuideArticleRecord[]> {
    validateActor(actor);
    const result = await this.#pool.query<DbRow>(
      `SELECT ${ARTICLE_COLUMNS}
         FROM guide_articles a
         LEFT JOIN guide_publications p ON p.id=a.current_publication_id
        WHERE a.creator_niho_user_id=$1
          AND (
            (a.subject_kind='WRITER' AND EXISTS (
              SELECT 1 FROM guide_writer_grants wg
               WHERE wg.niho_user_id=$1 AND wg.active=true
            ))
            OR
            (a.subject_kind='PROVIDER' AND EXISTS (
              SELECT 1 FROM provider_memberships m
               WHERE m.provider_id=a.subject_provider_id AND m.niho_user_id=$1
                 AND m.active=true AND m.role IN ('OWNER','EDITOR')
            ))
          )
        ORDER BY a.updated_at DESC, a.id`,
      [actor.nihoUserId],
    );
    return result.rows.map(articleFromRow);
  }

  async getArticle(actor: GuideActor, articleId: string): Promise<GuideArticleRecord> {
    validateActor(actor);
    assertStoreIdentifier(articleId, "articleId");
    return withTransaction(this.#pool, async (client) => {
      const article = await selectOwnedArticle(client, actor, articleId);
      await requireSubjectAuthority(client, actor, article.subject);
      return article;
    });
  }

  async saveDraft(
    actor: GuideActor,
    articleId: string,
    rawInput: SaveGuideDraftInput,
    expectedRevision: number,
  ): Promise<GuideArticleRecord> {
    validateActor(actor);
    assertStoreIdentifier(articleId, "articleId");
    validateRevision(expectedRevision);
    const input = validateDraft(rawInput);
    try {
      return await withTransaction(this.#pool, async (client) => {
        const article = await getOwnedArticleForUpdate(client, actor, articleId);
        if (article.revision !== expectedRevision) throw new StoreConflictError("Guide draft revision mismatch.");
        if (article.slug !== input.slug) {
          const published = await client.query(
            "SELECT 1 FROM guide_publications WHERE article_id=$1 LIMIT 1",
            [articleId],
          );
          if (published.rows[0] !== undefined) {
            throw new StoreConflictError("A guide slug cannot change after its first publication.");
          }
        }
        await client.query(
          `UPDATE guide_articles
              SET slug=$2, title=$3, description=$4, category_slug=$5, content=$6::jsonb,
                  revision=revision+1, updated_at=clock_timestamp()
            WHERE id=$1`,
          [articleId, input.slug, input.title, input.description, input.categorySlug ?? null, JSON.stringify(input.content)],
        );
        return selectOwnedArticle(client, actor, articleId);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new StoreConflictError("The global guide slug is already in use.");
      throw error;
    }
  }

  async commitPublication(
    actor: GuideActor,
    articleId: string,
    input: CommitGuidePublicationInput,
  ): Promise<PublicGuideArticle> {
    validateActor(actor);
    assertStoreIdentifier(articleId, "articleId");
    validateRevision(input.expectedRevision);
    if (input.visibility !== "PUBLIC" && input.visibility !== "UNLISTED") {
      throw new StoreValidationError("guide publication visibility is invalid.");
    }
    if (input.productLinks.length > 3) throw new StoreValidationError("A guide may link at most three products.");
    const linkKeys = new Set<string>();
    for (const link of input.productLinks) {
      assertStoreIdentifier(link.providerId, "guide.productLink.providerId");
      assertStoreIdentifier(link.productId, "guide.productLink.productId");
      const key = `${link.providerId}\u0000${link.productId}`;
      if (linkKeys.has(key)) throw new StoreValidationError("Guide product links must be unique.");
      linkKeys.add(key);
    }

    return withTransaction(this.#pool, async (client) => {
      const article = await getOwnedArticleForUpdate(client, actor, articleId);
      if (article.revision !== input.expectedRevision) throw new StoreConflictError("Guide draft revision mismatch.");
      if (article.subject.kind === "PROVIDER") {
        const subjectProviderId = article.subject.providerId;
        if (input.productLinks.some((link) => link.providerId !== subjectProviderId)) {
          throw new StoreValidationError("A provider article may link only its own products.");
        }
      }
      if (article.categorySlug === undefined) throw new StoreValidationError("A category is required before publication.");
      if (article.description.trim().length === 0) throw new StoreValidationError("A description is required before publication.");
      if (article.content.markdown.trim().length === 0) throw new StoreValidationError("Article Markdown is required before publication.");
      if (article.content.author === undefined) throw new StoreValidationError("A public author is required before publication.");

      const categoryResult = await client.query<DbRow>(
        `SELECT slug, label_en, label_ja, display_order
           FROM guide_categories WHERE slug=$1 AND active=true FOR SHARE`,
        [article.categorySlug],
      );
      const category = categoryResult.rows[0];
      if (category === undefined) throw new StoreConflictError("The selected guide category is no longer active.");

      const authorizedLinks: Array<GuideProductLinkInput & { permissionBasis: GuideLinkPermissionBasis }> = [];
      for (const link of input.productLinks) {
        const product = await client.query<DbRow>(
          `SELECT product.id,
                  EXISTS (
                    SELECT 1 FROM provider_memberships m
                     WHERE m.provider_id=product.provider_id AND m.niho_user_id=$3
                       AND m.active=true AND m.role IN ('OWNER','EDITOR')
                  ) AS provider_allowed,
                  EXISTS (
                    SELECT 1 FROM guide_product_link_memberships gm
                     WHERE gm.provider_id=product.provider_id AND gm.niho_user_id=$3 AND gm.active=true
                  ) AS guide_link_allowed
             FROM experience_products product
            WHERE product.provider_id=$1 AND product.id=$2 AND product.status='PUBLISHED'
            FOR SHARE`,
          [link.providerId, link.productId, actor.nihoUserId],
        );
        const productRow = product.rows[0];
        if (productRow === undefined) throw new StoreNotFoundError("published product for guide link");
        const permissionBasis = productRow.provider_allowed === true
          ? "PROVIDER_MEMBERSHIP"
          : productRow.guide_link_allowed === true
            ? "GUIDE_PRODUCT_LINK_MEMBERSHIP"
            : undefined;
        if (permissionBasis === undefined) throw new StoreAccessDeniedError();
        authorizedLinks.push({ ...link, permissionBasis });
      }

      const numberResult = await client.query<DbRow>(
        "SELECT coalesce(max(publication_number),0)+1 AS next_number FROM guide_publications WHERE article_id=$1",
        [articleId],
      );
      const publicationNumber = integerValue(numberResult.rows[0]!, "next_number");
      const publicationResult = await client.query<DbRow>(
        `INSERT INTO guide_publications (
           article_id, publication_number, source_revision, slug, subject_kind, subject_provider_id,
           category_slug, category_label_en, category_label_ja, category_display_order,
           title, description, content, visibility, published_by_niho_user_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15)
         RETURNING ${PUBLICATION_COLUMNS.replaceAll("p.", "")}`,
        [
          articleId,
          publicationNumber,
          article.revision,
          article.slug,
          article.subject.kind,
          article.subject.kind === "PROVIDER" ? article.subject.providerId : null,
          article.categorySlug,
          stringValue(category, "label_en"),
          stringValue(category, "label_ja"),
          integerValue(category, "display_order"),
          article.title,
          article.description,
          JSON.stringify(article.content),
          input.visibility,
          actor.nihoUserId,
        ],
      );
      const publication = publicationResult.rows[0]!;
      const publicationId = integerValue(publication, "publication_id");

      for (const link of authorizedLinks) {
        await client.query(
          `INSERT INTO guide_publication_product_links (
             article_id, publication_id, provider_id, product_id,
             link_created_by_niho_user_id, permission_basis
           ) VALUES ($1,$2,$3,$4,$5,$6)`,
          [articleId, publicationId, link.providerId, link.productId, actor.nihoUserId, link.permissionBasis],
        );
      }
      await client.query("UPDATE guide_publications SET sealed=true WHERE id=$1", [publicationId]);
      await client.query(
        `UPDATE guide_articles
            SET status='PUBLISHED', current_publication_id=$2,
                revision=revision+1, updated_at=clock_timestamp()
          WHERE id=$1`,
        [articleId, publicationId],
      );
      return publicArticleFromRow(
        publication,
        authorizedLinks.map(({ providerId, productId }) => ({ providerId, productId })),
      );
    });
  }

  async stopPublication(actor: GuideActor, articleId: string, expectedRevision: number): Promise<GuideArticleRecord> {
    validateActor(actor);
    assertStoreIdentifier(articleId, "articleId");
    validateRevision(expectedRevision);
    return withTransaction(this.#pool, async (client) => {
      const article = await getOwnedArticleForUpdate(client, actor, articleId);
      if (article.revision !== expectedRevision) throw new StoreConflictError("Guide draft revision mismatch.");
      if (article.status !== "PUBLISHED") throw new StoreConflictError("The guide has no current publication to stop.");
      await client.query(
        `UPDATE guide_articles
            SET status='STOPPED', current_publication_id=NULL,
                revision=revision+1, updated_at=clock_timestamp()
          WHERE id=$1`,
        [articleId],
      );
      return selectOwnedArticle(client, actor, articleId);
    });
  }

  async getPublicArticleBySlug(slug: string): Promise<PublicGuideArticle | null> {
    validateSlug(slug);
    return withTransaction(this.#pool, async (client) => {
      const result = await client.query<DbRow>(
        `SELECT ${PUBLICATION_COLUMNS}
           FROM guide_articles a
           JOIN guide_publications p ON p.id=a.current_publication_id AND p.article_id=a.id AND p.sealed=true
          WHERE a.status='PUBLISHED' AND p.slug=$1`,
        [slug],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      const publicationId = integerValue(row, "publication_id");
      return publicArticleFromRow(row, await activePublicLinks(client, publicationId));
    });
  }

  async listPublicArticles(): Promise<readonly PublicGuideArticle[]> {
    return withTransaction(this.#pool, async (client) => {
      const result = await client.query<DbRow>(
        `SELECT ${PUBLICATION_COLUMNS}
           FROM guide_articles a
           JOIN guide_publications p ON p.id=a.current_publication_id AND p.article_id=a.id AND p.sealed=true
          WHERE a.status='PUBLISHED' AND p.visibility='PUBLIC'
          ORDER BY p.published_at DESC, p.id DESC`,
      );
      const articles: PublicGuideArticle[] = [];
      for (const row of result.rows) {
        const publicationId = integerValue(row, "publication_id");
        articles.push(publicArticleFromRow(row, await activePublicLinks(client, publicationId)));
      }
      return articles;
    });
  }
}
