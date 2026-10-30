BEGIN;

-- Staff work queue for external reservations the ledger kept despite an
-- inventory conflict (for example the same occurrence sold on two sites).
-- Nothing here cancels, refunds, charges, or contacts anyone. There is no
-- free-text column, so personal details cannot be typed into the queue.
CREATE TABLE external_reservation_conflict_cases (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL REFERENCES experience_providers(id) ON DELETE RESTRICT,
  product_id text NOT NULL,
  occurrence_id text NOT NULL CHECK (length(occurrence_id) BETWEEN 1 AND 256),
  status text NOT NULL CHECK (status IN ('OPEN','RESOLVED')),
  opened_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  assignee_niho_user_id text CHECK (assignee_niho_user_id IS NULL OR length(assignee_niho_user_id) BETWEEN 1 AND 256),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  resolution text CHECK (resolution IN ('CONFLICT_CLEARED','CUSTOMER_CONTACTED','ACCEPTED_BOTH','CANCELLED_AT_SOURCE')),
  resolved_by_niho_user_id text CHECK (resolved_by_niho_user_id IS NULL OR length(resolved_by_niho_user_id) BETWEEN 1 AND 256),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (provider_id, product_id) REFERENCES experience_products(provider_id, id) ON DELETE RESTRICT,
  CHECK ((acknowledged_at IS NULL) = (assignee_niho_user_id IS NULL)),
  CHECK ((status = 'RESOLVED') = (resolved_at IS NOT NULL)),
  CHECK ((resolved_at IS NULL) = (resolution IS NULL)),
  -- CONFLICT_CLEARED is the watchdog's automatic resolution; every other one names the staff member.
  CHECK ((resolved_by_niho_user_id IS NOT NULL) = (resolution IS NOT NULL AND resolution <> 'CONFLICT_CLEARED')),
  CHECK (last_seen_at >= opened_at),
  CHECK (resolved_at IS NULL OR resolved_at >= opened_at)
);

CREATE UNIQUE INDEX external_reservation_conflict_cases_open
  ON external_reservation_conflict_cases (provider_id, occurrence_id) WHERE status = 'OPEN';
CREATE INDEX external_reservation_conflict_cases_resolved
  ON external_reservation_conflict_cases (provider_id, resolved_at) WHERE status = 'RESOLVED';

-- Reservations involved in a case. Seats and the external revision are the
-- values when the member was added; current status is read from its source.
CREATE TABLE external_reservation_conflict_members (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES external_reservation_conflict_cases(id) ON DELETE RESTRICT,
  member_kind text NOT NULL CHECK (member_kind IN ('EXTERNAL','DIRECT')),
  source_site text,
  source_external_account_id text,
  external_reservation_id text,
  local_revision bigint CHECK (local_revision IS NULL OR local_revision > 0),
  booking_id bigint REFERENCES bookings(id) ON DELETE RESTRICT,
  seats integer NOT NULL CHECK (seats BETWEEN 1 AND 1000),
  added_at timestamptz NOT NULL,
  FOREIGN KEY (source_site, source_external_account_id, external_reservation_id)
    REFERENCES external_reservations(source_site, source_external_account_id, external_reservation_id) ON DELETE RESTRICT,
  CHECK (
    (member_kind = 'EXTERNAL' AND source_site IS NOT NULL AND source_external_account_id IS NOT NULL
      AND external_reservation_id IS NOT NULL AND local_revision IS NOT NULL AND booking_id IS NULL)
    OR (member_kind = 'DIRECT' AND booking_id IS NOT NULL AND source_site IS NULL AND source_external_account_id IS NULL
      AND external_reservation_id IS NULL AND local_revision IS NULL)
  )
);

CREATE UNIQUE INDEX external_reservation_conflict_members_external
  ON external_reservation_conflict_members (case_id, source_site, source_external_account_id, external_reservation_id)
  WHERE member_kind = 'EXTERNAL';
CREATE UNIQUE INDEX external_reservation_conflict_members_direct
  ON external_reservation_conflict_members (case_id, booking_id) WHERE member_kind = 'DIRECT';

