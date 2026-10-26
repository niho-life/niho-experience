BEGIN;

CREATE TABLE experience_providers (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE provider_memberships (
  provider_id text NOT NULL REFERENCES experience_providers(id) ON DELETE RESTRICT,
  niho_user_id text NOT NULL CHECK (length(niho_user_id) BETWEEN 1 AND 256),
  role text NOT NULL CHECK (role IN ('OWNER', 'EDITOR', 'VIEWER')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, niho_user_id)
);

CREATE INDEX provider_memberships_active_user_idx
  ON provider_memberships (niho_user_id, provider_id)
  WHERE active;

CREATE TABLE experience_products (
  provider_id text NOT NULL REFERENCES experience_providers(id) ON DELETE RESTRICT,
  id text NOT NULL CHECK (length(id) BETWEEN 1 AND 256),
  slug text NOT NULL CHECK (length(slug) BETWEEN 1 AND 160),
  status text NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  public_title text NOT NULL CHECK (length(public_title) BETWEEN 1 AND 300),
  content jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(content) = 'object'),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  unit_amount bigint NOT NULL CHECK (unit_amount BETWEEN 0 AND 9999999999),
  cancellation_terms_ref text NOT NULL CHECK (length(cancellation_terms_ref) BETWEEN 1 AND 512),
  seller_niho_account_ref text NOT NULL CHECK (length(seller_niho_account_ref) BETWEEN 1 AND 256),
  stripe_connect_account_ref text NOT NULL CHECK (length(stripe_connect_account_ref) BETWEEN 1 AND 256),
  seller_display_name text NOT NULL CHECK (length(seller_display_name) BETWEEN 1 AND 300),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, id),
  UNIQUE (provider_id, slug)
);

CREATE INDEX experience_products_published_idx
  ON experience_products (provider_id, id)
  WHERE status = 'PUBLISHED';

CREATE TABLE schedule_rules (
  provider_id text NOT NULL,
  id text NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  product_id text NOT NULL,
  time_zone text NOT NULL CHECK (time_zone = 'Asia/Tokyo'),
  starts_on date NOT NULL,
  ends_on date,
  local_start_time time(0) without time zone NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 1 AND 1440),
  capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 1000),
  booking_cutoff_minutes integer NOT NULL CHECK (booking_cutoff_minutes BETWEEN 0 AND 525600),
  busy_buffer_before_minutes integer NOT NULL CHECK (busy_buffer_before_minutes BETWEEN 0 AND 1440),
  busy_buffer_after_minutes integer NOT NULL CHECK (busy_buffer_after_minutes BETWEEN 0 AND 1440),
  recurrence jsonb NOT NULL CHECK (
    jsonb_typeof(recurrence) = 'object'
    AND recurrence->>'kind' IN ('DAILY', 'WEEKLY', 'WEEKENDS', 'SELECTED_WEEKDAYS')
  ),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, id),
  FOREIGN KEY (provider_id, product_id)
    REFERENCES experience_products(provider_id, id) ON DELETE RESTRICT,
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);

CREATE INDEX schedule_rules_product_idx ON schedule_rules (provider_id, product_id);

CREATE TABLE schedule_occurrence_overrides (
  provider_id text NOT NULL,
  rule_id text NOT NULL,
  occurrence_id text NOT NULL CHECK (length(occurrence_id) BETWEEN 1 AND 256),
  kind text NOT NULL CHECK (kind IN ('CLOSE', 'RESCHEDULE')),
  local_date date,
  local_start_time time(0) without time zone,
  duration_minutes integer CHECK (duration_minutes BETWEEN 1 AND 1440),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, rule_id, occurrence_id),
  FOREIGN KEY (provider_id, rule_id) REFERENCES schedule_rules(provider_id, id) ON DELETE CASCADE,
  CHECK (
    (kind = 'CLOSE' AND local_date IS NULL AND local_start_time IS NULL AND duration_minutes IS NULL)
    OR
    (kind = 'RESCHEDULE' AND local_date IS NOT NULL AND local_start_time IS NOT NULL)
  )
);

