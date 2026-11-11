BEGIN;

-- Public provider identity is independent from the legal seller and payout
-- profile. Admin may register this before the provider has an account,
-- membership, seller profile, or Stripe account.
CREATE TABLE experience_provider_public_profiles (
  provider_id text PRIMARY KEY REFERENCES experience_providers(id) ON DELETE RESTRICT,
  public_display_name text NOT NULL CHECK (
    char_length(public_display_name) BETWEEN 1 AND 300
    AND public_display_name !~ '^\s|\s$'
    AND public_display_name !~ '[[:cntrl:]]'
  ),
  provider_kind text CHECK (provider_kind IS NULL OR provider_kind IN ('PERSON','BUSINESS')),
  consent_version text NOT NULL CHECK (char_length(consent_version) BETWEEN 1 AND 160),
  consented_at timestamptz NOT NULL,
  consented_by_admin_niho_user_id text NOT NULL CHECK (char_length(consented_by_admin_niho_user_id) BETWEEN 1 AND 256),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- OWNER uploads keep these columns null. Admin uploads record the exact
-- verified staff actor and the consent wording version used for that image.
ALTER TABLE experience_provider_media_assets
  ADD COLUMN rights_confirmed_by_admin_niho_user_id text
    CHECK (rights_confirmed_by_admin_niho_user_id IS NULL OR char_length(rights_confirmed_by_admin_niho_user_id) BETWEEN 1 AND 256),
  ADD COLUMN rights_consent_version text
    CHECK (rights_consent_version IS NULL OR char_length(rights_consent_version) BETWEEN 1 AND 160),
  ADD CONSTRAINT experience_provider_media_assets_admin_consent_check CHECK (
    (rights_confirmed_by_admin_niho_user_id IS NULL) = (rights_consent_version IS NULL)
  );

COMMIT;
