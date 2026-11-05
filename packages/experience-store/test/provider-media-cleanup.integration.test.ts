import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { ProviderMediaCleanupRepository } from "../src/public-media-cleanup.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe("provider media cleanup persistence (#378)", { skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false }, () => {
  it("claims only revoked unselected assets, rechecks completion, and keeps concurrent delivery idempotent", async () => {
    const { Pool } = await import("pg");
    const schema = `provider_media_cleanup_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
    const providerId = "provider-media-cleanup-synthetic";
    const ids = {
      ready: randomUUID(), selected: randomUUID(), eligible: randomUUID(), unsafe: randomUUID(), changed: randomUUID(),
      concurrentA: randomUUID(), concurrentB: randomUUID(),
    };
    const objectKey = (id: string) => `experience-provider-media/${id}.jpg`;
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      const migrations = (await readdir(new URL("../migrations/", import.meta.url))).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort();
      for (const name of migrations) await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      await pool.query("INSERT INTO experience_providers (id) VALUES ($1)", [providerId]);
      const insertAsset = (id: string, state: "READY" | "REVOKED", key = objectKey(id)) => pool.query(
        `INSERT INTO experience_provider_media_assets
           (id,provider_id,object_key,source_ref_hash,width,height,byte_size,rights_confirmed_at,state)
         VALUES ($1,$2,$3,$4,640,480,4096,clock_timestamp(),$5)`,
        [id, providerId, key, "a".repeat(64), state],
      );
      await insertAsset(ids.ready, "READY");
      await insertAsset(ids.selected, "READY");
      await insertAsset(ids.eligible, "REVOKED");
      await insertAsset(ids.unsafe, "REVOKED", `experience-provider-media/../${ids.unsafe}.jpg`);
      await insertAsset(ids.changed, "REVOKED");
      await pool.query(
        `INSERT INTO experience_provider_media_selection
           (provider_id,placement,asset_id,alt_text,alt_text_ja)
         VALUES ($1,'PROVIDER_PHOTO',$2,'Synthetic selected','合成選択')`,
        [providerId, ids.selected],
      );

      const repository = new ProviderMediaCleanupRepository(pool);
      const claims = await repository.claim(20);
      assert.deepEqual(new Set(claims.map((claim) => claim.assetId)), new Set([ids.eligible, ids.unsafe, ids.changed]));
      assert.equal(await repository.complete({ assetId: ids.ready, objectKey: objectKey(ids.ready) }), false, "READY assets are protected");
      assert.equal(await repository.complete({ assetId: ids.selected, objectKey: objectKey(ids.selected) }), false, "selected assets are protected");
      assert.equal(await repository.complete(claims.find((claim) => claim.assetId === ids.eligible)!), true);

      await pool.query(
        `INSERT INTO experience_provider_media_selection
           (provider_id,placement,asset_id,alt_text,alt_text_ja)
         VALUES ($1,'BUSINESS_LOGO',$2,'Synthetic changed','合成変更')`,
        [providerId, ids.changed],
      );
      assert.equal(await repository.complete(claims.find((claim) => claim.assetId === ids.changed)!), false, "completion rechecks selection");

      const states = await pool.query<{ id: string; cleanup_attempted_at: Date | null; object_deleted_at: Date | null }>(
        "SELECT id::text,cleanup_attempted_at,object_deleted_at FROM experience_provider_media_assets ORDER BY id",
      );
      const byId = new Map(states.rows.map((row) => [row.id, row]));
      assert.equal(byId.get(ids.ready)?.cleanup_attempted_at, null);
      assert.equal(byId.get(ids.selected)?.cleanup_attempted_at, null);
      assert.ok(byId.get(ids.eligible)?.object_deleted_at instanceof Date);
      assert.equal(byId.get(ids.changed)?.object_deleted_at, null);

      await insertAsset(ids.concurrentA, "REVOKED");
      await insertAsset(ids.concurrentB, "REVOKED");
      const concurrent = await Promise.all([repository.claim(1), repository.claim(1)]);
      const concurrentClaims = concurrent.flat();
      assert.equal(concurrentClaims.length, 2);
      assert.equal(new Set(concurrentClaims.map((claim) => claim.assetId)).size, 2, "concurrent claims do not starve fresh rows");
      assert.deepEqual(new Set(concurrentClaims.map((claim) => claim.assetId)), new Set([ids.concurrentA, ids.concurrentB]));

      const repeated = await Promise.all([
        repository.complete(concurrentClaims[0]!),
        repository.complete(concurrentClaims[0]!),
      ]);
      assert.deepEqual(repeated.sort(), [false, true], "replayed completion records physical deletion once");
      assert.equal(await repository.complete(concurrentClaims[1]!), true);

      const retry = await repository.claim(1);
      assert.equal(retry[0]?.assetId, ids.unsafe, "an attempted failure remains retryable after fresh work");
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      await pool.end();
    }
  });
});
