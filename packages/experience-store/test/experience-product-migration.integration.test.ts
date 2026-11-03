import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import type { ScheduleRule } from "@niho-experience/experience-domain";
import { StoreConflictError, StoreValidationError } from "../src/errors.ts";
import { ExperienceProductMigrationImport } from "../src/experience-product-migration.ts";
import { GuestBookingRepository } from "../src/guest-bookings.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const providerId = "provider-migration-synthetic";
const product = {
  id: "product-migration-synthetic", slug: "migration-synthetic", status: "PUBLISHED" as const,
  publicTitle: "Synthetic migrated experience", content: { description: "Synthetic public copy" },
  currency: "JPY", unitAmount: 5000, cancellationTermsRef: "cancel-migration-v1",
  sellerNihoAccountRef: "seller-migration-synthetic", stripeConnectAccountRef: "acct_migration_synthetic",
  sellerDisplayName: "Synthetic legal seller",
};
const rule: ScheduleRule = {
  id: "migration-weekly", timeZone: "Asia/Tokyo", startsOn: "2099-01-01", localStartTime: "10:00",
  durationMinutes: 90, capacity: 8, bookingCutoffMinutes: 60, busyBufferBeforeMinutes: 0,
  busyBufferAfterMinutes: 0, recurrence: { kind: "SELECTED_WEEKDAYS", weekdays: ["MONDAY"] },
};
const terms = {
  offerPrices: [{ offerId: rule.id, adultPriceYen: 30_000 }],
  childPricing: null, minimumParticipants: 1, maxPartySize: 8, cancellationPolicy: "FREE_UNTIL_24H" as const,
  bookingQuestions: [], conditionsVersion: null,
};

describe("Experience legacy product migration", { skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false }, () => {
  it("imports product, sale terms, schedules and the legacy exclusion atomically", async () => {
    const { Pool } = await import("pg");
    const schema = `experience_product_migration_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${schema}` });
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      const migrations = (await readdir(new URL("../migrations/", import.meta.url))).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort();
      for (const name of migrations) await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      await pool.query("INSERT INTO experience_providers (id) VALUES ($1)", [providerId]);
      await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES ($1,'owner-synthetic','OWNER')", [providerId]);
      await pool.query("INSERT INTO provider_sale_settings (provider_id,support_enabled,platform_fee_basis_points) VALUES ($1,false,1000)", [providerId]);

      const importer = new ExperienceProductMigrationImport(pool);
      await assert.rejects(importer.importBundle({ providerId, legacySaleStoppedConfirmed: false as never, product, saleTerms: terms, scheduleRules: [rule] }), StoreValidationError);
      const imported = await importer.importBundle({ providerId, legacySaleStoppedConfirmed: true, product, saleTerms: terms, scheduleRules: [rule] });
      assert.deepEqual(imported, { providerId, productId: product.id, productVersion: 1, scheduleCount: 1 });
      assert.equal(await new GuestBookingRepository(pool).publicBookingTerms(product.slug), null, "the imported PUBLISHED product cannot use the legacy checkout branch");
      assert.equal(Number((await pool.query("SELECT count(*) AS n FROM schedule_rules WHERE provider_id=$1 AND product_id=$2", [providerId, product.id])).rows[0]?.n), 1);
      assert.deepEqual((await pool.query(
        "SELECT rule_id,adult_price_amount::int,sale_terms_version::int FROM experience_offer_prices WHERE provider_id=$1 AND product_id=$2",
        [providerId, product.id],
      )).rows, [{ rule_id: rule.id, adult_price_amount: 30_000, sale_terms_version: 1 }]);
      assert.equal(Number((await pool.query("SELECT count(*) AS n FROM experience_product_cutovers WHERE provider_id=$1 AND product_id=$2", [providerId, product.id])).rows[0]?.n), 1);
      await assert.rejects(importer.importBundle({ providerId, legacySaleStoppedConfirmed: true, product, saleTerms: terms, scheduleRules: [rule] }), StoreConflictError);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      await pool.end();
    }
  });
});
