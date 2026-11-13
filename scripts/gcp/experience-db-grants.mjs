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
  // Verified Admin writes are immutable and contain actor/resource/action metadata only.
  admin_product_draft_audit_events: { write: I },
  admin_product_english_reviews: { write: I },
  admin_proxy_publication_audit_events: { write: I },
  // Admin のログイン (ADR 0003, 0066): sessions of admins signed in with Google; the mail job deletes ended ones.
  admin_sessions: { write: IUD },
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
  experience_product_sales_plan_versions: { write: I },
  experience_product_sales_plan_states: { write: IU },
  experience_sales_plan_transition_checkouts: { write: IU },
  experience_product_media_assets: { write: I },
  experience_product_media_selection: { write: ID },
  // Provider originals are append-only except for revoking the replaced or removed asset.
  experience_provider_media_assets: { write: IU },
  experience_provider_media_selection: { write: IUD },
  experience_provider_media_state: { write: IU },
  // Admin-confirmed public identity is provider-owned, not seller- or membership-owned.
  experience_provider_public_profiles: { write: IU },
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
  // A seller mapping is operator-provisioned; the BFF binds OWNER after the current NIHO identity matches it.
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
  // 団体・個別の相談 (#532, 0074): kept, edited by hand in the Admin console and mailed; v0 deletes by hand with a
  // separate operator role (docs/group-inquiry.md), so no DELETE here. The mail rows are removed with the inquiry (CASCADE).
  group_inquiries: { write: IU },
  group_inquiry_mails: { write: IU },
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
  // ホストのアカウント (ADR 0003, 0064): an account is suspended, never deleted. Sign-in link requests (their own mail
  // queue) and sessions are deleted by the mail job once they can no longer open or read anything.
  host_accounts: { write: IU },
  host_login_requests: { write: IUD },
  // ホストへのメールの宛先 (#194, 0038): the sign-in's copy and the host's choice; DELETE when access ends (the mail job).
  host_notification_address_confirmations: { write: IUD },
  host_notification_addresses: { write: IUD },
  host_push_subscriptions: { write: IUD },
  host_sessions: { write: IUD },
  inventory_resources: { write: IU },
  managed_booking_disputes: { write: IU },
  managed_booking_dispute_events: { write: I },
  managed_provider_compensations: { write: IU },
  managed_provider_compensation_events: { write: I },
  // 開催回の担当 (#535, 0073): a term is opened, then released or given an agreed fee; its history is append-only.
  occurrence_assignment_commands: { write: I },
  occurrence_assignment_events: { write: I },
  occurrence_assignments: { write: I, updateColumns: ["released_at", "agreed_fee_yen", "agreed_fee_set_at"] },
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
  // The publication BFF binds only the verified NIHO identity to its explicitly mapped Experience seller.
  provider_memberships: { write: IU },
  provider_notification_preferences: { write: IU },
  // Experience-native team CAS. Receipts are append-only; revisions and fixed-hour lookup buckets are upserted.
  provider_team_commands: { write: I },
  provider_team_resolve_buckets: { write: IU },
  provider_team_revisions: { write: IU },
  // 受取口座の利用同意 (ADR 0003, 0065): the current host-account OWNER records a consent; a withdrawal or a replacement
  // only marks the active row revoked (the rows are the consent's history: no DELETE, no other column changes).
  provider_payout_account_consents: { write: I, updateColumns: ["revoked_at", "revoked_by_niho_user_id"] },
  provider_publication_readiness: { write: IU },
  // Current OWNER writes only explicitly public seller fields. Idempotency receipts are append-only metadata
  // (actor, request fingerprint, action and applied version) and never duplicate disclosure/contact bodies.
  provider_seller_disclosures: { write: IU },
  provider_seller_disclosure_commands: { write: I },
  // ホスト紹介文 (#146): the current OWNER saves and withdraws (DELETE) the provider's one public bio. No history.
  provider_host_bios: { write: IUD },
  // Explicit Connect lookup mappings and host-account sellers (0065) are written by the operator registration scripts
  // only. The BFF's FOR SHARE needs UPDATE on a non-identity timestamp column to lock the matched row; no runtime path
  // changes it.
  experience_host_seller_profiles: { write: [], updateColumns: ["updated_at"] },
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
  "packages/experience-store/src/host-seller-provisioning.ts",
  "packages/experience-store/src/legacy-guide-import.ts",
]);
