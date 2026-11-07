import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { StoreValidationError } from "../src/errors.ts";
import { GuideRepository, parseGuideContent } from "../src/guides.ts";

describe("guide CMS schema", () => {
  it("adds provider-owned draft flexibility, immutable upload actors, and operations stop state", async () => {
    const sql = await readFile(new URL("../migrations/0067_guide_provider_ownership.sql", import.meta.url), "utf8");
    assert.match(sql, /^BEGIN;/);
    assert.match(sql, /COMMIT;\s*$/);
    assert.match(sql, /length\(title\) BETWEEN 0 AND 110/);
    assert.match(sql, /length\(cover_alt\) BETWEEN 0 AND 300/);
    assert.match(sql, /status IN \('DRAFT', 'PUBLISHED', 'STOPPED', 'OPS_STOPPED'\)/);
    assert.match(sql, /ADD COLUMN ops_stop_reason text/);
    assert.match(sql, /ADD COLUMN ops_stop_contact text/);
    assert.match(sql, /ADD COLUMN uploaded_by_actor_id text/);
    assert.match(sql, /DISABLE TRIGGER guide_media_assets_protect/);
    assert.match(sql, /SET uploaded_by_actor_id = creator_niho_user_id/);
    assert.match(sql, /ENABLE TRIGGER guide_media_assets_protect/);
    assert.match(sql, /ALTER COLUMN uploaded_by_actor_id SET NOT NULL/);
    assert.match(sql, /NEW\.uploaded_by_actor_id IS DISTINCT FROM OLD\.uploaded_by_actor_id/);
  });

  it("adds versioned guide administration and append-only minimal receipts", async () => {
    const sql = await readFile(new URL("../migrations/0012_guide_admin.sql", import.meta.url), "utf8");
    assert.match(sql, /^BEGIN;/);
    assert.match(sql, /COMMIT;\s*$/);
    assert.match(sql, /ADD COLUMN source_version bigint NOT NULL DEFAULT 0/);
    assert.match(sql, /ADD COLUMN source_invitation_id uuid/);
    assert.match(sql, /ADD COLUMN revision bigint NOT NULL DEFAULT 1/);
    assert.match(sql, /CREATE TABLE guide_admin_command_receipts/);
    assert.match(sql, /idempotency_key uuid PRIMARY KEY/);
    assert.match(sql, /request_hash char\(64\)/);
    assert.match(sql, /guide admin command receipts are append-only/);
    const receipt = sql.match(/CREATE TABLE guide_admin_command_receipts \(([\s\S]*?)\n\);/)?.[1] ?? "";
    assert.doesNotMatch(receipt, /email|name\b|token|invitation_body|profile/i);
  });

  it("adds ordered article draft links without private identity fields", async () => {
    const sql = await readFile(new URL("../migrations/0011_guide_draft_product_links.sql", import.meta.url), "utf8");
    assert.match(sql, /^BEGIN;/);
    assert.match(sql, /COMMIT;\s*$/);
    assert.match(sql, /CREATE TABLE guide_draft_product_links/);
    assert.match(sql, /PRIMARY KEY \(article_id, provider_id, product_id\)/);
    assert.match(sql, /UNIQUE \(article_id, display_order\)/);
    assert.match(sql, /display_order BETWEEN 1 AND 3/);
    assert.match(sql, /FOREIGN KEY \(provider_id, product_id\)[\s\S]*experience_products/);
    assert.match(sql, /ALTER TABLE guide_publication_product_links[\s\S]*ADD COLUMN display_order smallint/);
    assert.match(sql, /ON guide_publication_product_links \(publication_id, display_order\)/);
    assert.doesNotMatch(sql, /niho_user|email|display_name|profile/i);
  });

  it("adds immutable figure rights and ordered publication slots in a forward migration", async () => {
    const sql = await readFile(new URL("../migrations/0010_guide_body_media.sql", import.meta.url), "utf8");
    assert.match(sql, /^BEGIN;/);
    assert.match(sql, /COMMIT;\s*$/);
    assert.match(sql, /public_credit text/);
    assert.match(sql, /web_confirmed_at timestamptz/);
    assert.match(sql, /web_confirmed_by_niho_user_id text/);
    assert.match(sql, /ADD PRIMARY KEY \(publication_id, slot\)/);
    assert.match(sql, /placement = 'COVER' AND slot = 0/);
    assert.match(sql, /placement = 'FIGURE' AND slot BETWEEN 1 AND 10/);
    assert.match(sql, /guide publication media snapshots are immutable/);
    assert.doesNotMatch(sql, /https?:\/\/|signed_url|gcs_url|object_key\s+text/i);
  });

  it("adds private media assets and immutable publication snapshots without editing the CMS base migration", async () => {
    const sql = await readFile(new URL("../migrations/0009_guide_media.sql", import.meta.url), "utf8");
    assert.match(sql, /^BEGIN;/);
    assert.match(sql, /COMMIT;\s*$/);
    assert.match(sql, /CREATE TABLE guide_media_assets/);
    assert.match(sql, /state IN \('UPLOADING', 'READY', 'REVOKED'\)/);
    assert.match(sql, /CREATE TABLE guide_publication_media/);
    assert.match(sql, /guide publication media snapshots are immutable/);
    assert.match(sql, /cover_web_confirmed/);
    assert.doesNotMatch(sql, /https?:\/\/|signed_url|gcs_url/i);
  });

  it("stores article-link invitation consent without private identity fields", async () => {
    const sql = await readFile(new URL("../migrations/0008_guide_link_invitations.sql", import.meta.url), "utf8");
    assert.match(sql, /^BEGIN;/);
    assert.match(sql, /COMMIT;\s*$/);
    assert.match(sql, /CREATE TABLE guide_product_link_invitations/);
    assert.match(sql, /UNIQUE \(provider_id, writer_niho_user_id\)/);
    assert.match(sql, /generation integer NOT NULL DEFAULT 1 CHECK \(generation > 0\)/);
    assert.match(sql, /'PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED'/);
    const invitation = sql.match(/CREATE TABLE guide_product_link_invitations \(([\s\S]*?)\n\);/)?.[1] ?? "";
    assert.doesNotMatch(invitation, /email|display_name|profile|provider_memberships\s*\(/i);
  });

  it("keeps grants separate and seals immutable publication snapshots with their links", async () => {
    const sql = await readFile(new URL("../migrations/0005_guide_cms.sql", import.meta.url), "utf8");
    assert.match(sql, /^BEGIN;/);
    assert.match(sql, /COMMIT;\s*$/);
    assert.match(sql, /CREATE TABLE guide_writer_grants/);
    assert.match(sql, /CREATE TABLE guide_product_link_memberships/);
    assert.doesNotMatch(sql, /invite_email|invitation_token|pending_invite/i);
    assert.match(sql, /guide publication snapshots are immutable/);
    assert.match(sql, /guide publication links are immutable/);
    assert.match(sql, /a published guide slug is immutable/);
    assert.match(sql, /UNIQUE[\s\S]*\(slug\)/);
    assert.match(sql, /permission_basis IN \('PROVIDER_MEMBERSHIP', 'GUIDE_PRODUCT_LINK_MEMBERSHIP'\)/);
    assert.match(sql, /FOREIGN KEY \(provider_id, product_id\)[\s\S]*experience_products/);
  });

  it("stores category labels in the immutable publication rather than depending on current labels", async () => {
    const sql = await readFile(new URL("../migrations/0005_guide_cms.sql", import.meta.url), "utf8");
    const publication = sql.match(/CREATE TABLE guide_publications \(([\s\S]*?)\n\);/)?.[1] ?? "";
    assert.match(publication, /category_slug/);
    assert.match(publication, /category_label_en/);
    assert.match(publication, /category_label_ja/);
    assert.match(publication, /category_display_order/);
  });
});

describe("guide content boundary", () => {
  it("accepts Markdown and public author metadata without producing HTML", () => {
    assert.deepEqual(
      parseGuideContent({
        markdown: "## A synthetic walk\n\nPlain text.",
        language: "en",
        author: { name: "Synthetic Writer", role: "Guide", bio: "Writes synthetic test guides." },
        checkedOn: "2026-10-29",
      }),
      {
        markdown: "## A synthetic walk\n\nPlain text.",
        language: "en",
        author: { name: "Synthetic Writer", role: "Guide", bio: "Writes synthetic test guides." },
        checkedOn: "2026-10-29",
      },
    );
  });

  it("rejects arbitrary HTML fields and malformed author/date values", () => {
    assert.throws(() => parseGuideContent({ markdown: "safe", html: "<script>bad()</script>" }), StoreValidationError);
    assert.throws(() => parseGuideContent({ markdown: "safe", checkedOn: "29/10/2026" }), StoreValidationError);
    assert.throws(() => parseGuideContent({ markdown: "safe", checkedOn: "2026-02-30" }), StoreValidationError);
    assert.throws(() => parseGuideContent({ markdown: "safe", author: { name: "A", role: "B" } }), StoreValidationError);
    assert.throws(() => parseGuideContent({ markdown: "safe", language: "ja" }), StoreValidationError);
  });

  it("rejects unsafe or malformed Markdown before opening a database transaction", async () => {
    const pool = { async connect() { throw new Error("database must not be reached"); } } as unknown as Pool;
    const repository = new GuideRepository(pool);
    const input = (markdown: string) => repository.createArticle("hst_synthetic_owner", {
      id: "unsafe-guide",
      slug: "unsafe-guide",
      subject: { kind: "PROVIDER" as const, providerId: "provider-a" },
      title: "Unsafe guide",
      content: { language: "en" as const, markdown },
    });
    await assert.rejects(() => input("## Unsafe\n\n<script>bad()</script>"), StoreValidationError);
    await assert.rejects(() => input("## Unsafe\n\n[broken link](javascript:bad())"), StoreValidationError);
    await assert.rejects(() => input("## Unsafe\n\n**unclosed emphasis*"), StoreValidationError);
  });
});

describe("public guide reads", () => {
  it("batch-loads links and media for the whole list instead of querying once per article", async () => {
    const dataQueries: string[] = [];
    const publication = (id: number, slug: string) => ({
      article_id: `article-${id}`,
      publication_id: id,
      publication_number: 1,
      source_revision: 2,
      slug,
      subject_kind: "WRITER",
      subject_provider_id: null,
      category_slug: "culture",
      category_label_en: "Culture",
      category_label_ja: "文化",
      category_display_order: 10,
      title: `Guide ${id}`,
      description: `Synthetic guide ${id}`,
      content: { markdown: "## Synthetic\n\nBody.", author: { name: "Writer", role: "Guide", bio: "Synthetic." } },
      visibility: "PUBLIC",
      first_published_at: "2026-10-28T00:00:00.000Z",
      published_at: "2026-10-29T00:00:00.000Z",
    });
    const client = {
      async query(text: string) {
        if (text === "BEGIN" || text.startsWith("SET LOCAL") || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
        dataQueries.push(text);
        if (text.includes("FROM guide_articles a")) return { rows: [publication(1, "guide-one"), publication(2, "guide-two")] };
        if (text.includes("FROM guide_publication_product_links")) {
          return { rows: [
            { publication_id: 1, provider_id: "provider-a", product_id: "product-a", product_slug: "experience-a" },
            { publication_id: 2, provider_id: "provider-b", product_id: "product-b", product_slug: "experience-b" },
          ] };
        }
        if (text.includes("FROM guide_publication_media")) return { rows: [
          { publication_id: 1, slot: 0, placement: "COVER", asset_id: "00000000-0000-4000-8000-000000000001", alt_text: "Cover", public_credit: "Synthetic", width: 1200, height: 800 },
          { publication_id: 2, slot: 1, placement: "FIGURE", asset_id: "00000000-0000-4000-8000-000000000002", alt_text: "Figure", public_credit: "Synthetic", width: 900, height: 600 },
        ] };
        throw new Error(`Unexpected query: ${text}`);
      },
      release() {},
    };
    const pool = { async connect() { return client; } } as unknown as Pool;
    const articles = await new GuideRepository(pool).listPublicArticles();

    assert.equal(dataQueries.length, 3);
    assert.deepEqual(articles.map((article) => article.productLinks[0]?.productSlug), ["experience-a", "experience-b"]);
    assert.equal(articles[0]?.cover?.width, 1200);
    assert.equal(articles[1]?.figures[0]?.slot, 1);
  });

  it("limits a public media object to a READY asset in the current sealed publication", async () => {
    const queries: Array<{ text: string; values: readonly unknown[] }> = [];
    const pool = {
      async query(text: string, values: readonly unknown[]) {
        queries.push({ text, values });
        return { rows: [] };
      },
    } as unknown as Pool;
    const repository = new GuideRepository(pool);

    assert.equal(await repository.getPublicMediaAsset("00000000-0000-4000-8000-000000000189"), null);
    assert.match(queries[0]?.text ?? "", /state='READY'/);
    assert.match(queries[0]?.text ?? "", /article\.current_publication_id/);
    assert.match(queries[0]?.text ?? "", /publication\.sealed=true/);
    assert.match(queries[0]?.text ?? "", /article\.status='PUBLISHED'/);
    assert.deepEqual(queries[0]?.values, ["00000000-0000-4000-8000-000000000189"]);
    await assert.rejects(() => repository.getPublicMediaAsset("not-a-uuid"), StoreValidationError);
    assert.equal(queries.length, 1);
  });
});
