BEGIN;

-- Insert-only bootstrap of the deterministic OPEN/CLOSED anchor is fenced from
-- both setup and regular delivery. No credential or Google response body is
-- persisted here.
CREATE TABLE google_channel_anchor_journals (
  provider_id text NOT NULL,
  command_id uuid NOT NULL,
  account_id text NOT NULL,
  listing_id text NOT NULL,
  occurrence_id text NOT NULL CHECK (length(occurrence_id) BETWEEN 1 AND 256),
  actor_niho_user_id text NOT NULL CHECK (length(actor_niho_user_id) BETWEEN 1 AND 256),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  operation text NOT NULL CHECK (operation IN ('INITIALIZE','INSPECT')),
  operation_nonce uuid NOT NULL,
  operation_epoch bigint NOT NULL DEFAULT 1 CHECK (operation_epoch > 0),
  account_version bigint NOT NULL CHECK (account_version > 0),
  mapping_version bigint NOT NULL CHECK (mapping_version > 0),
  binding_version bigint NOT NULL CHECK (binding_version > 0),
  connection_generation bigint NOT NULL CHECK (connection_generation > 0),
  binding_calendar_digest text NOT NULL CHECK (binding_calendar_digest ~ '^[0-9a-f]{64}$'),
  granted_scopes_digest text NOT NULL CHECK (granted_scopes_digest ~ '^[0-9a-f]{64}$'),
  desired_state text NOT NULL CHECK (desired_state IN ('OPEN','CLOSED')),
  desired_version bigint NOT NULL CHECK (desired_version > 0),
  source_start_at timestamptz NOT NULL,
  source_end_at timestamptz NOT NULL,
  phase text NOT NULL CHECK (phase IN ('PREPARING','INITIALIZING','GOOGLE_VERIFIED','UNCERTAIN','FAILED_BEFORE_INITIALIZE')),
  reason text CHECK (reason IS NULL OR (length(reason) BETWEEN 1 AND 80 AND reason ~ '^[A-Z0-9_]+$')),
  event_id text CHECK (event_id IS NULL OR length(event_id) BETWEEN 1 AND 256),
  event_etag text CHECK (event_etag IS NULL OR length(event_etag) BETWEEN 1 AND 1024),
  google_binding_hash text CHECK (google_binding_hash IS NULL OR length(google_binding_hash) BETWEEN 1 AND 256),
  google_mapping_version bigint CHECK (google_mapping_version > 0),
  google_desired_version bigint CHECK (google_desired_version > 0),
  google_start_at timestamptz,
  google_end_at timestamptz,
  google_desired_state text CHECK (google_desired_state IN ('OPEN','CLOSED')),
  google_transparency text CHECK (google_transparency IN ('opaque','transparent')),
  changed boolean,
  write_acknowledged boolean,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id,command_id),
  FOREIGN KEY (provider_id,account_id) REFERENCES channel_external_accounts(provider_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id,listing_id) REFERENCES channel_listings(provider_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id,actor_niho_user_id) REFERENCES provider_memberships(provider_id,niho_user_id) ON DELETE RESTRICT,
  CHECK (source_end_at > source_start_at),
  CHECK (google_end_at IS NULL OR google_end_at > google_start_at),
  CHECK (phase<>'GOOGLE_VERIFIED' OR event_etag IS NOT NULL),
  CHECK ((phase IN ('UNCERTAIN','FAILED_BEFORE_INITIALIZE')) OR reason IS NULL)
);

-- A new command or desired fence cannot evade an insert whose outcome may
-- still arrive late. Explicit inspection reuses the original command row and
-- advances its nonce/epoch instead.
CREATE UNIQUE INDEX google_channel_anchor_unresolved_occurrence_idx
  ON google_channel_anchor_journals (provider_id,listing_id,occurrence_id)
  WHERE phase IN ('PREPARING','INITIALIZING','UNCERTAIN');

CREATE INDEX google_channel_anchor_listing_idx
  ON google_channel_anchor_journals (provider_id,listing_id,occurrence_id,created_at DESC);

COMMIT;
