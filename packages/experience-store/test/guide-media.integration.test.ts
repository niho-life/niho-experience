import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { StoreAccessDeniedError, StoreConflictError, StoreValidationError } from "../src/errors.ts";
import { GuideRepository } from "../src/guides.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrations = [
  "0001_experience_store.sql",
  "0002_google_oauth.sql",
  "0003_google_busy_coverage.sql",
  "0004_host_push_subscriptions.sql",
  "0005_guide_cms.sql",
  "0006_calendar_commands_and_sales_state.sql",
  "0007_channel_runtime.sql",
  "0008_guide_link_invitations.sql",
  "0009_guide_media.sql",
  "0010_guide_body_media.sql",
] as const;

const content = {
  markdown: "## Synthetic cover test\n\nOnly synthetic content.",
  author: { name: "Synthetic Writer", role: "Test guide", bio: "Synthetic profile." },
} as const;
const assetOne = "00000000-0000-4000-8000-000000000215";
const assetTwo = "00000000-0000-4000-8000-000000000216";

describe("PostgreSQL guide cover transaction", { skip: databaseUrl === undefined }, () => {
  it("enforces ownership and rights, snapshots media, and rolls failed publication back", async () => {
    const { Pool } = await import("pg");
    const schema = `experience_guide_media_${randomUUID().replaceAll("-", "")}`;
    const quotedSchema = `"${schema}"`;
    const pool = new Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${schema}` });
    try {
      await pool.query(`CREATE SCHEMA ${quotedSchema}`);
      for (const migration of migrations) {
        await pool.query(await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
      }
      await pool.query(
        `INSERT INTO guide_categories (slug, label_en, label_ja, display_order)
         VALUES ('walks','Walks','散歩',10)`,
      );
      await pool.query(
        `INSERT INTO guide_writer_grants (niho_user_id, granted_by_niho_user_id)
         VALUES ('writer-a','admin-synthetic'), ('writer-b','admin-synthetic')`,
      );

      const repository = new GuideRepository(pool);
      const actor = { nihoUserId: "writer-a" } as const;
      const other = { nihoUserId: "writer-b" } as const;
      const article = await repository.createArticle(actor, {
        id: "guide-media-a",
        slug: "synthetic-media-guide",
        subject: { kind: "WRITER" },
        categorySlug: "walks",
        title: "Synthetic media guide",
        description: "A synthetic guide cover transaction test.",
        content,
      });
      const otherArticle = await repository.createArticle(actor, {
        id: "guide-media-b",
        slug: "synthetic-other-guide",
        subject: { kind: "WRITER" },
        title: "Synthetic other guide",
      });

      await repository.createMediaAsset(actor, article.id, {
        id: assetOne,
        objectKey: `guide-covers/${assetOne}.jpg`,
      });
      await assert.rejects(
        () => repository.getReadyMediaAsset(other, article.id, assetOne),
        StoreAccessDeniedError,
      );
      await repository.markMediaAssetReady(actor, article.id, assetOne, {
        width: 1200,
        height: 800,
        byteSize: 12_345,
      });
      await assert.rejects(
        () => repository.saveDraft(actor, otherArticle.id, {
          slug: otherArticle.slug,
          title: otherArticle.title,
          description: "Synthetic other article.",
          categorySlug: "walks",
          content,
          cover: { assetId: assetOne, alt: "Wrong article", credit: "Synthetic", webConfirmed: true },
        }, otherArticle.revision),
        StoreAccessDeniedError,
      );

      const saved = await repository.saveDraft(actor, article.id, {
        slug: article.slug,
        title: article.title,
        description: article.description,
        categorySlug: "walks",
        content,
        cover: {
          assetId: assetOne,
          alt: "A synthetic blue rectangle",
          credit: "Synthetic test image",
          webConfirmed: true,
        },
      }, article.revision);
      const published = await repository.commitPublication(actor, article.id, {
        expectedRevision: saved.revision,
        visibility: "PUBLIC",
        productLinks: [],
      });
      assert.deepEqual(published.cover, {
        assetId: assetOne,
        alt: "A synthetic blue rectangle",
        credit: "Synthetic test image",
      });
      assert.doesNotMatch(JSON.stringify(published), /guide-covers|objectKey/);

      await repository.createMediaAsset(actor, article.id, {
        id: assetTwo,
        objectKey: `guide-covers/${assetTwo}.jpg`,
      });
      await repository.markMediaAssetReady(actor, article.id, assetTwo, {
        width: 900,
        height: 600,
        byteSize: 10_000,
      });
      const current = await repository.getArticle(actor, article.id);
      const unconfirmed = await repository.saveDraft(actor, article.id, {
        slug: current.slug,
        title: current.title,
        description: current.description,
        categorySlug: "walks",
        content,
        cover: {
          assetId: assetTwo,
          alt: "A second synthetic rectangle",
          credit: "Synthetic test image",
          webConfirmed: false,
        },
      }, current.revision);
      const beforeFailure = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM guide_publications WHERE article_id=$1",
        [article.id],
      );
      await assert.rejects(
        () => repository.commitPublication(actor, article.id, {
          expectedRevision: unconfirmed.revision,
          visibility: "PUBLIC",
          productLinks: [],
        }),
        StoreValidationError,
      );
      assert.equal(
        (await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM guide_publications WHERE article_id=$1",
          [article.id],
        )).rows[0]?.count,
        beforeFailure.rows[0]?.count,
      );
      assert.equal((await repository.getPublicArticleBySlug(article.slug))?.cover?.assetId, assetOne);

      await assert.rejects(
        () => repository.saveDraft(actor, article.id, {
          slug: unconfirmed.slug,
          title: unconfirmed.title,
          description: unconfirmed.description,
          categorySlug: "walks",
          content: { ...content, markdown: "## Unsafe\n\n![figure](https://example.test/image.jpg)" },
          cover: {
            assetId: assetTwo,
            alt: "A second synthetic rectangle",
            credit: "Synthetic test image",
            webConfirmed: true,
          },
        }, unconfirmed.revision),
        StoreValidationError,
      );
      assert.equal((await repository.getPublicArticleBySlug(article.slug))?.cover?.assetId, assetOne);
      const confirmed = await repository.saveDraft(actor, article.id, {
        slug: unconfirmed.slug,
        title: unconfirmed.title,
        description: unconfirmed.description,
        categorySlug: "walks",
        content,
        cover: {
          assetId: assetTwo,
          alt: "A second synthetic rectangle",
          credit: "Synthetic test image",
          webConfirmed: true,
        },
      }, unconfirmed.revision);

      await assert.rejects(
        () => pool.query(
          "UPDATE guide_publication_media SET public_credit='mutated' WHERE publication_id=$1",
          [published.publicationId],
        ),
        /immutable/,
      );
      await assert.rejects(
        () => pool.query("DELETE FROM guide_publication_media WHERE publication_id=$1", [published.publicationId]),
        /immutable/,
      );
      await repository.revokeMediaAsset(actor, article.id, assetOne, confirmed.revision);
      assert.equal((await repository.getPublicArticleBySlug(article.slug))?.cover, undefined);
      assert.equal(
        (await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM guide_publication_media WHERE publication_id=$1",
          [published.publicationId],
        )).rows[0]?.count,
        "1",
      );

      const revokedDraft = await repository.revokeMediaAsset(actor, article.id, assetTwo, confirmed.revision);
      assert.equal(revokedDraft.cover, undefined);
      assert.equal(revokedDraft.revision, confirmed.revision + 1);
      await assert.rejects(
        () => repository.saveDraft(actor, article.id, {
          slug: confirmed.slug,
          title: confirmed.title,
          description: confirmed.description,
          categorySlug: "walks",
          content,
          cover: { assetId: assetTwo, alt: "Stale", credit: "Synthetic", webConfirmed: true },
        }, confirmed.revision),
        StoreConflictError,
      );
      const coverless = await repository.saveDraft(actor, article.id, {
        slug: confirmed.slug,
        title: confirmed.title,
        description: confirmed.description,
        categorySlug: "walks",
        content,
      }, revokedDraft.revision);
      const coverlessPublication = await repository.commitPublication(actor, article.id, {
        expectedRevision: coverless.revision,
        visibility: "PUBLIC",
        productLinks: [],
      });
      assert.equal(coverlessPublication.cover, undefined);

      await pool.query("UPDATE guide_writer_grants SET active=false WHERE niho_user_id='writer-a'");
      await assert.rejects(
        () => repository.getReadyMediaAsset(actor, article.id, assetTwo),
        StoreAccessDeniedError,
      );
      await assert.rejects(
        () => repository.saveDraft(actor, article.id, {
          slug: confirmed.slug,
          title: confirmed.title,
          description: confirmed.description,
          categorySlug: "walks",
          content,
        }, coverless.revision + 1),
        StoreAccessDeniedError,
      );
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      await pool.end();
    }
  });
});
