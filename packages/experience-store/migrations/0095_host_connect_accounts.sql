BEGIN;

-- #710 (Epic #700 stage 3a, docs/host-payouts.md): the Stripe account a host registers by itself to receive its payouts
-- (Express). One valid row (retired_at IS NULL) per provider and purpose, the in-progress one included: a row is inserted
-- BEFORE Stripe is asked (stripe_account_ref NULL, the row's id is Stripe's idempotency key, creation_params are the exact
-- parameters), and the account ID is written once afterwards. Rows are never deleted; retiring is the office's act.
--
-- The seller profile (experience_host_seller_profiles) and the payout-account consent are the Direct charge seller's and
-- are not touched.

CREATE TABLE experience_connect_accounts (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL REFERENCES experience_providers(id) ON DELETE RESTRICT,
  purpose text NOT NULL CHECK (purpose IN ('PAYOUT')),
  stripe_account_ref text UNIQUE CHECK (stripe_account_ref IS NULL OR stripe_account_ref ~ '^acct_[A-Za-z0-9]{8,250}$'),
  -- The parameters accounts.create is called with (never a secret, never a personal detail): a retry sends the same ones.
  creation_params jsonb NOT NULL CHECK (jsonb_typeof(creation_params) = 'object'),
  created_by_host_account_id text NOT NULL CHECK (created_by_host_account_id ~ '^hst_[0-9a-f]{32}$')
    REFERENCES host_accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  retired_at timestamptz,
  retired_by text CHECK (retired_by IS NULL OR length(retired_by) BETWEEN 1 AND 256),
  CHECK ((retired_at IS NULL) = (retired_by IS NULL))
);

CREATE UNIQUE INDEX experience_connect_accounts_valid_idx
  ON experience_connect_accounts (provider_id, purpose) WHERE retired_at IS NULL;

CREATE FUNCTION protect_experience_connect_accounts() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'experience connect accounts are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.provider_id IS DISTINCT FROM OLD.provider_id OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.creation_params IS DISTINCT FROM OLD.creation_params OR NEW.created_by_host_account_id IS DISTINCT FROM OLD.created_by_host_account_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'experience connect account facts are immutable' USING ERRCODE = 'check_violation';
  END IF;
  -- The account ID goes from NULL to a value once.
  IF OLD.stripe_account_ref IS NOT NULL AND NEW.stripe_account_ref IS DISTINCT FROM OLD.stripe_account_ref THEN
    RAISE EXCEPTION 'the stripe account of a connect account is set once' USING ERRCODE = 'check_violation';
  END IF;
  -- A retired row stays retired.
  IF OLD.retired_at IS NOT NULL AND (NEW.retired_at IS DISTINCT FROM OLD.retired_at OR NEW.retired_by IS DISTINCT FROM OLD.retired_by) THEN
    RAISE EXCEPTION 'a retired connect account stays retired' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER experience_connect_accounts_protect
BEFORE UPDATE OR DELETE ON experience_connect_accounts
FOR EACH ROW EXECUTE FUNCTION protect_experience_connect_accounts();

-- What Stripe last said of the account (read again from Stripe on every screen load and every account.updated webhook; the
-- webhook's own payload is never trusted). Only the facts the screen and payout-readiness need; no personal detail.
CREATE TABLE experience_connect_account_snapshots (
  connect_account_id uuid PRIMARY KEY REFERENCES experience_connect_accounts(id) ON DELETE RESTRICT,
  stripe_account_ref text NOT NULL CHECK (stripe_account_ref ~ '^acct_[A-Za-z0-9]{8,250}$'),
  -- One of the screen's states (NOT_STARTED is never stored).
  state text NOT NULL CHECK (state IN ('IN_PROGRESS', 'VERIFYING', 'ACTION_REQUIRED', 'REJECTED', 'READY')),
  payout_ready boolean NOT NULL,
  details_submitted boolean NOT NULL,
  payouts_enabled boolean NOT NULL,
  transfers_active boolean NOT NULL,
  -- SHA-256 (hex) of the sorted requirement codes that are due or past due and of the disabled reason.
  requirements_hash text NOT NULL CHECK (requirements_hash ~ '^[0-9a-f]{64}$'),
  read_at timestamptz NOT NULL,
  CHECK (NOT payout_ready OR state = 'READY')
);

COMMIT;
