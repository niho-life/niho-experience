BEGIN;

-- 受取口座 (ADR 0003 slice 3, docs/host-accounts.md): sellers whose OWNER signs in with an Experience host account, and the
-- OWNER's versioned consent to receive the provider's Experience sales in its registered Stripe account. Loosening and
-- additive only: the current writer (the NIHO path) keeps writing seller profiles exactly as before and never reads the
-- new table.

-- A seller registered for Experience host accounts has no NIHO legacy Connect lookup key: readiness is read from Stripe
-- directly. UNIQUE stays (PostgreSQL lets NULLs repeat). Such a seller's seller_niho_account_ref is a provider-scoped
-- seller reference (`sel_` + 32 hex), minted once when Admin/ops register the profile and never derived from a person:
-- products, publications and readiness snapshots keep matching it when the OWNER changes, and its `sel_` shape never
-- matches a NIHO user ID or a host account ID (`hst_`). A profile with a NIHO path key keeps a NIHO user ID there.
ALTER TABLE experience_host_seller_profiles
  ALTER COLUMN legacy_provider_id DROP NOT NULL,
  ADD CONSTRAINT experience_host_seller_profiles_host_account_seller_check CHECK (
    legacy_provider_id IS NOT NULL OR seller_niho_account_ref ~ '^sel_[0-9a-f]{32}$'
  );

-- The OWNER's consent to use the provider's registered payout account (stripe_connect_account_ref, which Admin/ops
-- registered; never one from a browser) for the provider's Experience sales, at a consent version. Rows are never
-- deleted: a withdrawal or a replacement (another version, account or OWNER) sets revoked_at/revoked_by on the active
-- row, so the table is the consent's audit history. At most one active consent per provider. The actor columns follow
-- the `*_niho_user_id` naming of ADR 0003 (renamed to `*_actor_id` with the others later) and hold host account IDs only.
CREATE TABLE provider_payout_account_consents (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL REFERENCES experience_providers(id) ON DELETE RESTRICT,
  stripe_connect_account_ref text NOT NULL CHECK (stripe_connect_account_ref ~ '^acct_[A-Za-z0-9]{8,250}$'),
  consent_version text NOT NULL CHECK (length(consent_version) BETWEEN 1 AND 160 AND consent_version = btrim(consent_version)),
  consented_by_niho_user_id text NOT NULL CHECK (consented_by_niho_user_id ~ '^hst_[0-9a-f]{32}$')
    REFERENCES host_accounts(id) ON DELETE RESTRICT,
  consented_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by_niho_user_id text CHECK (revoked_by_niho_user_id ~ '^hst_[0-9a-f]{32}$')
    REFERENCES host_accounts(id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id, consented_by_niho_user_id)
    REFERENCES provider_memberships(provider_id, niho_user_id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id, revoked_by_niho_user_id)
    REFERENCES provider_memberships(provider_id, niho_user_id) ON DELETE RESTRICT,
  CHECK ((revoked_at IS NULL) = (revoked_by_niho_user_id IS NULL)),
  CHECK (revoked_at IS NULL OR revoked_at >= consented_at)
);

-- At most one active consent per provider; also the provider's history in order.
CREATE UNIQUE INDEX provider_payout_account_consents_active_idx
  ON provider_payout_account_consents (provider_id) WHERE revoked_at IS NULL;
CREATE INDEX provider_payout_account_consents_provider_idx
  ON provider_payout_account_consents (provider_id, consented_at);

COMMIT;
