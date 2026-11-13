import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StoreAccessDeniedError, StoreConflictError, StoreNotFoundError, StoreValidationError } from "../src/errors.ts";
import { ProductClassificationRepository } from "../src/product-classifications.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const ADMIN = { nihoUserId: "admin-classification-synthetic" } as const;

describe("product classification (#529)", { skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false }, () => {
  it("is set by the product's OWNER or the office, read back exactly, and shown on the public side only for published products", async () => {
    const db = await createIsolatedDatabase(databaseUrl, "product_classifications", { max: 4 });
    try {
      const pool = db.pool;
      for (const [provider, product, status] of [["prov-a", "p-live", "PUBLISHED"], ["prov-a", "p-draft", "DRAFT"], ["prov-b", "p-other", "PUBLISHED"], ["prov-b", "p-gone", "ARCHIVED"]] as const) {
        await pool.query("INSERT INTO experience_providers (id) VALUES ($1) ON CONFLICT DO NOTHING", [provider]);
        await pool.query(
          `INSERT INTO experience_products (provider_id,id,slug,status,public_title,currency,unit_amount,cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
           VALUES ($1,$2,$2,$3,$4,'JPY',5000,'terms','seller','acct_x','Seller')`, [provider, product, status, `Title ${product}`],
        );
      }
      await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES ('prov-a','owner-a','OWNER',true),('prov-a','editor-a','EDITOR',true),('prov-b','owner-b','OWNER',true)");
      const repository = new ProductClassificationRepository(pool);
      const owner = { providerId: "prov-a", nihoUserId: "owner-a" };

      // Nothing yet: empty, not an error.
      assert.deepEqual(await repository.readForOwner(owner, "p-live"), { category: null, area: null, companions: [], occasions: [] });
      // Saved in the lists' order whatever order it arrives in, and read back as saved.
      const saved = await repository.saveForOwner(owner, "p-live", { category: "walk", area: "kita", companions: ["friends", "solo"], occasions: ["anniv", "rain"] });
      assert.deepEqual(saved, { category: "walk", area: "kita", companions: ["solo", "friends"], occasions: ["rain", "anniv"] });
      assert.deepEqual(await repository.readForOwner(owner, "p-live"), saved);
      // A later save replaces the whole value.
      await repository.saveForOwner(owner, "p-live", { category: "sea", area: null, companions: [], occasions: [] });
      assert.deepEqual(await repository.readForOwner(owner, "p-live"), { category: "sea", area: null, companions: [], occasions: [] });

      // Only the OWNER, only of their own provider's product; unknown ids and shapes are refused.
      await assert.rejects(repository.saveForOwner({ providerId: "prov-a", nihoUserId: "editor-a" }, "p-live", saved), StoreAccessDeniedError);
      await assert.rejects(repository.saveForOwner({ providerId: "prov-a", nihoUserId: "owner-b" }, "p-live", saved), StoreAccessDeniedError);
      await assert.rejects(repository.readForOwner({ providerId: "prov-b", nihoUserId: "owner-b" }, "p-live"), StoreNotFoundError);
      for (const bad of [
        { category: "cooking", area: null, companions: [], occasions: [] }, { category: null, area: "tokyo", companions: [], occasions: [] },
        { category: null, area: null, companions: ["solo", "solo"], occasions: [] }, { category: null, area: null, companions: [], occasions: ["rain", "x"] },
        { category: null, area: null, companions: "solo", occasions: [] }, { category: null, area: null, companions: [], occasions: [], extra: 1 }, null, [],
      ]) await assert.rejects(repository.saveForOwner(owner, "p-live", bad), StoreValidationError);
      await assert.rejects(pool.query("UPDATE experience_product_classifications SET category='nope'"), /check/i);

      // The office lists every product that is not archived, and sets many at once, all or none.
      const listed = await repository.adminList(ADMIN);
      assert.deepEqual(listed.map((row) => row.productId), ["p-live", "p-other", "p-draft"]);
      const all = { category: "food", area: "zai", companions: ["family"], occasions: [] } as const;
      assert.equal(await repository.adminSave(ADMIN, [
        { providerId: "prov-a", productId: "p-draft", classification: all }, { providerId: "prov-b", productId: "p-other", classification: { ...all, category: "zen" } },
      ]), 2);
      await assert.rejects(repository.adminSave(ADMIN, [
        { providerId: "prov-a", productId: "p-live", classification: all }, { providerId: "prov-b", productId: "p-gone", classification: all },
      ]), StoreNotFoundError);
      assert.equal((await repository.adminList(ADMIN)).find((row) => row.productId === "p-live")?.classification.category, "sea", "a failed bulk save changes nothing");
      await assert.rejects(repository.adminSave(ADMIN, [{ providerId: "prov-a", productId: "p-live", classification: all }, { providerId: "prov-a", productId: "p-live", classification: all }]), StoreValidationError);
      await assert.rejects(repository.adminSave(ADMIN, []), StoreValidationError);
      assert.equal((await pool.query("SELECT updated_by_admin FROM experience_product_classifications WHERE product_id='p-draft'")).rows[0]?.updated_by_admin, true);

      // 運営の CLI (#576): `expected` is what the caller read. It saves while that is still the value, and refuses (saving nothing) once
      // somebody changed it, whether by the Admin screens, the owner, or another CLI run that came first.
      const read = (await repository.adminList(ADMIN)).find((row) => row.productId === "p-live")!.classification;
      const next = { category: "walk", area: "hase", companions: [], occasions: ["rain"] } as const;
      assert.equal(await repository.adminSave(ADMIN, [{ providerId: "prov-a", productId: "p-live", classification: next, expected: read }]), 1);
      await assert.rejects(repository.adminSave(ADMIN, [
        { providerId: "prov-a", productId: "p-draft", classification: next, expected: all },
        { providerId: "prov-a", productId: "p-live", classification: all, expected: read },
      ]), StoreConflictError);
      assert.deepEqual((await repository.adminList(ADMIN)).find((row) => row.productId === "p-live")?.classification, next, "a refused compare-and-set changes nothing");
      assert.deepEqual((await repository.adminList(ADMIN)).find((row) => row.productId === "p-draft")?.classification, all, "and not the products before it in the same save");
      await assert.rejects(repository.adminSave(ADMIN, [{ providerId: "prov-a", productId: "p-live", classification: all, expected: { category: "bogus" } }]), StoreValidationError);
      // An unclassified product's value is the empty one.
      const empty = { category: null, area: null, companions: [], occasions: [] } as const;
      await pool.query("DELETE FROM experience_product_classifications WHERE product_id = 'p-other'");
      assert.equal(await repository.adminSave(ADMIN, [{ providerId: "prov-b", productId: "p-other", classification: all, expected: empty }]), 1);
      // Two compare-and-sets from the same read: one wins, the other is refused, never both applied.
      const race = await Promise.allSettled([
        repository.adminSave(ADMIN, [{ providerId: "prov-a", productId: "p-live", classification: { ...next, category: "sea" }, expected: next }]),
        repository.adminSave(ADMIN, [{ providerId: "prov-a", productId: "p-live", classification: { ...next, category: "zen" }, expected: next }]),
      ]);
      assert.deepEqual(race.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
      assert.ok((race.find((r) => r.status === "rejected") as PromiseRejectedResult).reason instanceof StoreConflictError);

      // The public read is the visible publications' only (here none: a product status alone shows nothing); the positive case
      // and the stop are in managed-experience-sales.integration.test.ts, which publishes real products.
      assert.equal((await repository.listPublic()).size, 0);
    } finally {
      await db.dispose();
    }
  });
});
