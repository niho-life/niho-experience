BEGIN;

-- No NIHO Experience product, reservation, or hold is being migrated. Owner
-- publications are the only new checkout source, so the migration-only gate
-- and imported reservation-seat ledger are no longer part of the runtime model.
DROP TABLE IF EXISTS experience_legacy_reservation_inventory_current;
DROP TABLE IF EXISTS experience_legacy_reservation_inventory;
DROP TABLE IF EXISTS experience_product_cutovers;
DROP FUNCTION IF EXISTS reject_legacy_reservation_inventory_mutation();

COMMIT;
