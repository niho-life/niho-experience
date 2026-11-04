import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("provider media cleanup migration (#378)", () => {
  it("keeps durable attempt and physical deletion state with a retry-friendly partial index", async () => {
    const sql = await readFile(new URL("../migrations/0060_provider_media_cleanup.sql", import.meta.url), "utf8");
    assert.match(sql, /ADD COLUMN cleanup_attempted_at timestamptz/);
    assert.match(sql, /ADD COLUMN object_deleted_at timestamptz/);
    assert.match(sql, /cleanup_attempted_at NULLS FIRST, imported_at, id/);
    assert.match(sql, /WHERE state = 'REVOKED' AND object_deleted_at IS NULL/);
    assert.doesNotMatch(sql, /DELETE FROM experience_provider_media_assets/);
  });
});
