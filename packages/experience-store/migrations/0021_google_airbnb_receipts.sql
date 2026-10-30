BEGIN;

ALTER TABLE channel_job_results
  DROP CONSTRAINT channel_job_results_verified_check,
  ADD COLUMN google_airbnb_delivery_id uuid REFERENCES google_channel_deliveries(id) ON DELETE RESTRICT,
  ADD COLUMN google_airbnb_evidence text,
  ADD COLUMN google_airbnb_party_size smallint,
  ADD COLUMN google_airbnb_verified_at timestamptz,
  ADD CONSTRAINT channel_job_results_google_airbnb_proof_check CHECK (
    (google_airbnb_delivery_id IS NULL AND google_airbnb_evidence IS NULL
      AND google_airbnb_party_size IS NULL AND google_airbnb_verified_at IS NULL)
    OR
    (outcome='VERIFIED' AND google_airbnb_delivery_id IS NOT NULL
      AND google_airbnb_evidence IS NOT NULL AND google_airbnb_party_size IS NOT NULL
      AND google_airbnb_evidence='EXACT_SLOT_V1' AND google_airbnb_party_size=1
      AND google_airbnb_verified_at IS NOT NULL AND observed_manually_blocked IS NULL
      AND observed_at IS NOT NULL AND google_airbnb_verified_at<=observed_at
      AND ((observed_state='OPEN' AND observed_bookable=true)
        OR (observed_state='CLOSED' AND observed_bookable=false)))
  ),
  ADD CONSTRAINT channel_job_results_verified_check CHECK (
    outcome <> 'VERIFIED' OR (exact_target_match AND observed_state IS NOT NULL
      AND observed_bookable IS NOT NULL AND observed_at IS NOT NULL
      AND (
        (observed_manually_blocked IS NOT NULL AND google_airbnb_delivery_id IS NULL
          AND google_airbnb_evidence IS NULL AND google_airbnb_party_size IS NULL
          AND google_airbnb_verified_at IS NULL)
        OR
        (observed_manually_blocked IS NULL AND google_airbnb_delivery_id IS NOT NULL
          AND google_airbnb_evidence IS NOT NULL AND google_airbnb_party_size IS NOT NULL
          AND google_airbnb_evidence='EXACT_SLOT_V1' AND google_airbnb_party_size=1
          AND google_airbnb_verified_at IS NOT NULL)
      ))
  );

CREATE INDEX channel_job_results_google_airbnb_delivery_idx
  ON channel_job_results (google_airbnb_delivery_id)
  WHERE google_airbnb_delivery_id IS NOT NULL;

COMMIT;
