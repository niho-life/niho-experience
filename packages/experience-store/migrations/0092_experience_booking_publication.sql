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

-- Every publication until now was a sale version (seller and terms were mandatory) and its product is sellable today:
-- the standing page version becomes the standing sale version, status unchanged.
UPDATE experience_product_publication_states
   SET booking_publication_id = current_publication_id
 WHERE current_publication_id IS NOT NULL;

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
