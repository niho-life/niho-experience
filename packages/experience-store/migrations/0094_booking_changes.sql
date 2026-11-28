BEGIN;

-- 予約の日時変更 (#720, docs/guest-booking.md「予約の日時変更（#720）」): a guest moves their confirmed booking from its booking
-- page to another occurrence of the same offer, with the same party and the same price. Stage 1 (this migration): the guest
-- only; the host's setting screen and support's tools come later. The booking row keeps its identity, its money and its
-- other snapshots; only `occurrence_id` and `occurrence_snapshot` move, and only inside the store's change path. Additive
-- except the trigger function, which still refuses every update it refused before: the current writer never sets the new
-- transaction setting, so this may run before the new revision.

-- The booking snapshots stay immutable, with one exception: the change path sets `experience.booking_move` to the booking's
-- row id for its own transaction (set_config(..., true)), and only that row may then change its occurrence and its occurrence
-- snapshot, which must name the same occurrence. Without the setting, or for another booking, the same exception as before.
CREATE OR REPLACE FUNCTION protect_booking_snapshots() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  moving boolean := COALESCE(current_setting('experience.booking_move', true), '') = NEW.id::text;
BEGIN
  IF NEW.public_booking_id IS DISTINCT FROM OLD.public_booking_id
     OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
     OR NEW.product_id IS DISTINCT FROM OLD.product_id
     OR NEW.seats IS DISTINCT FROM OLD.seats
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.hold_expires_at IS DISTINCT FROM OLD.hold_expires_at
     OR NEW.pricing_snapshot IS DISTINCT FROM OLD.pricing_snapshot
     OR NEW.seller_snapshot IS DISTINCT FROM OLD.seller_snapshot
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (NOT moving AND (NEW.occurrence_id IS DISTINCT FROM OLD.occurrence_id
                         OR NEW.occurrence_snapshot IS DISTINCT FROM OLD.occurrence_snapshot))
     OR (moving AND (NEW.occurrence_snapshot->>'occurrenceId') IS DISTINCT FROM NEW.occurrence_id) THEN
    RAISE EXCEPTION 'booking identity and snapshots are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- A product's switch for guest changes (the host's screen comes in stage 2). No row means ON. Read when a booking is made:
-- the booking's pricing snapshot fixes `guestChange` then, so a later switch never changes a booking already made.
CREATE TABLE product_guest_change_settings (
  provider_id text NOT NULL,
  product_id text NOT NULL,
  allowed boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, product_id),
  FOREIGN KEY (provider_id, product_id) REFERENCES experience_products(provider_id, id) ON DELETE CASCADE
);

-- One row per change command (a UUID), as booking_cancellation_commands: who sent it (a guest's booking page has no account,
-- so no actor_ref), what for, a SHA-256 of the input and what it did. The same command returns its first result; the same ID
-- with other input is refused. Append-only (the runtime may only insert).
CREATE TABLE booking_change_commands (
  command_id uuid PRIMARY KEY,
  provider_id text NOT NULL REFERENCES experience_providers(id) ON DELETE RESTRICT,
  actor_kind text NOT NULL CHECK (actor_kind IN ('GUEST', 'HOST', 'SUPPORT')),
  actor_ref text CHECK (actor_ref IS NULL OR length(actor_ref) BETWEEN 1 AND 256),
  action text NOT NULL CHECK (action ~ '^[A-Z][A-Z_]{0,39}$'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((actor_kind = 'GUEST') = (actor_ref IS NULL))
);

-- The history of a booking's moves: the occurrence before and after, with both occurrence snapshots, the move's number for
-- the booking, the command and who moved it. No guest's name, address, phone or note. Append-only.
CREATE TABLE booking_changes (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL,
  booking_id bigint NOT NULL,
  change_number integer NOT NULL CHECK (change_number BETWEEN 1 AND 100),
  command_id uuid NOT NULL UNIQUE,
  from_occurrence_id text NOT NULL,
  to_occurrence_id text NOT NULL,
  from_snapshot jsonb NOT NULL CHECK (jsonb_typeof(from_snapshot) = 'object'),
  to_snapshot jsonb NOT NULL CHECK (jsonb_typeof(to_snapshot) = 'object'),
  changed_by text NOT NULL CHECK (changed_by IN ('GUEST', 'HOST', 'SUPPORT')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (provider_id, booking_id, change_number),
  FOREIGN KEY (provider_id, booking_id) REFERENCES bookings(provider_id, id) ON DELETE RESTRICT,
  CHECK (from_occurrence_id <> to_occurrence_id)
);

CREATE FUNCTION reject_booking_change_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'booking changes are append-only' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER booking_changes_no_update
BEFORE UPDATE OR DELETE ON booking_changes
FOR EACH ROW EXECUTE FUNCTION reject_booking_change_mutation();

CREATE TRIGGER booking_change_commands_no_update
BEFORE UPDATE OR DELETE ON booking_change_commands
FOR EACH ROW EXECUTE FUNCTION reject_booking_change_mutation();

COMMIT;
