BEGIN;

-- The seller no longer configures private-group booking in sale terms.
-- Historical publication and booking JSON snapshots are left unchanged;
-- readers ignore their retired privateBooking field.
ALTER TABLE experience_product_sale_terms DROP COLUMN private_booking;

COMMIT;
