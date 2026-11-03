BEGIN;

-- Terms shown at publication time travel with the immutable public snapshot and
-- the resulting booking, even if a later draft edits the product.
ALTER TABLE experience_product_publications
  ADD COLUMN sale_terms_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(sale_terms_snapshot) = 'object');

-- Public product media is copied into the Experience media bucket and rights are
-- recorded here. The source key is never returned by public DTOs.
CREATE TABLE experience_product_media_assets (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL,
  product_id text NOT NULL,
  source_position integer NOT NULL CHECK (source_position BETWEEN 0 AND 19),
  object_key text NOT NULL UNIQUE CHECK (length(object_key) BETWEEN 1 AND 512),
  source_ref_hash text NOT NULL CHECK (source_ref_hash ~ '^[0-9a-f]{64}$'),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 2400),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 2400),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  alt_text text NOT NULL CHECK (length(alt_text) <= 500),
  public_credit text CHECK (public_credit IS NULL OR length(public_credit) BETWEEN 1 AND 300),
  rights_confirmed_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'READY' CHECK (state = 'READY'),
  imported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, provider_id, product_id),
  UNIQUE (provider_id, product_id, source_ref_hash),
  UNIQUE (provider_id, product_id, source_position),
  FOREIGN KEY (provider_id, product_id)
    REFERENCES experience_products(provider_id, id) ON DELETE RESTRICT
);

CREATE TABLE experience_product_publication_media (
  publication_id bigint NOT NULL REFERENCES experience_product_publications(id) ON DELETE RESTRICT,
  asset_id uuid NOT NULL,
  provider_id text NOT NULL,
  product_id text NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 19),
  alt_text text NOT NULL CHECK (length(alt_text) <= 500),
  public_credit text CHECK (public_credit IS NULL OR length(public_credit) BETWEEN 1 AND 300),
  PRIMARY KEY (publication_id, position),
  UNIQUE (publication_id, asset_id),
  FOREIGN KEY (asset_id, provider_id, product_id)
    REFERENCES experience_product_media_assets(id, provider_id, product_id) ON DELETE RESTRICT,
  FOREIGN KEY (publication_id, provider_id, product_id)
    REFERENCES experience_product_publications(id, provider_id, product_id) ON DELETE RESTRICT
);

-- A migrated item can enter Experience checkout only after the legacy sale has
-- stopped, active legacy holds have drained, and the confirmed future seats
-- have been imported. No row keeps the existing legacy registration behavior.
CREATE TABLE experience_product_cutovers (
  provider_id text NOT NULL,
  product_id text NOT NULL,
  legacy_sales_stopped_at timestamptz NOT NULL,
  legacy_holds_drained_at timestamptz,
  inventory_import_batch_id uuid,
  imported_reservation_count integer,
  imported_seat_count integer,
  inventory_import_manifest_sha256 text,
  experience_sales_started_at timestamptz,
  experience_sales_stopped_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, product_id),
  FOREIGN KEY (provider_id, product_id)
    REFERENCES experience_products(provider_id, id) ON DELETE RESTRICT,
  CHECK (
    (legacy_holds_drained_at IS NULL
      AND inventory_import_batch_id IS NULL
      AND imported_reservation_count IS NULL
      AND imported_seat_count IS NULL
      AND inventory_import_manifest_sha256 IS NULL
      AND experience_sales_started_at IS NULL)
    OR
    (legacy_holds_drained_at IS NOT NULL
      AND inventory_import_batch_id IS NULL
      AND imported_reservation_count IS NULL
      AND imported_seat_count IS NULL
      AND inventory_import_manifest_sha256 IS NULL
      AND experience_sales_started_at IS NULL)
    OR
    (legacy_holds_drained_at IS NOT NULL
      AND inventory_import_batch_id IS NOT NULL
      AND imported_reservation_count IS NOT NULL AND imported_reservation_count >= 0
      AND imported_seat_count IS NOT NULL AND imported_seat_count >= 0
      AND inventory_import_manifest_sha256 ~ '^[0-9a-f]{64}$')
  ),
  CHECK (experience_sales_started_at IS NULL OR legacy_holds_drained_at IS NOT NULL),
  CHECK (experience_sales_stopped_at IS NULL OR experience_sales_started_at IS NOT NULL)
);

-- Minimal imported inventory only: no guest identity, contact details, or old
-- booking ID are copied. The source reference is a keyed hash prepared by the
-- cutover tool and rows are immutable; correcting a source fact requires a new
-- revision row and the current pointer update below.
CREATE TABLE experience_legacy_reservation_inventory (
  provider_id text NOT NULL,
  product_id text NOT NULL,
  occurrence_id text NOT NULL,
  source_ref_hash text NOT NULL CHECK (source_ref_hash ~ '^[0-9a-f]{64}$'),
  source_revision bigint NOT NULL CHECK (source_revision > 0),
  seats integer NOT NULL CHECK (seats BETWEEN 1 AND 1000),
  status text NOT NULL CHECK (status IN ('CONFIRMED', 'CANCELLED')),
  import_batch_id uuid NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, source_ref_hash, source_revision),
  FOREIGN KEY (provider_id, product_id)
    REFERENCES experience_products(provider_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id, occurrence_id)
    REFERENCES schedule_occurrences(provider_id, occurrence_id) ON DELETE RESTRICT
);

CREATE TABLE experience_legacy_reservation_inventory_current (
  provider_id text NOT NULL,
  source_ref_hash text NOT NULL,
  source_revision bigint NOT NULL,
  PRIMARY KEY (provider_id, source_ref_hash),
  FOREIGN KEY (provider_id, source_ref_hash, source_revision)
    REFERENCES experience_legacy_reservation_inventory(provider_id, source_ref_hash, source_revision)
    ON DELETE RESTRICT
);

CREATE INDEX experience_legacy_reservation_inventory_occurrence_idx
  ON experience_legacy_reservation_inventory (provider_id, occurrence_id, product_id)
  WHERE status = 'CONFIRMED';

CREATE INDEX experience_product_publication_media_asset_idx
  ON experience_product_publication_media (asset_id);

CREATE FUNCTION reject_experience_product_media_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'experience product media assets are immutable' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER experience_product_media_assets_no_update
BEFORE UPDATE OR DELETE ON experience_product_media_assets
FOR EACH ROW EXECUTE FUNCTION reject_experience_product_media_mutation();

CREATE TRIGGER experience_product_publication_media_no_update
BEFORE UPDATE OR DELETE ON experience_product_publication_media
FOR EACH ROW EXECUTE FUNCTION reject_experience_product_media_mutation();

CREATE FUNCTION reject_legacy_reservation_inventory_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'legacy reservation inventory revisions are immutable' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER experience_legacy_reservation_inventory_no_update
BEFORE UPDATE OR DELETE ON experience_legacy_reservation_inventory
FOR EACH ROW EXECUTE FUNCTION reject_legacy_reservation_inventory_mutation();

COMMIT;
