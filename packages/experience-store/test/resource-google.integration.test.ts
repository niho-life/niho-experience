import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import type { Occurrence } from "@niho-experience/experience-domain";
import { StoreConflictError, StoreNotFoundError } from "../src/errors.ts";
import { evaluateStoredInventory } from "../src/inventory.ts";
import { ExperienceStore } from "../src/repository.ts";
import { ResourceGoogleRepository } from "../src/resource-google.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const command = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const occurrence = (startUtc = "2099-01-01T02:00:00.000Z", endUtc = "2099-01-01T03:00:00.000Z"): Occurrence => ({
  id: `rule@${startUtc}`, ruleId: "rule", sourceLocalDate: "2099-01-01", localDate: "2099-01-01", localStartTime: "11:00",
  timeZone: "Asia/Tokyo", startUtc, endUtc, durationMinutes: 60, capacity: 8, bookingCutoffMinutes: 0,
  busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, status: "OPEN", rescheduled: false,
});

describe("resource Google inventory", { skip: databaseUrl === undefined }, () => {
  it("isolates resources, respects half-open buffers, fails closed, rejects ABA, and rolls command/outbox back together", async () => {
    const { Pool } = await import("pg");
    const schema = `resource_google_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
    const actor = { providerId: "provider-a", nihoUserId: "owner-a", calendarRoleCeiling: "OWNER" as const };
    let sequence = 1;
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      for (const name of (await readdir(new URL("../migrations/", import.meta.url))).filter((item) => /^\d{4}.*\.sql$/.test(item)).sort()) {
        await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      }
      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a')");
      await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES ('provider-a','owner-a','OWNER'),('provider-a','operator-a','EDITOR')");
      const store = new ExperienceStore(pool);
      for (const id of ["uses-room-a", "uses-room-b"]) await store.createProduct(actor, {
        id, slug: id, status: "PUBLISHED", publicTitle: id, content: {}, currency: "JPY", unitAmount: 1000,
        cancellationTermsRef: "terms", sellerNihoAccountRef: "seller", stripeConnectAccountRef: "acct_synthetic", sellerDisplayName: "Synthetic",
      });
      await store.saveInventoryResource(actor, { id: "room-a", kind: "VENUE", displayName: "Room A", active: true }, null, command(sequence++));
      await store.saveInventoryResource(actor, { id: "room-b", kind: "VENUE", displayName: "Room B", active: true }, null, command(sequence++));
      await store.saveProductInventorySetting(actor, "uses-room-a", { bookingMode: "SEAT", resources: [{ resourceId: "room-a", prepareMinutes: 30, cleanupMinutes: 15 }] }, null, command(sequence++));
      await store.saveProductInventorySetting(actor, "uses-room-b", { bookingMode: "SEAT", resources: [{ resourceId: "room-b", prepareMinutes: 30, cleanupMinutes: 15 }] }, null, command(sequence++));
      await pool.query(
        `INSERT INTO provider_google_connections
          (provider_id,connected_by_niho_user_id,encrypted_refresh_token,granted_scopes,busy_calendar_id,booking_calendar_id)
         VALUES ('provider-a','owner-a',$1,ARRAY['scope'],'legacy','booking-output')`, ["x".repeat(40)],
      );
      const generation = Number((await pool.query("SELECT connection_generation FROM provider_google_connections WHERE provider_id='provider-a'")).rows[0].connection_generation);
      const resourceGoogle = new ResourceGoogleRepository(pool);
      await resourceGoogle.replaceCalendarInventory(actor, { connectionGeneration: generation, fetchedAtUtc: new Date().toISOString(), calendars: [
        { id: "room-a-private", name: "Room A calendar", primary: false }, { id: "room-b-private", name: "Room B calendar", primary: false },
        { id: "booking-output", name: "Output", primary: false },
      ] });
      const saveCommand = command(sequence++);
      const saved = await resourceGoogle.save(actor, { resourceId: "room-a", calendarId: "room-a-private", enabled: true }, null, saveCommand);
      assert.equal(saved.version, 1);
      assert.equal((await resourceGoogle.save(actor, { resourceId: "room-a", calendarId: "room-a-private", enabled: true }, null, saveCommand)).repeated, true);
      await assert.rejects(() => resourceGoogle.save(actor, { resourceId: "room-a", calendarId: "room-b-private", enabled: true }, null, saveCommand), StoreConflictError);
      await assert.rejects(() => resourceGoogle.save(actor, { resourceId: "room-b", calendarId: "booking-output", enabled: true }, null, command(sequence++)), StoreConflictError);

      const nowUtc = "2098-12-01T00:00:00.000Z";
      assert.equal((await evaluateStoredInventory(pool, "provider-a", "uses-room-a", occurrence(), nowUtc, 1)).availability.reason, "RESOURCE_GOOGLE_UNAVAILABLE");
      assert.equal((await evaluateStoredInventory(pool, "provider-a", "uses-room-b", occurrence(), nowUtc, 1)).availability.reason, "AVAILABLE");
      await pool.query(
        `UPDATE resource_google_calendars SET sync_status='FRESH',fresh_until='2099-02-01T00:00:00Z',
           coverage_start='2099-01-01T01:30:00Z',coverage_end='2099-01-01T03:15:00Z',sync_dirty=false
          WHERE provider_id='provider-a' AND resource_id='room-a'`,
      );
      const setBusy = async (start: string, end: string) => {
        await pool.query("DELETE FROM resource_google_busy_intervals WHERE provider_id='provider-a' AND resource_id='room-a'");
        await pool.query(
          `INSERT INTO resource_google_busy_intervals
             (provider_id,resource_id,settings_version,connection_generation,start_at,end_at)
           SELECT provider_id,resource_id,settings_version,connection_generation,$3,$4 FROM resource_google_calendars
            WHERE provider_id=$1 AND resource_id=$2`, ["provider-a", "room-a", start, end],
        );
      };
      await setBusy("2099-01-01T01:00:00Z", "2099-01-01T01:30:00Z");
      assert.equal((await evaluateStoredInventory(pool, "provider-a", "uses-room-a", occurrence(), nowUtc, 1)).availability.reason, "AVAILABLE");
      await setBusy("2099-01-01T03:15:00Z", "2099-01-01T03:30:00Z");
      assert.equal((await evaluateStoredInventory(pool, "provider-a", "uses-room-a", occurrence(), nowUtc, 1)).availability.reason, "AVAILABLE");
      await setBusy("2099-01-01T03:14:00Z", "2099-01-01T03:16:00Z");
      assert.equal((await evaluateStoredInventory(pool, "provider-a", "uses-room-a", occurrence(), nowUtc, 1)).availability.reason, "RESOURCE_GOOGLE_BUSY");
      await pool.query("UPDATE resource_google_calendars SET coverage_end='2099-01-01T03:14:59Z' WHERE provider_id='provider-a' AND resource_id='room-a'");
      assert.equal((await evaluateStoredInventory(pool, "provider-a", "uses-room-a", occurrence(), nowUtc, 1)).availability.reason, "RESOURCE_GOOGLE_UNAVAILABLE");
      await pool.query("UPDATE resource_google_calendars SET coverage_end='2099-01-01T03:15:00Z',fresh_until='2098-01-01T00:00:00Z' WHERE provider_id='provider-a' AND resource_id='room-a'");
      assert.equal((await evaluateStoredInventory(pool, "provider-a", "uses-room-a", occurrence(), nowUtc, 1)).availability.reason, "RESOURCE_GOOGLE_UNAVAILABLE");

      const oldGeneration = generation;
      await pool.query("DELETE FROM provider_google_connections WHERE provider_id='provider-a'");
      const disconnected = await resourceGoogle.ownerSnapshot(actor);
      assert.equal(disconnected.connectionGeneration, null);
      assert.equal(disconnected.resources.find((item) => item.resourceId === "room-a")?.enabled, true);
      await pool.query(
        `INSERT INTO provider_google_connections
          (provider_id,connected_by_niho_user_id,encrypted_refresh_token,granted_scopes,busy_calendar_id,booking_calendar_id)
         VALUES ('provider-a','owner-a',$1,ARRAY['scope'],'legacy','booking-output')`, ["y".repeat(40)],
      );
      const newGeneration = Number((await pool.query("SELECT connection_generation FROM provider_google_connections WHERE provider_id='provider-a'")).rows[0].connection_generation);
      assert.ok(newGeneration > oldGeneration);
      assert.equal((await evaluateStoredInventory(pool, "provider-a", "uses-room-a", occurrence(), nowUtc, 1)).availability.reason, "RESOURCE_GOOGLE_UNAVAILABLE");
      await store.configureGoogleCalendar(actor, { opaqueCalendarId: "legacy", blockingEnabled: true }, null);
      await assert.rejects(() => store.recordGoogleBusySync({ providerId: "provider-a" }, {
        connectionGeneration: oldGeneration, opaqueCalendarId: "legacy", attemptedAtUtc: "2098-01-01T00:00:00.000Z",
        freshUntilUtc: "2098-01-01T00:20:00.000Z", coverageStartUtc: "2097-12-31T00:00:00.000Z", coverageEndUtc: "2098-01-02T00:00:00.000Z", busyIntervals: [],
      }), StoreNotFoundError);

      await pool.query(`CREATE FUNCTION fail_resource_google_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.aggregate_type='resource_google_calendar' THEN RAISE EXCEPTION 'synthetic outbox failure'; END IF; RETURN NEW; END $$`);
      await pool.query("CREATE TRIGGER fail_resource_google_outbox BEFORE INSERT ON calendar_outbox_events FOR EACH ROW EXECUTE FUNCTION fail_resource_google_outbox()");
      const rollbackCommand = command(sequence++);
      await assert.rejects(() => resourceGoogle.save(actor, { resourceId: "room-b", calendarId: "room-b-private", enabled: false }, null, rollbackCommand));
      assert.equal((await pool.query("SELECT 1 FROM resource_google_calendars WHERE provider_id='provider-a' AND resource_id='room-b'")).rowCount, 0);
      assert.equal((await pool.query("SELECT 1 FROM calendar_commands WHERE provider_id='provider-a' AND command_id=$1", [rollbackCommand])).rowCount, 0);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await pool.end();
    }
  });
});
