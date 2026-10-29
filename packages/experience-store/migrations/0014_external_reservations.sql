BEGIN;

-- Reservation reads are a separate, fail-closed capability. Existing adapters
-- remain unable to ingest reservation facts until both deployment and listing
-- configuration explicitly enable it.
ALTER TABLE channel_listings
  ADD COLUMN can_read_reservations boolean NOT NULL DEFAULT false;

CREATE TABLE external_reservation_reads (
  read_id uuid PRIMARY KEY,
  read_generation bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  job_id uuid NOT NULL REFERENCES channel_jobs(id) ON DELETE RESTRICT,
  worker_id text NOT NULL REFERENCES channel_workers(id) ON DELETE RESTRICT,
  lease_epoch bigint NOT NULL CHECK (lease_epoch > 0),
  lease_assignment_version bigint NOT NULL CHECK (lease_assignment_version > 0),
  provider_id text NOT NULL,
  account_id text NOT NULL,
  listing_id text NOT NULL,
  product_id text NOT NULL,
  occurrence_id text NOT NULL CHECK (length(occurrence_id) BETWEEN 1 AND 256),
  target_site text NOT NULL CHECK (length(target_site) BETWEEN 1 AND 80),
  target_external_account_id text NOT NULL CHECK (length(target_external_account_id) BETWEEN 1 AND 256),
  target_external_product_id text NOT NULL CHECK (length(target_external_product_id) BETWEEN 1 AND 256),
  target_external_option_id text NOT NULL DEFAULT '' CHECK (length(target_external_option_id) <= 256),
  source_start_at timestamptz NOT NULL,
  source_end_at timestamptz NOT NULL,
  account_version bigint NOT NULL CHECK (account_version > 0),
  mapping_version bigint NOT NULL CHECK (mapping_version > 0),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','SUBMITTED')),
  batch_status text CHECK (batch_status IN ('COMPLETE','PARTIAL','FAILED')),
  submitted_receipt_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  submitted_at timestamptz,
  UNIQUE (job_id, lease_epoch),
  UNIQUE (provider_id, read_id),
  FOREIGN KEY (provider_id, account_id) REFERENCES channel_external_accounts(provider_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id, listing_id) REFERENCES channel_listings(provider_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id, product_id) REFERENCES experience_products(provider_id, id) ON DELETE RESTRICT,
  CHECK (source_end_at > source_start_at),
  CHECK ((status = 'OPEN' AND submitted_receipt_id IS NULL AND submitted_at IS NULL AND batch_status IS NULL)
      OR (status = 'SUBMITTED' AND submitted_receipt_id IS NOT NULL AND submitted_at IS NOT NULL AND batch_status IS NOT NULL))
);

