BEGIN;

-- #535 v0: one internal assignee per occurrence (開催回). A booking never owns the assignee; later bookings in the same
-- occurrence are received by the person already assigned. The assignee is not a seller, an approval, a payment or a
-- confirmation: booking_guests.approval_status, bookings.status and the provider settlement are untouched.
--
-- A row is one "term" of assignment. At most one term per occurrence is open (released_at IS NULL); releasing closes the
-- term and the next person starts a new one, so earlier terms (and their agreed fee) stay readable.
CREATE TABLE occurrence_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id text NOT NULL,
  occurrence_id text NOT NULL CHECK (length(occurrence_id) BETWEEN 1 AND 256),
  assignee_niho_user_id text NOT NULL CHECK (length(assignee_niho_user_id) BETWEEN 1 AND 256),
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_at timestamptz,
  -- The amount agreed by hand for this person's work in yen. Empty means not set. Nothing is computed, split or paid from it.
  agreed_fee_yen integer CHECK (agreed_fee_yen IS NULL OR agreed_fee_yen BETWEEN 0 AND 10000000),
  agreed_fee_set_at timestamptz,
  FOREIGN KEY (provider_id, occurrence_id)
    REFERENCES schedule_occurrences(provider_id, occurrence_id) ON DELETE RESTRICT,
  CHECK (released_at IS NULL OR released_at >= claimed_at),
  CHECK (agreed_fee_yen IS NULL OR agreed_fee_set_at IS NOT NULL)
);

-- The race guard: two simultaneous "対応する" cannot both open a term.
CREATE UNIQUE INDEX occurrence_assignments_open_idx
  ON occurrence_assignments (provider_id, occurrence_id)
  WHERE released_at IS NULL;

CREATE INDEX occurrence_assignments_assignee_idx
  ON occurrence_assignments (assignee_niho_user_id, provider_id)
  WHERE released_at IS NULL;

CREATE FUNCTION protect_occurrence_assignment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'occurrence assignments are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
     OR NEW.occurrence_id IS DISTINCT FROM OLD.occurrence_id
     OR NEW.assignee_niho_user_id IS DISTINCT FROM OLD.assignee_niho_user_id
     OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at THEN
    RAISE EXCEPTION 'an occurrence assignment term only changes by release or fee' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.released_at IS NOT NULL
     AND (NEW.released_at IS DISTINCT FROM OLD.released_at
       OR NEW.agreed_fee_yen IS DISTINCT FROM OLD.agreed_fee_yen
       OR NEW.agreed_fee_set_at IS DISTINCT FROM OLD.agreed_fee_set_at) THEN
    RAISE EXCEPTION 'a released occurrence assignment term is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER occurrence_assignments_protect
BEFORE UPDATE OR DELETE ON occurrence_assignments
FOR EACH ROW EXECUTE FUNCTION protect_occurrence_assignment();

-- Append-only history: when / who / what / why. command_id makes a replayed request return the first result.
CREATE TABLE occurrence_assignment_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  command_id uuid NOT NULL,
  provider_id text NOT NULL,
  occurrence_id text NOT NULL,
  assignment_id uuid REFERENCES occurrence_assignments(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('CLAIM', 'DECLINE', 'RELEASE', 'SET_FEE')),
  -- SELF: the person acted. ADMIN: the NIHO office recorded it on their behalf (subject is the person it is about).
  recorded_by text NOT NULL CHECK (recorded_by IN ('SELF', 'ADMIN')),
  subject_niho_user_id text NOT NULL CHECK (length(subject_niho_user_id) BETWEEN 1 AND 256),
  actor_niho_user_id text NOT NULL CHECK (length(actor_niho_user_id) BETWEEN 1 AND 256),
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 300),
  fee_yen integer CHECK (fee_yen IS NULL OR fee_yen BETWEEN 0 AND 10000000),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (provider_id, command_id),
  FOREIGN KEY (provider_id, occurrence_id)
    REFERENCES schedule_occurrences(provider_id, occurrence_id) ON DELETE RESTRICT,
  CHECK (action <> 'SET_FEE' OR recorded_by = 'ADMIN'),
  CHECK (action = 'SET_FEE' OR fee_yen IS NULL),
  CHECK (action = 'DECLINE' OR assignment_id IS NOT NULL)
);

CREATE INDEX occurrence_assignment_events_occurrence_idx
  ON occurrence_assignment_events (provider_id, occurrence_id, id);

CREATE FUNCTION reject_occurrence_assignment_event_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'occurrence assignment history is append-only' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER occurrence_assignment_events_append_only
BEFORE UPDATE OR DELETE ON occurrence_assignment_events
FOR EACH ROW EXECUTE FUNCTION reject_occurrence_assignment_event_change();

CREATE TRIGGER occurrence_assignment_events_no_truncate
BEFORE TRUNCATE ON occurrence_assignment_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_occurrence_assignment_event_change();

COMMIT;
