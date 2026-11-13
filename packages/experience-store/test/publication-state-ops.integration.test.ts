import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StoreValidationError } from "../src/errors.ts";
import { ExperiencePublicationRepository } from "../src/experience-publication.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";

/** 運営の CLI (#576 ④): the office reads a product's publication state (the version a suspension names), also for a published product. */
const databaseUrl = process.env.TEST_DATABASE_URL;

describe("publication state for operations", { skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false }, () => {
  it("is null before the first publication, reports the version once there is a state, and takes only valid identifiers", async () => {
    const db = await createIsolatedDatabase(databaseUrl, "publication_state_ops", { max: 2 });
    try {
      const repository = new ExperiencePublicationRepository(db.pool);
      const actor = { nihoUserId: "adm_0123456789abcdef0123456789abcdef" };
      assert.equal(await repository.getStateForOperations(actor, "prov-a", "p-1"), null);
      await db.pool.query("INSERT INTO experience_providers (id) VALUES ('prov-a')");
      await db.pool.query(
        `INSERT INTO experience_products (provider_id,id,slug,status,public_title,currency,unit_amount,cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
         VALUES ('prov-a','p-1','p-1','DRAFT','Title','JPY',5000,'terms','seller','acct_x','Seller')`,
      );
      await db.pool.query("INSERT INTO experience_product_publication_states (provider_id,product_id,version) VALUES ('prov-a','p-1',7)");
      const state = await repository.getStateForOperations(actor, "prov-a", "p-1");
      assert.equal(state?.version, 7);
      assert.equal(state?.currentPublicationId, null);
      assert.equal(state?.operationsSuspendedAtUtc, null);
      await assert.rejects(() => repository.getStateForOperations(actor, "bad id", "p-1"), StoreValidationError);
    } finally {
      await db.dispose();
    }
  });
});
