import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { occurrenceIdFor, type ScheduleRule } from "@niho-experience/experience-domain";
import { StoreAccessDeniedError, StoreConflictError, StoreValidationError } from "../src/errors.ts";
import { ExperienceStore } from "../src/repository.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const command = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;

describe("PostgreSQL Admin shared inventory", { skip: databaseUrl === undefined }, () => {
  it("uses a dedicated Admin actor without weakening host membership or tenant/version fences", async () => {
    const { Pool } = await import("pg");
    const schema = `admin_inventory_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
    const admin = { nihoUserId: "verified-admin" } as const;
    const owner = { providerId: "provider-a", nihoUserId: "owner-a" } as const;
    let schemaCreated = false;
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      schemaCreated = true;
      const migrations = (await readdir(new URL("../migrations/", import.meta.url))).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort();
      for (const name of migrations) await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a'),('provider-b')");
      await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES ('provider-a','owner-a','OWNER')");
      await pool.query(
        `INSERT INTO experience_products
          (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
         VALUES ('provider-a','tea','tea','PUBLISHED','Synthetic tea','{}','JPY',1000,'terms','seller','acct_synthetic','Synthetic Seller'),
                ('provider-b','foreign','foreign','PUBLISHED','Synthetic foreign','{}','JPY',2000,'terms','seller','acct_other','Other Seller')`,
      );
      const store = new ExperienceStore(pool);
      const resourceCommand = command(1);
      const room = await store.saveInventoryResourceAsAdmin(admin, "provider-a", {
        id: "room-a", kind: "VENUE", displayName: "Synthetic room", active: true,
      }, null, resourceCommand);
      assert.equal((await store.saveInventoryResourceAsAdmin(admin, "provider-a", {
        id: "room-a", kind: "VENUE", displayName: "Synthetic room", active: true,
      }, null, resourceCommand)).repeated, true);
      await assert.rejects(() => store.saveInventoryResourceAsAdmin({ nihoUserId: "" }, "provider-a", {
        id: "bad", kind: "VENUE", displayName: "Bad", active: false,
      }, null, command(2)), StoreValidationError);
      await assert.rejects(() => store.saveInventoryResource({ providerId: "provider-a", nihoUserId: "not-a-member" }, {
        id: "host-bypass", kind: "VENUE", displayName: "Bad", active: false,
      }, null, command(3)), StoreAccessDeniedError);

      await store.saveInventoryResourceAsAdmin(admin, "provider-b", {
        id: "foreign-room", kind: "VENUE", displayName: "Foreign room", active: true,
      }, null, command(4));
      await assert.rejects(() => store.saveProductInventorySettingAsAdmin(admin, "provider-a", "tea", {
        bookingMode: "PRIVATE_GROUP", resources: [{ resourceId: "foreign-room", prepareMinutes: 0, cleanupMinutes: 0 }],
      }, null, command(5)), StoreConflictError);

      const inventory = await store.saveProductInventorySettingAsAdmin(admin, "provider-a", "tea", {
        bookingMode: "PRIVATE_GROUP", resources: [{ resourceId: "room-a", prepareMinutes: 15, cleanupMinutes: 10 }],
      }, null, command(6));
      const providers = await store.listInventoryAdminProviders(admin);
      assert.deepEqual(providers, [{ id: "provider-b", displayName: "Other Seller" }, { id: "provider-a", displayName: "Synthetic Seller" }]);
      const snapshot = await store.getInventoryAdminSnapshot(admin, "provider-a");
      assert.equal(snapshot.products[0]?.id, "tea");
      assert.equal(snapshot.products[0]?.inventory?.bookingMode, "PRIVATE_GROUP");
      assert.equal(snapshot.resources[0]?.displayName, "Synthetic room");
      assert.equal("unitAmount" in snapshot.products[0]!, false);
      assert.equal("stripeConnectAccountRef" in snapshot.products[0]!, false);

      const rule: ScheduleRule = {
        id: "tea-rule", timeZone: "Asia/Tokyo", startsOn: "2099-01-01", localStartTime: "10:00", durationMinutes: 60,
        capacity: 8, bookingCutoffMinutes: 0, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "DAILY" },
      };
      await store.saveScheduleRule(owner, "tea", rule, null, command(7));
      await store.createBookingHold({ providerId: "provider-a" }, {
        productId: "tea", occurrenceId: occurrenceIdFor(rule.id, "2099-01-01"), seats: 2, idempotencyKey: "synthetic-admin-hold", holdSeconds: 3600,
      });
      await assert.rejects(() => store.saveProductInventorySettingAsAdmin(admin, "provider-a", "tea", {
        bookingMode: "SEAT", resources: [],
      }, inventory.version, command(8)), StoreConflictError);
      const paused = await store.saveInventoryResourceAsAdmin(admin, "provider-a", {
        id: "room-a", kind: "VENUE", displayName: "Synthetic room", active: false,
      }, room.version, command(9));
      assert.equal(paused.version, room.version + 1);
      assert.equal(Number((await pool.query("SELECT count(*) FROM bookings WHERE provider_id='provider-a' AND status='HOLD'")).rows[0]?.count), 1);


      assert.equal(Number((await pool.query("SELECT count(*) FROM calendar_commands WHERE provider_id='provider-a' AND action IN ('inventory_resource.save','product_inventory.save')")).rows[0]?.count), 3);
      assert.equal(Number((await pool.query("SELECT count(*) FROM calendar_outbox_events WHERE provider_id='provider-a' AND aggregate_type IN ('inventory_resource','product_inventory')")).rows[0]?.count), 3);
    } finally {
      if (schemaCreated) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });
});
