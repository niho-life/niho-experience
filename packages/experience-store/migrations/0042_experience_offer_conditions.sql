BEGIN;

-- Existing rows keep their current 24 h / 48 h / no-free-cancellation behavior.
-- New period and refund values are explicit offer settings; no product-specific
-- value is inferred from unpublished legacy content.
ALTER TABLE experience_product_sale_terms
  ADD COLUMN cancellation_window_minutes_before_start integer,
  ADD COLUMN cancellation_refund_basis_points integer,
  ADD COLUMN private_booking boolean NOT NULL DEFAULT false,
  ADD COLUMN minimum_chargeable_participants integer NOT NULL DEFAULT 1,
  ADD COLUMN minimum_attendance integer;

UPDATE experience_product_sale_terms
   SET cancellation_window_minutes_before_start = CASE cancellation_policy
         WHEN 'FREE_UNTIL_24H' THEN 1440
         WHEN 'FREE_UNTIL_48H' THEN 2880
         ELSE NULL
       END,
       cancellation_refund_basis_points = CASE cancellation_policy
         WHEN 'FREE_UNTIL_24H' THEN 10000
         WHEN 'FREE_UNTIL_48H' THEN 10000
         ELSE 0
       END;

ALTER TABLE experience_product_sale_terms
  ALTER COLUMN cancellation_refund_basis_points SET NOT NULL,
  ADD CONSTRAINT experience_product_sale_terms_free_cancel_minutes_check
    CHECK (cancellation_window_minutes_before_start BETWEEN 0 AND 2147483647 OR cancellation_window_minutes_before_start IS NULL),
  ADD CONSTRAINT experience_product_sale_terms_refund_basis_points_check
    CHECK (cancellation_refund_basis_points BETWEEN 0 AND 10000),
  ADD CONSTRAINT experience_product_sale_terms_min_chargeable_check
    CHECK (minimum_chargeable_participants BETWEEN 1 AND 500 AND minimum_chargeable_participants <= max_party_size),
  ADD CONSTRAINT experience_product_sale_terms_min_attendance_check
    CHECK (minimum_attendance BETWEEN 1 AND 2147483647 OR minimum_attendance IS NULL),
  ADD CONSTRAINT experience_product_sale_terms_cancel_pair_check
    CHECK (cancellation_window_minutes_before_start IS NOT NULL OR cancellation_refund_basis_points = 0);

-- Preserve compatibility for an older operator insert that still supplies only
-- cancellation_policy. New writers send the explicit period/rate pair.
CREATE FUNCTION set_legacy_experience_cancellation_terms() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.cancellation_window_minutes_before_start IS NULL AND NEW.cancellation_refund_basis_points IS NULL THEN
    NEW.cancellation_window_minutes_before_start := CASE NEW.cancellation_policy
      WHEN 'FREE_UNTIL_24H' THEN 1440
      WHEN 'FREE_UNTIL_48H' THEN 2880
      ELSE NULL
    END;
    NEW.cancellation_refund_basis_points := CASE NEW.cancellation_policy
      WHEN 'FREE_UNTIL_24H' THEN 10000
      WHEN 'FREE_UNTIL_48H' THEN 10000
      ELSE 0
    END;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER experience_product_sale_terms_legacy_cancellation_defaults
BEFORE INSERT ON experience_product_sale_terms
FOR EACH ROW EXECUTE FUNCTION set_legacy_experience_cancellation_terms();

COMMIT;
