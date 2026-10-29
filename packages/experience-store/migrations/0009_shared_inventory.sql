BEGIN;

CREATE TABLE inventory_resources (
  provider_id text NOT NULL REFERENCES experience_providers(id) ON DELETE RESTRICT,
  id text NOT NULL CHECK (length(id) BETWEEN 1 AND 256),
  kind text NOT NULL CHECK (kind IN ('VENUE', 'INSTRUCTOR', 'EQUIPMENT')),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  active boolean NOT NULL DEFAULT true,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, id)
);

CREATE TABLE product_inventory_settings (
  provider_id text NOT NULL,
  product_id text NOT NULL,
  booking_mode text NOT NULL DEFAULT 'SEAT' CHECK (booking_mode IN ('SEAT', 'PRIVATE_GROUP')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, product_id),
  FOREIGN KEY (provider_id, product_id)
    REFERENCES experience_products(provider_id, id) ON DELETE RESTRICT
);

CREATE TABLE product_inventory_resources (
  provider_id text NOT NULL,
  product_id text NOT NULL,
  resource_id text NOT NULL,
  prepare_minutes integer NOT NULL DEFAULT 0 CHECK (prepare_minutes BETWEEN 0 AND 1440),
  cleanup_minutes integer NOT NULL DEFAULT 0 CHECK (cleanup_minutes BETWEEN 0 AND 1440),
  PRIMARY KEY (provider_id, product_id, resource_id),
  FOREIGN KEY (provider_id, product_id)
    REFERENCES product_inventory_settings(provider_id, product_id) ON DELETE CASCADE,
  FOREIGN KEY (provider_id, resource_id)
    REFERENCES inventory_resources(provider_id, id) ON DELETE RESTRICT
);

CREATE INDEX product_inventory_resources_resource_idx
  ON product_inventory_resources (provider_id, resource_id, product_id);

-- The mode and occupied intervals accepted with a booking are immutable snapshots.
-- Current booking status and HOLD expiry, rather than a mutable flag here, determine
-- whether these rows currently consume inventory.
CREATE TABLE booking_inventory_snapshots (
  provider_id text NOT NULL,
  booking_id bigint NOT NULL,
  booking_mode text NOT NULL CHECK (booking_mode IN ('SEAT', 'PRIVATE_GROUP')),
  occurrence_start_at timestamptz NOT NULL,
  occurrence_end_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, booking_id),
  FOREIGN KEY (provider_id, booking_id)
    REFERENCES bookings(provider_id, id) ON DELETE RESTRICT,
  CHECK (occurrence_end_at > occurrence_start_at)
);

CREATE TABLE booking_resource_occupancies (
  provider_id text NOT NULL,
  booking_id bigint NOT NULL,
  resource_id text NOT NULL,
  resource_kind text NOT NULL CHECK (resource_kind IN ('VENUE', 'INSTRUCTOR', 'EQUIPMENT')),
  prepare_minutes integer NOT NULL CHECK (prepare_minutes BETWEEN 0 AND 1440),
  cleanup_minutes integer NOT NULL CHECK (cleanup_minutes BETWEEN 0 AND 1440),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  PRIMARY KEY (provider_id, booking_id, resource_id),
  FOREIGN KEY (provider_id, booking_id)
    REFERENCES booking_inventory_snapshots(provider_id, booking_id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id, resource_id)
    REFERENCES inventory_resources(provider_id, id) ON DELETE RESTRICT,
  CHECK (end_at > start_at)
);

CREATE INDEX booking_resource_occupancies_overlap_idx
  ON booking_resource_occupancies (provider_id, resource_id, start_at, end_at);

CREATE FUNCTION reject_booking_inventory_snapshot_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'booking inventory snapshots are immutable' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER booking_inventory_snapshots_no_update
BEFORE UPDATE OR DELETE ON booking_inventory_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_booking_inventory_snapshot_mutation();

CREATE TRIGGER booking_resource_occupancies_no_update
BEFORE UPDATE OR DELETE ON booking_resource_occupancies
FOR EACH ROW EXECUTE FUNCTION reject_booking_inventory_snapshot_mutation();

-- A provider tick has at most one durable reconciliation event in flight. The
-- consumer advances next_due_at only after the event's final bounded page commits.
CREATE TABLE calendar_reconciliation_ticks (
  provider_id text PRIMARY KEY REFERENCES experience_providers(id) ON DELETE RESTRICT,
  next_due_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  pending_command_id uuid,
  last_completed_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (provider_id, pending_command_id)
    REFERENCES calendar_commands(provider_id, command_id) ON DELETE RESTRICT,
  CHECK (last_completed_at IS NULL OR next_due_at > last_completed_at)
);

CREATE INDEX calendar_reconciliation_ticks_due_idx
  ON calendar_reconciliation_ticks (next_due_at, provider_id)
  WHERE pending_command_id IS NULL;

COMMIT;
