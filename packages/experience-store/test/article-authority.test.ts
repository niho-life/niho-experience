import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { ArticleAuthorityRepository } from "../src/article-authority.ts";

test("candidate query excludes globally ambiguous published slugs before applying the scan limit", async () => {
  let sql = "";
  let params: unknown[] = [];
  const pool = {
    async query(text: string, values: unknown[]) {
      sql = text;
      params = values;
      return {
        rows: [{ provider_id: "provider-a", slug: "safe-trip", public_title: "Safe trip", seller_display_name: "Synthetic Provider" }],
      };
    },
  } as unknown as Pool;

  const result = await new ArticleAuthorityRepository(pool).listPublishedCandidates({ afterSlug: "earlier-trip", limit: 96 });

  assert.deepEqual(result, [{ providerId: "provider-a", slug: "safe-trip", title: "Safe trip", providerName: "Synthetic Provider" }]);
  assert.deepEqual(params, ["", "earlier-trip", 96]);
  assert.match(sql, /NOT EXISTS\s*\([\s\S]*duplicate\.status='PUBLISHED'[\s\S]*duplicate\.slug=p\.slug/);
  assert.ok(sql.indexOf("NOT EXISTS") < sql.indexOf("LIMIT $3"), "global ambiguity filter must run before the bounded scan");
});
