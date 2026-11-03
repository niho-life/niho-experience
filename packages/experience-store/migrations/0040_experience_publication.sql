BEGIN;

-- A short-lived projection written only after the server has checked the current
-- NIHO account/OWNER and Connect state. Public reads fail closed when it is
-- absent, stale, false, or no longer backed by the same active OWNER row.
CREATE TABLE provider_publication_readiness (
  provider_id text PRIMARY KEY REFERENCES experience_providers(id) ON DELETE RESTRICT,
  owner_niho_user_id text NOT NULL,
  account_usable boolean NOT NULL,
  connect_ready boolean NOT NULL,
  seller_display_ready boolean NOT NULL,
  seller_niho_account_ref text NOT NULL CHECK (length(seller_niho_account_ref) BETWEEN 1 AND 256),
  stripe_connect_account_ref text NOT NULL CHECK (length(stripe_connect_account_ref) BETWEEN 1 AND 256),
  seller_display_name text NOT NULL CHECK (length(seller_display_name) BETWEEN 1 AND 300),
  required_consent_version text NOT NULL CHECK (length(required_consent_version) BETWEEN 1 AND 160),
  observed_at timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (provider_id, owner_niho_user_id)
    REFERENCES provider_memberships(provider_id, niho_user_id) ON DELETE RESTRICT,
  CHECK (valid_until > observed_at),
  CHECK (valid_until <= observed_at + interval '10 minutes')
);

-- Each row is the public, immutable copy. The editable experience_products row
-- remains a draft and existing booking snapshots keep referring to their own
-- immutable JSON snapshots.
CREATE TABLE experience_product_publications (
  id bigint GENERATED ALWAYS AS IDENTITY,
  provider_id text NOT NULL,
  product_id text NOT NULL,
  draft_version bigint NOT NULL CHECK (draft_version > 0),
  slug text NOT NULL CHECK (length(slug) BETWEEN 1 AND 160),
  public_title text NOT NULL CHECK (length(public_title) BETWEEN 1 AND 300),
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  unit_amount bigint NOT NULL CHECK (unit_amount BETWEEN 0 AND 9999999999),
  cancellation_terms_ref text NOT NULL CHECK (length(cancellation_terms_ref) BETWEEN 1 AND 512),
  seller_niho_account_ref text NOT NULL CHECK (length(seller_niho_account_ref) BETWEEN 1 AND 256),
  stripe_connect_account_ref text NOT NULL CHECK (length(stripe_connect_account_ref) BETWEEN 1 AND 256),
  seller_display_name text NOT NULL CHECK (length(seller_display_name) BETWEEN 1 AND 300),
  consent_version text NOT NULL CHECK (length(consent_version) BETWEEN 1 AND 160),
  published_by_niho_user_id text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (id),
  UNIQUE (id, provider_id, product_id),
  UNIQUE (provider_id, product_id, draft_version, consent_version),
  FOREIGN KEY (provider_id, product_id)
    REFERENCES experience_products(provider_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id, published_by_niho_user_id)
    REFERENCES provider_memberships(provider_id, niho_user_id) ON DELETE RESTRICT
);

CREATE INDEX experience_product_publications_slug_idx
  ON experience_product_publications (slug, published_at DESC, id DESC);

-- OWNER intent and an operations suspension are independent. Operations sets
-- owner_resume_required, and clearing the suspension deliberately leaves it set:
-- only a later OWNER publication/restart clears it.
CREATE TABLE experience_product_publication_states (
  provider_id text NOT NULL,
  product_id text NOT NULL,
  current_publication_id bigint,
  self_stopped_at timestamptz,
  operations_suspended_at timestamptz,
  operations_suspension_code text,
  operations_suspended_by_niho_user_id text,
  owner_resume_required boolean NOT NULL DEFAULT false,
  first_published_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, product_id),
  FOREIGN KEY (provider_id, product_id)
    REFERENCES experience_products(provider_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (current_publication_id, provider_id, product_id)
    REFERENCES experience_product_publications(id, provider_id, product_id) ON DELETE RESTRICT,
  CHECK ((current_publication_id IS NULL) = (first_published_at IS NULL)),
  CHECK (
    (operations_suspended_at IS NULL AND operations_suspension_code IS NULL AND operations_suspended_by_niho_user_id IS NULL)
    OR
    (operations_suspended_at IS NOT NULL
      AND operations_suspension_code ~ '^[A-Z0-9_]{1,80}$'
      AND length(operations_suspended_by_niho_user_id) BETWEEN 1 AND 256)
  )
);

CREATE INDEX experience_product_publication_states_public_idx
  ON experience_product_publication_states (current_publication_id)
  WHERE self_stopped_at IS NULL
    AND operations_suspended_at IS NULL
    AND owner_resume_required = false;

CREATE FUNCTION reject_experience_publication_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'experience product publications are immutable' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER experience_product_publications_no_update
BEFORE UPDATE OR DELETE ON experience_product_publications
FOR EACH ROW EXECUTE FUNCTION reject_experience_publication_mutation();

COMMIT;
