BEGIN;

-- This contract migration is intentionally not compatible with the legacy writer.
-- The release runbook requires a maintenance stop and drained old revisions.
LOCK TABLE schedule_occurrence_overrides IN ACCESS EXCLUSIVE MODE;

-- A moved occurrence and whether it is on sale are independent decisions. OPEN rows are
-- intentionally retained so close -> reopen cannot recreate version 1 (ABA).
CREATE TABLE schedule_occurrence_sales_states (
  provider_id text NOT NULL,
  rule_id text NOT NULL,
  occurrence_id text NOT NULL CHECK (length(occurrence_id) BETWEEN 1 AND 256),
  desired_state text NOT NULL CHECK (desired_state IN ('OPEN', 'CLOSED')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, rule_id, occurrence_id),
  FOREIGN KEY (provider_id, rule_id) REFERENCES schedule_rules(provider_id, id) ON DELETE CASCADE
);

-- Preserve both the closed decision and its optimistic-lock history from the legacy row.
INSERT INTO schedule_occurrence_sales_states
  (provider_id, rule_id, occurrence_id, desired_state, version, created_at, updated_at)
SELECT provider_id, rule_id, occurrence_id, 'CLOSED', version, created_at, updated_at
  FROM schedule_occurrence_overrides
 WHERE kind = 'CLOSE';

DELETE FROM schedule_occurrence_overrides WHERE kind = 'CLOSE';
ALTER TABLE schedule_occurrence_overrides
  DROP CONSTRAINT schedule_occurrence_overrides_kind_check,
  DROP CONSTRAINT schedule_occurrence_overrides_check;
ALTER TABLE schedule_occurrence_overrides
  ADD CONSTRAINT schedule_occurrence_overrides_kind_check CHECK (kind = 'RESCHEDULE'),
  ADD CONSTRAINT schedule_occurrence_overrides_reschedule_check
    CHECK (local_date IS NOT NULL AND local_start_time IS NOT NULL);

-- Every browser retry uses the same UUID. A mismatched payload is rejected by the store.
CREATE TABLE calendar_commands (
  provider_id text NOT NULL REFERENCES experience_providers(id) ON DELETE RESTRICT,
  command_id uuid NOT NULL,
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 80),
  request_fingerprint text NOT NULL CHECK (length(request_fingerprint) BETWEEN 1 AND 8192),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, command_id)
);

-- OTA/calendar delivery has its own processing cursor. The existing notification
-- consumer may continue updating outbox_messages.processed_at without claiming these rows.
CREATE TABLE calendar_outbox_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_id text NOT NULL REFERENCES experience_providers(id) ON DELETE RESTRICT,
  command_id uuid NOT NULL,
  aggregate_type text NOT NULL CHECK (length(aggregate_type) BETWEEN 1 AND 80),
  aggregate_id text NOT NULL CHECK (length(aggregate_id) BETWEEN 1 AND 256),
  topic text NOT NULL CHECK (length(topic) BETWEEN 1 AND 160),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  processed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  UNIQUE (provider_id, command_id),
  FOREIGN KEY (provider_id, command_id) REFERENCES calendar_commands(provider_id, command_id) ON DELETE RESTRICT
);

CREATE INDEX calendar_outbox_events_pending_idx
  ON calendar_outbox_events (available_at, id)
  WHERE processed_at IS NULL;

COMMIT;
