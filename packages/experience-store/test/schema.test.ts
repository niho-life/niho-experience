import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const migrationUrl = new URL("../migrations/0001_experience_store.sql", import.meta.url);

describe("database invariants", () => {
  it("defines tenant, idempotency, snapshot, ledger, and outbox safeguards", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    assert.match(sql, /PRIMARY KEY \(provider_id, niho_user_id\)/);
    assert.match(sql, /UNIQUE \(provider_id, idempotency_key\)/);
    assert.match(sql, /bookings_protect_snapshots/);
    assert.match(sql, /payment ledger entries are append-only/);
    assert.match(sql, /stripe_webhook_events/);
    assert.match(sql, /outbox_messages_pending_idx/);
  });

  it("stores no Google event content columns", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    const busyTable = sql.match(/CREATE TABLE google_busy_intervals \(([\s\S]*?)\n\);/)?.[1] ?? "";
    assert.doesNotMatch(busyTable, /title|description|attendee|organizer/i);
    assert.match(busyTable, /opaque_calendar_id/);
    assert.match(busyTable, /start_at/);
    assert.match(busyTable, /end_at/);
  });

  it("keeps host push subscriptions to one row per endpoint, with keys and a coarse device only (#177)", async () => {
    const sql = await readFile(new URL("../migrations/0004_host_push_subscriptions.sql", import.meta.url), "utf8");
    assert.match(sql, /^BEGIN;/);
    assert.match(sql, /COMMIT;\s*$/);
    assert.doesNotMatch(sql, /CREATE EXTENSION/);
    const table = sql.match(/CREATE TABLE host_push_subscriptions \(([\s\S]*?)\n\);/)?.[1] ?? "";
    assert.match(table, /id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY/);
    assert.match(table, /endpoint text NOT NULL UNIQUE/);
    assert.match(table, /\{87\}/);
    assert.match(table, /\{22\}/);
    assert.match(table, /device_label IN \('iphone', 'ipad', 'android', 'mac', 'windows', 'other'\)/);
    assert.match(table, /failure_count integer NOT NULL DEFAULT 0 CHECK \(failure_count >= 0\)/);
    // No names, message text, amounts or browser details beyond the coarse device.
    assert.doesNotMatch(table, /name\b|message|amount|user_agent/i);
    assert.match(sql, /ON host_push_subscriptions \(niho_user_id\)/);
    assert.match(sql, /ON host_push_subscriptions \(connection_id\)/);
  });
});