-- 0021 named only the column checks; the table-level checks keep their names.
ALTER TABLE channel_runtime_incidents
  DROP CONSTRAINT channel_runtime_incidents_kind_check,
  DROP CONSTRAINT channel_runtime_incidents_subject_type_check,
  ADD CONSTRAINT channel_runtime_incidents_kind_check
    CHECK (kind IN ('WORKER_STALE','SYNC_OVERDUE','RESERVATION_READ_OVERDUE','ACCOUNT_QUARANTINED','EXTERNAL_RESERVATION_CONFLICT')),
  ADD CONSTRAINT channel_runtime_incidents_subject_type_check
    CHECK (subject_type IN ('worker','account','conflict_case')),
  ADD CONSTRAINT channel_runtime_incidents_conflict_subject_check
    CHECK ((kind = 'EXTERNAL_RESERVATION_CONFLICT') = (subject_type = 'conflict_case'));

-- One measurement per external reservation revision that newly occupied an
-- occurrence: from detection until the product's other listings are verified
-- closed. outbox_watermark_id is the provider's latest calendar outbox event
-- after that write; a target is judged OPEN-not-required only once every
-- event up to it has been processed.
CREATE TABLE channel_propagation_measurements (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL REFERENCES experience_providers(id) ON DELETE RESTRICT,
  product_id text NOT NULL,
  occurrence_id text NOT NULL CHECK (length(occurrence_id) BETWEEN 1 AND 256),
  source_site text NOT NULL,
  source_external_account_id text NOT NULL,
  external_reservation_id text NOT NULL,
  local_revision bigint NOT NULL CHECK (local_revision > 0),
  source_updated_at timestamptz,
  detected_at timestamptz NOT NULL,
  outbox_watermark_id bigint CHECK (outbox_watermark_id IS NULL OR outbox_watermark_id > 0),
  status text NOT NULL CHECK (status IN ('OPEN','COMPLETED','NOT_REQUIRED','ABANDONED','TIMED_OUT')),
  target_count integer NOT NULL CHECK (target_count >= 0),
  closed_verified_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (source_site, source_external_account_id, external_reservation_id, local_revision),
  FOREIGN KEY (source_site, source_external_account_id, external_reservation_id)
    REFERENCES external_reservations(source_site, source_external_account_id, external_reservation_id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id, product_id) REFERENCES experience_products(provider_id, id) ON DELETE RESTRICT,
  CHECK ((status = 'OPEN') = (completed_at IS NULL)),
  CHECK ((status = 'COMPLETED') = (closed_verified_at IS NOT NULL)),
  CHECK (closed_verified_at IS NULL OR closed_verified_at >= detected_at),
  CHECK (completed_at IS NULL OR completed_at >= detected_at),
  CHECK (status <> 'OPEN' OR (target_count > 0 AND outbox_watermark_id IS NOT NULL))
);

CREATE INDEX channel_propagation_measurements_provider_detected
  ON channel_propagation_measurements (provider_id, detected_at);
CREATE INDEX channel_propagation_measurements_open
  ON channel_propagation_measurements (detected_at, id) WHERE status = 'OPEN';

CREATE TABLE channel_propagation_targets (
  measurement_id uuid NOT NULL REFERENCES channel_propagation_measurements(id) ON DELETE RESTRICT,
  listing_id text NOT NULL REFERENCES channel_listings(id) ON DELETE RESTRICT,
  site text NOT NULL CHECK (length(site) BETWEEN 1 AND 80),
  outcome text NOT NULL DEFAULT 'PENDING' CHECK (outcome IN ('PENDING','VERIFIED','NOT_REQUIRED','UNVERIFIED')),
  job_created_at timestamptz,
  job_claimed_at timestamptz,
  verified_closed_at timestamptz,
  PRIMARY KEY (measurement_id, listing_id),
  CHECK ((outcome = 'VERIFIED') = (verified_closed_at IS NOT NULL)),
  CHECK (job_claimed_at IS NULL OR job_created_at IS NOT NULL),
  CHECK (outcome = 'VERIFIED' OR (job_created_at IS NULL AND job_claimed_at IS NULL))
);

COMMIT;
