BEGIN;

-- #481: a NIHO-authorized article writer may use /write without being a provider host. The durable Experience actor is
-- still an hst_ account linked one-to-one to the verified NIHO identity, but it has no email address: Experience neither
-- receives nor invents one, and the email-link login can never be used for this account.
ALTER TABLE host_accounts
  ALTER COLUMN email DROP NOT NULL,
  ALTER COLUMN email_key DROP NOT NULL;

ALTER TABLE host_accounts
  ADD CONSTRAINT host_accounts_email_pair_check CHECK ((email IS NULL) = (email_key IS NULL)),
  ADD CONSTRAINT host_accounts_emailless_unverified_check CHECK (email IS NOT NULL OR email_verified_at IS NULL);

-- Keep the binding reason explicit in the immutable identity history. Existing bindings and sessions are untouched.
ALTER TABLE host_account_identities
  DROP CONSTRAINT host_account_identities_linked_via_check,
  ADD CONSTRAINT host_account_identities_linked_via_check
    CHECK (linked_via IN ('INVITATION', 'SETTINGS', 'OPS', 'WRITER'));

ALTER TABLE host_account_identity_events
  DROP CONSTRAINT host_account_identity_events_via_check,
  ADD CONSTRAINT host_account_identity_events_via_check
    CHECK (via IN ('INVITATION', 'SETTINGS', 'OPS', 'WRITER'));

COMMIT;
