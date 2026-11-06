import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { StoreValidationError } from "../src/errors.ts";
import { GuideRepository } from "../src/guides.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

// The Store no longer writes guides (#251). The public read path stays as the rollback source,
// so every row below is inserted with plain SQL, the way an imported or historical row exists.
const content = {
  markdown: "## A synthetic route\n\n![Synthetic figure](niho-guide-asset:00000000-0000-4000-8000-0000000000f1)\n\nTest-only text.",
  author: { name: "Synthetic Writer", role: "Test guide", bio: "A synthetic profile used only by the disposable database test." },
  checkedOn: "2026-10-29",
} as const;

const ASSET = {
  oldCover: "00000000-0000-4000-8000-0000000000a0",
  cover: "00000000-0000-4000-8000-0000000000c1",
  figure: "00000000-0000-4000-8000-0000000000f1",
  revokedFigure: "00000000-0000-4000-8000-0000000000f2",
  unlisted: "00000000-0000-4000-8000-0000000000b1",
  stopped: "00000000-0000-4000-8000-0000000000d1",
  draft: "00000000-0000-4000-8000-0000000000e1",
  missing: "00000000-0000-4000-8000-0000000000ff",
} as const;

async function insertArticle(pool: Pool, input: {
  id: string; slug: string; creator: string; subjectProviderId?: string; categorySlug: string; title: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO guide_articles
       (id, slug, creator_niho_user_id, subject_kind, subject_provider_id, category_slug, title, description, content)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'Synthetic draft description', $8)`,
    [input.id, input.slug, input.creator, input.subjectProviderId === undefined ? "WRITER" : "PROVIDER",
      input.subjectProviderId ?? null, input.categorySlug, input.title, JSON.stringify(content)],
  );
}

async function insertReadyAsset(pool: Pool, input: {
  id: string; articleId: string; creator: string; width: number; height: number; credit?: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO guide_media_assets
       (id, article_id, creator_niho_user_id, object_key, state, width, height, byte_size, ready_at,
        public_credit, web_confirmed_at, web_confirmed_by_niho_user_id)
     VALUES ($1::uuid, $2, $3, $4, 'READY', $5, $6, 4096, '2026-10-01T00:00:00Z',
        $7, CASE WHEN $7::text IS NULL THEN NULL ELSE '2026-10-02T00:00:00Z'::timestamptz END,
        CASE WHEN $7::text IS NULL THEN NULL ELSE $3 END)`,
    [input.id, input.articleId, input.creator, `synthetic/guides/${input.id}.jpg`, input.width, input.height, input.credit ?? null],
  );
}

