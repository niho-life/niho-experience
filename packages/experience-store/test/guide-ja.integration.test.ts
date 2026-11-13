import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { StoreValidationError } from "../src/errors.ts";
import { GuideRepository } from "../src/guides.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrations = [
  "0001_experience_store.sql", "0002_google_oauth.sql", "0003_google_busy_coverage.sql", "0004_host_push_subscriptions.sql",
  "0005_guide_cms.sql", "0006_calendar_commands_and_sales_state.sql", "0007_channel_runtime.sql", "0008_guide_link_invitations.sql",
  "0009_guide_media.sql", "0010_guide_body_media.sql", "0011_guide_draft_product_links.sql", "0067_guide_provider_ownership.sql",
] as const;
const owner = "hst_synthetic_ja_owner";
const author = { name: "合成 花子", role: "合成のホスト", bio: "使い捨てのDBテスト用の紹介です。" } as const;

/** 読みもの (#154): a guide written in Japanese publishes for the Japanese site and the English rules stay as they were. */
describe("Japanese guides in the CMS (#154)", { skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false }, () => {
  it("publishes an article declared Japanese when its title and body are Japanese, and keeps the English article's Latin-script rule", async () => {
    const { Pool } = await import("pg");
    const schema = `experience_guide_ja_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${schema}` });
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      for (const migration of migrations) await pool.query(await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a')");
      await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES ('provider-a',$1,'OWNER',true)", [owner]);
      await pool.query("INSERT INTO guide_categories (slug,label_en,label_ja,display_order,active) VALUES ('walks','Walks','歩く',10,true)");
      const repository = new GuideRepository(pool);

      const draft = await repository.createArticle(owner, {
        id: "ja-guide", slug: "ja-guide", subject: { kind: "PROVIDER", providerId: "provider-a" },
        title: "雨の日の鎌倉", categorySlug: "walks",
        content: { language: "ja", markdown: "## 屋根の下で\n\n雨の日は、手を動かす体験がいいです。", author },
      });
      assert.equal(draft.content.language, "ja");
      const saved = await repository.saveDraft(owner, draft.id, {
        slug: draft.slug, title: draft.title, description: "雨の日の過ごし方。", categorySlug: "walks",
        content: { language: "ja", markdown: "## 屋根の下で\n\n雨の日は、手を動かす体験がいいです。", author },
      }, draft.revision);
      const published = await repository.commitPublication(owner, draft.id, { expectedRevision: saved.revision, visibility: "PUBLIC" });
      assert.equal(published.content.language, "ja");
      assert.equal(published.title, "雨の日の鎌倉");
      assert.equal((await repository.getPublicArticleBySlug("ja-guide"))?.content.language, "ja");
      assert.deepEqual((await repository.listPublicArticles()).map((article) => [article.slug, article.content.language]), [["ja-guide", "ja"]]);

      // Declared Japanese but written in English: refused. Declared English but written in Japanese: refused as before.
      const wrong = await repository.createArticle(owner, {
        id: "wrong-ja", slug: "wrong-ja", subject: { kind: "PROVIDER", providerId: "provider-a" },
        title: "A rainy day", categorySlug: "walks",
        content: { language: "ja", markdown: "## Under a roof\n\nA hands-on experience suits a rainy day.", author },
      });
      await assert.rejects(() => repository.commitPublication(owner, wrong.id, { expectedRevision: wrong.revision, visibility: "PUBLIC" }), StoreValidationError);
      const englishInJapanese = await repository.createArticle(owner, {
        id: "wrong-en", slug: "wrong-en", subject: { kind: "PROVIDER", providerId: "provider-a" },
        title: "雨の日の鎌倉（英語と宣言）", categorySlug: "walks",
        content: { language: "en", markdown: "## 屋根の下で\n\n雨の日は、手を動かす体験がいいです。", author },
      });
      await assert.rejects(() => repository.commitPublication(owner, englishInJapanese.id, { expectedRevision: englishInJapanese.revision, visibility: "PUBLIC" }), StoreValidationError);

      // No other language, and a missing declaration still cannot publish.
      await assert.rejects(() => repository.createArticle(owner, {
        id: "fr-guide", slug: "fr-guide", subject: { kind: "PROVIDER", providerId: "provider-a" }, title: "Pluie",
        content: { language: "fr" as never, markdown: "## Pluie\n\nBonjour." },
      }), StoreValidationError);
      const undeclared = await repository.createArticle(owner, {
        id: "undeclared", slug: "undeclared", subject: { kind: "PROVIDER", providerId: "provider-a" }, title: "雨", categorySlug: "walks",
        content: { markdown: "## 見出し\n\n本文です。", author },
      });
      await assert.rejects(() => repository.commitPublication(owner, undeclared.id, { expectedRevision: undeclared.revision, visibility: "PUBLIC" }), StoreValidationError);
    } finally {
      await pool.end();
    }
  });
});
