// Runtime privileges for the dedicated Experience database, one entry per table.
// Every table gets SELECT. `write` lists table-level privileges; `updateColumns`
// gives column-only UPDATE where PostgreSQL needs it for SELECT ... FOR UPDATE/SHARE
// but the runtime never changes the row. A new table or a new INSERT/UPDATE/DELETE,
// upsert, or row lock in the store must be declared here; the store test
// `runtime-grants.test.ts` fails otherwise.

const I = ["INSERT"];
const IU = ["INSERT", "UPDATE"];
const ID = ["INSERT", "DELETE"];
const IUD = ["INSERT", "UPDATE", "DELETE"];

export const RUNTIME_TABLE_GRANTS = Object.freeze({
  booking_guests: { write: IU },
  booking_inventory_snapshots: { write: I },
  booking_resource_occupancies: { write: I },
  bookings: { write: IU },
  calendar_commands: { write: I, updateColumns: ["created_at"] },
  calendar_outbox_events: { write: IU },
  calendar_reconciliation_ticks: { write: IU },
  channel_admin_commands: { write: I },
  channel_audit_events: { write: I },
  channel_desired_states: { write: IU },
  channel_external_accounts: { write: IU },
  channel_job_results: { write: I },
  channel_jobs: { write: IU },
  channel_listings: { write: IU },
  channel_propagation_measurements: { write: IU },
  channel_propagation_targets: { write: IU },
  channel_runtime_incidents: { write: IU },
  channel_slot_retirements: { write: IU },
  channel_watchdog_state: { write: IU },
  channel_worker_accounts: { write: IU },
  channel_workers: { write: IU },
  experience_product_sale_terms: { write: IU },
  experience_products: { write: IU },
  // Providers are provisioned privately; the runtime only locks them.
  experience_providers: { write: [], updateColumns: ["created_at"] },
  external_reservation_conflict_cases: { write: IU },
  external_reservation_conflict_members: { write: IU },
  external_reservation_inventory_snapshots: { write: I },
  external_reservation_listing_health: { write: IU },
  external_reservation_read_dispatch_states: { write: IU },
  external_reservation_read_manifest_occurrences: { write: I },
  external_reservation_reads: { write: IU },
  external_reservation_receipts: { write: I },
  external_reservation_resource_occupancies: { write: I },
  external_reservation_revisions: { write: I },
  external_reservation_window_facts: { write: I },
  external_reservation_window_page_receipts: { write: IU },
  external_reservations: { write: IU },
  google_busy_intervals: { write: ID },
  google_channel_activation_commands: { write: I },
  google_channel_anchor_journals: { write: IU },
  google_channel_deliveries: { write: IU },
  google_channel_output_bindings: { write: I, updateColumns: ["active", "binding_version", "initialize_missing_open_anchor", "updated_at"] },
  google_channel_setup_journals: { write: IU },
  google_airbnb_propagation_waits: { write: IU },
  guest_question_messages: { write: IU },
  guest_question_reply_tokens: { write: IU },
  // DELETE: the mail job erases a question a year after its last message; its messages and reply
  // links go by ON DELETE CASCADE, which PostgreSQL runs as the table owner.
  guest_question_threads: { write: IUD },
  guest_review_invitations: { write: IU },
  guest_reviews: { write: IU },
  guide_admin_command_receipts: { write: I },
  guide_articles: { write: IU },
  guide_categories: { write: IU },
  guide_draft_product_links: { write: ID },
  guide_legacy_slug_reservations: { write: [] },
  guide_media_assets: { write: IU },
  guide_product_link_invitations: { write: IU },
  guide_product_link_memberships: { write: IU },
  guide_publication_media: { write: I },
  guide_publication_product_links: { write: I },
  guide_publications: { write: IU },
  guide_writer_grants: { write: IU },
  host_push_subscriptions: { write: IUD },
  inventory_resources: { write: IU },
  // Read by the host notification and guest mail jobs, which also mark rows done and move their lease.
  outbox_messages: { write: IU },
  // Append-only; the ledger trigger also rejects mutation.
  payment_ledger_entries: { write: I },
  product_inventory_resources: { write: ID },
  product_inventory_settings: { write: IU },
  product_operator_audit_events: { write: I },
  product_operator_commands: { write: I },
  product_operator_grants: { write: IU },
  product_operator_invitations: { write: IU },
  provider_google_calendar_inventory: { write: ID, updateColumns: ["fetched_at"] },
  provider_google_calendars: { write: IUD },
  provider_google_connections: { write: IUD },
  // role and active stay immutable to the runtime; the timestamp only enables FOR SHARE.
  provider_memberships: { write: [], updateColumns: ["updated_at"] },
  provider_notification_preferences: { write: IU },
  provider_sale_settings: { write: IU },
  resource_google_busy_intervals: { write: ID },
  resource_google_calendars: { write: IU },
  resource_google_sync_receipts: { write: I },
  resource_google_watch_channels: { write: IU },
  schedule_occurrence_overrides: { write: IU },
  schedule_occurrence_sales_states: { write: IU },
  schedule_occurrences: { write: IU },
  schedule_rules: { write: IU },
  stripe_webhook_events: { write: I },
});

/** Owned by the migration role; the runtime gets no privilege on it. */
export const MIGRATION_LEDGER_TABLE = "experience_schema_migrations";
