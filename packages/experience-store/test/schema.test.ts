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

  it("separates occurrence timing from selling and records idempotent calendar commands", async () => {
    const sql = await readFile(new URL("../migrations/0006_calendar_commands_and_sales_state.sql", import.meta.url), "utf8");
    assert.match(sql, /CREATE TABLE schedule_occurrence_sales_states/);
    assert.match(sql, /LOCK TABLE schedule_occurrence_overrides IN ACCESS EXCLUSIVE MODE/);
    assert.match(sql, /desired_state IN \('OPEN', 'CLOSED'\)/);
    assert.match(sql, /INSERT INTO schedule_occurrence_sales_states[\s\S]*WHERE kind = 'CLOSE'/);
    assert.match(sql, /CREATE TABLE calendar_commands/);
    assert.match(sql, /PRIMARY KEY \(provider_id, command_id\)/);
    assert.match(sql, /CREATE TABLE calendar_outbox_events/);
    assert.match(sql, /FOREIGN KEY \(provider_id, command_id\) REFERENCES calendar_commands/);
    assert.doesNotMatch(sql, /UPDATE outbox_messages|INSERT INTO outbox_messages/);
  });

  it("keeps OTA targets immutable, credentials hashed, and expired leases locked", async () => {
    const sql = await readFile(new URL("../migrations/0007_channel_runtime.sql", import.meta.url), "utf8");
    assert.match(sql, /credential_digest text NOT NULL/);
    assert.doesNotMatch(sql, /credential_token|bearer_token|cookie_value/);
    assert.match(sql, /target_external_account_id text NOT NULL/);
    assert.match(sql, /account_version bigint NOT NULL/);
    assert.match(sql, /mapping_version bigint NOT NULL/);
    assert.match(sql, /UNIQUE \(site, external_account_id\)/);
    assert.match(sql, /lease_epoch bigint NOT NULL/);
    assert.match(sql, /observed_bookable boolean/);
    assert.match(sql, /observed_manually_blocked boolean/);
    assert.match(sql, /channel_jobs_global_browser_lease[\s\S]*WHERE status = 'LEASED'/);
    assert.match(sql, /channel_jobs_account_lease[\s\S]*WHERE status = 'LEASED'/);
    assert.match(sql, /expired lease deliberately remains LEASED/);
    assert.match(sql, /outcome IN \('VERIFIED','AUTH_REQUIRED','NEEDS_REVIEW','UNKNOWN_AFTER_SAVE','RETRY_WAIT','SUPERSEDED'\)/);
  });

  it("scopes shared resources by provider and keeps booking occupancy snapshots immutable", async () => {
    const sql = await readFile(new URL("../migrations/0010_shared_inventory.sql", import.meta.url), "utf8");
    assert.match(sql, /PRIMARY KEY \(provider_id, id\)/);
    assert.match(sql, /FOREIGN KEY \(provider_id, resource_id\)[\s\S]*REFERENCES inventory_resources\(provider_id, id\)/);
    assert.match(sql, /booking_resource_occupancies_overlap_idx/);
    assert.match(sql, /booking inventory snapshots are immutable/);
    assert.match(sql, /calendar_reconciliation_ticks/);
    assert.match(sql, /pending_command_id/);
  });

  it("keeps resource Google input opaque, generation fenced, durable, and event-content free", async () => {
    const sql = await readFile(new URL("../migrations/0015_resource_google_busy.sql", import.meta.url), "utf8");
    assert.match(sql, /CREATE SEQUENCE provider_google_connection_generation_seq/);
    assert.match(sql, /FOREIGN KEY \(provider_id, resource_id\)[\s\S]*REFERENCES inventory_resources\(provider_id, id\)/);
    assert.match(sql, /resource_google_calendars_due_idx/);
    assert.match(sql, /resource_google_sync_receipts/);
    assert.match(sql, /token_digest text NOT NULL/);
    const intervals = sql.match(/CREATE TABLE resource_google_busy_intervals \(([\s\S]*?)\n\);/)?.[1] ?? "";
    assert.match(intervals, /start_at/);
    assert.match(intervals, /end_at/);
    assert.doesNotMatch(intervals, /title|summary|description|attendee|organizer|event_id/i);
  });

  it("adds bounded immutable reservation window manifests, page receipts, and separate health", async () => {
    const sql = await readFile(new URL("../migrations/0016_external_reservation_window_reads.sql", import.meta.url), "utf8");
    assert.match(sql, /read_scope IN \('OCCURRENCE','WINDOW'\)/);
    assert.match(sql, /ADD CONSTRAINT external_reservation_reads_completion_check/);
    assert.doesNotMatch(sql, /ADD CONSTRAINT external_reservation_reads_status_check/);
    assert.match(sql, /coverage_to <= coverage_from \+ interval '62 days'/);
    assert.match(sql, /manifest_index integer NOT NULL CHECK \(manifest_index BETWEEN 0 AND 511\)/);
    assert.match(sql, /CREATE TABLE external_reservation_window_page_receipts/);
    assert.match(sql, /UNIQUE \(read_id, page_number\)/);
    assert.match(sql, /source_cursor_fingerprint/);
    assert.match(sql, /next_source_cursor_fingerprint/);
    assert.match(sql, /CREATE TABLE external_reservation_listing_health/);
    assert.doesNotMatch(sql, /external_reservation_listing_read_requirements/);
    assert.match(sql, /external_reservation_listing_health\.read_generation < EXCLUDED\.read_generation|read_generation bigint NOT NULL/);
    assert.doesNotMatch(sql, /customer|guest|email|phone|price|amount|cookie|raw_response/i);
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

  it("stores product operator invitation secrets only as hashes and keeps commands separate", async () => {
    const sql = await readFile(new URL("../migrations/0013_product_operators.sql", import.meta.url), "utf8");
    const invitations = sql.match(/CREATE TABLE product_operator_invitations \(([\s\S]*?)\n\);/)?.[1] ?? "";
    assert.match(invitations, /token_hash bytea NOT NULL CHECK \(octet_length\(token_hash\) = 32\)/);
    assert.doesNotMatch(invitations, /plain|secret|token_value/i);
    assert.match(invitations, /FOREIGN KEY \(provider_id, product_id\)/);
    assert.match(sql, /expires_at <= created_at \+ interval '7 days'/);
    assert.match(sql, /CREATE TABLE product_operator_grants/);
    assert.match(sql, /PRIMARY KEY \(provider_id, product_id, niho_user_id\)/);
    assert.match(sql, /CHECK \(\(accepted_niho_user_id IS NULL\) = \(accepted_at IS NULL\)\)/);
    assert.match(sql, /FOREIGN KEY \(invitation_id, provider_id, product_id, niho_user_id\)/);
    assert.match(sql, /CREATE TABLE product_operator_commands/);
    assert.match(sql, /CREATE TABLE product_operator_audit_events/);
    assert.doesNotMatch(sql, /calendar_commands|calendar_outbox_events/);
  });
});
