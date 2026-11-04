BEGIN;

-- NIHO v1.0 deliberately does not export a provider directory or a provider
-- registration API. Experience therefore keeps an operator-provisioned,
-- explicit mapping for the one NIHO Connect projection it is allowed to read.
-- provider_id is Experience's authority key; legacy_provider_id is only the
-- NIHO path key. Neither is used as the current person's NIHO user ID.
CREATE TABLE experience_host_seller_profiles (
  provider_id text PRIMARY KEY REFERENCES experience_providers(id) ON DELETE RESTRICT,
  legacy_provider_id text NOT NULL UNIQUE CHECK (length(legacy_provider_id) BETWEEN 1 AND 200 AND legacy_provider_id ~ '^[A-Za-z0-9_-]+$'),
  provider_display_name text NOT NULL CHECK (length(provider_display_name) BETWEEN 1 AND 300),
  seller_niho_account_ref text NOT NULL CHECK (length(seller_niho_account_ref) BETWEEN 1 AND 256),
  stripe_connect_account_ref text NOT NULL CHECK (stripe_connect_account_ref ~ '^acct_[A-Za-z0-9]{8,250}$'),
  seller_display_name text NOT NULL CHECK (length(seller_display_name) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Existing readiness snapshots did not record NIHO's separate consent to reuse
-- its Connect account. Historical rows fail closed until a fresh v1 projection.
ALTER TABLE provider_publication_readiness
  ADD COLUMN payment_reuse_consent_accepted boolean NOT NULL DEFAULT false,
  ADD COLUMN payment_reuse_consent_version text,
  ADD COLUMN payment_reuse_consented_at timestamptz,
  ADD CONSTRAINT provider_publication_readiness_payment_reuse_consent_check CHECK (
    (payment_reuse_consent_accepted AND payment_reuse_consent_version IS NOT NULL AND payment_reuse_consented_at IS NOT NULL)
    OR (NOT payment_reuse_consent_accepted AND payment_reuse_consent_version IS NULL AND payment_reuse_consented_at IS NULL)
  );

COMMIT;
