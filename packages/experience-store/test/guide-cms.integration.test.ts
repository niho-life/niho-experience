import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { StoreAccessDeniedError, StoreConflictError, StoreNotFoundError, StoreValidationError } from "../src/errors.ts";
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

const content = {
  markdown: "## A synthetic route\n\nThis article contains test-only content.",
  author: {
    name: "Synthetic Writer",
    role: "Test guide",
    bio: "A synthetic profile used only by the disposable database test.",
  },
  checkedOn: "2026-10-29",
} as const;

describe("PostgreSQL guide publication transaction", { skip: databaseUrl === undefined }, () => {
  it("keeps drafts private and switches sealed snapshots and authorized product links atomically", async () => {
    const { Pool } = await import("pg");
    const schema = `experience_guides_test_${randomUUID().replaceAll("-", "")}`;
    const quotedSchema = `"${schema}"`;
    const pool = new Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${schema}` });
    try {
      await pool.query(`CREATE SCHEMA ${quotedSchema}`);
      for (const name of migrations) {
        await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      }
      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a'), ('provider-b')");
      await pool.query(
        `INSERT INTO provider_memberships (provider_id, niho_user_id, role)
         VALUES ('provider-a','host-a','OWNER'), ('provider-b','host-a','VIEWER')`,
      );
      await pool.query(
        `INSERT INTO experience_products (
           provider_id, id, slug, status, public_title, content, currency, unit_amount,
           cancellation_terms_ref, seller_niho_account_ref, stripe_connect_account_ref, seller_display_name
         ) VALUES
           ('provider-a','tea','tea','PUBLISHED','Synthetic tea','{}','JPY',1000,'terms','seller','acct_synthetic','Synthetic Seller'),
           ('provider-a','tea-two','tea-two','PUBLISHED','Synthetic tea two','{}','JPY',1200,'terms','seller','acct_synthetic','Synthetic Seller'),
           ('provider-b','walk','walk','PUBLISHED','Synthetic walk','{}','JPY',2000,'terms','seller','acct_synthetic_b','Synthetic Seller'),
           ('provider-b','draft-product','draft-product','DRAFT','Synthetic draft','{}','JPY',2000,'terms','seller','acct_synthetic_b','Synthetic Seller')`,
      );
      await pool.query(
        `INSERT INTO guide_categories (slug, label_en, label_ja, display_order)
         VALUES ('food','Food','食',10), ('culture','Culture','文化',20)`,
      );
      await pool.query(
        `INSERT INTO guide_writer_grants (niho_user_id, granted_by_niho_user_id)
         VALUES ('writer-a','admin-synthetic'), ('writer-b','admin-synthetic')`,
      );
      await pool.query(
        `INSERT INTO guide_product_link_invitations
           (id, provider_id, writer_niho_user_id, invited_by_niho_user_id, state, accepted_at)
         VALUES ('00000000-0000-4000-8000-000000000007', 'provider-a', 'writer-a', 'host-a', 'ACCEPTED', clock_timestamp())`,
      );
      await pool.query(
        `INSERT INTO guide_product_link_memberships (provider_id, niho_user_id, granted_by_niho_user_id)
         VALUES ('provider-a','writer-a','host-a')`,
      );

      const store = new GuideRepository(pool);
      const actor = { nihoUserId: "writer-a" } as const;
      const otherWriter = { nihoUserId: "writer-b" } as const;
      assert.deepEqual(await store.listWritableSubjects("writer-a"), [{ kind: "WRITER" }]);
      assert.deepEqual(await store.listWritableSubjects("host-a"), [{ kind: "PROVIDER", providerId: "provider-a" }]);
      await assert.rejects(
        () => store.createArticle(actor, {
          id: "guide-unknown-category",
          slug: "guide-unknown-category",
          subject: { kind: "WRITER" },
          title: "Unknown category",
          categorySlug: "does-not-exist",
        }),
        StoreValidationError,
      );
      await assert.rejects(
        () => store.createArticle(actor, {
          id: "guide-reserved",
          slug: "kamakura-after-4-pm",
          subject: { kind: "WRITER" },
          title: "Collision with the code-backed guide",
        }),
        StoreConflictError,
      );
      const created = await store.createArticle(actor, {
        id: "guide-a",
        slug: "synthetic-guide",
        subject: { kind: "WRITER" },
        title: "Synthetic guide",
      });
      assert.equal(created.revision, 1);
      assert.equal(created.status, "DRAFT");
      await assert.rejects(() => store.getArticle(otherWriter, created.id), StoreAccessDeniedError);
      assert.equal(await store.getPublicArticleBySlug(created.slug), null);
      await assert.rejects(
        () => store.saveDraft(actor, created.id, {
          slug: created.slug,
          title: created.title,
          description: "A synthetic guide for database tests.",
          categorySlug: "does-not-exist",
          content,
        }, created.revision),
        StoreValidationError,
      );

      const saved = await store.saveDraft(actor, created.id, {
        slug: created.slug,
        title: created.title,
        description: "A synthetic guide for database tests.",
        categorySlug: "food",
        content,
        draftProductLinks: [
          { providerId: "provider-a", productId: "tea" },
          { providerId: "provider-a", productId: "tea-two" },
        ],
      }, created.revision);
      assert.equal(saved.revision, 2);
      const reordered = await store.saveDraft(actor, created.id, {
        slug: saved.slug,
        title: saved.title,
        description: saved.description,
        categorySlug: "food",
        content: saved.content,
        draftProductLinks: [
          { providerId: "provider-a", productId: "tea-two" },
          { providerId: "provider-a", productId: "tea" },
        ],
      }, saved.revision);
      assert.deepEqual(reordered.draftProductLinks, [
        { providerId: "provider-a", productId: "tea-two" },
        { providerId: "provider-a", productId: "tea" },
      ]);
      const publicationDraft = await store.saveDraft(actor, created.id, {
        slug: reordered.slug,
        title: reordered.title,
        description: reordered.description,
        categorySlug: "food",
        content: reordered.content,
        draftProductLinks: [{ providerId: "provider-a", productId: "tea" }],
      }, reordered.revision);
      await assert.rejects(
        () => store.saveDraft(actor, created.id, {
          slug: created.slug,
          title: "Stale overwrite",
          description: saved.description,
          categorySlug: "food",
          content,
        }, created.revision),
        StoreConflictError,
      );

      const unlisted = await store.commitPublication(actor, created.id, {
        expectedRevision: publicationDraft.revision,
        visibility: "UNLISTED",
      });
      assert.equal(unlisted.indexable, false);
      assert.equal(unlisted.category.labelEn, "Food");
      assert.deepEqual(unlisted.productLinks, [{ providerId: "provider-a", productId: "tea", productSlug: "tea" }]);
      assert.equal((await store.listPublicArticles()).length, 0);
      assert.equal((await store.getPublicArticleBySlug(created.slug))?.title, "Synthetic guide");

      const afterPublish = await store.getArticle(actor, created.id);
      const edited = await store.saveDraft(actor, created.id, {
        slug: created.slug,
        title: "Unpublished newer draft",
        description: saved.description,
        categorySlug: "food",
        content: { ...content, markdown: `${content.markdown}\n\nA private edit.` },
      }, afterPublish.revision);
      assert.deepEqual(edited.draftProductLinks, [{ providerId: "provider-a", productId: "tea" }]);
      assert.equal((await store.getPublicArticleBySlug(created.slug))?.title, "Synthetic guide");
      await assert.rejects(
        () => store.saveDraft(actor, created.id, {
          slug: "changed-after-publication",
          title: edited.title,
          description: edited.description,
          categorySlug: "food",
          content: edited.content,
        }, edited.revision),
        StoreConflictError,
      );

      const publicationCount = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM guide_publications WHERE article_id=$1",
        [created.id],
      );
      await assert.rejects(
        () => store.saveDraft(actor, created.id, {
          slug: edited.slug,
          title: edited.title,
          description: edited.description,
          categorySlug: "food",
          content: edited.content,
          draftProductLinks: [
            { providerId: "provider-a", productId: "tea" },
            { providerId: "provider-b", productId: "draft-product" },
          ],
        }, edited.revision),
        StoreNotFoundError,
      );
      assert.equal(
        (await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM guide_publications WHERE article_id=$1",
          [created.id],
        )).rows[0]?.count,
        publicationCount.rows[0]?.count,
      );

      const listed = await store.commitPublication(actor, created.id, {
        expectedRevision: edited.revision,
        visibility: "PUBLIC",
      });
      assert.equal(listed.publicationNumber, 2);
      assert.equal(listed.firstPublishedAtUtc, unlisted.publishedAtUtc);
      assert.equal((await store.listPublicArticles()).length, 1);
      assert.equal((await store.getPublicArticleBySlug(created.slug))?.firstPublishedAtUtc, unlisted.publishedAtUtc);
      await pool.query("UPDATE guide_categories SET label_en='Food and drink', active=false WHERE slug='food'");
      assert.equal((await store.getPublicArticleBySlug(created.slug))?.category.labelEn, "Food");
      await pool.query("UPDATE guide_categories SET active=true WHERE slug='food'");

      const linkAudit = await pool.query<{ link_created_by_niho_user_id: string; permission_basis: string }>(
        `SELECT link_created_by_niho_user_id, permission_basis
           FROM guide_publication_product_links WHERE publication_id=$1`,
        [listed.publicationId],
      );
      assert.deepEqual(linkAudit.rows[0], {
        link_created_by_niho_user_id: "writer-a",
        permission_basis: "GUIDE_PRODUCT_LINK_MEMBERSHIP",
      });
      await pool.query("UPDATE guide_writer_grants SET active=false WHERE niho_user_id='writer-a'");
      assert.deepEqual((await store.getPublicArticleBySlug(created.slug))?.productLinks, []);
      await pool.query("UPDATE guide_writer_grants SET active=true WHERE niho_user_id='writer-a'");
      assert.deepEqual((await store.getPublicArticleBySlug(created.slug))?.productLinks, [
        { providerId: "provider-a", productId: "tea", productSlug: "tea" },
      ]);
      await pool.query(
        `INSERT INTO experience_products (
           provider_id, id, slug, status, public_title, content, currency, unit_amount,
           cancellation_terms_ref, seller_niho_account_ref, stripe_connect_account_ref, seller_display_name
         ) VALUES ('provider-b','same-slug','tea','PUBLISHED','Other synthetic tea','{}','JPY',1000,'terms','seller','acct_synthetic_b','Synthetic Seller')`,
      );
      assert.deepEqual((await store.getPublicArticleBySlug(created.slug))?.productLinks, []);
      assert.deepEqual((await store.listPublicArticles())[0]?.productLinks, []);
      await pool.query("UPDATE experience_products SET slug='other-tea' WHERE provider_id='provider-b' AND id='same-slug'");
      assert.deepEqual((await store.getPublicArticleBySlug(created.slug))?.productLinks, [
        { providerId: "provider-a", productId: "tea", productSlug: "tea" },
      ]);
      await pool.query(
        "UPDATE guide_product_link_memberships SET active=false WHERE provider_id='provider-a' AND niho_user_id='writer-a'",
      );
      assert.deepEqual((await store.getPublicArticleBySlug(created.slug))?.productLinks, []);
      const expiredPermissionDraft = await store.getArticle(actor, created.id);
      const retained = await store.saveDraft(actor, created.id, {
        slug: expiredPermissionDraft.slug,
        title: "Retained while link permission is unavailable",
        description: expiredPermissionDraft.description,
        categorySlug: "food",
        content: expiredPermissionDraft.content,
      }, expiredPermissionDraft.revision);
      assert.deepEqual(retained.draftProductLinks, [{ providerId: "provider-a", productId: "tea" }]);
      await assert.rejects(
        () => store.commitPublication(actor, created.id, {
          expectedRevision: retained.revision,
          visibility: "PUBLIC",
        }),
        StoreAccessDeniedError,
      );
      assert.equal((await store.getPublicArticleBySlug(created.slug))?.publicationId, listed.publicationId);
      await assert.rejects(
        () => store.saveDraft(actor, created.id, {
          slug: retained.slug,
          title: "Must roll back",
          description: retained.description,
          categorySlug: "food",
          content: retained.content,
          draftProductLinks: [
            ...retained.draftProductLinks,
            { providerId: "provider-b", productId: "walk" },
          ],
        }, retained.revision),
        StoreAccessDeniedError,
      );
      assert.equal((await store.getArticle(actor, created.id)).title, retained.title);
      const removed = await store.saveDraft(actor, created.id, {
        slug: retained.slug,
        title: retained.title,
        description: retained.description,
        categorySlug: "food",
        content: retained.content,
        draftProductLinks: [],
      }, retained.revision);
      assert.deepEqual(removed.draftProductLinks, []);

      const host = { nihoUserId: "host-a" } as const;
      await pool.query(
        "UPDATE provider_memberships SET role='OWNER' WHERE provider_id='provider-b' AND niho_user_id='host-a'",
      );
      const hostArticle = await store.createArticle(host, {
        id: "host-guide",
        slug: "host-guide",
        subject: { kind: "PROVIDER", providerId: "provider-a" },
        title: "Host guide",
        categorySlug: "culture",
        description: "A synthetic host guide.",
        content,
      });
      assert.deepEqual(await store.listLinkableProducts(host, hostArticle.subject), [
        { providerId: "provider-a", productId: "tea", publicTitle: "Synthetic tea" },
        { providerId: "provider-a", productId: "tea-two", publicTitle: "Synthetic tea two" },
      ]);
      await assert.rejects(
        () => store.saveDraft(host, hostArticle.id, {
          slug: hostArticle.slug,
          title: hostArticle.title,
          description: hostArticle.description,
          categorySlug: "culture",
          content: hostArticle.content,
          draftProductLinks: [{ providerId: "provider-b", productId: "walk" }],
        }, hostArticle.revision),
        StoreValidationError,
      );
      const linkedHostArticle = await store.saveDraft(host, hostArticle.id, {
        slug: hostArticle.slug,
        title: hostArticle.title,
        description: hostArticle.description,
        categorySlug: "culture",
        content: hostArticle.content,
        draftProductLinks: [{ providerId: "provider-a", productId: "tea" }],
      }, hostArticle.revision);
      const hostPublication = await store.commitPublication(host, hostArticle.id, {
        expectedRevision: linkedHostArticle.revision,
        visibility: "PUBLIC",
      });
      assert.deepEqual(hostPublication.productLinks, [{ providerId: "provider-a", productId: "tea", productSlug: "tea" }]);
      await pool.query(
        "UPDATE provider_memberships SET active=false WHERE provider_id='provider-a' AND niho_user_id='host-a'",
      );
      assert.deepEqual((await store.getPublicArticleBySlug(hostArticle.slug))?.productLinks, []);

      await assert.rejects(
        () => pool.query("UPDATE guide_publications SET title='mutated' WHERE id=$1", [listed.publicationId]),
        /immutable/,
      );
      await assert.rejects(
        () => pool.query(
          `INSERT INTO guide_publication_product_links (
             article_id, publication_id, provider_id, product_id,
             link_created_by_niho_user_id, permission_basis
           ) VALUES ($1,$2,'provider-b','walk','writer-a','GUIDE_PRODUCT_LINK_MEMBERSHIP')`,
          [created.id, listed.publicationId],
        ),
        /immutable/,
      );

      const current = await store.getArticle(actor, created.id);
      const stopped = await store.stopPublication(actor, created.id, current.revision);
      assert.equal(stopped.status, "STOPPED");
      assert.equal(await store.getPublicArticleBySlug(created.slug), null);
      assert.equal(
        (await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM guide_publications WHERE article_id=$1",
          [created.id],
        )).rows[0]?.count,
        "2",
      );
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      await pool.end();
    }
  });
});
