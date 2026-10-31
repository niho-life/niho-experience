BEGIN;

-- A creatable browser listing (GetYourGuide) first makes sure the external
-- slot exists at the occurrence's time (#241). ENSURE_OCCURRENCE is an
-- AVAILABILITY job like SET_OPEN; its verified readback is recorded below so
-- later OPEN writes at the same time and mapping go straight to SET_OPEN.
DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
     WHERE conrelid='channel_jobs'::regclass AND contype='c'
       AND pg_get_constraintdef(oid) LIKE 'CHECK ((action = ANY (ARRAY[%'
  LOOP
    EXECUTE format('ALTER TABLE channel_jobs DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE channel_jobs
  ADD CONSTRAINT channel_jobs_action_check CHECK (action IN ('SET_OPEN','SET_CLOSED','OBSERVE','ENSURE_OCCURRENCE')),
  ADD CONSTRAINT channel_jobs_ensure_occurrence_check CHECK (
    action <> 'ENSURE_OCCURRENCE' OR (purpose='AVAILABILITY' AND target_connection_mode='BROWSER')
  );

-- One row per external slot the worker has confirmed to exist (created now or
-- already there). Only internal identifiers, UTC boundaries and the verifying
-- job are kept; no external ID, page content or customer data.
CREATE TABLE channel_ensured_slots (
  listing_id text NOT NULL,
  provider_id text NOT NULL,
  occurrence_id text NOT NULL CHECK (length(occurrence_id) BETWEEN 1 AND 256),
  source_start_at timestamptz NOT NULL,
  source_end_at timestamptz NOT NULL,
  mapping_version bigint NOT NULL CHECK (mapping_version > 0),
  created boolean NOT NULL,
  job_id uuid NOT NULL REFERENCES channel_jobs(id) ON DELETE RESTRICT,
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (listing_id, occurrence_id, source_start_at, source_end_at, mapping_version),
  FOREIGN KEY (provider_id, listing_id) REFERENCES channel_listings(provider_id, id) ON DELETE RESTRICT,
  CHECK (source_end_at > source_start_at)
);

-- Whether the worker created the slot. Only an ENSURE_OCCURRENCE VERIFIED
-- result carries it; the runtime rejects it on every other job action.
ALTER TABLE channel_job_results
  ADD COLUMN ensure_created boolean,
  ADD CONSTRAINT channel_job_results_ensure_created_check CHECK (ensure_created IS NULL OR outcome = 'VERIFIED');

COMMIT;
