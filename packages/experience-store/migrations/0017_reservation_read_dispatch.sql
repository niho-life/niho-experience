BEGIN;

-- Reservation-window scans reuse OBSERVE jobs and the existing browser lease,
-- but remain a distinct purpose so they can never reach the availability
-- executor or mutate availability readback state.
ALTER TABLE channel_jobs
  ADD COLUMN purpose text NOT NULL DEFAULT 'AVAILABILITY'
    CHECK (purpose IN ('AVAILABILITY','RESERVATION_WINDOW')),
  ADD COLUMN dispatch_sequence bigint NOT NULL DEFAULT 0 CHECK (dispatch_sequence >= 0),
  ADD COLUMN dispatch_worker_id text REFERENCES channel_workers(id) ON DELETE RESTRICT,
  ADD COLUMN dispatch_assignment_version bigint CHECK (dispatch_assignment_version > 0),
  ADD CONSTRAINT channel_jobs_dispatch_assignment_check CHECK (
    (purpose='AVAILABILITY' AND dispatch_worker_id IS NULL AND dispatch_assignment_version IS NULL AND dispatch_sequence=0)
    OR (purpose='RESERVATION_WINDOW' AND dispatch_worker_id IS NOT NULL AND dispatch_assignment_version IS NOT NULL AND dispatch_sequence>0)
  );

ALTER TABLE channel_jobs DROP CONSTRAINT channel_jobs_outcome_check;
ALTER TABLE channel_jobs
  ADD CONSTRAINT channel_jobs_outcome_check CHECK (
    outcome IN ('VERIFIED','RESERVATION_VERIFIED','AUTH_REQUIRED','NEEDS_REVIEW',
      'UNKNOWN_AFTER_SAVE','RETRY_WAIT','SUPERSEDED')
  );

DO $$
DECLARE constraint_name text;
BEGIN
  SELECT conname INTO constraint_name
    FROM pg_constraint
   WHERE conrelid='channel_jobs'::regclass AND contype='u'
     AND pg_get_constraintdef(oid) LIKE
       'UNIQUE (listing_id, occurrence_id, action, account_version, desired_version, mapping_version)%';
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE channel_jobs DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

ALTER TABLE channel_jobs
  ADD CONSTRAINT channel_jobs_purpose_identity_key
  UNIQUE (listing_id,occurrence_id,action,purpose,dispatch_sequence,account_version,desired_version,mapping_version);

ALTER TABLE channel_job_results
  ADD COLUMN reservation_read_id uuid REFERENCES external_reservation_reads(read_id) ON DELETE RESTRICT,
  ADD COLUMN reservation_receipt_id uuid REFERENCES external_reservation_window_page_receipts(receipt_id) ON DELETE RESTRICT;

ALTER TABLE channel_job_results DROP CONSTRAINT channel_job_results_outcome_check;
ALTER TABLE channel_job_results DROP CONSTRAINT channel_job_results_occurrence_id_check;
ALTER TABLE channel_job_results DROP CONSTRAINT channel_job_results_check;
ALTER TABLE channel_job_results DROP CONSTRAINT channel_job_results_check1;
ALTER TABLE channel_job_results
  ALTER COLUMN occurrence_id DROP NOT NULL,
  ALTER COLUMN source_start_at DROP NOT NULL,
  ALTER COLUMN source_end_at DROP NOT NULL,
  ADD CONSTRAINT channel_job_results_outcome_check CHECK (
    outcome IN ('VERIFIED','RESERVATION_VERIFIED','AUTH_REQUIRED','NEEDS_REVIEW',
      'UNKNOWN_AFTER_SAVE','RETRY_WAIT','SUPERSEDED')
  ),
  ADD CONSTRAINT channel_job_results_shape_check CHECK (
    (outcome = 'RESERVATION_VERIFIED'
      AND reservation_read_id IS NOT NULL AND reservation_receipt_id IS NOT NULL
      AND occurrence_id IS NULL AND source_start_at IS NULL AND source_end_at IS NULL
      AND observed_state IS NULL AND observed_bookable IS NULL
      AND observed_manually_blocked IS NULL AND observed_at IS NULL)
    OR
    (outcome <> 'RESERVATION_VERIFIED'
      AND reservation_read_id IS NULL AND reservation_receipt_id IS NULL
      AND occurrence_id IS NOT NULL AND length(occurrence_id) BETWEEN 1 AND 256
      AND source_start_at IS NOT NULL AND source_end_at IS NOT NULL
      AND source_end_at > source_start_at)
  ),
  ADD CONSTRAINT channel_job_results_verified_check CHECK (
    outcome <> 'VERIFIED' OR (exact_target_match AND observed_state IS NOT NULL
      AND observed_bookable IS NOT NULL AND observed_manually_blocked IS NOT NULL
      AND observed_at IS NOT NULL)
  );

-- One durable scheduler row per listing. A pending leased job is deliberately
-- retained until the normal stopped-result path releases the existing lease.
CREATE TABLE external_reservation_read_dispatch_states (
  provider_id text NOT NULL,
  listing_id text NOT NULL,
  account_id text NOT NULL,
  product_id text NOT NULL,
  next_due_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  pending_job_id uuid UNIQUE REFERENCES channel_jobs(id) ON DELETE RESTRICT,
  dispatch_sequence bigint NOT NULL DEFAULT 0 CHECK (dispatch_sequence >= 0),
  last_success_at timestamptz,
  retry_count smallint NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 5),
  last_error text CHECK (last_error IS NULL OR (length(last_error) BETWEEN 1 AND 80 AND last_error ~ '^[A-Z0-9_]+$')),
  halted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id,listing_id),
  FOREIGN KEY (provider_id,account_id) REFERENCES channel_external_accounts(provider_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id,listing_id) REFERENCES channel_listings(provider_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id,product_id) REFERENCES experience_products(provider_id,id) ON DELETE RESTRICT,
  CHECK ((halted_at IS NULL) OR last_error IS NOT NULL)
);

CREATE INDEX external_reservation_read_dispatch_due_idx
  ON external_reservation_read_dispatch_states (next_due_at,provider_id,listing_id)
  WHERE pending_job_id IS NULL AND halted_at IS NULL;

COMMIT;
