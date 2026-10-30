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

  it("separates scheduled reservation reads from availability observations and keeps durable listing state", async () => {
    const sql = await readFile(new URL("../migrations/0017_reservation_read_dispatch.sql", import.meta.url), "utf8");
    assert.match(sql, /purpose IN \('AVAILABILITY','RESERVATION_WINDOW'\)/);
    assert.match(sql, /CREATE TABLE external_reservation_read_dispatch_states/);
    assert.match(sql, /pending_job_id uuid UNIQUE REFERENCES channel_jobs/);
    assert.match(sql, /reservation_read_id uuid REFERENCES external_reservation_reads/);
    assert.match(sql, /reservation_receipt_id uuid REFERENCES external_reservation_window_page_receipts/);
    assert.match(sql, /CREATE UNIQUE INDEX channel_jobs_availability_identity/);
    assert.match(sql, /WHERE purpose='AVAILABILITY'/);
    assert.doesNotMatch(sql, /UNIQUE \(listing_id,occurrence_id,action,purpose/);
    assert.match(sql, /outcome = 'RESERVATION_VERIFIED'/);
    assert.match(sql, /observed_state IS NULL AND observed_bookable IS NULL/);
    assert.doesNotMatch(sql, /customer|guest|email|phone|price|amount|cookie|raw_response/i);
  });

  it("journals Google channel output without creating a parallel desired-state source", async () => {
    const sql = await readFile(new URL("../migrations/0018_google_channel_delivery.sql", import.meta.url), "utf8");
    assert.match(sql, /CREATE TABLE google_channel_output_bindings/);
    assert.match(sql, /UNIQUE \(opaque_calendar_id\)/);
    assert.match(sql, /CREATE TABLE google_channel_deliveries/);
    assert.match(sql, /intent_fingerprint text NOT NULL UNIQUE/);
    assert.match(sql, /phase IN \('DISPATCHING','GOOGLE_VERIFIED','UNCERTAIN','NOT_MATCHED','STOPPED'\)/);
    assert.match(sql, /lease_epoch bigint NOT NULL/);
    assert.match(sql, /assignment_version bigint NOT NULL/);
    assert.match(sql, /account_version bigint NOT NULL/);
    assert.match(sql, /binding_calendar_digest text NOT NULL/);
    assert.match(sql, /granted_scopes_digest text NOT NULL/);
    assert.match(sql, /operation_nonce uuid NOT NULL/);
    assert.match(sql, /operation_epoch bigint NOT NULL/);
    assert.doesNotMatch(sql, /refresh_token|access_token|raw_response|error_body|guest|email|price|amount/i);
    assert.doesNotMatch(sql, /CREATE TABLE .*desired/i);
  });

  it("fences OWNER calendar creation before I/O without persisting credentials or response bodies", async () => {
    const sql = await readFile(new URL("../migrations/0019_google_channel_setup.sql", import.meta.url), "utf8");
    assert.match(sql, /CREATE TABLE google_channel_setup_journals/);
    assert.match(sql, /phase IN \('PREPARING','CREATING','READY_FOR_CONNECTION','FAILED_BEFORE_CREATE','UNCERTAIN'\)/);
    assert.match(sql, /operation_nonce uuid NOT NULL/);
    assert.match(sql, /created_by_niho_user_id text NOT NULL/);
    assert.match(sql, /expected_mapping_version bigint NOT NULL/);
    assert.match(sql, /connection_generation bigint NOT NULL/);
    assert.match(sql, /granted_scopes_digest text NOT NULL/);
    assert.match(sql, /WHERE phase IN \('PREPARING','CREATING','UNCERTAIN'\)/);
    assert.doesNotMatch(sql, /access_token|refresh_token|raw_response|error_body|customer|guest|email|phone/i);
  });

  it("adds OPEN hold, desired change age, deduplicated incidents, and one watchdog row without private data", async () => {
    const sql = await readFile(new URL("../migrations/0021_channel_runtime_watchdog.sql", import.meta.url), "utf8");
    assert.match(sql, /^BEGIN;/);
    assert.match(sql, /COMMIT;\s*$/);
    assert.match(sql, /ALTER TABLE channel_workers\s+ADD COLUMN open_hold_since timestamptz;/);
    assert.match(sql, /UPDATE channel_desired_states SET desired_changed_at = updated_at;/);
    assert.match(sql, /desired_changed_at SET DEFAULT clock_timestamp\(\)/);
    assert.match(sql, /desired_changed_at SET NOT NULL/);
    assert.match(sql, /kind IN \('WORKER_STALE','SYNC_OVERDUE','RESERVATION_READ_OVERDUE','ACCOUNT_QUARANTINED'\)/);
    assert.match(sql, /subject_type IN \('worker','account'\)/);
    assert.match(sql, /resolution IN \('AUTO_RECOVERED'\)/);
    assert.match(sql, /CHECK \(\(resolved_at IS NULL\) = \(resolution IS NULL\)\)/);
    assert.match(sql, /CREATE UNIQUE INDEX channel_runtime_incidents_open_dedupe[\s\S]*\(dedupe_key\) WHERE resolved_at IS NULL/);
    assert.match(sql, /id smallint PRIMARY KEY CHECK \(id = 1\)/);
    assert.doesNotMatch(sql, /DROP |DELETE FROM|external_account_id|customer|guest|email|phone|price|amount|cookie|bearer|token|raw_response/i);
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

  it("tracks rescheduled old slots as a separate SET_CLOSED-only job purpose without customer data (#241)", async () => {
    const sql = await readFile(new URL("../migrations/0021_channel_slot_retirements.sql", import.meta.url), "utf8");
    assert.match(sql, /^BEGIN;/);
    assert.match(sql, /COMMIT;\s*$/);
    const table = sql.match(/CREATE TABLE channel_slot_retirements \(([\s\S]*?)\n\);/)?.[1] ?? "";
    assert.match(table, /status IN \('PENDING','CLOSED_VERIFIED','NEEDS_REVIEW','SUPERSEDED'\)/);
    assert.match(table, /reason IS NULL OR \(length\(reason\) BETWEEN 1 AND 80 AND reason ~ '\^\[A-Z0-9_\]\+\$'\)/);
    assert.match(table, /retirement_version bigint NOT NULL CHECK \(retirement_version > 0\)/);
    assert.match(table, /UNIQUE \(listing_id, occurrence_id, source_start_at, source_end_at\)/);
    assert.match(table, /FOREIGN KEY \(provider_id, listing_id\) REFERENCES channel_listings\(provider_id, id\)/);
    assert.match(table, /CHECK \(source_end_at > source_start_at\)/);
    assert.doesNotMatch(table, /external_|customer|guest|email|phone|price|amount|raw_response/i);
    assert.match(sql, /slot_retirement_id uuid REFERENCES channel_slot_retirements\(id\)/);
    assert.match(sql, /purpose IN \('AVAILABILITY','RESERVATION_WINDOW','SLOT_RETIREMENT'\)/);
    assert.match(sql, /purpose='SLOT_RETIREMENT' AND action='SET_CLOSED' AND slot_retirement_id IS NOT NULL/);
    assert.match(sql, /purpose<>'SLOT_RETIREMENT' AND slot_retirement_id IS NULL/);
    assert.match(sql, /purpose IN \('AVAILABILITY','SLOT_RETIREMENT'\) AND dispatch_worker_id IS NULL/);
    assert.match(sql, /CREATE UNIQUE INDEX channel_jobs_slot_retirement_identity\s+ON channel_jobs \(slot_retirement_id,desired_version\)\s+WHERE purpose='SLOT_RETIREMENT'/);
    assert.doesNotMatch(sql, /channel_jobs_availability_identity/);
  });

  it("keeps only the three stoppable notification choices per provider, with no addresses (#109)", async () => {
    const sql = await readFile(new URL("../migrations/0020_provider_notification_preferences.sql", import.meta.url), "utf8");
    assert.match(sql, /^BEGIN;/);
    assert.match(sql, /COMMIT;\s*$/);
    const table = sql.match(/CREATE TABLE provider_notification_preferences \(([\s\S]*?)\n\);/)?.[1] ?? "";
    assert.match(table, /notification_key IN \('GUEST_MESSAGE', 'DAY_BEFORE_SUMMARY', 'NEW_REVIEW'\)/);
    assert.match(table, /PRIMARY KEY \(provider_id, notification_key\)/);
    assert.match(table, /REFERENCES experience_providers\(id\)/);
    assert.doesNotMatch(table, /email|address|display_name|body\b|NEW_BOOKING|CANCELLATION/i);
  });

  it("keeps guest questions per provider, reply links only as hashes, and no IP addresses (#105 #106)", async () => {
    const sql = await readFile(new URL("../migrations/0022_guest_questions.sql", import.meta.url), "utf8");
    assert.match(sql, /^BEGIN;/);
    assert.match(sql, /COMMIT;\s*$/);
    assert.doesNotMatch(sql, /CREATE EXTENSION|\bip_address\b|\binet\b|user_agent/i);
    const threads = sql.match(/CREATE TABLE guest_question_threads \(([\s\S]*?)\n\);/)?.[1] ?? "";
    assert.match(threads, /FOREIGN KEY \(provider_id, product_id\) REFERENCES experience_products\(provider_id, id\)/);
    assert.match(threads, /topic IN \('CHILDREN', 'FOOD', 'ACCESS', 'LANGUAGE', 'OTHER'\)/);
    assert.match(threads, /guest_email_key = lower\(guest_email\)/);
    assert.match(threads, /UNIQUE \(provider_id, product_id, client_request_key\)/);
    const messages = sql.match(/CREATE TABLE guest_question_messages \(([\s\S]*?)\n\);/)?.[1] ?? "";
    assert.match(messages, /FOREIGN KEY \(provider_id, thread_id\) REFERENCES guest_question_threads\(provider_id, id\)/);
    assert.match(messages, /delivery_status IN \('PENDING', 'SENDING', 'SENT', 'FAILED'\)/);
    assert.match(messages, /UNIQUE \(provider_id, command_id\)/);
    assert.match(messages, /author = 'GUEST' AND length\(body\) <= 1000\) OR \(author = 'HOST' AND length\(body\) <= 4000/);
    assert.doesNotMatch(messages, /email/i);
    const tokens = sql.match(/CREATE TABLE guest_question_reply_tokens \(([\s\S]*?)\n\);/)?.[1] ?? "";
    assert.match(tokens, /token_hash bytea PRIMARY KEY CHECK \(octet_length\(token_hash\) = 32\)/);
    assert.doesNotMatch(tokens, /token_value|plain|secret|email/i);
    assert.doesNotMatch(sql, /outbox_messages/);
  });

  it("keeps sale terms per product and guest details per booking, erasable and without IP addresses (#285)", async () => {
    const sql = await readFile(new URL("../migrations/0023_guest_bookings.sql", import.meta.url), "utf8");
    assert.match(sql, /^BEGIN;/);
    assert.match(sql, /COMMIT;\s*$/);
    assert.doesNotMatch(sql, /CREATE EXTENSION|\bip_address\b|\binet\b|user_agent|ALTER TABLE|DROP /i);
    const terms = sql.match(/CREATE TABLE experience_product_sale_terms \(([\s\S]*?)\n\);/)?.[1] ?? "";
    assert.match(terms, /PRIMARY KEY \(provider_id, product_id\)/);
    assert.match(terms, /FOREIGN KEY \(provider_id, product_id\) REFERENCES experience_products\(provider_id, id\)/);
    assert.match(terms, /cancellation_policy IN \('FREE_UNTIL_24H', 'FREE_UNTIL_48H', 'NONE'\)/);
    assert.match(terms, /max_party_size >= minimum_participants/);
    assert.match(terms, /booking_questions_fingerprint text NOT NULL CHECK \(booking_questions_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'\)/);
    const guests = sql.match(/CREATE TABLE booking_guests \(([\s\S]*?)\n\);/)?.[1] ?? "";
    assert.match(guests, /PRIMARY KEY \(provider_id, booking_id\)/);
    assert.match(guests, /FOREIGN KEY \(provider_id, booking_id\) REFERENCES bookings\(provider_id, id\)/);
    assert.match(guests, /guest_email_key = lower\(guest_email\)/);
    assert.match(guests, /guest_language IN \('EN', 'JA'\)/);
    assert.match(guests, /request_fingerprint text NOT NULL/);
    assert.match(guests, /pii_erased_at timestamptz,/);
    // Personal columns are NULL exactly when the row was erased.
    assert.match(guests, /pii_erased_at IS NOT NULL\s+OR \(guest_name IS NOT NULL AND guest_email IS NOT NULL/);
    assert.match(guests, /pii_erased_at IS NULL\s+OR \(guest_name IS NULL AND guest_email IS NULL/);
    assert.match(sql, /ON booking_guests \(provider_id, guest_email_key, created_at\)/);
    assert.match(sql, /a booking checkout session is set once/);
    assert.doesNotMatch(sql, /outbox_messages/);
  });
});
