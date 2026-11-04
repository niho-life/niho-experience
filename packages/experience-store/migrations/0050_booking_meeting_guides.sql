BEGIN;

-- Private after-booking logistics are edited independently of sale terms and
-- public publication. Guests receive an immutable copy only after payment.
CREATE TABLE experience_product_booking_guides (
  provider_id text NOT NULL,
  product_id text NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  guide jsonb NOT NULL CHECK (jsonb_typeof(guide) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, product_id),
  FOREIGN KEY (provider_id, product_id)
    REFERENCES experience_products(provider_id, id) ON DELETE RESTRICT
);

CREATE TABLE booking_meeting_guide_snapshots (
  provider_id text NOT NULL,
  booking_id bigint NOT NULL,
  guide_version bigint NOT NULL CHECK (guide_version > 0),
  guide jsonb NOT NULL CHECK (jsonb_typeof(guide) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, booking_id),
  FOREIGN KEY (provider_id, booking_id) REFERENCES bookings(provider_id, id) ON DELETE RESTRICT
);

CREATE FUNCTION reject_booking_meeting_guide_snapshot_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'booking meeting guide snapshots are immutable' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER booking_meeting_guide_snapshots_no_update
BEFORE UPDATE ON booking_meeting_guide_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_booking_meeting_guide_snapshot_mutation();

COMMIT;
