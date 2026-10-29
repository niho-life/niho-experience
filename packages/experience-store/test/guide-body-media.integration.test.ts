import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { StoreAccessDeniedError, StoreValidationError } from "../src/errors.ts";
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
  "0011_guide_draft_product_links.sql",
] as const;

const actor = { nihoUserId: "writer-a" } as const;
const assetOne = "00000000-0000-4000-8000-000000000216";
const assetTwo = "00000000-0000-4000-8000-000000000217";
const assetUploading = "00000000-0000-4000-8000-000000000218";
const assetOther = "00000000-0000-4000-8000-000000000219";
const missingAsset = "00000000-0000-4000-8000-000000000220";
const author = { name: "Synthetic Writer", role: "Test guide", bio: "Synthetic profile." } as const;

describe("PostgreSQL guide body media", { skip: databaseUrl === undefined }, () => {
  it("validates scoped assets, snapshots every placement, rolls back, and hides revoked media", async () => {
    const { Pool } = await import("pg");
    const schema = `experience_guide_body_media_${randomUUID().replaceAll("-", "")}`;
    const quotedSchema = `"${schema}"`;
    const pool = new Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${schema}` });
    try {
      await pool.query(`CREATE SCHEMA ${quotedSchema}`);
      for (const migration of migrations) {
        await pool.query(await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
      }
      await pool.query("INSERT INTO guide_categories (slug,label_en,label_ja,display_order) VALUES ('walks','Walks','散歩',10)");
      await pool.query("INSERT INTO guide_writer_grants (niho_user_id,granted_by_niho_user_id) VALUES ('writer-a','admin')");

      const repository = new GuideRepository(pool);
      await assert.rejects(
        () => repository.createArticle(actor, {
          id: "legacy-create",
          slug: "legacy-create",
          subject: { kind: "WRITER" },
          title: "Legacy create",
          content: { markdown: "![Unsafe](https://example.test/photo.jpg)" },
        }),
        StoreValidationError,
      );
      const article = await repository.createArticle(actor, {
        id: "body-media",
        slug: "body-media",
        subject: { kind: "WRITER" },
        categorySlug: "walks",
        title: "Body media",
        description: "Synthetic body media.",
        content: { markdown: "## Start\n\nSynthetic body.", author },
      });
      const other = await repository.createArticle(actor, {
        id: "body-media-other",
        slug: "body-media-other",
        subject: { kind: "WRITER" },
        title: "Other",
      });

      for (const [id, target] of [[assetOne, article.id], [assetTwo, article.id], [assetUploading, article.id], [assetOther, other.id]] as const) {
        await repository.createMediaAsset(actor, target, { id, objectKey: `guide-media/${id}.jpg` });
        if (id !== assetUploading) {
          await repository.markMediaAssetReady(actor, target, id, { width: 1200, height: 800, byteSize: 1234 });
        }
      }
      await repository.confirmMediaAssetWebRights(actor, article.id, assetOne, "Photo: Synthetic One");
      await repository.confirmMediaAssetWebRights(actor, article.id, assetTwo, "Photo: Synthetic Two");
      await repository.confirmMediaAssetWebRights(actor, other.id, assetOther, "Photo: Other Article");
      assert.deepEqual(
        (await repository.listReadyMediaAssets(actor, article.id)).map(({ id, webConfirmed }) => ({ id, webConfirmed })),
        [{ id: assetTwo, webConfirmed: true }, { id: assetOne, webConfirmed: true }],
      );

      const invalidBodies = [
        `![External](https://example.test/photo.jpg)`,
        `![Sample](/sample/photos/example.jpg)`,
        `![<img src=x>](niho-guide-asset:${assetOne})`,
        `![Missing](niho-guide-asset:${missingAsset})`,
        `![Uploading](niho-guide-asset:${assetUploading})`,
        `![Other](niho-guide-asset:${assetOther})`,
      ];
      for (const markdown of invalidBodies) {
        await assert.rejects(
          () => repository.saveDraft(actor, article.id, {
            slug: article.slug,
            title: article.title,
            description: article.description,
            categorySlug: "walks",
            content: { markdown: `## Invalid\n\n${markdown}`, author },
          }, article.revision),
          markdown.includes("External") || markdown.includes("Sample") || markdown.includes("<img")
            ? StoreValidationError : StoreAccessDeniedError,
        );
      }

      const maliciousContent = { markdown: `## Invalid\n\n![<img src=x>](niho-guide-asset:${assetOne})`, author };
      await pool.query("UPDATE guide_articles SET content=$2::jsonb WHERE id=$1", [article.id, JSON.stringify(maliciousContent)]);
      await assert.rejects(
        () => repository.commitPublication(actor, article.id, {
          expectedRevision: article.revision,
          visibility: "PUBLIC",
        }),
        StoreValidationError,
      );
      await pool.query("UPDATE guide_articles SET content=$2::jsonb WHERE id=$1", [article.id, JSON.stringify(article.content)]);

      const markdown = [
        "## Synthetic figures",
        "",
        `![A synthetic blue rectangle](niho-guide-asset:${assetOne})`,
        "",
        `![A second synthetic rectangle](niho-guide-asset:${assetTwo})`,
        "",
        `![The first rectangle again](niho-guide-asset:${assetOne})`,
      ].join("\n");
      const saved = await repository.saveDraft(actor, article.id, {
        slug: article.slug,
        title: article.title,
        description: article.description,
        categorySlug: "walks",
        content: { markdown, author },
      }, article.revision);
      const published = await repository.commitPublication(actor, article.id, {
        expectedRevision: saved.revision,
        visibility: "PUBLIC",
      });
      assert.deepEqual(published.figures, [
        { slot: 1, assetId: assetOne, alt: "A synthetic blue rectangle", credit: "Photo: Synthetic One" },
        { slot: 2, assetId: assetTwo, alt: "A second synthetic rectangle", credit: "Photo: Synthetic Two" },
        { slot: 3, assetId: assetOne, alt: "The first rectangle again", credit: "Photo: Synthetic One" },
      ]);
      assert.deepEqual((await repository.getPublicArticleBySlug(article.slug))?.figures, published.figures);
      await assert.rejects(
        () => pool.query("UPDATE guide_publication_media SET alt_text='changed' WHERE publication_id=$1 AND slot=1", [published.publicationId]),
        /immutable/,
      );

      const afterPublish = await repository.getArticle(actor, article.id);
      await pool.query("UPDATE guide_media_assets SET state='REVOKED', revoked_at=clock_timestamp() WHERE id=$1::uuid", [assetTwo]);
      const beforeCount = (await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM guide_publications WHERE article_id=$1", [article.id])).rows[0]!.count;
      await assert.rejects(
        () => repository.commitPublication(actor, article.id, {
          expectedRevision: afterPublish.revision,
          visibility: "PUBLIC",
        }),
        StoreAccessDeniedError,
      );
      assert.equal((await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM guide_publications WHERE article_id=$1", [article.id])).rows[0]!.count, beforeCount);
      assert.deepEqual((await repository.getPublicArticleBySlug(article.slug))?.figures.map((figure) => figure.slot), [1, 3]);

      const revoked = await repository.revokeMediaAsset(actor, article.id, assetOne, afterPublish.revision);
      assert.equal(revoked.content.markdown, markdown);
      assert.equal(revoked.revision, afterPublish.revision + 1);
      assert.deepEqual((await repository.getPublicArticleBySlug(article.slug))?.figures, []);
      assert.equal(
        (await repository.revokeMediaAsset(actor, article.id, assetOne, revoked.revision)).revision,
        revoked.revision,
      );
      await assert.rejects(
        () => repository.saveDraft(actor, article.id, {
          slug: revoked.slug,
          title: revoked.title,
          description: revoked.description,
          categorySlug: "walks",
          content: revoked.content,
        }, revoked.revision),
        StoreAccessDeniedError,
      );
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      await pool.end();
    }
  });
});
