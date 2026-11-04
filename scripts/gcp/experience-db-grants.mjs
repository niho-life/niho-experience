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
  // DELETE: the mail job removes grants and sessions that can no longer open or read a booking.
  booking_access_grants: { write: IUD },
  // 出欠 (#107): one row per booking, its mark replaced when the host corrects it.
  booking_attendance: { write: IU },
  // 取消と返金 (#285 slice 7): commands are append-only; refunds and requests move through their states.
  booking_cancellation_commands: { write: I },
  booking_cancellation_requests: { write: IU },
  // Short-lived, HMAC-only IP counters for public Checkout (#374); no address or guest reference is stored.
  booking_checkout_ip_buckets: { write: IUD },
  booking_guests: { write: IU },
  // Immutable after-booking logistics; DELETE is only used after the booking page's 30-day retention window.
  booking_meeting_guide_snapshots: { write: ID },
  booking_inventory_snapshots: { write: I },
  booking_refunds: { write: IU },
  booking_resource_occupancies: { write: I },
  booking_sessions: { write: IUD },
  bookings: { write: IU },
  calendar_commands: { write: I, updateColumns: ["created_at"] },
  calendar_outbox_events: { write: IU },
  calendar_reconciliation_ticks: { write: IU },
  channel_admin_commands: { write: I },
  channel_audit_events: { write: I },
  channel_desired_states: { write: IU },
  channel_ensured_slots: { write: IU },
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
  experience_offer_prices: { write: IUD },
  experience_product_sale_terms: { write: IU },
  experience_product_media_assets: { write: I },
  experience_product_media_selection: { write: ID },
  // Provider originals are append-only except for revoking the replaced or removed asset.
  experience_provider_media_assets: { write: IU },
  experience_provider_media_selection: { write: IUD },
  experience_provider_media_state: { write: IU },
  experience_product_publication_media: { write: I },
  // Immutable public copies are inserted; state and short-lived NIHO/Connect readiness move independently.
  experience_product_publications: { write: I },
  experience_product_booking_guides: { write: IU },
  experience_product_publication_states: { write: IU },
  experience_products: { write: IU },
  // Support case content is private to current Admins; its event ledger stores only actor/action/outcome metadata.
  experience_support_cases: { write: IU },
  experience_support_case_commands: { write: I, updateColumns: ["created_at"] },
  experience_support_case_events: { write: I },
  // Notification producers are database triggers in the booking transaction; each Admin's read is append-only.
  experience_support_admin_notifications: { write: I },
  experience_support_admin_notification_reads: { write: I },
  // Financial snapshots are updated by the reconciliation worker; transfer commands remain durable and auditable.
  experience_booking_settlements: { write: IU },
  experience_settlement_commands: { write: IU },
  // A host workspace is created only after the BFF verifies the current NIHO OWNER.
  experience_providers: { write: I, updateColumns: ["created_at"] },
  // 出欠 of OTA bookings (#194 PR B, 0039): one row per reservation, its mark replaced when the host corrects it.
  external_reservation_attendance: { write: IU },
  external_reservation_conflict_cases: { write: IU },
  external_reservation_conflict_members: { write: IU },
  // OTA の予約者 (#194): the ledger keeps what a reader sent; the mail job's erasure blanks it (no DELETE).
  external_reservation_guests: { write: IU },
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
  // What the booking-events job wrote to each booking calendar (#238): claimed, then marked written or absent.
  google_booking_calendar_events: { write: IU },
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
  // PII-free post-accept mail feedback; DELETE with the booking guest's PII erasure.
  guest_mail_delivery_feedback: { write: ID, updateColumns: ["created_at"] },
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
  // ホストへのメールの宛先 (#194, 0038): the sign-in's copy and the host's choice; DELETE when access ends (the mail job).
  host_notification_address_confirmations: { write: IUD },
  host_notification_addresses: { write: IUD },
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
  // 設定 › カレンダー's bookings feed (#109): issued again in place, deleted when the OWNER stops it.
  provider_calendar_feeds: { write: IUD },
  provider_google_calendar_inventory: { write: ID, updateColumns: ["fetched_at"] },
  provider_google_calendars: { write: IUD },
  provider_google_connections: { write: IUD },
  // The publication BFF mirrors its currently verified OWNER role; no browser role is accepted.
  provider_memberships: { write: IU },
  provider_notification_preferences: { write: IU },
  provider_publication_readiness: { write: IU },
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

// Store sources that only the operator's scripts run, with the migration identity (never the runtime).
// `runtime-grants.test.ts` leaves them out of the runtime scan and checks that web and the public store
// entrypoint never reach them.
export const OPERATOR_ONLY_SOURCES = Object.freeze([
  "packages/experience-store/src/site-sale-registration.ts",
]);
