BEGIN;

-- Keep the original one-occurrence contract intact while allowing a server
-- issued, immutable window manifest to share the same OBSERVE lease.
ALTER TABLE external_reservation_reads
  ADD COLUMN read_scope text NOT NULL DEFAULT 'OCCURRENCE'
    CHECK (read_scope IN ('OCCURRENCE','WINDOW')),
  ADD COLUMN coverage_from timestamptz,
  ADD COLUMN coverage_to timestamptz,
  ADD COLUMN manifest_fingerprint text
    CHECK (manifest_fingerprint IS NULL OR manifest_fingerprint ~ '^[0-9a-f]{64}$'),
  ADD COLUMN read_started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ALTER COLUMN occurrence_id DROP NOT NULL,
  ALTER COLUMN source_start_at DROP NOT NULL,
  ALTER COLUMN source_end_at DROP NOT NULL;

ALTER TABLE external_reservation_reads
  DROP CONSTRAINT external_reservation_reads_check,
  DROP CONSTRAINT external_reservation_reads_check1,
  DROP CONSTRAINT external_reservation_reads_job_id_lease_epoch_key;

ALTER TABLE external_reservation_reads
  ADD CONSTRAINT external_reservation_reads_scope_check CHECK (
    (read_scope = 'OCCURRENCE'
      AND occurrence_id IS NOT NULL AND source_start_at IS NOT NULL AND source_end_at IS NOT NULL
      AND source_end_at > source_start_at
      AND coverage_from IS NULL AND coverage_to IS NULL AND manifest_fingerprint IS NULL)
    OR
    (read_scope = 'WINDOW'
      AND occurrence_id IS NULL AND source_start_at IS NULL AND source_end_at IS NULL
      AND coverage_from IS NOT NULL AND coverage_to IS NOT NULL AND coverage_to > coverage_from
      AND coverage_to <= coverage_from + interval '62 days'
      AND manifest_fingerprint IS NOT NULL)
  ),
  ADD CONSTRAINT external_reservation_reads_completion_check CHECK (
    (status = 'OPEN' AND submitted_receipt_id IS NULL AND submitted_at IS NULL AND batch_status IS NULL)
    OR (status = 'SUBMITTED' AND submitted_at IS NOT NULL AND batch_status IS NOT NULL
      AND ((read_scope = 'OCCURRENCE' AND submitted_receipt_id IS NOT NULL)
        OR (read_scope = 'WINDOW' AND submitted_receipt_id IS NULL)))
  ),
  ADD CONSTRAINT external_reservation_reads_job_lease_scope_key UNIQUE (job_id, lease_epoch, read_scope),
  ADD CONSTRAINT external_reservation_reads_identity_key UNIQUE (read_id, job_id, worker_id);

CREATE FUNCTION protect_external_reservation_read_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.read_id IS DISTINCT FROM OLD.read_id
    OR NEW.read_generation IS DISTINCT FROM OLD.read_generation
    OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.worker_id IS DISTINCT FROM OLD.worker_id
    OR NEW.lease_epoch IS DISTINCT FROM OLD.lease_epoch
    OR NEW.lease_assignment_version IS DISTINCT FROM OLD.lease_assignment_version
    OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.listing_id IS DISTINCT FROM OLD.listing_id
    OR NEW.product_id IS DISTINCT FROM OLD.product_id
    OR NEW.occurrence_id IS DISTINCT FROM OLD.occurrence_id
    OR NEW.target_site IS DISTINCT FROM OLD.target_site
    OR NEW.target_external_account_id IS DISTINCT FROM OLD.target_external_account_id
    OR NEW.target_external_product_id IS DISTINCT FROM OLD.target_external_product_id
    OR NEW.target_external_option_id IS DISTINCT FROM OLD.target_external_option_id
    OR NEW.source_start_at IS DISTINCT FROM OLD.source_start_at
    OR NEW.source_end_at IS DISTINCT FROM OLD.source_end_at
    OR NEW.account_version IS DISTINCT FROM OLD.account_version
    OR NEW.mapping_version IS DISTINCT FROM OLD.mapping_version
    OR NEW.read_scope IS DISTINCT FROM OLD.read_scope
    OR NEW.coverage_from IS DISTINCT FROM OLD.coverage_from
    OR NEW.coverage_to IS DISTINCT FROM OLD.coverage_to
    OR NEW.manifest_fingerprint IS DISTINCT FROM OLD.manifest_fingerprint
    OR NEW.read_started_at IS DISTINCT FROM OLD.read_started_at THEN
    RAISE EXCEPTION 'external reservation read scope is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER external_reservation_read_scope_no_update
BEFORE UPDATE ON external_reservation_reads
FOR EACH ROW EXECUTE FUNCTION protect_external_reservation_read_scope();

-- Canonical occurrences are generated from the current Experience schedule;
-- the worker can only select one of these exact rows.
CREATE TABLE external_reservation_read_manifest_occurrences (
  read_id uuid NOT NULL REFERENCES external_reservation_reads(read_id) ON DELETE RESTRICT,
  manifest_index integer NOT NULL CHECK (manifest_index BETWEEN 0 AND 511),
  occurrence_id text NOT NULL CHECK (length(occurrence_id) BETWEEN 1 AND 256),
  source_start_at timestamptz NOT NULL,
  source_end_at timestamptz NOT NULL,
  PRIMARY KEY (read_id, manifest_index),
  UNIQUE (read_id, occurrence_id),
  CHECK (source_end_at > source_start_at)
);

