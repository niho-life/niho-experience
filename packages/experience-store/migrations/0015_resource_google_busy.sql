BEGIN;

-- A sequence, rather than a per-row counter, prevents delete/recreate ABA.
CREATE SEQUENCE provider_google_connection_generation_seq;
ALTER TABLE provider_google_connections
  ADD COLUMN connection_generation bigint NOT NULL
    DEFAULT nextval('provider_google_connection_generation_seq')
    CHECK (connection_generation > 0);
CREATE UNIQUE INDEX provider_google_connections_generation_idx
  ON provider_google_connections (connection_generation);

-- A bounded, server-only snapshot of calendars visible to the connected OWNER.
-- Names and opaque IDs are never exposed through non-OWNER read models.
CREATE TABLE provider_google_calendar_inventory (
  provider_id text NOT NULL REFERENCES experience_providers(id) ON DELETE RESTRICT,
  connection_generation bigint NOT NULL CHECK (connection_generation > 0),
  opaque_calendar_id text NOT NULL CHECK (length(opaque_calendar_id) BETWEEN 1 AND 512),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 300),
  is_primary boolean NOT NULL DEFAULT false,
  fetched_at timestamptz NOT NULL,
  PRIMARY KEY (provider_id, opaque_calendar_id)
);

CREATE TABLE resource_google_calendars (
  provider_id text NOT NULL,
  resource_id text NOT NULL,
  opaque_calendar_id text NOT NULL CHECK (length(opaque_calendar_id) BETWEEN 1 AND 512),
  enabled boolean NOT NULL DEFAULT false,
  settings_version bigint NOT NULL DEFAULT 1 CHECK (settings_version > 0),
  connection_generation bigint NOT NULL CHECK (connection_generation > 0),
  sync_status text NOT NULL DEFAULT 'STALE' CHECK (sync_status IN ('FRESH','STALE','FAILED')),
  last_attempted_at timestamptz,
  last_succeeded_at timestamptz,
  fresh_until timestamptz,
  coverage_start timestamptz,
  coverage_end timestamptz,
  sync_dirty boolean NOT NULL DEFAULT true,
  next_sync_due_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sync_claim_id uuid,
  sync_claimed_by text REFERENCES channel_workers(id) ON DELETE RESTRICT,
  sync_lease_epoch bigint NOT NULL DEFAULT 0 CHECK (sync_lease_epoch >= 0),
  sync_lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, resource_id),
  FOREIGN KEY (provider_id, resource_id)
    REFERENCES inventory_resources(provider_id, id) ON DELETE RESTRICT,
  CHECK ((coverage_start IS NULL) = (coverage_end IS NULL)),
  CHECK (coverage_end IS NULL OR coverage_end > coverage_start),
  CHECK ((sync_claim_id IS NULL) = (sync_claimed_by IS NULL)),
  CHECK ((sync_claim_id IS NULL) = (sync_lease_expires_at IS NULL))
);
CREATE INDEX resource_google_calendars_due_idx
  ON resource_google_calendars (next_sync_due_at, provider_id, resource_id)
  WHERE enabled=true;

CREATE TABLE resource_google_busy_intervals (
  provider_id text NOT NULL,
  resource_id text NOT NULL,
  settings_version bigint NOT NULL CHECK (settings_version > 0),
  connection_generation bigint NOT NULL CHECK (connection_generation > 0),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  PRIMARY KEY (provider_id, resource_id, start_at, end_at),
  FOREIGN KEY (provider_id, resource_id)
    REFERENCES resource_google_calendars(provider_id, resource_id) ON DELETE CASCADE,
  CHECK (end_at > start_at)
);
CREATE INDEX resource_google_busy_intervals_overlap_idx
  ON resource_google_busy_intervals (provider_id, resource_id, start_at, end_at);

CREATE TABLE resource_google_watch_channels (
  channel_id uuid PRIMARY KEY,
  provider_id text NOT NULL,
  resource_id text NOT NULL,
  connection_generation bigint NOT NULL CHECK (connection_generation > 0),
  settings_version bigint NOT NULL CHECK (settings_version > 0),
  google_resource_id text NOT NULL CHECK (length(google_resource_id) BETWEEN 1 AND 512),
  token_digest text NOT NULL CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  last_message_number numeric(20,0) NOT NULL DEFAULT 0 CHECK (last_message_number >= 0),
  stopped_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (provider_id, resource_id)
    REFERENCES resource_google_calendars(provider_id, resource_id) ON DELETE RESTRICT
);
CREATE INDEX resource_google_watch_current_idx
  ON resource_google_watch_channels (provider_id, resource_id, expires_at)
  WHERE stopped_at IS NULL;

-- Receipts make a retried Studio trigger observable without returning calendar IDs.
CREATE TABLE resource_google_sync_receipts (
  claim_id uuid PRIMARY KEY,
  provider_id text NOT NULL REFERENCES experience_providers(id) ON DELETE RESTRICT,
  worker_id text NOT NULL REFERENCES channel_workers(id) ON DELETE RESTRICT,
  lease_epoch bigint NOT NULL CHECK (lease_epoch > 0),
  outcome text NOT NULL CHECK (outcome IN ('APPLIED','SUPERSEDED','FAILED')),
  calendars_attempted integer NOT NULL CHECK (calendars_attempted BETWEEN 0 AND 10),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

COMMIT;