CREATE TABLE schedule_occurrences (
  provider_id text NOT NULL,
  occurrence_id text NOT NULL CHECK (length(occurrence_id) BETWEEN 1 AND 256),
  product_id text NOT NULL,
  rule_id text NOT NULL,
  source_local_date date NOT NULL,
  local_date date NOT NULL,
  local_start_time time(0) without time zone NOT NULL,
  time_zone text NOT NULL CHECK (time_zone = 'Asia/Tokyo'),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 1 AND 1440),
  capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 1000),
  booking_cutoff_minutes integer NOT NULL CHECK (booking_cutoff_minutes BETWEEN 0 AND 525600),
  busy_buffer_before_minutes integer NOT NULL CHECK (busy_buffer_before_minutes BETWEEN 0 AND 1440),
  busy_buffer_after_minutes integer NOT NULL CHECK (busy_buffer_after_minutes BETWEEN 0 AND 1440),
  status text NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
  rescheduled boolean NOT NULL,
  schedule_rule_version bigint NOT NULL CHECK (schedule_rule_version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, occurrence_id),
  UNIQUE (provider_id, rule_id, source_local_date),
  FOREIGN KEY (provider_id, product_id)
    REFERENCES experience_products(provider_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id, rule_id)
    REFERENCES schedule_rules(provider_id, id) ON DELETE RESTRICT,
  CHECK (end_at > start_at)
);

CREATE INDEX schedule_occurrences_upcoming_idx
  ON schedule_occurrences (provider_id, product_id, start_at);

CREATE TABLE provider_google_calendars (
  provider_id text PRIMARY KEY REFERENCES experience_providers(id) ON DELETE RESTRICT,
  opaque_calendar_id text NOT NULL CHECK (length(opaque_calendar_id) BETWEEN 1 AND 512),
  blocking_enabled boolean NOT NULL DEFAULT false,
  sync_status text NOT NULL DEFAULT 'STALE' CHECK (sync_status IN ('FRESH', 'STALE', 'FAILED')),
  last_attempted_at timestamptz,
  last_succeeded_at timestamptz,
  fresh_until timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (fresh_until IS NULL OR last_succeeded_at IS NOT NULL),
  CHECK (fresh_until IS NULL OR fresh_until > last_succeeded_at)
);

CREATE TABLE google_busy_intervals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_id text NOT NULL REFERENCES provider_google_calendars(provider_id) ON DELETE CASCADE,
  opaque_calendar_id text NOT NULL CHECK (length(opaque_calendar_id) BETWEEN 1 AND 512),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  sync_version bigint NOT NULL CHECK (sync_version > 0),
  CHECK (end_at > start_at)
);

CREATE INDEX google_busy_intervals_overlap_idx
  ON google_busy_intervals (provider_id, start_at, end_at);

CREATE TABLE bookings (
  id bigint GENERATED ALWAYS AS IDENTITY,
  public_booking_id uuid NOT NULL UNIQUE,
  provider_id text NOT NULL,
  product_id text NOT NULL,
  occurrence_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('HOLD', 'CONFIRMED', 'EXPIRED', 'CANCELLED', 'PAYMENT_REVIEW')),
  seats integer NOT NULL CHECK (seats BETWEEN 1 AND 1000),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  hold_expires_at timestamptz NOT NULL,
  occurrence_snapshot jsonb NOT NULL CHECK (jsonb_typeof(occurrence_snapshot) = 'object'),
  pricing_snapshot jsonb NOT NULL CHECK (jsonb_typeof(pricing_snapshot) = 'object'),
  seller_snapshot jsonb NOT NULL CHECK (jsonb_typeof(seller_snapshot) = 'object'),
  stripe_payment_ref text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  PRIMARY KEY (id),
  UNIQUE (provider_id, id),
  UNIQUE (provider_id, idempotency_key),
  FOREIGN KEY (provider_id, product_id)
    REFERENCES experience_products(provider_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id, occurrence_id)
    REFERENCES schedule_occurrences(provider_id, occurrence_id) ON DELETE RESTRICT,
  CHECK (hold_expires_at > created_at),
  CHECK ((status = 'CONFIRMED') = (confirmed_at IS NOT NULL))
);

