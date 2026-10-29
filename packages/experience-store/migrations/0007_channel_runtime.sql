BEGIN;

CREATE TABLE channel_external_accounts (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  provider_id text NOT NULL REFERENCES experience_providers(id) ON DELETE RESTRICT,
  site text NOT NULL CHECK (length(site) BETWEEN 1 AND 80),
  external_account_id text NOT NULL CHECK (length(external_account_id) BETWEEN 1 AND 256),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 300),
  operating_model smallint NOT NULL CHECK (operating_model BETWEEN 1 AND 4),
  active boolean NOT NULL DEFAULT false,
  delegated_until timestamptz,
  revoked_at timestamptz,
  private_profile_ref text CHECK (private_profile_ref IS NULL OR (length(private_profile_ref) BETWEEN 1 AND 512 AND private_profile_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]*$')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  quarantined_at timestamptz,
  quarantine_reason text CHECK (quarantine_reason IS NULL OR length(quarantine_reason) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (site, external_account_id),
  UNIQUE (provider_id, id),
  CHECK ((quarantined_at IS NULL) = (quarantine_reason IS NULL))
);

CREATE TABLE channel_listings (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  provider_id text NOT NULL,
  account_id text NOT NULL,
  product_id text NOT NULL,
  external_product_id text NOT NULL CHECK (length(external_product_id) BETWEEN 1 AND 256),
  external_option_id text NOT NULL DEFAULT '' CHECK (length(external_option_id) <= 256),
  time_zone text NOT NULL DEFAULT 'Asia/Tokyo' CHECK (time_zone = 'Asia/Tokyo'),
  adapter text NOT NULL CHECK (length(adapter) BETWEEN 1 AND 120),
  adapter_version text NOT NULL CHECK (length(adapter_version) BETWEEN 1 AND 80),
  connection_mode text NOT NULL CHECK (connection_mode IN ('BROWSER', 'GOOGLE', 'API')),
  can_observe boolean NOT NULL DEFAULT false,
  can_close boolean NOT NULL DEFAULT false,
  can_open boolean NOT NULL DEFAULT false,
  can_create boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT false,
  mapping_version bigint NOT NULL DEFAULT 1 CHECK (mapping_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (account_id, external_product_id, external_option_id),
  UNIQUE (provider_id, id),
  UNIQUE (provider_id, account_id, id),
  FOREIGN KEY (provider_id, account_id) REFERENCES channel_external_accounts(provider_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id, product_id) REFERENCES experience_products(provider_id, id) ON DELETE RESTRICT
);

CREATE INDEX channel_listings_product_idx ON channel_listings (provider_id, product_id) WHERE active;

CREATE TABLE channel_admin_commands (
  command_id uuid PRIMARY KEY,
  actor_niho_user_id text NOT NULL CHECK (length(actor_niho_user_id) BETWEEN 1 AND 256),
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE channel_audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_niho_user_id text NOT NULL CHECK (length(actor_niho_user_id) BETWEEN 1 AND 256),
  provider_id text,
  resource_type text NOT NULL CHECK (length(resource_type) BETWEEN 1 AND 80),
  resource_id text NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 256),
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  command_id uuid REFERENCES channel_admin_commands(command_id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE channel_workers (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  credential_digest text NOT NULL CHECK (credential_digest ~ '^[0-9a-f]{64}$'),
  credential_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_heartbeat_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE channel_worker_accounts (
  worker_id text NOT NULL REFERENCES channel_workers(id) ON DELETE RESTRICT,
  account_id text NOT NULL REFERENCES channel_external_accounts(id) ON DELETE RESTRICT,
  assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (worker_id, account_id)
);

CREATE TABLE channel_desired_states (
  listing_id text NOT NULL REFERENCES channel_listings(id) ON DELETE RESTRICT,
  provider_id text NOT NULL,
  occurrence_id text NOT NULL CHECK (length(occurrence_id) BETWEEN 1 AND 256),
  desired_state text NOT NULL CHECK (desired_state IN ('OPEN', 'CLOSED')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 160),
  desired_version bigint NOT NULL CHECK (desired_version > 0),
  mapping_version bigint NOT NULL CHECK (mapping_version > 0),
  source_start_at timestamptz NOT NULL,
  source_end_at timestamptz NOT NULL,
  observed_state text CHECK (observed_state IN ('OPEN', 'CLOSED')),
  observed_desired_version bigint,
  observed_mapping_version bigint,
  last_verified_at timestamptz,
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 300),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (listing_id, occurrence_id),
  FOREIGN KEY (provider_id, listing_id) REFERENCES channel_listings(provider_id, id) ON DELETE RESTRICT,
  CHECK (source_end_at > source_start_at),
  CHECK ((observed_state IS NULL) = (last_verified_at IS NULL))
);

CREATE TABLE channel_jobs (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL,
  account_id text NOT NULL,
  listing_id text NOT NULL,
  occurrence_id text NOT NULL CHECK (length(occurrence_id) BETWEEN 1 AND 256),
  action text NOT NULL CHECK (action IN ('SET_OPEN', 'SET_CLOSED', 'OBSERVE')),
  account_version bigint NOT NULL CHECK (account_version > 0),
  desired_version bigint NOT NULL CHECK (desired_version > 0),
  mapping_version bigint NOT NULL CHECK (mapping_version > 0),
  target_site text NOT NULL CHECK (length(target_site) BETWEEN 1 AND 80),
  target_external_account_id text NOT NULL CHECK (length(target_external_account_id) BETWEEN 1 AND 256),
  target_external_product_id text NOT NULL CHECK (length(target_external_product_id) BETWEEN 1 AND 256),
  target_external_option_id text NOT NULL CHECK (length(target_external_option_id) <= 256),
  target_time_zone text NOT NULL CHECK (target_time_zone = 'Asia/Tokyo'),
  target_adapter text NOT NULL CHECK (length(target_adapter) BETWEEN 1 AND 120),
  target_adapter_version text NOT NULL CHECK (length(target_adapter_version) BETWEEN 1 AND 80),
  target_connection_mode text NOT NULL CHECK (target_connection_mode IN ('BROWSER', 'GOOGLE', 'API')),
  source_start_at timestamptz NOT NULL,
  source_end_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'LEASED', 'FINISHED')),
  priority smallint NOT NULL CHECK (priority BETWEEN 0 AND 100),
  attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  job_deadline_at timestamptz,
  leased_worker_id text REFERENCES channel_workers(id) ON DELETE RESTRICT,
  lease_digest text CHECK (lease_digest IS NULL OR lease_digest ~ '^[0-9a-f]{64}$'),
  lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_started_at timestamptz,
  lease_expires_at timestamptz,
  outcome text CHECK (outcome IN ('VERIFIED','AUTH_REQUIRED','NEEDS_REVIEW','UNKNOWN_AFTER_SAVE','RETRY_WAIT','SUPERSEDED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (listing_id, occurrence_id, action, account_version, desired_version, mapping_version),
  FOREIGN KEY (provider_id, account_id) REFERENCES channel_external_accounts(provider_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id, listing_id) REFERENCES channel_listings(provider_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id, account_id, listing_id) REFERENCES channel_listings(provider_id, account_id, id) ON DELETE RESTRICT,
  CHECK (source_end_at > source_start_at),
  CHECK (
    (status = 'LEASED' AND leased_worker_id IS NOT NULL AND lease_digest IS NOT NULL AND lease_epoch > 0
      AND lease_started_at IS NOT NULL AND lease_expires_at IS NOT NULL AND job_deadline_at IS NOT NULL)
    OR status <> 'LEASED'
  )
);

-- An expired lease deliberately remains LEASED. Only an authenticated stopped result or
-- explicit stop-confirmed recovery changes it, so neither lock can silently disappear.
CREATE UNIQUE INDEX channel_jobs_global_browser_lease ON channel_jobs ((1)) WHERE status = 'LEASED';
CREATE UNIQUE INDEX channel_jobs_account_lease ON channel_jobs (account_id) WHERE status = 'LEASED';
CREATE INDEX channel_jobs_claim_idx ON channel_jobs (priority DESC, next_attempt_at, created_at) WHERE status = 'QUEUED';

CREATE TABLE channel_job_results (
  result_id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES channel_jobs(id) ON DELETE RESTRICT,
  worker_id text NOT NULL REFERENCES channel_workers(id) ON DELETE RESTRICT,
  lease_epoch bigint NOT NULL CHECK (lease_epoch > 0),
  lease_digest text NOT NULL CHECK (lease_digest ~ '^[0-9a-f]{64}$'),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('VERIFIED','AUTH_REQUIRED','NEEDS_REVIEW','UNKNOWN_AFTER_SAVE','RETRY_WAIT','SUPERSEDED')),
  stopped boolean NOT NULL,
  exact_target_match boolean NOT NULL,
  occurrence_id text NOT NULL CHECK (length(occurrence_id) BETWEEN 1 AND 256),
  source_start_at timestamptz NOT NULL,
  source_end_at timestamptz NOT NULL,
  observed_state text CHECK (observed_state IN ('OPEN', 'CLOSED')),
  observed_bookable boolean,
  observed_manually_blocked boolean,
  observed_at timestamptz,
  accepted_as_current boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (job_id, fingerprint),
  CHECK (source_end_at > source_start_at),
  CHECK (outcome <> 'VERIFIED' OR (exact_target_match AND observed_state IS NOT NULL
    AND observed_bookable IS NOT NULL AND observed_manually_blocked IS NOT NULL AND observed_at IS NOT NULL))
);

COMMIT;
