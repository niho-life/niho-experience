import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  StoreAccessDeniedError,
  StoreConflictError,
  StoreValidationError,
} from "../src/errors.ts";
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
  "0067_guide_provider_ownership.sql",
] as const;

const actorId = "hst_synthetic_owner";
const secondOwnerId = "hst_synthetic_second_owner";
const editorId = "hst_synthetic_editor";
const viewerId = "hst_synthetic_viewer";
const assetId = "00000000-0000-4000-8000-000000000477";
const baseContent = {
  language: "en",
  markdown: "## A synthetic route\n\nThis opening paragraph is used as the optional lead for a test-only guide.",
  author: { name: "Synthetic Host", role: "Host", bio: "A synthetic profile for a disposable database test." },
} as const;

describe("PostgreSQL OWNER guide writes", { skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false }, () => {
  it("creates, saves, publishes immutable updates, enforces current OWNER authority, and stops", async () => {
    const { Pool } = await import("pg");
    const schema = `experience_guide_write_${randomUUID().replaceAll("-", "")}`;
    const quotedSchema = `"${schema}"`;
    const pool = new Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${schema}` });
    try {
      await pool.query(`CREATE SCHEMA ${quotedSchema}`);
      for (const migration of migrations) {
        await pool.query(await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
      }
      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a'),('provider-b')");
      await pool.query(
        `INSERT INTO provider_memberships (provider_id,niho_user_id,role,active)
         VALUES ('provider-a',$1,'OWNER',true),('provider-a',$2,'OWNER',true),
                ('provider-a',$3,'EDITOR',true),('provider-a',$4,'VIEWER',true),
                ('provider-b','hst_other_owner','OWNER',true)`,
        [actorId, secondOwnerId, editorId, viewerId],
      );
      await pool.query(
        `INSERT INTO experience_products
           (provider_id,id,slug,status,public_title,content,currency,unit_amount,
            cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
         VALUES
           ('provider-a','tea','synthetic-tea','PUBLISHED','Synthetic tea','{}','JPY',1000,
            'terms','seller-a','acct_SyntheticA','Synthetic Seller A'),
           ('provider-b','walk','synthetic-walk','PUBLISHED','Synthetic walk','{}','JPY',2000,
            'terms','seller-b','acct_SyntheticB','Synthetic Seller B')`,
      );
      await pool.query(
        "INSERT INTO guide_categories (slug,label_en,label_ja,display_order,active) VALUES ('culture','Culture','文化',10,true)",
      );

      const repository = new GuideRepository(pool);
      const blankDraft = await repository.createArticle(actorId, {
        id: "blank-japanese-draft",
        slug: "blank-japanese-draft",
        subject: { kind: "PROVIDER", providerId: "provider-a" },
        title: "",
        content: { markdown: "## 下書きメモ\n\n公開前の日本語メモ。" },
      });
      assert.equal(blankDraft.title, "");
      await assert.rejects(
        () => repository.createArticle(actorId, {
          id: "unsafe-guide",
          slug: "unsafe-guide",
          subject: { kind: "PROVIDER", providerId: "provider-a" },
          title: "Unsafe guide",
          content: { language: "en", markdown: "## Unsafe\n\n<script>bad()</script>" },
        }),
        StoreValidationError,
      );
      const requirements = await repository.createArticle(actorId, {
        id: "publication-requirements",
        slug: "publication-requirements",
        subject: { kind: "PROVIDER", providerId: "provider-a" },
        title: "Publication requirements",
        categorySlug: "culture",
        content: { markdown: "## A heading\n\nA paragraph without an English declaration." },
      });
      await assert.rejects(
        () => repository.commitPublication(actorId, requirements.id, {
          expectedRevision: requirements.revision,
          visibility: "PUBLIC",
        }),
        StoreValidationError,
      );
      const withoutHeading = await repository.saveDraft(actorId, requirements.id, {
        slug: requirements.slug,
        title: requirements.title,
        description: "",
        categorySlug: "culture",
        content: { language: "en", markdown: "An English paragraph without the required heading." },
      }, requirements.revision);
      await assert.rejects(
        () => repository.commitPublication(actorId, requirements.id, {
          expectedRevision: withoutHeading.revision,
          visibility: "PUBLIC",
        }),
        StoreValidationError,
      );
      const withConfirm = await repository.saveDraft(actorId, requirements.id, {
        slug: requirements.slug,
        title: requirements.title,
        description: "",
        categorySlug: "culture",
        content: { language: "en", markdown: "## A heading\n\n[CONFIRM: replace this marker]." },
      }, withoutHeading.revision);
      await assert.rejects(
        () => repository.commitPublication(actorId, requirements.id, {
          expectedRevision: withConfirm.revision,
          visibility: "PUBLIC",
        }),
        StoreValidationError,
      );
      const withoutParagraph = await repository.saveDraft(actorId, requirements.id, {
        slug: requirements.slug,
        title: requirements.title,
        description: "",
        categorySlug: "culture",
        content: { language: "en", markdown: "## A heading\n\n- A list is not an opening paragraph" },
      }, withConfirm.revision);
      await assert.rejects(
        () => repository.commitPublication(actorId, requirements.id, {
          expectedRevision: withoutParagraph.revision,
          visibility: "PUBLIC",
        }),
        StoreValidationError,
      );
      const japaneseMemo = await repository.saveDraft(actorId, requirements.id, {
        slug: requirements.slug,
        title: "日本語メモ",
        description: "",
        categorySlug: "culture",
        content: { language: "en", markdown: "## 日本語\n\nこれは公開前のメモです。" },
      }, withoutParagraph.revision);
      await assert.rejects(
        () => repository.commitPublication(actorId, requirements.id, {
          expectedRevision: japaneseMemo.revision,
          visibility: "PUBLIC",
        }),
        StoreValidationError,
      );

      const created = await repository.createArticle(actorId, {
        id: "provider-guide",
        slug: "provider-guide",
        subject: { kind: "PROVIDER", providerId: "provider-a" },
        title: "A synthetic provider guide",
        categorySlug: "culture",
        content: baseContent,
      });
      assert.equal(created.revision, 1);
      assert.equal(created.status, "DRAFT");
      assert.equal((await repository.listArticles(actorId)).some((article) => article.id === created.id), true);
      assert.equal((await repository.listArticles(secondOwnerId)).some((article) => article.id === created.id), true);
      assert.deepEqual(await repository.listArticles(editorId), []);
      assert.deepEqual(await repository.listArticles(viewerId), []);
      assert.equal((await repository.getArticle(actorId, created.id)).subject.providerId, "provider-a");
      await assert.rejects(() => repository.getArticle(editorId, created.id), StoreAccessDeniedError);
      await assert.rejects(() => repository.getArticle(viewerId, created.id), StoreAccessDeniedError);
      await assert.rejects(() => repository.getArticle("hst_other_owner", created.id), StoreAccessDeniedError);

      const uploaded = await repository.createMediaAsset(secondOwnerId, created.id, {
        id: assetId,
        objectKey: `private/guides/${assetId}.jpg`,
      });
      assert.equal(uploaded.creatorNihoUserId, actorId);
      assert.equal(uploaded.uploadedByActorId, secondOwnerId);
      await repository.markMediaAssetReady(secondOwnerId, created.id, assetId, {
        width: 1200,
        height: 800,
        byteSize: 4096,
      });
      const unconfirmedAsset = await repository.getReadyMediaAsset(secondOwnerId, created.id, assetId);
      assert.equal(unconfirmedAsset.creatorNihoUserId, actorId);
      assert.equal(unconfirmedAsset.uploadedByActorId, secondOwnerId);
      assert.equal(unconfirmedAsset.webConfirmedByNihoUserId, undefined);
      assert.equal(await repository.getPublicMediaAsset(assetId), null);

      const figureMarkdown = `${baseContent.markdown}\n\n![A synthetic blue rectangle](niho-guide-asset:${assetId})`;
      const saved = await repository.saveDraft(secondOwnerId, created.id, {
        slug: created.slug,
        title: created.title,
        description: "",
        categorySlug: "culture",
        content: { ...baseContent, markdown: figureMarkdown },
        cover: { assetId, alt: "", credit: "", webConfirmed: false },
        draftProductLinks: [{ providerId: "provider-a", productId: "tea" }],
      }, created.revision);
      assert.equal(saved.revision, 2);
      await assert.rejects(
        () => repository.commitPublication(actorId, created.id, {
          expectedRevision: saved.revision,
          visibility: "PUBLIC",
        }),
        StoreValidationError,
      );
      await repository.confirmMediaAssetWebRights(secondOwnerId, created.id, assetId, "Photo: Synthetic Host");
      const ownedAsset = await repository.getReadyMediaAsset(secondOwnerId, created.id, assetId);
      assert.equal(ownedAsset.creatorNihoUserId, actorId);
      assert.equal(ownedAsset.uploadedByActorId, secondOwnerId);
      assert.equal(ownedAsset.webConfirmedByNihoUserId, secondOwnerId);
      const confirmedCover = await repository.saveDraft(secondOwnerId, created.id, {
        slug: saved.slug,
        title: saved.title,
        description: saved.description,
        categorySlug: "culture",
        content: saved.content,
        cover: { assetId, alt: "A synthetic cover", credit: "Photo: Synthetic Host", webConfirmed: true },
      }, saved.revision);
      await assert.rejects(
        () => repository.saveDraft(actorId, created.id, {
          slug: created.slug,
          title: "A stale overwrite",
          description: "",
          categorySlug: "culture",
          content: baseContent,
        }, created.revision),
        StoreConflictError,
      );
      await assert.rejects(
        () => repository.saveDraft(actorId, created.id, {
          slug: confirmedCover.slug,
          title: confirmedCover.title,
          description: "",
          categorySlug: "culture",
          content: confirmedCover.content,
          draftProductLinks: [{ providerId: "provider-b", productId: "walk" }],
        }, confirmedCover.revision),
        StoreAccessDeniedError,
      );

      const first = await repository.commitPublication(secondOwnerId, created.id, {
        expectedRevision: confirmedCover.revision,
        visibility: "PUBLIC",
      });
      assert.equal(first.publicationNumber, 1);
      assert.equal(first.description, "This opening paragraph is used as the optional lead for a test-only guide.");
      assert.deepEqual(first.productLinks, [
        { providerId: "provider-a", productId: "tea", productSlug: "synthetic-tea" },
      ]);
      assert.deepEqual(first.figures, [
        { slot: 1, assetId, alt: "A synthetic blue rectangle", credit: "Photo: Synthetic Host" },
      ]);
      assert.deepEqual(first.cover, {
        assetId,
        alt: "A synthetic cover",
        credit: "Photo: Synthetic Host",
        width: 1200,
        height: 800,
      });
      assert.doesNotMatch(JSON.stringify(first), /private\/guides|creatorActorId|creatorNihoUserId|publishedBy|objectKey/i);
      assert.equal((await repository.getPublicMediaAsset(assetId))?.objectKey, `private/guides/${assetId}.jpg`);
      const firstRetry = await repository.commitPublication(secondOwnerId, created.id, {
        expectedRevision: confirmedCover.revision,
        visibility: "PUBLIC",
      });
      assert.deepEqual(firstRetry, first);
      assert.equal(
        (await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM guide_publications WHERE article_id=$1 AND sealed=true",
          [created.id],
        )).rows[0]?.count,
        "1",
      );
      await assert.rejects(
        () => repository.commitPublication(actorId, created.id, {
          expectedRevision: confirmedCover.revision,
          visibility: "PUBLIC",
        }),
        StoreConflictError,
      );

      const afterFirst = await repository.getArticle(actorId, created.id);
      const privateEdit = await repository.saveDraft(actorId, created.id, {
        slug: afterFirst.slug,
        title: "A private newer draft",
        description: "A deliberate public lead.",
        categorySlug: "culture",
        content: afterFirst.content,
      }, afterFirst.revision);
      assert.equal((await repository.getPublicArticleBySlug(created.slug))?.title, first.title);
      const second = await repository.commitPublication(actorId, created.id, {
        expectedRevision: privateEdit.revision,
        visibility: "PUBLIC",
      });
      assert.equal(second.publicationNumber, 2);
      assert.equal(second.title, "A private newer draft");
      assert.equal(second.firstPublishedAtUtc, first.publishedAtUtc);
      assert.deepEqual(
        (await pool.query(
          `SELECT permission_basis FROM guide_publication_product_links WHERE publication_id=$1`,
          [first.publicationId],
        )).rows,
        [{ permission_basis: "PROVIDER_MEMBERSHIP" }],
      );

      await pool.query(
        "UPDATE provider_memberships SET active=false WHERE provider_id='provider-a' AND niho_user_id=$1",
        [actorId],
      );
      assert.deepEqual((await repository.getPublicArticleBySlug(created.slug))?.productLinks, []);
      assert.deepEqual(await repository.listArticles(actorId), []);
      await assert.rejects(() => repository.getArticle(actorId, created.id), StoreAccessDeniedError);
      await assert.rejects(() => repository.getReadyMediaAsset(actorId, created.id, assetId), StoreAccessDeniedError);
      assert.equal((await repository.listArticles(secondOwnerId)).some((article) => article.id === created.id), true);
      assert.equal((await repository.getArticle(secondOwnerId, created.id)).id, created.id);
      assert.equal((await repository.getReadyMediaAsset(secondOwnerId, created.id, assetId)).id, assetId);
      await assert.rejects(
        () => repository.saveDraft(actorId, created.id, {
          slug: privateEdit.slug,
          title: privateEdit.title,
          description: privateEdit.description,
          categorySlug: "culture",
          content: privateEdit.content,
        }, second.sourceRevision + 1),
        StoreAccessDeniedError,
      );

      await pool.query(
        "UPDATE provider_memberships SET active=true WHERE provider_id='provider-a' AND niho_user_id=$1",
        [actorId],
      );
      const beforeOpsStop = await repository.getArticle(actorId, created.id);
      const stopClient = await pool.connect();
      try {
        await stopClient.query("BEGIN");
        await stopClient.query("SELECT id FROM guide_articles WHERE id=$1 FOR UPDATE", [created.id]);
        await stopClient.query(
          `UPDATE guide_articles
              SET status='OPS_STOPPED', current_publication_id=NULL,
                  ops_stop_reason=$2, ops_stop_contact=$3,
                  revision=revision+1, updated_at=clock_timestamp()
            WHERE id=$1 AND status='PUBLISHED'`,
          [created.id, "Synthetic policy review", "support@example.invalid"],
        );
        await stopClient.query("COMMIT");
      } catch (error) {
        await stopClient.query("ROLLBACK");
        throw error;
      } finally {
        stopClient.release();
      }
      const opsStopped = await repository.getArticle(actorId, created.id);
      assert.equal(opsStopped.status, "OPS_STOPPED");
      assert.equal(opsStopped.revision, beforeOpsStop.revision + 1);
      assert.equal(opsStopped.opsStopReason, "Synthetic policy review");
      assert.equal(opsStopped.opsStopContact, "support@example.invalid");
      assert.equal(await repository.getPublicArticleBySlug(created.slug), null);
      assert.equal((await repository.listPublicArticles()).some((article) => article.articleId === created.id), false);
      const savedWhileOpsStopped = await repository.saveDraft(actorId, created.id, {
        slug: opsStopped.slug,
        title: "Ops-stopped private edit",
        description: opsStopped.description,
        categorySlug: "culture",
        content: opsStopped.content,
      }, opsStopped.revision);
      assert.equal(savedWhileOpsStopped.status, "OPS_STOPPED");
      assert.equal(savedWhileOpsStopped.opsStopReason, "Synthetic policy review");
      await assert.rejects(
        () => repository.commitPublication(actorId, created.id, {
          expectedRevision: savedWhileOpsStopped.revision,
          visibility: "PUBLIC",
        }),
        StoreConflictError,
      );
      const releaseClient = await pool.connect();
      try {
        await releaseClient.query("BEGIN");
        await releaseClient.query("SELECT id FROM guide_articles WHERE id=$1 FOR UPDATE", [created.id]);
        await releaseClient.query(
          `UPDATE guide_articles
              SET status='STOPPED', ops_stop_reason=NULL, ops_stop_contact=NULL,
                  revision=revision+1, updated_at=clock_timestamp()
            WHERE id=$1 AND status='OPS_STOPPED'`,
          [created.id],
        );
        await releaseClient.query("COMMIT");
      } catch (error) {
        await releaseClient.query("ROLLBACK");
        throw error;
      } finally {
        releaseClient.release();
      }
      const released = await repository.getArticle(actorId, created.id);
      assert.equal(released.status, "STOPPED");
      assert.equal("opsStopReason" in released, false);
      assert.equal("opsStopContact" in released, false);
      const republished = await repository.commitPublication(actorId, created.id, {
        expectedRevision: released.revision,
        visibility: "PUBLIC",
      });
      assert.equal(republished.publicationNumber, 3);
      const current = await repository.getArticle(secondOwnerId, created.id);
      const stopped = await repository.stopPublication(secondOwnerId, created.id, current.revision);
      assert.equal(stopped.status, "STOPPED");
      assert.equal(await repository.getPublicArticleBySlug(created.slug), null);
      assert.deepEqual(
        (await pool.query(
          `SELECT a.creator_niho_user_id, m.creator_niho_user_id AS photo_creator,
                  m.uploaded_by_actor_id, array_agg(p.published_by_niho_user_id ORDER BY p.publication_number) AS publishers
             FROM guide_articles a
             JOIN guide_media_assets m ON m.article_id=a.id
             JOIN guide_publications p ON p.article_id=a.id
            WHERE a.id=$1
            GROUP BY a.creator_niho_user_id, m.creator_niho_user_id, m.uploaded_by_actor_id`,
          [created.id],
        )).rows,
        [{
          creator_niho_user_id: actorId,
          photo_creator: actorId,
          uploaded_by_actor_id: secondOwnerId,
          publishers: [secondOwnerId, actorId, actorId],
        }],
      );
      assert.equal(
        (await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM guide_publications WHERE article_id=$1 AND sealed=true",
          [created.id],
        )).rows[0]?.count,
        "3",
      );
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`).catch(() => undefined);
      await pool.end();
    }
  });
});