CREATE TRIGGER external_reservation_manifest_no_update
BEFORE UPDATE OR DELETE ON external_reservation_read_manifest_occurrences
FOR EACH ROW EXECUTE FUNCTION reject_booking_inventory_snapshot_mutation();

-- Each page has a server-issued receipt ID. The request fingerprint includes
-- page order, cursor, snapshot token, terminal evidence, and canonical facts.
CREATE TABLE external_reservation_window_page_receipts (
  receipt_id uuid PRIMARY KEY,
  read_id uuid NOT NULL REFERENCES external_reservation_reads(read_id) ON DELETE RESTRICT,
  job_id uuid NOT NULL REFERENCES channel_jobs(id) ON DELETE RESTRICT,
  worker_id text NOT NULL REFERENCES channel_workers(id) ON DELETE RESTRICT,
  page_number integer NOT NULL CHECK (page_number BETWEEN 0 AND 4095),
  previous_receipt_id uuid,
  request_fingerprint text CHECK (request_fingerprint IS NULL OR request_fingerprint ~ '^[0-9a-f]{64}$'),
  source_cursor_fingerprint text CHECK (source_cursor_fingerprint IS NULL OR source_cursor_fingerprint ~ '^[0-9a-f]{64}$'),
  next_source_cursor_fingerprint text CHECK (next_source_cursor_fingerprint IS NULL OR next_source_cursor_fingerprint ~ '^[0-9a-f]{64}$'),
  snapshot_token_fingerprint text CHECK (snapshot_token_fingerprint IS NULL OR snapshot_token_fingerprint ~ '^[0-9a-f]{64}$'),
  terminal_status text CHECK (terminal_status IN ('COMPLETE','PARTIAL','FAILED')),
  result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  submitted_at timestamptz,
  UNIQUE (read_id, page_number),
  UNIQUE (read_id, receipt_id),
  FOREIGN KEY (read_id,job_id,worker_id)
    REFERENCES external_reservation_reads(read_id,job_id,worker_id) ON DELETE RESTRICT,
  FOREIGN KEY (read_id,previous_receipt_id)
    REFERENCES external_reservation_window_page_receipts(read_id,receipt_id) ON DELETE RESTRICT,
  CHECK ((page_number = 0 AND previous_receipt_id IS NULL) OR (page_number > 0 AND previous_receipt_id IS NOT NULL)),
  CHECK ((request_fingerprint IS NULL AND result IS NULL AND submitted_at IS NULL AND terminal_status IS NULL
      AND source_cursor_fingerprint IS NULL AND next_source_cursor_fingerprint IS NULL
      AND snapshot_token_fingerprint IS NULL)
    OR (request_fingerprint IS NOT NULL AND result IS NOT NULL AND submitted_at IS NOT NULL
      AND ((page_number = 0 AND source_cursor_fingerprint IS NULL)
        OR (page_number > 0 AND source_cursor_fingerprint IS NOT NULL))
      AND ((terminal_status IS NULL AND next_source_cursor_fingerprint IS NOT NULL)
        OR (terminal_status IS NOT NULL AND next_source_cursor_fingerprint IS NULL))))
);

-- Cross-page duplicates are accepted only when their canonical fact is equal.
CREATE TABLE external_reservation_window_facts (
  read_id uuid NOT NULL REFERENCES external_reservation_reads(read_id) ON DELETE RESTRICT,
  external_reservation_id text NOT NULL CHECK (length(external_reservation_id) BETWEEN 1 AND 256),
  observation_fingerprint text NOT NULL CHECK (observation_fingerprint ~ '^[0-9a-f]{64}$'),
  first_page_number integer NOT NULL CHECK (first_page_number BETWEEN 0 AND 4095),
  PRIMARY KEY (read_id, external_reservation_id)
);

CREATE TRIGGER external_reservation_window_facts_no_update
BEFORE UPDATE OR DELETE ON external_reservation_window_facts
FOR EACH ROW EXECUTE FUNCTION reject_booking_inventory_snapshot_mutation();

-- Health is deliberately separate from facts. Only a complete, current,
-- contiguous scan can advance it, and newer generations win.
CREATE TABLE external_reservation_listing_health (
  provider_id text NOT NULL,
  listing_id text NOT NULL,
  account_id text NOT NULL,
  product_id text NOT NULL,
  read_id uuid NOT NULL UNIQUE REFERENCES external_reservation_reads(read_id) ON DELETE RESTRICT,
  read_generation bigint NOT NULL CHECK (read_generation > 0),
  account_version bigint NOT NULL CHECK (account_version > 0),
  mapping_version bigint NOT NULL CHECK (mapping_version > 0),
  coverage_from timestamptz NOT NULL,
  coverage_to timestamptz NOT NULL,
  read_started_at timestamptz NOT NULL,
  read_finished_at timestamptz NOT NULL,
  last_complete_at timestamptz NOT NULL,
  next_due_at timestamptz NOT NULL,
  fresh_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, listing_id),
  FOREIGN KEY (provider_id, account_id) REFERENCES channel_external_accounts(provider_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id, listing_id) REFERENCES channel_listings(provider_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id, product_id) REFERENCES experience_products(provider_id, id) ON DELETE RESTRICT,
  CHECK (coverage_to > coverage_from),
  CHECK (read_finished_at >= read_started_at),
  CHECK (next_due_at > last_complete_at),
  CHECK (fresh_until > next_due_at)
);

CREATE INDEX external_reservation_listing_health_fresh_idx
  ON external_reservation_listing_health (provider_id, fresh_until, coverage_from, coverage_to);

COMMIT;
