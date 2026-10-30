BEGIN;

-- OWNER-initiated provisioning is fenced separately from delivery. The journal
-- contains only bounded authority snapshots and selected setup metadata.
CREATE TABLE google_channel_setup_journals (
  provider_id text NOT NULL,
  command_id uuid NOT NULL,
  listing_id text NOT NULL,
  account_id text NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_by_niho_user_id text NOT NULL CHECK (length(created_by_niho_user_id) BETWEEN 1 AND 256),
  operation_nonce uuid NOT NULL,
  expected_mapping_version bigint NOT NULL CHECK (expected_mapping_version > 0),
  account_version bigint NOT NULL CHECK (account_version > 0),
  connection_generation bigint NOT NULL CHECK (connection_generation > 0),
  granted_scopes_digest text NOT NULL CHECK (granted_scopes_digest ~ '^[0-9a-f]{64}$'),
  calendar_summary text NOT NULL CHECK (length(calendar_summary) BETWEEN 1 AND 200),
  phase text NOT NULL CHECK (phase IN ('PREPARING','CREATING','READY_FOR_CONNECTION','FAILED_BEFORE_CREATE','UNCERTAIN')),
  failure_reason text CHECK (failure_reason IS NULL OR (length(failure_reason) BETWEEN 1 AND 80 AND failure_reason ~ '^[A-Z0-9_]+$')),
  created_calendar_id text CHECK (created_calendar_id IS NULL OR length(created_calendar_id) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id,command_id),
  FOREIGN KEY (provider_id,listing_id) REFERENCES channel_listings(provider_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id,account_id) REFERENCES channel_external_accounts(provider_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id,created_by_niho_user_id) REFERENCES provider_memberships(provider_id,niho_user_id) ON DELETE RESTRICT,
  CHECK ((phase='READY_FOR_CONNECTION') = (created_calendar_id IS NOT NULL)),
  CHECK ((phase IN ('FAILED_BEFORE_CREATE','UNCERTAIN')) OR failure_reason IS NULL)
);

-- A different command may not step around an unresolved create attempt. A READY
-- binding is protected independently by google_channel_output_bindings.
CREATE UNIQUE INDEX google_channel_setup_unresolved_listing_idx
  ON google_channel_setup_journals (provider_id,listing_id)
  WHERE phase IN ('PREPARING','CREATING','UNCERTAIN');

CREATE INDEX google_channel_setup_listing_idx
  ON google_channel_setup_journals (provider_id,listing_id,created_at DESC);

COMMIT;
