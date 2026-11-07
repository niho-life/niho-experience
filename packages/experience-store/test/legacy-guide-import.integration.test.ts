import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { GuideRepository } from "../src/guides.ts";
import {
  importLegacyGuide,
  LegacyGuideImportError,
  type LegacyGuideSource,
} from "../src/legacy-guide-import.ts";

const { kamakuraAfter4Pm } = await import(
  new URL("../../../apps/web/src/content/guides/kamakura-after-4-pm.ts", import.meta.url).href
) as { kamakuraAfter4Pm: LegacyGuideSource };

const databaseUrl = process.env.TEST_DATABASE_URL;

describe("legacy Guide ops import", { skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false }, () => {
  it("dry-runs, atomically imports one UNLISTED publication, verifies retries, and rechecks OWNER authority", async () => {
    const { Pool } = await import("pg");
    const schema = `legacy_guide_import_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${schema}` });
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      const migrations = (await readdir(new URL("../migrations/", import.meta.url)))
        .filter((name) => /^\d{4}.*\.sql$/.test(name)).sort();
      for (const migration of migrations) {
        await pool.query(await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
      }
      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-import')");
      await pool.query(
        `INSERT INTO provider_memberships (provider_id,niho_user_id,role,active)
         VALUES ('provider-import','owner-import','OWNER',true),
                ('provider-import','editor-import','EDITOR',true)`,
      );
      assert.equal(Number((await pool.query("SELECT count(*) FROM guide_categories")).rows[0]!.count), 0);
      await pool.query(
        `INSERT INTO experience_products
           (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,
            seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
         VALUES ('provider-import','dinner','kamakura-community-dinner','PUBLISHED','Synthetic dinner','{}','JPY',5000,
                 'synthetic-terms','synthetic-seller','acct_SyntheticImport','Synthetic Seller')`,
      );
      const experiencePublication = await pool.query<{ id: string }>(
        `INSERT INTO experience_product_publications
           (provider_id,product_id,draft_version,slug,public_title,content,currency,unit_amount,cancellation_terms_ref,
            seller_niho_account_ref,stripe_connect_account_ref,seller_display_name,consent_version,published_by_niho_user_id)
         VALUES ('provider-import','dinner',1,'kamakura-community-dinner','Synthetic dinner','{}','JPY',5000,
                 'synthetic-terms','synthetic-seller','acct_SyntheticImport','Synthetic Seller','synthetic-v1','owner-import')
         RETURNING id::text`,
      );
      await pool.query(
        `INSERT INTO experience_product_publication_states
           (provider_id,product_id,current_publication_id,first_published_at)
         VALUES ('provider-import','dinner',$1,'2026-10-01T00:00:00Z')`,
        [experiencePublication.rows[0]!.id],
      );

      const input = {
        providerId: "provider-import",
        ownerId: "owner-import",
        categorySlug: "evenings",
        source: kamakuraAfter4Pm,
      } as const;
      assert.deepEqual(await importLegacyGuide(pool, { ...input, dryRun: true }), {
        outcome: "imported", dryRun: true, linkedPublishedExperienceCount: 1,
      });
      assert.equal(Number((await pool.query("SELECT count(*) FROM guide_articles")).rows[0]!.count), 0);
      assert.equal(Number((await pool.query("SELECT count(*) FROM guide_categories")).rows[0]!.count), 0);
      assert.equal(Number((await pool.query("SELECT count(*) FROM guide_legacy_slug_reservations WHERE slug='kamakura-after-4-pm'")).rows[0]!.count), 1);
      await assert.rejects(
        () => importLegacyGuide(pool, { ...input, categorySlug: "nightlife", dryRun: false }),
        (error: unknown) => error instanceof LegacyGuideImportError && /requires GUIDE_IMPORT_CATEGORY_SLUG=evenings/.test(error.message),
      );
      assert.equal(Number((await pool.query("SELECT count(*) FROM guide_categories")).rows[0]!.count), 0);

      assert.deepEqual(await importLegacyGuide(pool, { ...input, dryRun: false }), {
        outcome: "imported", dryRun: false, linkedPublishedExperienceCount: 1,
      });
      const categoryBeforeRetry = (await pool.query(
        `SELECT slug,label_en,label_ja,display_order,active,revision::int,created_at,updated_at
           FROM guide_categories`,
      )).rows;
      assert.deepEqual(categoryBeforeRetry.map(({ created_at: _created, updated_at: _updated, ...category }) => category), [{
        slug: "evenings", label_en: "Evenings", label_ja: "夕方・夜",
        display_order: 20, active: true, revision: 1,
      }]);
      const repository = new GuideRepository(pool);
      assert.deepEqual(await repository.listPublicArticles(), []);
      const imported = await repository.getPublicArticleBySlug("kamakura-after-4-pm");
      assert.ok(imported);
      assert.equal(imported.visibility, "UNLISTED");
      assert.equal(imported.indexable, false);
      assert.equal(imported.firstPublishedAtUtc, "2026-10-29T00:00:00.000Z");
      assert.equal(imported.publishedAtUtc, "2026-10-29T00:00:00.000Z");
      assert.equal(imported.content.checkedOn, "2026-10-29");
      assert.match(imported.content.markdown, /## Frequently asked questions/);
      assert.match(imported.content.markdown, /### Is everything in Kamakura closed after 4 pm\?/);
      assert.deepEqual(imported.productLinks.map((link) => link.productSlug), ["kamakura-community-dinner"]);
      assert.equal(Number((await pool.query("SELECT count(*) FROM guide_legacy_slug_reservations WHERE slug='kamakura-after-4-pm'")).rows[0]!.count), 0);

      assert.deepEqual(await importLegacyGuide(pool, { ...input, dryRun: false }), {
        outcome: "verified", dryRun: false, linkedPublishedExperienceCount: 1,
      });
      assert.deepEqual((await pool.query(
        `SELECT slug,label_en,label_ja,display_order,active,revision::int,created_at,updated_at
           FROM guide_categories`,
      )).rows, categoryBeforeRetry);
      assert.equal(Number((await pool.query("SELECT count(*) FROM guide_articles WHERE slug='kamakura-after-4-pm'")).rows[0]!.count), 1);
      assert.equal(Number((await pool.query("SELECT count(*) FROM guide_publications WHERE slug='kamakura-after-4-pm'")).rows[0]!.count), 1);

      await pool.query("UPDATE guide_categories SET active=false WHERE slug='evenings'");
      await assert.rejects(
        () => importLegacyGuide(pool, { ...input, dryRun: false }),
        (error: unknown) => error instanceof LegacyGuideImportError && /exists but is inactive/.test(error.message),
      );
      await pool.query("UPDATE guide_categories SET active=true WHERE slug='evenings'");
      await pool.query("UPDATE provider_memberships SET active=false WHERE niho_user_id='owner-import'");
      await assert.rejects(
        () => importLegacyGuide(pool, { ...input, dryRun: false }),
        (error: unknown) => error instanceof LegacyGuideImportError && /current active OWNER/.test(error.message),
      );
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });
});
