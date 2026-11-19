import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ArticleAuthorityRepository } from "../src/article-authority.ts";
import { HostAccountIdentities } from "../src/host-account-identities.ts";
import { StoreAccessDeniedError, StoreGuideProductLinkUnavailableError, StorePermissionDeniedError } from "../src/errors.ts";
import { GuideRepository, type GuideWriterAuthority } from "../src/guides.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const writerActor = `hst_${"1".repeat(32)}`;
const otherActor = `hst_${"2".repeat(32)}`;
const ownerActor = `hst_${"3".repeat(32)}`;
const assetId = "00000000-0000-4000-8000-000000000481";
const content = {
  language: "en",
  markdown: "## A writer route\n\nThis synthetic paragraph is long enough to become the public description.",
  author: { name: "Synthetic Writer", role: "Writer", bio: "A synthetic profile used only by this disposable test." },
} as const;

describe("NIHO-authorized personal guide writer", { skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false }, () => {
  it("binds every mutation and public association to current writer, inviter OWNER, and published product authority", async () => {
    const database = await createIsolatedDatabase(databaseUrl, "guide_writer_481");
    const { pool } = database;
    let authority: GuideWriterAuthority | Error = {
      writer: true,
      links: [{ providerId: "provider-a", inviterNihoUserId: "niho-owner" }],
    };
    const repository = new GuideRepository(pool, {
      writerAuthority: async (actorId, providerIds, queryable) => {
        assert.equal(actorId, writerActor);
        assert.equal(await new HostAccountIdentities(pool).readNihoUserId({ hostAccountId: actorId }, queryable), "niho-writer");
        assert.deepEqual(providerIds, [...new Set(providerIds)].sort());
        if (authority instanceof Error) throw authority;
        return authority;
      },
    });
    try {
      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a')");
      await pool.query(
        `INSERT INTO host_accounts (id,email,email_key,created_at,updated_at)
         VALUES ($1,NULL,NULL,clock_timestamp(),clock_timestamp()),
                ($2,'owner@example.test','owner@example.test',clock_timestamp(),clock_timestamp())`,
        [writerActor, ownerActor],
      );
      await pool.query(
        `INSERT INTO host_account_identities (host_account_id,provider,subject,linked_via,linked_at,last_login_at)
         VALUES ($1,'NIHO','niho-writer','WRITER',clock_timestamp(),clock_timestamp()),
                ($2,'NIHO','niho-owner','OPS',clock_timestamp(),clock_timestamp())`,
        [writerActor, ownerActor],
      );
      await pool.query(
        "INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES ('provider-a',$1,'OWNER',true)",
        [ownerActor],
      );
      await pool.query(
        `INSERT INTO experience_products
           (provider_id,id,slug,status,public_title,content,currency,unit_amount,
            cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
         VALUES ('provider-a','tea','writer-tea','PUBLISHED','Writer tea','{}','JPY',1000,
                 'terms','seller-a','acct_SyntheticA','Synthetic Seller')`,
      );
      await pool.query(
        "INSERT INTO guide_categories (slug,label_en,label_ja,display_order,active) VALUES ('culture','Culture','文化',10,true)",
      );

      const articleAuthority = new ArticleAuthorityRepository(pool);
      assert.equal(await articleAuthority.providerNameForOwner("provider-a", "niho-owner"), "Synthetic Seller");
      assert.deepEqual(await articleAuthority.ownedProviderIds("niho-owner"), ["provider-a"]);
      assert.deepEqual((await articleAuthority.activeOwnerIds(["provider-a"])).get("provider-a"), new Set(["niho-owner"]));

      const created = await repository.createArticle(writerActor, {
        id: "writer-guide",
        slug: "writer-guide",
        subject: { kind: "WRITER" },
        title: "A personal writer guide",
        categorySlug: "culture",
        content,
      });
      assert.deepEqual(created.subject, { kind: "WRITER" });
      await assert.rejects(() => repository.getArticle(otherActor, created.id), StoreAccessDeniedError);

      const uploaded = await repository.createMediaAsset(writerActor, created.id, { id: assetId, objectKey: `private/guides/${assetId}.jpg` });
      assert.equal(uploaded.creatorNihoUserId, writerActor);
      await repository.markMediaAssetReady(writerActor, created.id, assetId, { width: 1200, height: 800, byteSize: 4096 });

      const saved = await repository.saveDraft(writerActor, created.id, {
        slug: created.slug,
        title: created.title,
        description: "",
        categorySlug: "culture",
        content,
        draftProductLinks: [{ providerId: "provider-a", productId: "tea" }],
      }, created.revision);
      const published = await repository.commitPublication(writerActor, created.id, { expectedRevision: saved.revision, visibility: "PUBLIC" });
      assert.deepEqual(published.productLinks, [{ providerId: "provider-a", productId: "tea", productSlug: "writer-tea" }]);
      assert.deepEqual((await repository.getPublicArticleBySlug(created.slug))?.productLinks, published.productLinks);

      authority = { writer: false, links: [] };
      assert.equal((await repository.getArticle(writerActor, created.id)).id, created.id, "revocation must not hide the preserved draft");
      await assert.rejects(
        () => repository.saveDraft(writerActor, created.id, {
          slug: saved.slug, title: "Revoked overwrite", description: saved.description,
          categorySlug: "culture", content: saved.content, draftProductLinks: saved.draftProductLinks,
        }, published.sourceRevision + 1),
        StorePermissionDeniedError,
      );
      await assert.rejects(() => repository.stopPublication(writerActor, created.id, published.sourceRevision + 1), StorePermissionDeniedError);
      assert.deepEqual((await repository.getPublicArticleBySlug(created.slug))?.productLinks, []);

      authority = new Error("synthetic NIHO outage");
      assert.deepEqual((await repository.getPublicArticleBySlug(created.slug))?.productLinks, [], "authority outage hides only the association");
      const providerRepository = new GuideRepository(pool, { writerAuthority: async () => { throw authority; } });
      const providerArticle = await providerRepository.createArticle(ownerActor, {
        id: "provider-during-writer-outage", slug: "provider-during-writer-outage",
        subject: { kind: "PROVIDER", providerId: "provider-a" }, title: "Provider remains independent", content,
      });
      assert.equal(providerArticle.subject.kind, "PROVIDER");

      authority = { writer: true, links: [{ providerId: "provider-a", inviterNihoUserId: "niho-owner" }] };
      await pool.query("UPDATE provider_memberships SET active=false WHERE provider_id='provider-a' AND niho_user_id=$1", [ownerActor]);
      assert.equal(await articleAuthority.providerNameForOwner("provider-a", "niho-owner"), null);
      assert.deepEqual((await repository.getPublicArticleBySlug(created.slug))?.productLinks, []);
      await pool.query("UPDATE provider_memberships SET active=true WHERE provider_id='provider-a' AND niho_user_id=$1", [ownerActor]);
      await pool.query("UPDATE experience_products SET status='ARCHIVED' WHERE provider_id='provider-a' AND id='tea'");
      assert.deepEqual((await repository.getPublicArticleBySlug(created.slug))?.productLinks, []);
      const latest = await repository.getArticle(writerActor, created.id);
      const edit = {
        slug: latest.slug, title: "Updated after unlink", description: latest.description,
        categorySlug: "culture", content: latest.content,
      };
      await assert.rejects(
        () => repository.saveDraft(writerActor, created.id, { ...edit, draftProductLinks: latest.draftProductLinks }, latest.revision),
        StoreGuideProductLinkUnavailableError,
      );
      const updated = await repository.saveDraft(writerActor, created.id, { ...edit, draftProductLinks: [] }, latest.revision);
      assert.equal(updated.title, edit.title);
      assert.deepEqual(updated.draftProductLinks, []);
    } finally {
      await database.dispose();
    }
  });
});
