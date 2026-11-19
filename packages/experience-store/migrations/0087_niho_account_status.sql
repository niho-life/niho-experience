BEGIN;

-- #627: account status is checked per server-side Experience session. A merge gets a new active
-- binding while the old binding remains in its immutable history; article and publication actors
-- (the existing hst_ IDs) are deliberately untouched.
ALTER TABLE host_sessions
  ADD COLUMN niho_status_checked_at timestamptz;

ALTER TABLE traveler_sessions
  ADD COLUMN niho_status_checked_at timestamptz;

-- A merged host identity is closed and re-bound to NIHO's canonical ID. Keep the transition in
-- the append-only audit with both IDs, rather than rewriting the old binding row.
ALTER TABLE host_account_identity_events
  ADD COLUMN merged_into_subject text;

ALTER TABLE host_account_identity_events
  DROP CONSTRAINT host_account_identity_events_event_kind_check,
  ADD CONSTRAINT host_account_identity_events_event_kind_check
    CHECK (event_kind IN ('LINKED', 'UNLINKED', 'LINK_REFUSED', 'UNLINK_REFUSED', 'MERGED')),
  DROP CONSTRAINT host_account_identity_events_via_check,
  ADD CONSTRAINT host_account_identity_events_via_check
    CHECK (via IN ('INVITATION', 'SETTINGS', 'OPS', 'WRITER', 'NIHO_STATUS')),
  ADD CONSTRAINT host_account_identity_events_merged_into_check
    CHECK ((event_kind = 'MERGED') = (merged_into_subject IS NOT NULL));

COMMIT;
