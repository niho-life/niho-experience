BEGIN;

-- A host reschedule keeps the occurrence ID but moves its time. The desired
-- row follows the new time, so the old external slot is tracked separately
-- until a stopped worker has closed it and read it back as CLOSED. Only
-- internal identifiers and the old UTC boundaries are stored here.
CREATE TABLE channel_slot_retirements (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL,
  listing_id text NOT NULL,
  occurrence_id text NOT NULL CHECK (length(occurrence_id) BETWEEN 1 AND 256),
  source_start_at timestamptz NOT NULL,
  source_end_at timestamptz NOT NULL,
  mapping_version bigint NOT NULL CHECK (mapping_version > 0),
  account_version bigint NOT NULL CHECK (account_version > 0),
  retirement_version bigint NOT NULL CHECK (retirement_version > 0),
  status text NOT NULL CHECK (status IN ('PENDING','CLOSED_VERIFIED','NEEDS_REVIEW','SUPERSEDED')),
  reason text CHECK (reason IS NULL OR (length(reason) BETWEEN 1 AND 80 AND reason ~ '^[A-Z0-9_]+$')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (listing_id, occurrence_id, source_start_at, source_end_at),
  FOREIGN KEY (provider_id, listing_id) REFERENCES channel_listings(provider_id, id) ON DELETE RESTRICT,
  CHECK (source_end_at > source_start_at),
  CHECK (status <> 'NEEDS_REVIEW' OR reason IS NOT NULL)
);

-- A retirement close reuses the browser lease and SET_CLOSED executor, but is
-- a distinct purpose so its readback never updates the new-time desired row.
ALTER TABLE channel_jobs
  ADD COLUMN slot_retirement_id uuid REFERENCES channel_slot_retirements(id) ON DELETE RESTRICT;

ALTER TABLE channel_jobs DROP CONSTRAINT channel_jobs_purpose_check;
ALTER TABLE channel_jobs
  ADD CONSTRAINT channel_jobs_purpose_check CHECK (purpose IN ('AVAILABILITY','RESERVATION_WINDOW','SLOT_RETIREMENT'));

ALTER TABLE channel_jobs DROP CONSTRAINT channel_jobs_dispatch_assignment_check;
ALTER TABLE channel_jobs
  ADD CONSTRAINT channel_jobs_dispatch_assignment_check CHECK (
    (purpose IN ('AVAILABILITY','SLOT_RETIREMENT') AND dispatch_worker_id IS NULL AND dispatch_assignment_version IS NULL AND dispatch_sequence=0)
    OR (purpose='RESERVATION_WINDOW' AND dispatch_worker_id IS NOT NULL AND dispatch_assignment_version IS NOT NULL AND dispatch_sequence>0)
  ),
  ADD CONSTRAINT channel_jobs_slot_retirement_check CHECK (
    (purpose='SLOT_RETIREMENT' AND action='SET_CLOSED' AND slot_retirement_id IS NOT NULL)
    OR (purpose<>'SLOT_RETIREMENT' AND slot_retirement_id IS NULL)
  );

-- desired_version carries retirement_version for SLOT_RETIREMENT jobs.
CREATE UNIQUE INDEX channel_jobs_slot_retirement_identity
  ON channel_jobs (slot_retirement_id,desired_version)
  WHERE purpose='SLOT_RETIREMENT';

COMMIT;
