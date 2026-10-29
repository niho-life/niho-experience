import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { StoreAccessDeniedError, StoreConflictError } from "../src/errors.ts";
import { GuideRepository } from "../src/guides.ts";
import { ExperienceStore } from "../src/repository.ts";

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
] as const;

const content = {
  markdown: "## A synthetic link\n\nTest-only article content.",
  author: {
    name: "Synthetic Writer",
    role: "Test guide",
    bio: "A synthetic profile used only by the disposable database test.",
  },
  checkedOn: "2026-10-29",
} as const;

describe("PostgreSQL guide product-link invitations", { skip: databaseUrl === undefined }, () => {
  it("requires current consent and authority across invitation, projection, and public reads", async () => {
    const { Pool } = await import("pg");
    const schema = `experience_guide_invites_${randomUUID().replaceAll("-", "")}`;
    const quotedSchema = `"${schema}"`;
    const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
    try {
      await pool.query(`CREATE SCHEMA ${quotedSchema}`);
      for (const name of migrations) {
        await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      }
      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a'), ('provider-b')");
      await pool.query(
        `INSERT INTO provider_memberships (provider_id, niho_user_id, role)
         VALUES
           ('provider-a','owner-a','OWNER'),
           ('provider-a','editor-a','EDITOR'),
           ('provider-b','owner-b','OWNER')`,
      );
      await pool.query(
        `INSERT INTO experience_products (
           provider_id, id, slug, status, public_title, content, currency, unit_amount,
           cancellation_terms_ref, seller_niho_account_ref, stripe_connect_account_ref, seller_display_name
         ) VALUES
           ('provider-a','published-a','published-a','PUBLISHED','Published A','{}','JPY',1000,'terms','seller-a','acct_a','Seller A'),
           ('provider-a','draft-a','draft-a','DRAFT','Draft A','{}','JPY',1000,'terms','seller-a','acct_a','Seller A'),
           ('provider-b','published-b','published-b','PUBLISHED','Published B','{}','JPY',1000,'terms','seller-b','acct_b','Seller B')`,
      );
      await pool.query(
        `INSERT INTO guide_writer_grants (niho_user_id, granted_by_niho_user_id)
         VALUES ('writer-a','admin-synthetic'), ('writer-b','admin-synthetic')`,
      );
      await pool.query(
        "INSERT INTO guide_categories (slug, label_en, label_ja, display_order) VALUES ('culture','Culture','文化',10)",
      );

      const store = new GuideRepository(pool);
      const experienceStore = new ExperienceStore(pool);
      const owner = { nihoUserId: "owner-a" } as const;
      const editor = { nihoUserId: "editor-a" } as const;
      const writer = { nihoUserId: "writer-a" } as const;
      const otherWriter = { nihoUserId: "writer-b" } as const;

      assert.deepEqual(await store.listLinkableProducts(writer), []);
      await pool.query(
        `INSERT INTO guide_product_link_memberships (provider_id, niho_user_id, granted_by_niho_user_id)
         VALUES ('provider-a','writer-a','owner-a')`,
      );
      assert.deepEqual(await store.listLinkableProducts(writer), []);
      const uninvitedArticle = await store.createArticle(writer, {
        id: "uninvited-guide",
        slug: "uninvited-guide",
        subject: { kind: "WRITER" },
        title: "Uninvited guide",
        description: "Synthetic permission boundary test.",
        categorySlug: "culture",
        content,
      });
      await assert.rejects(
        () => store.commitPublication(writer, uninvitedArticle.id, {
          expectedRevision: uninvitedArticle.revision,
          visibility: "PUBLIC",
          productLinks: [{ providerId: "provider-a", productId: "published-a" }],
        }),
        StoreAccessDeniedError,
      );
      await pool.query(
        "DELETE FROM guide_product_link_memberships WHERE provider_id='provider-a' AND niho_user_id='writer-a'",
      );

      await assert.rejects(
        () => store.inviteProductLinkWriter(editor, "provider-a", "writer-a"),
        StoreAccessDeniedError,
      );
      await assert.rejects(
        () => store.inviteProductLinkWriter(owner, "provider-a", "writer-without-grant"),
        StoreAccessDeniedError,
      );

      const pending = await store.inviteProductLinkWriter(owner, "provider-a", "writer-a");
      assert.equal(pending.state, "PENDING");
      assert.equal(pending.generation, 1);
      assert.equal(
        (await pool.query(
          `SELECT count(*)::text AS count FROM guide_product_link_memberships
            WHERE provider_id='provider-a' AND niho_user_id='writer-a'`,
        )).rows[0]?.count,
        "0",
      );
      assert.deepEqual(await store.inviteProductLinkWriter(owner, "provider-a", "writer-a"), pending);
      assert.deepEqual(await store.listOwnPendingLinkInvitations(writer), [pending]);
      assert.deepEqual(await store.listProviderLinkInvitations(owner, "provider-a"), [pending]);
      await assert.rejects(
        () => store.listProviderLinkInvitations(editor, "provider-a"),
        StoreAccessDeniedError,
      );
      await assert.rejects(
        () => store.acceptLinkInvitation(otherWriter, pending.id, pending.generation),
        StoreAccessDeniedError,
      );
      await pool.query("UPDATE guide_writer_grants SET active=false WHERE niho_user_id='writer-a'");
      assert.deepEqual(await store.listOwnPendingLinkInvitations(writer), []);
      await assert.rejects(
        () => store.acceptLinkInvitation(writer, pending.id, pending.generation),
        StoreAccessDeniedError,
      );
      await pool.query("UPDATE guide_writer_grants SET active=true WHERE niho_user_id='writer-a'");

      const accepted = await store.acceptLinkInvitation(writer, pending.id, pending.generation);
      assert.equal(accepted.state, "ACCEPTED");
      assert.equal(
        (await pool.query(
          `SELECT active FROM guide_product_link_memberships
            WHERE provider_id='provider-a' AND niho_user_id='writer-a'`,
        )).rows[0]?.active,
        true,
      );
      assert.equal(
        await experienceStore.verifyActiveMembership({ providerId: "provider-a", nihoUserId: "writer-a" }),
        null,
      );
      await assert.rejects(
        () => experienceStore.createProduct(
          { providerId: "provider-a", nihoUserId: "writer-a" },
          {
            id: "writer-must-not-create",
            slug: "writer-must-not-create",
            status: "DRAFT",
            publicTitle: "Must not be created",
            content: {},
            currency: "JPY",
            unitAmount: 1000,
            cancellationTermsRef: "terms",
            sellerNihoAccountRef: "seller-a",
            stripeConnectAccountRef: "acct_a",
            sellerDisplayName: "Seller A",
          },
        ),
        StoreAccessDeniedError,
      );
      await assert.rejects(
        () => store.inviteProductLinkWriter(owner, "provider-a", "writer-a"),
        StoreConflictError,
      );
      assert.deepEqual(await store.listLinkableProducts(writer), [
        { providerId: "provider-a", productId: "published-a", publicTitle: "Published A" },
      ]);
      assert.deepEqual(await store.listLinkableProducts(owner), [
        { providerId: "provider-a", productId: "published-a", publicTitle: "Published A" },
      ]);
      assert.deepEqual(await store.listLinkableProducts(editor), [
        { providerId: "provider-a", productId: "published-a", publicTitle: "Published A" },
      ]);

      const article = await store.createArticle(writer, {
        id: "writer-guide",
        slug: "writer-guide",
        subject: { kind: "WRITER" },
        title: "Writer guide",
        description: "Synthetic article for invitation tests.",
        categorySlug: "culture",
        content,
      });
      await store.commitPublication(writer, article.id, {
        expectedRevision: article.revision,
        visibility: "PUBLIC",
        productLinks: [{ providerId: "provider-a", productId: "published-a" }],
      });
      assert.deepEqual((await store.getPublicArticleBySlug(article.slug))?.productLinks, [
        { providerId: "provider-a", productId: "published-a" },
      ]);

      await pool.query("UPDATE guide_writer_grants SET active=false WHERE niho_user_id='writer-a'");
      assert.deepEqual(await store.listLinkableProducts(writer), []);
      assert.deepEqual((await store.getPublicArticleBySlug(article.slug))?.productLinks, []);
      await pool.query("UPDATE guide_writer_grants SET active=true WHERE niho_user_id='writer-a'");
      assert.deepEqual((await store.getPublicArticleBySlug(article.slug))?.productLinks, [
        { providerId: "provider-a", productId: "published-a" },
      ]);

      const revoked = await store.revokeLinkInvitation(owner, pending.id);
      assert.equal(revoked.state, "REVOKED");
      assert.deepEqual(await store.listLinkableProducts(writer), []);
      assert.deepEqual((await store.getPublicArticleBySlug(article.slug))?.productLinks, []);
      assert.equal(
        (await pool.query(
          `SELECT active FROM guide_product_link_memberships
            WHERE provider_id='provider-a' AND niho_user_id='writer-a'`,
        )).rows[0]?.active,
        false,
      );

      const reinvited = await store.inviteProductLinkWriter(owner, "provider-a", "writer-a");
      assert.equal(reinvited.id, pending.id);
      assert.equal(reinvited.generation, 2);
      await assert.rejects(
        () => store.acceptLinkInvitation(writer, pending.id, pending.generation),
        StoreConflictError,
      );
      assert.equal((await store.acceptLinkInvitation(writer, reinvited.id, reinvited.generation)).state, "ACCEPTED");
      assert.deepEqual((await store.getPublicArticleBySlug(article.slug))?.productLinks, [
        { providerId: "provider-a", productId: "published-a" },
      ]);

      const writerBPending = await store.inviteProductLinkWriter(owner, "provider-a", "writer-b");
      await pool.query(
        "UPDATE provider_memberships SET active=false WHERE provider_id='provider-a' AND niho_user_id='owner-a'",
      );
      assert.deepEqual(await store.listOwnPendingLinkInvitations(otherWriter), []);
      await assert.rejects(
        () => store.acceptLinkInvitation(otherWriter, writerBPending.id, writerBPending.generation),
        StoreAccessDeniedError,
      );
      await pool.query(
        "UPDATE provider_memberships SET active=true WHERE provider_id='provider-a' AND niho_user_id='owner-a'",
      );
      assert.equal(
        (await store.declineLinkInvitation(otherWriter, writerBPending.id, writerBPending.generation)).state,
        "DECLINED",
      );
      const writerBReinvited = await store.inviteProductLinkWriter(owner, "provider-a", "writer-b");
      assert.equal(writerBReinvited.generation, 2);
      await assert.rejects(
        () => store.declineLinkInvitation(otherWriter, writerBPending.id, writerBPending.generation),
        StoreConflictError,
      );

      await store.revokeLinkInvitation(owner, reinvited.id);
      const concurrent = await store.inviteProductLinkWriter(owner, "provider-a", "writer-a");
      const race = await Promise.allSettled([
        store.acceptLinkInvitation(writer, concurrent.id, concurrent.generation),
        store.revokeLinkInvitation(owner, concurrent.id),
      ]);
      assert.ok(race.some((result) => result.status === "fulfilled"));
      const finalInvitation = (await store.listProviderLinkInvitations(owner, "provider-a"))
        .find((invitation) => invitation.writerNihoUserId === "writer-a");
      assert.equal(finalInvitation?.state, "REVOKED");
      assert.equal(
        (await pool.query(
          `SELECT active FROM guide_product_link_memberships
            WHERE provider_id='provider-a' AND niho_user_id='writer-a'`,
        )).rows[0]?.active,
        false,
      );
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      await pool.end();
    }
  });
});
