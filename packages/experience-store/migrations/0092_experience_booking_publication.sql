-- #705 (host registration, stage 1b): the public PAGE of an experience and the START OF BOOKINGS are two states.
--
--   * experience_product_publication_states.current_publication_id is the PAGE version: the immutable copy the public
--     page shows. (Until now it also meant "for sale".)
--   * booking_publication_id (new, NULL-able) is the SALE version: an immutable publication that carries the seller and
--     the sale-terms snapshot. Every reader that sells (checkout, booking terms, availability, OTA/channel feeds,
--     refunds, settlement, mails) reads this pointer, never the page pointer.
--   * experience_products.status stays the sale gate those readers filter on: PUBLISHED  <=>  bookings are open
--     (booking_publication_id IS NOT NULL) for a product that has a state row. A page-only product stays DRAFT, so every
--     reader that filters status='PUBLISHED' stays closed to it. The store keeps that equivalence in its transactions.
--   * While bookings are open both pointers name the same row (CHECK below): a page and the terms it is sold on never
--     drift apart.
--
-- A page version has no seller: the seller group (and the payout consent version) of a publication is NULL as one group,
-- and a page version has no sale-terms snapshot. A sale version must have both (immutable rows; the sale-terms CHECK is
-- NOT VALID because rows published before 0043 keep the sentinel sale_terms_version 0, and no row can be updated anyway).
-- Starting and stopping bookings are appended to an append-only event table.

BEGIN;

ALTER TABLE experience_product_publications
  ALTER COLUMN seller_niho_account_ref DROP NOT NULL,
  ALTER COLUMN stripe_connect_account_ref DROP NOT NULL,
  ALTER COLUMN seller_display_name DROP NOT NULL,
  ALTER COLUMN consent_version DROP NOT NULL;

ALTER TABLE experience_product_publications
  ADD CONSTRAINT experience_product_publications_sale_all_or_none CHECK (
    (seller_niho_account_ref IS NULL AND stripe_connect_account_ref IS NULL
      AND seller_display_name IS NULL AND consent_version IS NULL)
    OR (seller_niho_account_ref IS NOT NULL AND stripe_connect_account_ref IS NOT NULL
      AND seller_display_name IS NOT NULL AND consent_version IS NOT NULL)
  ),
  ADD CONSTRAINT experience_product_publications_page_has_no_sale_terms CHECK (
    seller_niho_account_ref IS NOT NULL
    OR (sale_terms_version = 0 AND sale_terms_snapshot = '{}'::jsonb)
  );

-- A new sale version carries the sale terms it was published with.
ALTER TABLE experience_product_publications
  ADD CONSTRAINT experience_product_publications_sale_has_terms CHECK (
    seller_niho_account_ref IS NULL
    OR (sale_terms_version > 0 AND sale_terms_snapshot <> '{}'::jsonb)
  ) NOT VALID;

-- One page version per saved draft (page versions have no consent version, so the 0043 uniqueness cannot see them).
CREATE UNIQUE INDEX experience_product_publications_page_version_key
  ON experience_product_publications (provider_id, product_id, draft_version)
  WHERE seller_niho_account_ref IS NULL;

ALTER TABLE experience_product_publication_states
  ADD COLUMN booking_publication_id bigint;

ALTER TABLE experience_product_publication_states
  ADD CONSTRAINT experience_product_publication_states_booking_fkey
    FOREIGN KEY (booking_publication_id, provider_id, product_id)
    REFERENCES experience_product_publications(id, provider_id, product_id) ON DELETE RESTRICT,
  ADD CONSTRAINT experience_product_publication_states_booking_is_page CHECK (
    booking_publication_id IS NULL OR booking_publication_id = current_publication_id
  );

CREATE FUNCTION require_booking_publication_is_sale_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.booking_publication_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM experience_product_publications publication
     WHERE publication.id = NEW.booking_publication_id
       AND publication.provider_id = NEW.provider_id
       AND publication.product_id = NEW.product_id
       AND publication.seller_niho_account_ref IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'a booking publication must carry a seller and sale terms' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER experience_product_publication_states_booking_is_sale
