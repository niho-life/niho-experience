BEGIN;

-- #726 (Epic #700 stage 3c-1, docs/host-payouts.md「3c」): the host's OWN Stripe account (a full-dashboard "Standard" account the
-- host signs in to, the seller of an independent 10% sale). It lives in the same table as the Express payout account (rows
-- reserved before Stripe is asked, the account ID written once, retired only by the office), with its own purpose. One valid row
-- per provider and purpose (the unique index already says so); one Stripe account is never two rows (stripe_account_ref UNIQUE).

ALTER TABLE experience_connect_accounts
  DROP CONSTRAINT experience_connect_accounts_purpose_check,
  ADD CONSTRAINT experience_connect_accounts_purpose_check CHECK (purpose IN ('PAYOUT', 'DIRECT'));

-- What the seller profile (0099) points at: the row, its provider, its purpose and its Stripe account, as one key.
ALTER TABLE experience_connect_accounts
  ADD CONSTRAINT experience_connect_accounts_seller_key UNIQUE (id, provider_id, purpose, stripe_account_ref);

-- A host's own account takes this site's payments, so whether Stripe says charges are enabled is kept too (false for every
-- payout-account snapshot, which never takes payments).
ALTER TABLE experience_connect_account_snapshots
  ADD COLUMN charges_enabled boolean NOT NULL DEFAULT false;

COMMIT;
