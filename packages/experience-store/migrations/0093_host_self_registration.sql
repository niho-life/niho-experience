BEGIN;

-- #707 (Epic #700 stage 2a): a person registers as a host without Admin. The records below say who consented to the public
-- name and how the host came to be, and the database itself keeps one host account to at most 3 active OWNER memberships.

-- A new route of the immutable identity history: a NIHO identity that registered itself as a host.
ALTER TABLE host_account_identities
  DROP CONSTRAINT host_account_identities_linked_via_check,
  ADD CONSTRAINT host_account_identities_linked_via_check
    CHECK (linked_via IN ('INVITATION', 'SETTINGS', 'OPS', 'WRITER', 'SELF_REGISTRATION'));

ALTER TABLE host_account_identity_events
  DROP CONSTRAINT host_account_identity_events_via_check,
  ADD CONSTRAINT host_account_identity_events_via_check
    CHECK (via IN ('INVITATION', 'SETTINGS', 'OPS', 'WRITER', 'NIHO_STATUS', 'SELF_REGISTRATION'));

-- The public name is consented to by Admin (existing rows) or by the provider's own OWNER; exactly one of the two.
ALTER TABLE experience_provider_public_profiles
  ADD COLUMN consent_source text NOT NULL DEFAULT 'ADMIN' CHECK (consent_source IN ('ADMIN', 'OWNER')),
  ADD COLUMN consented_by_host_account_id text REFERENCES host_accounts(id) ON DELETE RESTRICT,
  ALTER COLUMN consented_by_admin_niho_user_id DROP NOT NULL;

-- Writers say their source; a forgotten column must fail rather than become ADMIN.
ALTER TABLE experience_provider_public_profiles
  ALTER COLUMN consent_source DROP DEFAULT,
  ADD CONSTRAINT experience_provider_public_profiles_consent_actor_check CHECK (
    (consent_source = 'ADMIN' AND consented_by_admin_niho_user_id IS NOT NULL AND consented_by_host_account_id IS NULL)
    OR (consent_source = 'OWNER' AND consented_by_host_account_id IS NOT NULL AND consented_by_admin_niho_user_id IS NULL)
  );

-- How a provider came to be registered by its own OWNER (Admin's host list shows the route, stage 4). Append-only.
CREATE TABLE experience_provider_self_registrations (
  provider_id text PRIMARY KEY REFERENCES experience_providers(id) ON DELETE RESTRICT,
  host_account_id text NOT NULL REFERENCES host_accounts(id) ON DELETE RESTRICT,
  host_terms_version text NOT NULL CHECK (char_length(host_terms_version) BETWEEN 1 AND 160),
  host_terms_accepted_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX experience_provider_self_registrations_account_idx
  ON experience_provider_self_registrations (host_account_id);

CREATE FUNCTION reject_experience_provider_self_registration_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'experience provider self registrations are append-only' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER experience_provider_self_registrations_no_update
BEFORE UPDATE OR DELETE ON experience_provider_self_registrations
FOR EACH ROW EXECUTE FUNCTION reject_experience_provider_self_registration_mutation();

-- A host account (`hst_`) is the active OWNER of at most 3 providers (HOST_PROVIDER_OWNER_LIMIT in host-accounts.ts: change
-- both together). The TS paths count under the same advisory lock key and seed (47); taking it here makes a direct write wait
-- for them and count what they committed. An old NIHO user ID is not limited.
CREATE FUNCTION enforce_host_provider_owner_limit() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role = 'OWNER' AND NEW.active AND NEW.niho_user_id ~ '^hst_[0-9a-f]{32}$' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('experience-host-owner:' || NEW.niho_user_id, 47));
    IF (SELECT count(*) FROM provider_memberships m
         WHERE m.niho_user_id = NEW.niho_user_id AND m.role = 'OWNER' AND m.active
           AND m.provider_id <> NEW.provider_id) >= 3 THEN
      RAISE EXCEPTION 'a host account is the OWNER of at most 3 providers' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_memberships_host_owner_limit
BEFORE INSERT OR UPDATE OF role, active, niho_user_id ON provider_memberships
FOR EACH ROW EXECUTE FUNCTION enforce_host_provider_owner_limit();

COMMIT;