/** Inserts an unsealed snapshot; the caller adds its links and media, then seals it. */
async function insertPublication(pool: Pool, input: {
  articleId: string; number: number; slug: string; subjectProviderId?: string;
  category: readonly [slug: string, labelEn: string, labelJa: string, order: number];
  title: string; visibility: "PUBLIC" | "UNLISTED"; publishedAt: string; publishedBy: string;
}): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO guide_publications
       (article_id, publication_number, source_revision, slug, subject_kind, subject_provider_id,
        category_slug, category_label_en, category_label_ja, category_display_order,
        title, description, content, visibility, published_by_niho_user_id, published_at)
     VALUES ($1, $2::bigint, $2::bigint + 1, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id::int AS id`,
    [input.articleId, input.number, input.slug, input.subjectProviderId === undefined ? "WRITER" : "PROVIDER",
      input.subjectProviderId ?? null, ...input.category, input.title, `${input.title} description`,
      JSON.stringify(content), input.visibility, input.publishedBy, input.publishedAt],
  );
  return result.rows[0]!.id;
}

async function seal(pool: Pool, publicationId: number): Promise<void> {
  await pool.query("UPDATE guide_publications SET sealed=true WHERE id=$1", [publicationId]);
}

async function setCurrent(pool: Pool, articleId: string, publicationId: number | null, status: "PUBLISHED" | "STOPPED"): Promise<void> {
  await pool.query("UPDATE guide_articles SET status=$2, current_publication_id=$3 WHERE id=$1", [articleId, status, publicationId]);
}

describe("public guide reads after the Store write path was removed", { skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false }, () => {
  it("serves only current sealed publications, their authorized links, and READY media", async () => {
    const { Pool } = await import("pg");
    const schema = `guide_public_read_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${schema}` });
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      const migrations = (await readdir(new URL("../migrations/", import.meta.url))).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort();
      for (const name of migrations) await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));

      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a'), ('provider-b')");
      await pool.query(
        `INSERT INTO provider_memberships (provider_id, niho_user_id, role, active)
         VALUES ('provider-a','host-a','OWNER',true), ('provider-a','former-host','EDITOR',false)`,
      );
      await pool.query(
        `INSERT INTO experience_products
           (provider_id, id, slug, status, public_title, content, currency, unit_amount,
            cancellation_terms_ref, seller_niho_account_ref, stripe_connect_account_ref, seller_display_name)
         VALUES
           ('provider-a','tea','tea','PUBLISHED','Synthetic tea','{}','JPY',1000,'terms','seller-a','acct_SyntheticA','Synthetic Seller A'),
           ('provider-a','tea-two','tea-two','PUBLISHED','Synthetic tea two','{}','JPY',1000,'terms','seller-a','acct_SyntheticA','Synthetic Seller A'),
           ('provider-a','tea-three','tea-three','PUBLISHED','Synthetic tea three','{}','JPY',1000,'terms','seller-a','acct_SyntheticA','Synthetic Seller A'),
           ('provider-a','old-tea','old-tea','ARCHIVED','Synthetic old tea','{}','JPY',1000,'terms','seller-a','acct_SyntheticA','Synthetic Seller A'),
           ('provider-a','shared-walk','shared-walk','PUBLISHED','Synthetic shared walk A','{}','JPY',1000,'terms','seller-a','acct_SyntheticA','Synthetic Seller A'),
           ('provider-b','walk','walk','PUBLISHED','Synthetic walk','{}','JPY',2000,'terms','seller-b','acct_SyntheticB','Synthetic Seller B'),
           ('provider-b','walk-two','walk-two','PUBLISHED','Synthetic walk two','{}','JPY',2000,'terms','seller-b','acct_SyntheticB','Synthetic Seller B'),
           ('provider-b','shared-walk-b','shared-walk','PUBLISHED','Synthetic shared walk B','{}','JPY',2000,'terms','seller-b','acct_SyntheticB','Synthetic Seller B')`,
      );
      await pool.query(
        `INSERT INTO guide_categories (slug, label_en, label_ja, display_order, active)
         VALUES ('culture','Culture','文化',20,true), ('nature','Nature','自然',10,true),
                ('food','Food','食',10,true), ('retired','Retired','終了',5,false)`,
      );
      await pool.query(
        `INSERT INTO guide_writer_grants (niho_user_id, granted_by_niho_user_id, active)
         VALUES ('writer-a','admin-synthetic',true), ('writer-b','admin-synthetic',false)`,
      );
      await pool.query(
        `INSERT INTO guide_product_link_invitations
           (id, provider_id, writer_niho_user_id, invited_by_niho_user_id, state, accepted_at)
         VALUES ('00000000-0000-4000-8000-000000000101','provider-b','writer-a','host-b','ACCEPTED',clock_timestamp()),
                ('00000000-0000-4000-8000-000000000102','provider-b','writer-b','host-b','ACCEPTED',clock_timestamp())`,
      );
      await pool.query(
        `INSERT INTO guide_product_link_memberships (provider_id, niho_user_id, granted_by_niho_user_id)
         VALUES ('provider-b','writer-a','host-b'), ('provider-b','writer-b','host-b')`,
      );

      // A public article first sealed as UNLISTED, then republished as PUBLIC with a cover and figures.
      await insertArticle(pool, { id: "article-public", slug: "public-guide", creator: "writer-a", categorySlug: "culture", title: "Draft title" });
      await insertReadyAsset(pool, { id: ASSET.oldCover, articleId: "article-public", creator: "writer-a", width: 800, height: 600 });
      await insertReadyAsset(pool, { id: ASSET.cover, articleId: "article-public", creator: "writer-a", width: 1200, height: 800 });
      await insertReadyAsset(pool, { id: ASSET.figure, articleId: "article-public", creator: "writer-a", width: 900, height: 600, credit: "Synthetic Photographer" });
      await insertReadyAsset(pool, { id: ASSET.revokedFigure, articleId: "article-public", creator: "writer-a", width: 900, height: 600, credit: "Synthetic Revoked" });
      const firstPublication = await insertPublication(pool, {
        articleId: "article-public", number: 1, slug: "public-guide", category: ["culture", "Culture", "文化", 20],
        title: "Synthetic first title", visibility: "UNLISTED", publishedAt: "2026-10-10T00:00:00Z", publishedBy: "writer-a",
      });
      await pool.query(
        `INSERT INTO guide_publication_media (article_id, publication_id, asset_id, alt_text, public_credit, slot, placement)
         VALUES ('article-public',$1,$2::uuid,'Old cover','Synthetic Old Credit',0,'COVER')`,
        [firstPublication, ASSET.oldCover],
      );
      await seal(pool, firstPublication);
      await setCurrent(pool, "article-public", firstPublication, "PUBLISHED");
      const publicPublication = await insertPublication(pool, {
        articleId: "article-public", number: 2, slug: "public-guide", category: ["culture", "Culture", "文化", 20],
        title: "Synthetic public title", visibility: "PUBLIC", publishedAt: "2026-10-20T00:00:00Z", publishedBy: "writer-a",
      });
      await pool.query(
        `INSERT INTO guide_publication_product_links
           (article_id, publication_id, provider_id, product_id, link_created_by_niho_user_id, permission_basis, display_order)
         VALUES
           ('article-public',$1,'provider-b','walk','writer-a','GUIDE_PRODUCT_LINK_MEMBERSHIP',1),
           ('article-public',$1,'provider-a','tea','host-a','PROVIDER_MEMBERSHIP',2),
           ('article-public',$1,'provider-a','old-tea','host-a','PROVIDER_MEMBERSHIP',3),
           ('article-public',$1,'provider-a','shared-walk','host-a','PROVIDER_MEMBERSHIP',NULL),
           ('article-public',$1,'provider-a','tea-two','former-host','PROVIDER_MEMBERSHIP',NULL),
           ('article-public',$1,'provider-b','walk-two','writer-b','GUIDE_PRODUCT_LINK_MEMBERSHIP',NULL),
           ('article-public',$1,'provider-a','tea-three','host-a','PROVIDER_MEMBERSHIP',NULL)`,
        [publicPublication],
      );
      await pool.query(
        `INSERT INTO guide_publication_media (article_id, publication_id, asset_id, alt_text, public_credit, slot, placement)
         VALUES ('article-public',$1,$2::uuid,'Synthetic cover','Synthetic Cover Credit',0,'COVER'),
                ('article-public',$1,$3::uuid,'Synthetic figure','Synthetic Photographer',1,'FIGURE'),
                ('article-public',$1,$4::uuid,'Revoked figure','Synthetic Revoked',2,'FIGURE')`,
        [publicPublication, ASSET.cover, ASSET.figure, ASSET.revokedFigure],
      );
      await seal(pool, publicPublication);
      await setCurrent(pool, "article-public", publicPublication, "PUBLISHED");
      await pool.query(
        "UPDATE guide_media_assets SET state='REVOKED', revoked_at='2026-10-21T00:00:00Z' WHERE id=$1::uuid",
        [ASSET.revokedFigure],
      );
      // Later label edits do not rewrite the sealed snapshot.
      await pool.query("UPDATE guide_categories SET label_en='Culture renamed' WHERE slug='culture'");

      // An UNLISTED provider article: readable by slug, never listed.
      await insertArticle(pool, { id: "article-unlisted", slug: "unlisted-guide", creator: "host-a", subjectProviderId: "provider-a", categorySlug: "food", title: "Draft unlisted" });
      await insertReadyAsset(pool, { id: ASSET.unlisted, articleId: "article-unlisted", creator: "host-a", width: 640, height: 480 });
      const unlistedPublication = await insertPublication(pool, {
        articleId: "article-unlisted", number: 1, slug: "unlisted-guide", subjectProviderId: "provider-a", category: ["food", "Food", "食", 10],
        title: "Synthetic unlisted title", visibility: "UNLISTED", publishedAt: "2026-10-22T00:00:00Z", publishedBy: "host-a",
      });
      await pool.query(
        `INSERT INTO guide_publication_media (article_id, publication_id, asset_id, alt_text, public_credit, slot, placement)
         VALUES ('article-unlisted',$1,$2::uuid,'Unlisted cover','Synthetic Unlisted Credit',0,'COVER')`,
        [unlistedPublication, ASSET.unlisted],
      );
      await seal(pool, unlistedPublication);
      await setCurrent(pool, "article-unlisted", unlistedPublication, "PUBLISHED");

      // A stopped article keeps its sealed snapshot but has no current publication.
      await insertArticle(pool, { id: "article-stopped", slug: "stopped-guide", creator: "writer-a", categorySlug: "food", title: "Draft stopped" });
      await insertReadyAsset(pool, { id: ASSET.stopped, articleId: "article-stopped", creator: "writer-a", width: 640, height: 480 });
      const stoppedPublication = await insertPublication(pool, {
        articleId: "article-stopped", number: 1, slug: "stopped-guide", category: ["food", "Food", "食", 10],
        title: "Synthetic stopped title", visibility: "PUBLIC", publishedAt: "2026-10-23T00:00:00Z", publishedBy: "writer-a",
      });
      await pool.query(
        `INSERT INTO guide_publication_media (article_id, publication_id, asset_id, alt_text, public_credit, slot, placement)
         VALUES ('article-stopped',$1,$2::uuid,'Stopped cover','Synthetic Stopped Credit',0,'COVER')`,
        [stoppedPublication, ASSET.stopped],
      );
      await seal(pool, stoppedPublication);
      await setCurrent(pool, "article-stopped", stoppedPublication, "PUBLISHED");
      await setCurrent(pool, "article-stopped", null, "STOPPED");

      // A draft with an uploaded photo was never published.
      await insertArticle(pool, { id: "article-draft", slug: "draft-guide", creator: "writer-a", categorySlug: "food", title: "Draft only" });
      await insertReadyAsset(pool, { id: ASSET.draft, articleId: "article-draft", creator: "writer-a", width: 640, height: 480, credit: "Synthetic Draft Credit" });

      // A newer PUBLIC article whose category was later deactivated, without links or media.
      await insertArticle(pool, { id: "article-newer", slug: "newer-guide", creator: "host-a", subjectProviderId: "provider-a", categorySlug: "retired", title: "Draft newer" });
      const newerPublication = await insertPublication(pool, {
        articleId: "article-newer", number: 1, slug: "newer-guide", subjectProviderId: "provider-a", category: ["retired", "Retired", "終了", 5],
        title: "Synthetic newer title", visibility: "PUBLIC", publishedAt: "2026-10-25T00:00:00Z", publishedBy: "host-a",
      });
      await seal(pool, newerPublication);
      await setCurrent(pool, "article-newer", newerPublication, "PUBLISHED");

      const repository = new GuideRepository(pool);

      assert.deepEqual(await repository.listActiveCategories(), [
        { slug: "food", labelEn: "Food", labelJa: "食", displayOrder: 10 },
        { slug: "nature", labelEn: "Nature", labelJa: "自然", displayOrder: 10 },
        { slug: "culture", labelEn: "Culture renamed", labelJa: "文化", displayOrder: 20 },
      ]);

      const expectedPublic = {
        articleId: "article-public",
        publicationId: publicPublication,
        publicationNumber: 2,
        sourceRevision: 3,
        slug: "public-guide",
        subject: { kind: "WRITER" },
        category: { slug: "culture", labelEn: "Culture", labelJa: "文化", displayOrder: 20 },
        title: "Synthetic public title",
        description: "Synthetic public title description",
        content,
        visibility: "PUBLIC",
        indexable: true,
        productLinks: [
          { providerId: "provider-b", productId: "walk", productSlug: "walk" },
          { providerId: "provider-a", productId: "tea", productSlug: "tea" },
          { providerId: "provider-a", productId: "tea-three", productSlug: "tea-three" },
        ],
        cover: { assetId: ASSET.cover, alt: "Synthetic cover", credit: "Synthetic Cover Credit", width: 1200, height: 800 },
        figures: [{ slot: 1, assetId: ASSET.figure, alt: "Synthetic figure", credit: "Synthetic Photographer" }],
        firstPublishedAtUtc: "2026-10-10T00:00:00.000Z",
        publishedAtUtc: "2026-10-20T00:00:00.000Z",
      };
      assert.deepEqual(await repository.getPublicArticleBySlug("public-guide"), expectedPublic);

      const unlisted = await repository.getPublicArticleBySlug("unlisted-guide");
      assert.deepEqual(
        unlisted && { subject: unlisted.subject, visibility: unlisted.visibility, indexable: unlisted.indexable, cover: unlisted.cover, figures: unlisted.figures, productLinks: unlisted.productLinks, firstPublishedAtUtc: unlisted.firstPublishedAtUtc },
        {
          subject: { kind: "PROVIDER", providerId: "provider-a" },
          visibility: "UNLISTED",
          indexable: false,
          cover: { assetId: ASSET.unlisted, alt: "Unlisted cover", credit: "Synthetic Unlisted Credit", width: 640, height: 480 },
          figures: [],
          productLinks: [],
          firstPublishedAtUtc: "2026-10-22T00:00:00.000Z",
        },
      );
      assert.equal(await repository.getPublicArticleBySlug("stopped-guide"), null);
      assert.equal(await repository.getPublicArticleBySlug("draft-guide"), null);
      assert.equal(await repository.getPublicArticleBySlug("missing-guide"), null);
      // The code-backed article keeps its reserved slug; the database has no article for it.
      assert.deepEqual((await pool.query("SELECT slug FROM guide_legacy_slug_reservations")).rows, [{ slug: "kamakura-after-4-pm" }]);
      assert.equal(await repository.getPublicArticleBySlug("kamakura-after-4-pm"), null);
      await assert.rejects(() => repository.getPublicArticleBySlug("Not A Slug"), StoreValidationError);

      const listed = await repository.listPublicArticles();
      assert.deepEqual(listed.map((article) => article.slug), ["newer-guide", "public-guide"]);
      assert.deepEqual(listed[1], expectedPublic);
      assert.deepEqual(listed[0], {
        articleId: "article-newer",
        publicationId: newerPublication,
        publicationNumber: 1,
        sourceRevision: 2,
        slug: "newer-guide",
        subject: { kind: "PROVIDER", providerId: "provider-a" },
        category: { slug: "retired", labelEn: "Retired", labelJa: "終了", displayOrder: 5 },
        title: "Synthetic newer title",
        description: "Synthetic newer title description",
        content,
        visibility: "PUBLIC",
        indexable: true,
        productLinks: [],
        figures: [],
        firstPublishedAtUtc: "2026-10-25T00:00:00.000Z",
        publishedAtUtc: "2026-10-25T00:00:00.000Z",
      });

      assert.deepEqual(await repository.getPublicMediaAsset(ASSET.figure), {
        id: ASSET.figure,
        articleId: "article-public",
        creatorNihoUserId: "writer-a",
        objectKey: `synthetic/guides/${ASSET.figure}.jpg`,
        state: "READY",
        width: 900,
        height: 600,
        byteSize: 4096,
        publicCredit: "Synthetic Photographer",
        webConfirmedAtUtc: "2026-10-02T00:00:00.000Z",
        webConfirmedByNihoUserId: "writer-a",
      });
      assert.deepEqual(await repository.getPublicMediaAsset(ASSET.cover), {
        id: ASSET.cover,
        articleId: "article-public",
        creatorNihoUserId: "writer-a",
        objectKey: `synthetic/guides/${ASSET.cover}.jpg`,
        state: "READY",
        width: 1200,
        height: 800,
        byteSize: 4096,
      });
      // The current implementation relays media of the current publication regardless of visibility.
      assert.equal((await repository.getPublicMediaAsset(ASSET.unlisted))?.id, ASSET.unlisted);
      for (const assetId of [ASSET.revokedFigure, ASSET.oldCover, ASSET.stopped, ASSET.draft, ASSET.missing]) {
        assert.equal(await repository.getPublicMediaAsset(assetId), null, assetId);
      }
      await assert.rejects(() => repository.getPublicMediaAsset("not-a-uuid"), StoreValidationError);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await pool.end();
    }
  });
});
