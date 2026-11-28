BEGIN;

-- #726 (Epic #700 stage 3c-1, docs/host-payouts.md「3c」): the runtime may create a Direct charge seller profile, but only for the
-- host's own Stripe account (a DIRECT row of experience_connect_accounts, 0098) that the host registered in its own name. Until
-- now the profile was written by the office's scripts alone (the migration identity); that path is unchanged.

ALTER TABLE experience_host_seller_profiles
  ADD COLUMN connect_account_id uuid UNIQUE,
  ADD COLUMN connect_account_purpose text CHECK (connect_account_purpose = 'DIRECT'),
  -- Both or neither; a profile that points at a host's own account has no NIHO legacy key and a `sel_` seller reference.
  ADD CONSTRAINT experience_host_seller_profiles_connect_account_check CHECK (
    (connect_account_id IS NULL) = (connect_account_purpose IS NULL)
    AND (connect_account_id IS NULL OR (legacy_provider_id IS NULL AND seller_niho_account_ref ~ '^sel_[0-9a-f]{32}$'))
  ),
  -- The profile's provider and Stripe account are the row's own (with ON DELETE RESTRICT, a bound row is never deleted).
  ADD CONSTRAINT experience_host_seller_profiles_connect_account_fkey
    FOREIGN KEY (connect_account_id, provider_id, connect_account_purpose, stripe_connect_account_ref)
    REFERENCES experience_connect_accounts (id, provider_id, purpose, stripe_account_ref) ON DELETE RESTRICT;

-- Who may insert what. The table's owner (the migration identity, the office's scripts) is as before. Anyone else (the runtime)
-- may insert only a profile bound to a valid DIRECT row of the same provider and the same Stripe account.
-- The function pins its search_path (pg_temp last) and qualifies every relation: a role that may create temporary tables must not be able to
-- shadow pg_class or experience_connect_accounts with a table of its own and so pass the check.
CREATE FUNCTION guard_experience_host_seller_profile_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF pg_catalog.pg_has_role(current_user, (SELECT relowner FROM pg_catalog.pg_class WHERE oid = TG_RELID), 'MEMBER') THEN
    RETURN NEW;
  END IF;
  IF NEW.connect_account_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.experience_connect_accounts account
     WHERE account.id = NEW.connect_account_id AND account.provider_id = NEW.provider_id AND account.purpose = 'DIRECT'
       AND account.retired_at IS NULL AND account.stripe_account_ref = NEW.stripe_connect_account_ref
  ) THEN
    RAISE EXCEPTION 'a seller profile is created from the host''s own valid Stripe account only' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER experience_host_seller_profiles_guard_insert
BEFORE INSERT ON experience_host_seller_profiles
FOR EACH ROW EXECUTE FUNCTION guard_experience_host_seller_profile_insert();

-- An account row a seller profile is bound to is never retired (the office changes the seller first). The foreign key does not stop an
-- UPDATE of retired_at, so this does, in the database: a retirement racing a registration (which holds the row FOR SHARE) waits for
-- it, then sees the profile and is refused.
CREATE FUNCTION guard_experience_connect_account_retirement() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.experience_host_seller_profiles profile WHERE profile.connect_account_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'a connect account a seller profile is bound to is not retired' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER experience_connect_accounts_guard_retirement
BEFORE UPDATE ON experience_connect_accounts
FOR EACH ROW EXECUTE FUNCTION guard_experience_connect_account_retirement();

COMMIT;
