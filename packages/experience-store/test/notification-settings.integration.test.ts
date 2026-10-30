import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { StoreAccessDeniedError, StoreValidationError } from "../src/errors.ts";
import { HOST_NOTIFICATION_KEYS, ProviderNotificationSettings } from "../src/notification-settings.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe("PostgreSQL provider notification settings (#109)", { skip: databaseUrl === undefined }, () => {
  it("lets only the OWNER change the three stoppable notifications and tells senders", async () => {
    const { Pool } = await import("pg");
    const schema = `notification_settings_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      const migrations = (await readdir(new URL("../migrations/", import.meta.url))).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort();
      for (const name of migrations) await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a'),('provider-b')");
      await pool.query(
        `INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES
           ('provider-a','owner-a','OWNER',true),('provider-a','editor-a','EDITOR',true),
           ('provider-a','former-a','OWNER',false),('provider-b','owner-b','OWNER',true)`,
      );
      const settings = new ProviderNotificationSettings(pool);
      const ownerA = { providerId: "provider-a", nihoUserId: "owner-a" } as const;

      // Nothing saved yet: all seven, in order, all on; only the three stoppable ones unlocked.
      const initial = await settings.get(ownerA);
      assert.deepEqual(initial.map((item) => item.key), [...HOST_NOTIFICATION_KEYS]);
      assert.ok(initial.every((item) => item.enabled));
      assert.deepEqual(initial.filter((item) => !item.locked).map((item) => item.key), ["GUEST_MESSAGE", "DAY_BEFORE_SUMMARY", "NEW_REVIEW"]);

      const changed = await settings.update(ownerA, { DAY_BEFORE_SUMMARY: false, NEW_REVIEW: false });
      assert.equal(changed.find((item) => item.key === "DAY_BEFORE_SUMMARY")?.enabled, false);
      assert.equal(changed.find((item) => item.key === "NEW_REVIEW")?.enabled, false);
      assert.equal(changed.find((item) => item.key === "GUEST_MESSAGE")?.enabled, true);
      assert.deepEqual(await settings.get(ownerA), changed);
      const again = await settings.update(ownerA, { NEW_REVIEW: true });
      assert.equal(again.find((item) => item.key === "NEW_REVIEW")?.enabled, true);
      assert.equal(again.find((item) => item.key === "DAY_BEFORE_SUMMARY")?.enabled, false);

      // Senders: a stopped one is off, the locked ones always come, another provider is untouched.
      assert.equal(await settings.enabledFor("provider-a", "DAY_BEFORE_SUMMARY"), false);
      assert.equal(await settings.enabledFor("provider-a", "NEW_BOOKING"), true);
      assert.equal(await settings.enabledFor("provider-b", "DAY_BEFORE_SUMMARY"), true);

      // Not the OWNER, an inactive OWNER, another provider's OWNER, NIHO capping the role, a product operator.
      for (const actor of [
        { providerId: "provider-a", nihoUserId: "editor-a" },
        { providerId: "provider-a", nihoUserId: "former-a" },
        { providerId: "provider-a", nihoUserId: "owner-b" },
        { ...ownerA, calendarRoleCeiling: "EDITOR" as const },
        { ...ownerA, calendarScope: "OPERATOR" as const },
      ]) {
        await assert.rejects(() => settings.get(actor), StoreAccessDeniedError);
        await assert.rejects(() => settings.update(actor, { GUEST_MESSAGE: false }), StoreAccessDeniedError);
      }
      assert.equal(await settings.enabledFor("provider-a", "GUEST_MESSAGE"), true);

      // Locked, unknown, empty and non-boolean changes never reach the table.
      await assert.rejects(() => settings.update(ownerA, { NEW_BOOKING: false } as never), StoreValidationError);
      await assert.rejects(() => settings.update(ownerA, { SOMETHING: false } as never), StoreValidationError);
      await assert.rejects(() => settings.update(ownerA, {}), StoreValidationError);
      await assert.rejects(() => settings.update(ownerA, { GUEST_MESSAGE: "no" } as never), StoreValidationError);
      const stored = await pool.query("SELECT notification_key, updated_by_niho_user_id FROM provider_notification_preferences ORDER BY notification_key");
      assert.deepEqual(stored.rows, [
        { notification_key: "DAY_BEFORE_SUMMARY", updated_by_niho_user_id: "owner-a" },
        { notification_key: "NEW_REVIEW", updated_by_niho_user_id: "owner-a" },
      ]);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });
});
