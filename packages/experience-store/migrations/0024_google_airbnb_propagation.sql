BEGIN;

-- A typed RETRY_WAIT receipt is a durable, independently observed Airbnb
-- mismatch only when it carries the same exact three-field Google proof as a
-- VERIFIED receipt. Ordinary RETRY_WAIT results remain proof-free.
ALTER TABLE channel_job_results
  DROP CONSTRAINT channel_job_results_google_airbnb_proof_check,
  ADD CONSTRAINT channel_job_results_google_airbnb_proof_check CHECK (
    (google_airbnb_delivery_id IS NULL AND google_airbnb_evidence IS NULL
      AND google_airbnb_party_size IS NULL AND google_airbnb_verified_at IS NULL)
    OR
    (outcome IN ('VERIFIED','RETRY_WAIT') AND google_airbnb_delivery_id IS NOT NULL
      AND google_airbnb_evidence IS NOT NULL AND google_airbnb_party_size IS NOT NULL
      AND google_airbnb_evidence='EXACT_SLOT_V1' AND google_airbnb_party_size=1
      AND google_airbnb_verified_at IS NOT NULL AND observed_manually_blocked IS NULL
      AND observed_state IS NOT NULL AND observed_bookable IS NOT NULL
      AND observed_at IS NOT NULL AND google_airbnb_verified_at<=observed_at
      AND ((observed_state='OPEN' AND observed_bookable=true)
        OR (observed_state='CLOSED' AND observed_bookable=false)))
  );

-- Propagation observations are AVAILABILITY/OBSERVE jobs, but are not another
-- desired-state identity. The delivery marker gives them a separate durable
-- identity and fixes them to the worker assignment that observed the mismatch.
ALTER TABLE channel_jobs
  ADD COLUMN google_propagation_delivery_id uuid
    REFERENCES google_channel_deliveries(id) ON DELETE RESTRICT;

DROP INDEX channel_jobs_availability_identity;
CREATE UNIQUE INDEX channel_jobs_availability_identity
  ON channel_jobs (listing_id,occurrence_id,action,account_version,desired_version,mapping_version)
  WHERE purpose='AVAILABILITY' AND google_propagation_delivery_id IS NULL;

ALTER TABLE channel_jobs
  DROP CONSTRAINT channel_jobs_dispatch_assignment_check,
  ADD CONSTRAINT channel_jobs_dispatch_assignment_check CHECK (
    (purpose IN ('AVAILABILITY','SLOT_RETIREMENT') AND google_propagation_delivery_id IS NULL
      AND dispatch_worker_id IS NULL AND dispatch_assignment_version IS NULL AND dispatch_sequence=0)
    OR
    (purpose='AVAILABILITY' AND google_propagation_delivery_id IS NOT NULL
      AND dispatch_worker_id IS NOT NULL AND dispatch_assignment_version IS NOT NULL AND dispatch_sequence=0)
    OR
    (purpose='RESERVATION_WINDOW' AND google_propagation_delivery_id IS NULL
      AND dispatch_worker_id IS NOT NULL AND dispatch_assignment_version IS NOT NULL AND dispatch_sequence>0)
  ),
  ADD CONSTRAINT channel_jobs_google_propagation_shape_check CHECK (
    google_propagation_delivery_id IS NULL OR
    (purpose='AVAILABILITY' AND action='OBSERVE' AND slot_retirement_id IS NULL
      AND target_site='Airbnb' AND target_connection_mode='GOOGLE'
      AND target_adapter='airbnb-google-busy' AND target_adapter_version='1')
  );

CREATE UNIQUE INDEX channel_jobs_google_propagation_live
  ON channel_jobs (google_propagation_delivery_id)
  WHERE google_propagation_delivery_id IS NOT NULL AND status IN ('QUEUED','LEASED');

-- This is intentionally separate from channel_propagation_measurements/targets:
-- those tables measure reservation fan-out to other channels, while this row
-- owns one Google-output-to-Airbnb convergence wait.
CREATE TABLE google_airbnb_propagation_waits (
  delivery_id uuid PRIMARY KEY REFERENCES google_channel_deliveries(id) ON DELETE RESTRICT,
  provider_id text NOT NULL,
  account_id text NOT NULL,
  listing_id text NOT NULL,
  occurrence_id text NOT NULL CHECK (length(occurrence_id) BETWEEN 1 AND 256),
  desired_state text NOT NULL CHECK (desired_state IN ('OPEN','CLOSED')),
  desired_version bigint NOT NULL CHECK (desired_version > 0),
  mapping_version bigint NOT NULL CHECK (mapping_version > 0),
  account_version bigint NOT NULL CHECK (account_version > 0),
  source_start_at timestamptz NOT NULL,
  source_end_at timestamptz NOT NULL,
  target_site text NOT NULL CHECK (target_site='Airbnb'),
  target_external_account_id text NOT NULL CHECK (length(target_external_account_id) BETWEEN 1 AND 256),
  target_external_product_id text NOT NULL CHECK (length(target_external_product_id) BETWEEN 1 AND 256),
  target_external_option_id text NOT NULL CHECK (length(target_external_option_id) <= 256),
  target_adapter text NOT NULL CHECK (target_adapter='airbnb-google-busy'),
  target_adapter_version text NOT NULL CHECK (target_adapter_version='1'),
  target_connection_mode text NOT NULL CHECK (target_connection_mode='GOOGLE'),
  binding_version bigint NOT NULL CHECK (binding_version > 0),
  connection_generation bigint NOT NULL CHECK (connection_generation > 0),
  binding_calendar_digest text NOT NULL CHECK (binding_calendar_digest ~ '^[0-9a-f]{64}$'),
  granted_scopes_digest text NOT NULL CHECK (granted_scopes_digest ~ '^[0-9a-f]{64}$'),
  dispatched_worker_id text NOT NULL REFERENCES channel_workers(id) ON DELETE RESTRICT,
  dispatched_assignment_version bigint NOT NULL CHECK (dispatched_assignment_version > 0),
  first_verified_at timestamptz NOT NULL,
  deadline_at timestamptz NOT NULL,
  next_due_at timestamptz NOT NULL,
  pending_job_id uuid UNIQUE REFERENCES channel_jobs(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('WAITING','CHECKING','MATCHED','SUPERSEDED','NEEDS_REVIEW')),
  latest_reason text CHECK (latest_reason IS NULL OR
    (length(latest_reason) BETWEEN 1 AND 80 AND latest_reason ~ '^[A-Z0-9_]+$')),
  latest_observed_at timestamptz,
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (provider_id,account_id) REFERENCES channel_external_accounts(provider_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id,listing_id) REFERENCES channel_listings(provider_id,id) ON DELETE RESTRICT,
  CHECK (source_end_at > source_start_at),
  CHECK (deadline_at = first_verified_at + interval '60 minutes'),
  CHECK (next_due_at <= deadline_at),
  CHECK ((status='CHECKING' AND pending_job_id IS NOT NULL)
    OR (status IN ('WAITING','MATCHED') AND pending_job_id IS NULL)
    OR status IN ('SUPERSEDED','NEEDS_REVIEW')),
  CHECK (status NOT IN ('SUPERSEDED','NEEDS_REVIEW') OR latest_reason IS NOT NULL)
);

CREATE INDEX google_airbnb_propagation_waits_due
  ON google_airbnb_propagation_waits (dispatched_worker_id,next_due_at,delivery_id)
  WHERE status IN ('WAITING','CHECKING');

COMMIT;