BEFORE INSERT OR UPDATE OF booking_publication_id ON experience_product_publication_states
FOR EACH ROW EXECUTE FUNCTION require_booking_publication_is_sale_version();

-- Every publication until now was a sale version (seller and terms were mandatory). A product that is PUBLISHED today is
-- sellable today, so its standing page version becomes its booking version too, status unchanged. A state whose product
-- is not PUBLISHED (never sold, or not sold any more) keeps no booking version, so "status PUBLISHED <=> booking open"
-- holds for the existing rows from the first moment.
-- Size: these are tiny tables in production (one state row per published experience, tens of rows). The migration runs in
-- one transaction and holds its locks until commit; it is deliberately not split into batches.
UPDATE experience_product_publication_states s
   SET booking_publication_id = s.current_publication_id
  FROM experience_products p
 WHERE p.provider_id = s.provider_id AND p.id = s.product_id
   AND p.status = 'PUBLISHED' AND s.current_publication_id IS NOT NULL;

-- One truth for "bookings are open", checked at commit: for a product that has a (published) state row,
-- status='PUBLISHED' <=> booking_publication_id IS NOT NULL, with ARCHIVED free (archiving a product need not first drop its
-- pointer; every sale reader filters on status, so an archived product is closed). Legacy products with no state row, and
-- states that were never published, are not covered.
CREATE FUNCTION require_status_matches_booking_publication() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  checked_provider text;
  checked_product text;
  product_status text;
  booking_open boolean;
  published boolean;
BEGIN
  IF TG_TABLE_NAME = 'experience_products' THEN
    checked_provider := NEW.provider_id;
    checked_product := NEW.id;
  ELSE
    checked_provider := NEW.provider_id;
    checked_product := NEW.product_id;
  END IF;
  SELECT p.status, s.booking_publication_id IS NOT NULL, s.current_publication_id IS NOT NULL
    INTO product_status, booking_open, published
    FROM experience_product_publication_states s
    JOIN experience_products p ON p.provider_id = s.provider_id AND p.id = s.product_id
   WHERE s.provider_id = checked_provider AND s.product_id = checked_product;
  IF FOUND AND published AND product_status <> 'ARCHIVED' AND ((product_status = 'PUBLISHED') <> booking_open) THEN
    RAISE EXCEPTION 'product status and booking publication disagree for %/%', checked_provider, checked_product
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER experience_product_publication_states_status_matches_booking
AFTER INSERT OR UPDATE ON experience_product_publication_states
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_status_matches_booking_publication();

CREATE CONSTRAINT TRIGGER experience_products_status_matches_booking
AFTER UPDATE OF status ON experience_products
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_status_matches_booking_publication();

-- Append-only record of when bookings opened and stopped. The state row (CAS on its version) is the truth; this is the log.
CREATE TABLE experience_product_booking_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_id text NOT NULL,
  product_id text NOT NULL,
  publication_id bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('OPENED', 'STOPPED')),
  reason text NOT NULL CHECK (reason ~ '^[A-Z0-9_]{1,80}$'),
  actor_niho_user_id text CHECK (actor_niho_user_id IS NULL OR length(actor_niho_user_id) BETWEEN 1 AND 256),
  state_version bigint CHECK (state_version IS NULL OR state_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (provider_id, product_id)
    REFERENCES experience_products(provider_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (publication_id, provider_id, product_id)
    REFERENCES experience_product_publications(id, provider_id, product_id) ON DELETE RESTRICT
);

CREATE INDEX experience_product_booking_events_product_idx
  ON experience_product_booking_events (provider_id, product_id, id DESC);

CREATE FUNCTION reject_experience_booking_event_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'experience booking events are append-only' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER experience_product_booking_events_no_update
BEFORE UPDATE OR DELETE ON experience_product_booking_events
FOR EACH ROW EXECUTE FUNCTION reject_experience_booking_event_mutation();

INSERT INTO experience_product_booking_events (provider_id, product_id, publication_id, kind, reason, state_version)
SELECT provider_id, product_id, booking_publication_id, 'OPENED', 'BACKFILL', version
  FROM experience_product_publication_states
 WHERE booking_publication_id IS NOT NULL;

COMMIT;
