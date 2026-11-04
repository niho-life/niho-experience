BEGIN;

-- Public seller information explicitly entered by the current Experience OWNER.
-- This table never receives NIHO profile/KYC data. The seller name must still be
-- checked against experience_host_seller_profiles by the Store transaction.
CREATE TABLE provider_seller_disclosures (
  provider_id text PRIMARY KEY REFERENCES experience_providers(id) ON DELETE RESTRICT,
  method text NOT NULL CHECK (method IN ('NATIVE', 'EXTERNAL', 'WITHDRAWN')),
  seller_kind text NOT NULL CHECK (seller_kind IN ('PERSON', 'BUSINESS')),
  seller_display_name text NOT NULL CHECK (
    length(seller_display_name) BETWEEN 1 AND 300
    AND seller_display_name = btrim(seller_display_name)
    AND seller_display_name !~ '[[:cntrl:]]'
  ),
  representative_name text CHECK (
    length(representative_name) BETWEEN 1 AND 200
    AND representative_name = btrim(representative_name)
    AND representative_name !~ '[[:cntrl:]]'
  ),
  public_address text CHECK (
    length(public_address) BETWEEN 1 AND 500
    AND public_address = btrim(public_address)
    -- The address textarea permits line breaks; other control characters remain forbidden.
    AND replace(replace(public_address,chr(10),''),chr(13),'') !~ '[[:cntrl:]]'
  ),
  public_phone text CHECK (
    length(public_phone) BETWEEN 1 AND 40
    AND public_phone = btrim(public_phone)
    AND public_phone ~ '^\+?[0-9 ()-]+$'
  ),
  public_email text CHECK (
    length(public_email) BETWEEN 3 AND 254
    AND public_email = btrim(public_email)
    AND public_email ~ '^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+\.[^[:space:][:cntrl:]@]+$'
  ),
  external_url text CHECK (
    length(external_url) BETWEEN 1 AND 2048
    AND external_url ~ '^https://[^[:space:]]+$'
  ),
  consent_version text NOT NULL CHECK (length(consent_version) BETWEEN 1 AND 160),
  consented_at timestamptz NOT NULL,
  consented_by_niho_user_id text NOT NULL,
  withdrawn_at timestamptz,
  withdrawn_by_niho_user_id text,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (provider_id, consented_by_niho_user_id)
    REFERENCES provider_memberships(provider_id, niho_user_id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id, withdrawn_by_niho_user_id)
    REFERENCES provider_memberships(provider_id, niho_user_id) ON DELETE RESTRICT,
  CHECK (
    (method = 'NATIVE'
      AND public_address IS NOT NULL AND public_phone IS NOT NULL AND public_email IS NOT NULL
      AND external_url IS NULL AND withdrawn_at IS NULL AND withdrawn_by_niho_user_id IS NULL
      AND ((seller_kind = 'BUSINESS' AND representative_name IS NOT NULL)
        OR (seller_kind = 'PERSON' AND representative_name IS NULL)))
    OR
    (method = 'EXTERNAL'
      AND representative_name IS NULL AND public_address IS NULL AND public_phone IS NULL AND public_email IS NULL
      AND external_url IS NOT NULL AND withdrawn_at IS NULL AND withdrawn_by_niho_user_id IS NULL)
    OR
    (method = 'WITHDRAWN'
      AND representative_name IS NULL AND public_address IS NULL AND public_phone IS NULL AND public_email IS NULL
      AND external_url IS NULL AND withdrawn_at IS NOT NULL AND withdrawn_by_niho_user_id IS NOT NULL)
  )
);

-- A receipt makes an uncertain PUT/DELETE safe to repeat. It intentionally stores
-- no disclosure body or result snapshot: a replay is checked against the current
-- row by applied_version so withdrawn/superseded contact details cannot resurface.
CREATE TABLE provider_seller_disclosure_commands (
  provider_id text NOT NULL REFERENCES experience_providers(id) ON DELETE RESTRICT,
  command_id uuid NOT NULL,
  actor_niho_user_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('SAVE', 'WITHDRAW')),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  applied_version bigint NOT NULL CHECK (applied_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, command_id),
  FOREIGN KEY (provider_id, actor_niho_user_id)
    REFERENCES provider_memberships(provider_id, niho_user_id) ON DELETE RESTRICT
);

CREATE FUNCTION reject_provider_seller_disclosure_command_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'provider seller disclosure commands are immutable' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER provider_seller_disclosure_commands_no_update
BEFORE UPDATE OR DELETE ON provider_seller_disclosure_commands
FOR EACH ROW EXECUTE FUNCTION reject_provider_seller_disclosure_command_mutation();

COMMIT;
