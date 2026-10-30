BEGIN;

-- Provisioning is intentionally private and out of scope for the runtime API.
-- One app-created output calendar is pinned to one current Airbnb listing and
-- one Google connection generation. It is never inferred from calendar names.
CREATE TABLE google_channel_output_bindings (
  provider_id text NOT NULL,
  listing_id text NOT NULL,
  mapping_version bigint NOT NULL CHECK (mapping_version > 0),
  connection_generation bigint NOT NULL CHECK (connection_generation > 0),
  opaque_calendar_id text NOT NULL CHECK (length(opaque_calendar_id) BETWEEN 1 AND 512),
  binding_version bigint NOT NULL DEFAULT 1 CHECK (binding_version > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id,listing_id),
  FOREIGN KEY (provider_id,listing_id) REFERENCES channel_listings(provider_id,id) ON DELETE RESTRICT,
  UNIQUE (opaque_calendar_id)
);

CREATE TABLE google_channel_deliveries (
  id uuid PRIMARY KEY,
  intent_fingerprint text NOT NULL UNIQUE CHECK (intent_fingerprint ~ '^[0-9a-f]{64}$'),
  job_id uuid NOT NULL REFERENCES channel_jobs(id) ON DELETE RESTRICT,
  provider_id text NOT NULL,
  account_id text NOT NULL,
  listing_id text NOT NULL,
  occurrence_id text NOT NULL CHECK (length(occurrence_id) BETWEEN 1 AND 256),
  action text NOT NULL CHECK (action IN ('SET_OPEN','SET_CLOSED')),
  desired_state text NOT NULL CHECK (desired_state IN ('OPEN','CLOSED')),
  desired_version bigint NOT NULL CHECK (desired_version > 0),
  mapping_version bigint NOT NULL CHECK (mapping_version > 0),
  source_start_at timestamptz NOT NULL,
  source_end_at timestamptz NOT NULL,
  worker_id text NOT NULL REFERENCES channel_workers(id) ON DELETE RESTRICT,
  lease_epoch bigint NOT NULL CHECK (lease_epoch > 0),
  assignment_version bigint NOT NULL CHECK (assignment_version > 0),
  account_version bigint NOT NULL CHECK (account_version > 0),
  binding_version bigint NOT NULL CHECK (binding_version > 0),
  connection_generation bigint NOT NULL CHECK (connection_generation > 0),
  binding_calendar_digest text NOT NULL CHECK (binding_calendar_digest ~ '^[0-9a-f]{64}$'),
  granted_scopes_digest text NOT NULL CHECK (granted_scopes_digest ~ '^[0-9a-f]{64}$'),
  operation_nonce uuid NOT NULL,
  operation_epoch bigint NOT NULL DEFAULT 1 CHECK (operation_epoch > 0),
  operation_kind text NOT NULL CHECK (operation_kind IN ('DISPATCH','RECONCILE')),
  operation_job_id uuid NOT NULL REFERENCES channel_jobs(id) ON DELETE RESTRICT,
  operation_worker_id text NOT NULL REFERENCES channel_workers(id) ON DELETE RESTRICT,
  operation_lease_epoch bigint NOT NULL CHECK (operation_lease_epoch > 0),
  operation_assignment_version bigint NOT NULL CHECK (operation_assignment_version > 0),
  phase text NOT NULL CHECK (phase IN ('DISPATCHING','GOOGLE_VERIFIED','UNCERTAIN','NOT_MATCHED','STOPPED')),
  reason text CHECK (reason IS NULL OR (length(reason) BETWEEN 1 AND 80 AND reason ~ '^[A-Z0-9_]+$')),
  event_id text CHECK (event_id IS NULL OR length(event_id) BETWEEN 1 AND 256),
  event_etag text CHECK (event_etag IS NULL OR length(event_etag) BETWEEN 1 AND 1024),
  binding_hash text CHECK (binding_hash IS NULL OR length(binding_hash) BETWEEN 1 AND 256),
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
  FOREIGN KEY (provider_id,account_id) REFERENCES channel_external_accounts(provider_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id,listing_id) REFERENCES channel_listings(provider_id,id) ON DELETE RESTRICT,
  CHECK (source_end_at > source_start_at),
  CHECK (phase<>'GOOGLE_VERIFIED' OR event_etag IS NOT NULL),
  CHECK (google_end_at IS NULL OR google_end_at > google_start_at)
);

CREATE INDEX google_channel_deliveries_job_idx ON google_channel_deliveries (job_id,created_at DESC);
CREATE INDEX google_channel_deliveries_unconfirmed_idx
  ON google_channel_deliveries (provider_id,listing_id,occurrence_id)
  WHERE phase IN ('DISPATCHING','UNCERTAIN');

COMMIT;
