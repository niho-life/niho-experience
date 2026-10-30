BEGIN;

ALTER TABLE google_channel_deliveries
  DROP CONSTRAINT google_channel_deliveries_operation_kind_check,
  ADD COLUMN operation_verified_at timestamptz,
  ADD COLUMN first_verified_at timestamptz,
  ADD CONSTRAINT google_channel_deliveries_operation_kind_check
    CHECK (operation_kind IN ('DISPATCH','RECONCILE','OBSERVE'));

-- Existing selected GOOGLE_VERIFIED metadata is a historical verification.
-- New operations reset operation_verified_at before any Google I/O and only
-- saveResult may establish a fresh timestamp for the current operation.
UPDATE google_channel_deliveries
   SET operation_verified_at=updated_at,first_verified_at=updated_at
 WHERE phase='GOOGLE_VERIFIED';

ALTER TABLE google_channel_deliveries
  ADD CONSTRAINT google_channel_deliveries_verified_timestamps_check CHECK (
    (operation_verified_at IS NULL)
    OR
    (phase='GOOGLE_VERIFIED' AND first_verified_at IS NOT NULL
      AND operation_verified_at>=first_verified_at)
  );

COMMIT;