CREATE UNIQUE INDEX bookings_stripe_payment_ref_idx
  ON bookings (provider_id, stripe_payment_ref)
  WHERE stripe_payment_ref IS NOT NULL;

CREATE INDEX bookings_capacity_idx
  ON bookings (provider_id, occurrence_id, status, hold_expires_at);

CREATE INDEX bookings_provider_created_idx
  ON bookings (provider_id, created_at DESC);

CREATE TABLE stripe_webhook_events (
  event_id text PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 256),
  provider_id text NOT NULL REFERENCES experience_providers(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 256),
  booking_id bigint NOT NULL,
  occurred_at timestamptz NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  outcome text NOT NULL CHECK (outcome IN ('CONFIRMED', 'PAYMENT_REVIEW', 'DUPLICATE')),
  FOREIGN KEY (provider_id, booking_id) REFERENCES bookings(provider_id, id) ON DELETE RESTRICT
);

CREATE INDEX stripe_webhook_events_booking_idx
  ON stripe_webhook_events (provider_id, booking_id, occurred_at);

CREATE TABLE payment_ledger_entries (
  provider_id text NOT NULL,
  entry_id text NOT NULL CHECK (length(entry_id) BETWEEN 1 AND 256),
  booking_id bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('PAYMENT_CAPTURED', 'REFUND', 'DISPUTE', 'ADJUSTMENT')),
  amount bigint NOT NULL CHECK (amount <> 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  stripe_payment_ref text,
  stripe_event_id text,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, entry_id),
  FOREIGN KEY (provider_id, booking_id) REFERENCES bookings(provider_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (stripe_event_id) REFERENCES stripe_webhook_events(event_id) ON DELETE RESTRICT,
  CHECK (kind <> 'PAYMENT_CAPTURED' OR (amount > 0 AND stripe_payment_ref IS NOT NULL AND stripe_event_id IS NOT NULL))
);

CREATE INDEX payment_ledger_entries_booking_idx
  ON payment_ledger_entries (provider_id, booking_id, occurred_at);

CREATE UNIQUE INDEX payment_ledger_one_capture_idx
  ON payment_ledger_entries (provider_id, stripe_payment_ref)
  WHERE kind = 'PAYMENT_CAPTURED';

CREATE TABLE outbox_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_id text NOT NULL REFERENCES experience_providers(id) ON DELETE RESTRICT,
  aggregate_type text NOT NULL CHECK (length(aggregate_type) BETWEEN 1 AND 80),
  aggregate_id text NOT NULL CHECK (length(aggregate_id) BETWEEN 1 AND 256),
  topic text NOT NULL CHECK (length(topic) BETWEEN 1 AND 160),
  deduplication_key text NOT NULL CHECK (length(deduplication_key) BETWEEN 1 AND 256),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  processed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  UNIQUE (provider_id, deduplication_key)
);

CREATE INDEX outbox_messages_pending_idx
  ON outbox_messages (available_at, id)
  WHERE processed_at IS NULL;

CREATE FUNCTION protect_booking_snapshots() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.public_booking_id IS DISTINCT FROM OLD.public_booking_id
     OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
     OR NEW.product_id IS DISTINCT FROM OLD.product_id
     OR NEW.occurrence_id IS DISTINCT FROM OLD.occurrence_id
     OR NEW.seats IS DISTINCT FROM OLD.seats
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.hold_expires_at IS DISTINCT FROM OLD.hold_expires_at
     OR NEW.occurrence_snapshot IS DISTINCT FROM OLD.occurrence_snapshot
     OR NEW.pricing_snapshot IS DISTINCT FROM OLD.pricing_snapshot
     OR NEW.seller_snapshot IS DISTINCT FROM OLD.seller_snapshot
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'booking identity and snapshots are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER bookings_protect_snapshots
BEFORE UPDATE ON bookings
FOR EACH ROW EXECUTE FUNCTION protect_booking_snapshots();

CREATE FUNCTION reject_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payment ledger entries are append-only' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER payment_ledger_no_update
BEFORE UPDATE OR DELETE ON payment_ledger_entries
FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

COMMIT;
