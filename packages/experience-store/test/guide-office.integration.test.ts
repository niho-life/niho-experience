import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StoreAccessDeniedError } from "../src/errors.ts";
import { adminActorIdForGoogleSubject } from "../src/admin-sessions.ts";
import { GuideRepository } from "../src/guides.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";

/** 運営の CLI (#576 ⑤): the office writes articles for a provider; a provider's own repository never takes an office actor. Synthetic data only. */
const databaseUrl = process.env.TEST_DATABASE_URL;
const ADMIN = adminActorIdForGoogleSubject("100000000000000000001");
const owner = "hst_synthetic_office_owner";
const author = { name: "NIHO kamakura", role: "運営", bio: "合成のテスト用の紹介です。" } as const;
const markdown = "## 屋根の下で\n\n雨の日は、手を動かす体験がいいです。";

describe("office-written guides (#576)", { skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false }, () => {
  it("writes, publishes and stops an article for a provider without being a member, and keeps the host-facing repository closed to it", async () => {
    const db = await createIsolatedDatabase(databaseUrl, "guide_office", { max: 4 });
    try {
      const pool = db.pool;
      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a'),('provider-b')");
      await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES ('provider-a',$1,'OWNER',true)", [owner]);
      await pool.query("INSERT INTO guide_categories (slug,label_en,label_ja,display_order,active) VALUES ('walks','Walks','歩く',10,true)");
      const office = new GuideRepository(pool, { office: true });
      const host = new GuideRepository(pool);

      // Any provider that exists, with the office's own admin ID as the creator.
      const created = await office.createArticle(ADMIN, { id: "office-guide", slug: "office-guide", subject: { kind: "PROVIDER", providerId: "provider-b" }, title: "雨の日の鎌倉", categorySlug: "walks", content: { language: "ja", markdown, author } });
      assert.equal(created.subject.kind === "PROVIDER" && created.subject.providerId, "provider-b");
      const saved = await office.saveDraft(ADMIN, created.id, { slug: created.slug, title: created.title, description: "雨の日の過ごし方。", categorySlug: "walks", content: { language: "ja", markdown, author } }, created.revision);
      assert.deepEqual((await office.listArticles(ADMIN)).map((article) => article.id), ["office-guide"]);

      // A provider's OWNER does not see it, and the host-facing repository refuses the admin ID.
      assert.deepEqual(await host.listArticles(owner), []);
      await assert.rejects(() => host.getArticle(owner, created.id), StoreAccessDeniedError);
      await assert.rejects(() => host.getArticle(ADMIN, created.id), StoreAccessDeniedError);
      await assert.rejects(() => host.createArticle(ADMIN, { id: "x", slug: "x", subject: { kind: "PROVIDER", providerId: "provider-b" }, title: "雨", content: { language: "ja", markdown, author } }), StoreAccessDeniedError);

      // The office takes only admin IDs and providers that exist.
      await assert.rejects(() => office.getArticle(owner, created.id), StoreAccessDeniedError);
      await assert.rejects(() => office.createArticle(ADMIN, { id: "ghost", slug: "ghost", subject: { kind: "PROVIDER", providerId: "no-such-provider" }, title: "雨", content: { language: "ja", markdown, author } }), StoreAccessDeniedError);
      await assert.rejects(() => office.listArticles(owner), StoreAccessDeniedError);

      const published = await office.commitPublication(ADMIN, created.id, { expectedRevision: saved.revision, visibility: "PUBLIC" });
      assert.equal(published.content.language, "ja");
      assert.equal((await host.getPublicArticleBySlug("office-guide"))?.title, "雨の日の鎌倉");
      const stopped = await office.stopPublication(ADMIN, created.id, (await office.getArticle(ADMIN, created.id)).revision);
      assert.notEqual(stopped.status, "PUBLISHED");
      assert.equal(await host.getPublicArticleBySlug("office-guide"), null);
    } finally {
      await db.dispose();
    }
  });
});
