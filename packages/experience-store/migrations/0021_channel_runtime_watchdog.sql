BEGIN;

-- A Studio executor that was silent for more than 90 seconds holds new OPEN
-- writes for its providers until it has re-read reservations after the gap.
-- Closing, observing, and reservation reads are never held.
ALTER TABLE channel_workers
  ADD COLUMN open_hold_since timestamptz;

-- Sync age is measured from the last desired_version change, not from
-- updated_at, which also moves on observation and error bookkeeping.
ALTER TABLE channel_desired_states
  ADD COLUMN desired_changed_at timestamptz;
UPDATE channel_desired_states SET desired_changed_at = updated_at;
ALTER TABLE channel_desired_states
  ALTER COLUMN desired_changed_at SET DEFAULT clock_timestamp(),
  ALTER COLUMN desired_changed_at SET NOT NULL;

-- One unresolved incident per dedupe key. Incidents resolve only when the
-- watched condition clears; staff can take ownership but not close them.
-- detail holds counts, ages, and internal reason codes only: never external
-- account IDs, traveler data, or credentials.
CREATE TABLE channel_runtime_incidents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('WORKER_STALE','SYNC_OVERDUE','RESERVATION_READ_OVERDUE','ACCOUNT_QUARANTINED')),
  subject_type text NOT NULL CHECK (subject_type IN ('worker','account')),
  subject_id text NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 256),
  provider_id text REFERENCES experience_providers(id) ON DELETE RESTRICT,
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 400),
  opened_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  escalated_at timestamptz,
  acknowledged_at timestamptz,
  assignee_niho_user_id text CHECK (assignee_niho_user_id IS NULL OR length(assignee_niho_user_id) BETWEEN 1 AND 256),
  resolved_at timestamptz,
  resolution text CHECK (resolution IN ('AUTO_RECOVERED')),
  notified_open_at timestamptz,
  notified_escalated_at timestamptz,
  notified_resolved_at timestamptz,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((resolved_at IS NULL) = (resolution IS NULL)),
  CHECK ((acknowledged_at IS NULL) = (assignee_niho_user_id IS NULL)),
  CHECK ((kind = 'WORKER_STALE') = (subject_type = 'worker')),
  CHECK (subject_type = 'worker' OR provider_id IS NOT NULL),
  CHECK (last_seen_at >= opened_at),
  CHECK (escalated_at IS NULL OR escalated_at >= opened_at),
  CHECK (resolved_at IS NULL OR resolved_at >= opened_at)
);

CREATE UNIQUE INDEX channel_runtime_incidents_open_dedupe
  ON channel_runtime_incidents (dedupe_key) WHERE resolved_at IS NULL;
CREATE INDEX channel_runtime_incidents_open_provider
  ON channel_runtime_incidents (provider_id, opened_at) WHERE resolved_at IS NULL;

-- The independent cloud watchdog records its last run so Admin can show a
-- stopped watchdog separately from a stopped Studio.
CREATE TABLE channel_watchdog_state (
  id smallint PRIMARY KEY CHECK (id = 1),
  last_run_at timestamptz NOT NULL,
  last_opened integer NOT NULL DEFAULT 0 CHECK (last_opened >= 0),
  last_resolved integer NOT NULL DEFAULT 0 CHECK (last_resolved >= 0),
  last_escalated integer NOT NULL DEFAULT 0 CHECK (last_escalated >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

COMMIT;