-- Current materialized fact. The external identity snapshot is deliberately the
-- key: changing an internal account row never rewrites reservation provenance.
CREATE TABLE external_reservations (
  source_site text NOT NULL CHECK (length(source_site) BETWEEN 1 AND 80),
  source_external_account_id text NOT NULL CHECK (length(source_external_account_id) BETWEEN 1 AND 256),
  external_reservation_id text NOT NULL CHECK (length(external_reservation_id) BETWEEN 1 AND 256),
  provider_id text NOT NULL,
  account_id text NOT NULL,
  listing_id text NOT NULL,
  product_id text NOT NULL,
  occurrence_id text,
  external_product_id text NOT NULL CHECK (length(external_product_id) BETWEEN 1 AND 256),
  external_option_id text NOT NULL DEFAULT '' CHECK (length(external_option_id) <= 256),
  source_start_at timestamptz NOT NULL,
  source_end_at timestamptz NOT NULL,
  seats integer NOT NULL CHECK (seats BETWEEN 1 AND 1000),
  status text NOT NULL CHECK (status IN ('PENDING','CONFIRMED','CANCELLED')),
  payment_owner text NOT NULL DEFAULT 'EXTERNAL' CHECK (payment_owner = 'EXTERNAL'),
  local_revision bigint NOT NULL CHECK (local_revision > 0),
  source_updated_at timestamptz,
  source_revision text CHECK (source_revision IS NULL OR length(source_revision) BETWEEN 1 AND 256),
  last_read_generation bigint NOT NULL CHECK (last_read_generation > 0),
  current_fingerprint text NOT NULL CHECK (current_fingerprint ~ '^[0-9a-f]{64}$'),
  needs_review boolean NOT NULL DEFAULT false,
  review_reason text CHECK (review_reason IS NULL OR length(review_reason) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (source_site, source_external_account_id, external_reservation_id),
  FOREIGN KEY (provider_id, account_id) REFERENCES channel_external_accounts(provider_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id, listing_id) REFERENCES channel_listings(provider_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id, product_id) REFERENCES experience_products(provider_id, id) ON DELETE RESTRICT,
  CHECK (source_end_at > source_start_at),
  CHECK ((needs_review AND review_reason IS NOT NULL) OR (NOT needs_review AND review_reason IS NULL))
);

CREATE INDEX external_reservations_occurrence_active_idx
  ON external_reservations (provider_id, occurrence_id, product_id)
  WHERE status IN ('PENDING','CONFIRMED') AND occurrence_id IS NOT NULL;
CREATE INDEX external_reservations_account_active_idx
  ON external_reservations (provider_id, account_id, source_end_at)
  WHERE status IN ('PENDING','CONFIRMED');

-- Every submitted fact is retained even when it is stale or quarantined. No
-- customer, price, cookie, or raw response JSON is stored here.
CREATE TABLE external_reservation_revisions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_site text NOT NULL,
  source_external_account_id text NOT NULL,
  external_reservation_id text NOT NULL,
  read_id uuid NOT NULL REFERENCES external_reservation_reads(read_id) ON DELETE RESTRICT,
  read_generation bigint NOT NULL CHECK (read_generation > 0),
  local_revision bigint,
  external_product_id text NOT NULL CHECK (length(external_product_id) BETWEEN 1 AND 256),
  external_option_id text NOT NULL DEFAULT '' CHECK (length(external_option_id) <= 256),
  source_start_at timestamptz NOT NULL,
  source_end_at timestamptz NOT NULL,
  seats integer NOT NULL CHECK (seats BETWEEN 1 AND 1000),
  status text NOT NULL CHECK (status IN ('PENDING','CONFIRMED','CANCELLED')),
  source_updated_at timestamptz,
  source_revision text CHECK (source_revision IS NULL OR length(source_revision) BETWEEN 1 AND 256),
  observation_fingerprint text NOT NULL CHECK (observation_fingerprint ~ '^[0-9a-f]{64}$'),
  disposition text NOT NULL CHECK (disposition IN ('APPLIED','DUPLICATE','STALE','NEEDS_REVIEW')),
  review_reason text CHECK (review_reason IS NULL OR length(review_reason) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (read_id, external_reservation_id),
  FOREIGN KEY (source_site, source_external_account_id, external_reservation_id)
    REFERENCES external_reservations(source_site, source_external_account_id, external_reservation_id) ON DELETE RESTRICT,
  CHECK (source_end_at > source_start_at),
  CHECK ((disposition = 'NEEDS_REVIEW' AND review_reason IS NOT NULL) OR disposition <> 'NEEDS_REVIEW')
);

-- Inventory snapshots are immutable by revision. Moving or cancelling a current
-- reservation changes the ledger pointer; it never deletes its earlier audit.
CREATE TABLE external_reservation_inventory_snapshots (
  source_site text NOT NULL,
  source_external_account_id text NOT NULL,
  external_reservation_id text NOT NULL,
  local_revision bigint NOT NULL CHECK (local_revision > 0),
  provider_id text NOT NULL,
  product_id text NOT NULL,
  occurrence_id text NOT NULL CHECK (length(occurrence_id) BETWEEN 1 AND 256),
  booking_mode text NOT NULL CHECK (booking_mode IN ('SEAT','PRIVATE_GROUP')),
  occurrence_start_at timestamptz NOT NULL,
  occurrence_end_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (source_site, source_external_account_id, external_reservation_id, local_revision),
  FOREIGN KEY (source_site, source_external_account_id, external_reservation_id)
    REFERENCES external_reservations(source_site, source_external_account_id, external_reservation_id) ON DELETE RESTRICT,
  CHECK (occurrence_end_at > occurrence_start_at)
);

CREATE TABLE external_reservation_resource_occupancies (
  source_site text NOT NULL,
  source_external_account_id text NOT NULL,
  external_reservation_id text NOT NULL,
  local_revision bigint NOT NULL,
  provider_id text NOT NULL,
  product_id text NOT NULL,
  occurrence_id text NOT NULL,
  resource_id text NOT NULL,
  resource_kind text NOT NULL CHECK (resource_kind IN ('VENUE','INSTRUCTOR','EQUIPMENT')),
  prepare_minutes integer NOT NULL CHECK (prepare_minutes BETWEEN 0 AND 1440),
  cleanup_minutes integer NOT NULL CHECK (cleanup_minutes BETWEEN 0 AND 1440),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  PRIMARY KEY (source_site, source_external_account_id, external_reservation_id, local_revision, resource_id),
  FOREIGN KEY (source_site, source_external_account_id, external_reservation_id, local_revision)
    REFERENCES external_reservation_inventory_snapshots(source_site, source_external_account_id, external_reservation_id, local_revision) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id, resource_id) REFERENCES inventory_resources(provider_id, id) ON DELETE RESTRICT,
  CHECK (end_at > start_at)
);

CREATE INDEX external_reservation_resource_overlap_idx
  ON external_reservation_resource_occupancies (provider_id, resource_id, start_at, end_at);

CREATE TRIGGER external_reservation_revisions_no_update
BEFORE UPDATE OR DELETE ON external_reservation_revisions
FOR EACH ROW EXECUTE FUNCTION reject_booking_inventory_snapshot_mutation();

CREATE TRIGGER external_reservation_inventory_snapshots_no_update
BEFORE UPDATE OR DELETE ON external_reservation_inventory_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_booking_inventory_snapshot_mutation();

CREATE TRIGGER external_reservation_resource_occupancies_no_update
BEFORE UPDATE OR DELETE ON external_reservation_resource_occupancies
FOR EACH ROW EXECUTE FUNCTION reject_booking_inventory_snapshot_mutation();

CREATE TABLE external_reservation_receipts (
  receipt_id uuid PRIMARY KEY,
  read_id uuid NOT NULL UNIQUE REFERENCES external_reservation_reads(read_id) ON DELETE RESTRICT,
  job_id uuid NOT NULL REFERENCES channel_jobs(id) ON DELETE RESTRICT,
  worker_id text NOT NULL REFERENCES channel_workers(id) ON DELETE RESTRICT,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  batch_status text NOT NULL CHECK (batch_status IN ('COMPLETE','PARTIAL','FAILED')),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE external_reservation_reads
  ADD CONSTRAINT external_reservation_reads_receipt_fk
  FOREIGN KEY (submitted_receipt_id) REFERENCES external_reservation_receipts(receipt_id) ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

COMMIT;
