BEGIN;

-- The Google calendar jobs (#238): Cloud Scheduler re-checks the busy inputs and writes confirmed
-- bookings to the provider's booking calendar without an OTA worker. A worker's claim still names it.
ALTER TABLE resource_google_calendars
  DROP CONSTRAINT resource_google_calendars_check2,
  ADD CONSTRAINT resource_google_calendars_claimant_check CHECK (sync_claimed_by IS NULL OR sync_claim_id IS NOT NULL),
  -- When the current run of failed reads began; NULL while the input is read. Tells the OWNER once per run.
  ADD COLUMN failing_since timestamptz;

ALTER TABLE resource_google_sync_receipts
  ALTER COLUMN worker_id DROP NOT NULL,
  ADD COLUMN claimant text NOT NULL DEFAULT 'WORKER' CHECK (claimant IN ('WORKER','SCHEDULER')),
  ADD CONSTRAINT resource_google_sync_receipts_worker_check CHECK ((claimant = 'WORKER') = (worker_id IS NOT NULL));

-- The provider-wide input (the primary calendar chosen at connect) gets the same due time and lease.
ALTER TABLE provider_google_calendars
  ADD COLUMN next_sync_due_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN sync_lease_expires_at timestamptz,
  ADD COLUMN failing_since timestamptz;

CREATE INDEX provider_google_calendars_due_idx
  ON provider_google_calendars (next_sync_due_at, provider_id)
  WHERE blocking_enabled = true;

-- What this site wrote to a connection's booking calendar, one row per booking and connection.
-- The event holds the experience's title, the time and the party size only: no guest's name or contact.
CREATE TABLE google_booking_calendar_events (
  provider_id text NOT NULL,
  booking_id bigint NOT NULL,
  connection_generation bigint NOT NULL CHECK (connection_generation > 0),
  opaque_calendar_id text NOT NULL CHECK (length(opaque_calendar_id) BETWEEN 1 AND 512),
  -- WRITTEN: the event is on the calendar for the times below. ABSENT: not there (deleted, or not written yet).
  state text NOT NULL DEFAULT 'ABSENT' CHECK (state IN ('WRITTEN','ABSENT')),
  written_start_at timestamptz,
  written_end_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claim_id uuid,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, booking_id, connection_generation),
  FOREIGN KEY (provider_id, booking_id) REFERENCES bookings(provider_id, id) ON DELETE RESTRICT,
  CHECK ((state = 'WRITTEN') = (written_start_at IS NOT NULL)),
  CHECK ((written_start_at IS NULL) = (written_end_at IS NULL)),
  CHECK (written_end_at IS NULL OR written_end_at > written_start_at),
  CHECK ((claim_id IS NULL) = (lease_expires_at IS NULL))
);

CREATE INDEX google_booking_calendar_events_written_idx
  ON google_booking_calendar_events (provider_id, connection_generation)
  WHERE state = 'WRITTEN';

COMMIT;
