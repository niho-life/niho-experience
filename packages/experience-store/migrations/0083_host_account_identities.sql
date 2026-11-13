BEGIN;

-- ログインを NIHO アカウントへ揃える (Epic #591, #593): a host account (`hst_`) can be bound to one NIHO account, so the
-- host signs in with NIHO and gets an Experience session. The person's ID in Experience stays `hst_`: nothing that names
-- an actor (`*_niho_user_id` columns, article authors, publication versions, photos) is rewritten, and no row of a
-- table that is immutable by trigger is touched. NIHO only proves who is signing in; no NIHO token is stored here.
--
-- A row is one binding. Unlinking never deletes it (`unlinked_at`), so the history of who was bound to a host account
-- stays; at most one binding of a host account and at most one binding of a NIHO user ID are active at a time.

CREATE TABLE host_account_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_account_id text NOT NULL REFERENCES host_accounts(id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (provider = 'NIHO'),
  -- The NIHO user ID. Read by the store only; never shown to a browser or written to a log.
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 256 AND subject !~ '[[:cntrl:]]' AND subject !~ '^(hst|sel)_'),
  -- INVITATION: an ops-issued invitation link (#596). SETTINGS: the host's own 設定 (#595). OPS: Admin/ops by hand.
  linked_via text NOT NULL CHECK (linked_via IN ('INVITATION', 'SETTINGS', 'OPS')),
  linked_at timestamptz NOT NULL,
  last_login_at timestamptz,
  unlinked_at timestamptz,
  CHECK (last_login_at IS NULL OR last_login_at >= linked_at),
  CHECK (unlinked_at IS NULL OR unlinked_at >= linked_at)
);

-- A NIHO account stands for one host account only, and a host account has one NIHO account bound at a time.
CREATE UNIQUE INDEX host_account_identities_subject_active_idx
  ON host_account_identities (provider, subject) WHERE unlinked_at IS NULL;
CREATE UNIQUE INDEX host_account_identities_account_active_idx
  ON host_account_identities (host_account_id, provider) WHERE unlinked_at IS NULL;
CREATE INDEX host_account_identities_account_idx ON host_account_identities (host_account_id, linked_at);

CREATE FUNCTION protect_host_account_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'host account identities are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.host_account_id IS DISTINCT FROM OLD.host_account_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.subject IS DISTINCT FROM OLD.subject
     OR NEW.linked_via IS DISTINCT FROM OLD.linked_via
     OR NEW.linked_at IS DISTINCT FROM OLD.linked_at THEN
    RAISE EXCEPTION 'a host account identity only changes by its last sign-in or by unlinking' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.unlinked_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'an unlinked host account identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER host_account_identities_protect
BEFORE UPDATE OR DELETE ON host_account_identities
FOR EACH ROW EXECUTE FUNCTION protect_host_account_identity();

-- The audit trail of bindings: a link, an unlink, and a refused attempt of either. Append-only. It is the one place the
-- NIHO user ID is kept besides the binding itself (a refusal has no binding). Nothing else is recorded about the person.
CREATE TABLE host_account_identity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_account_id text NOT NULL REFERENCES host_accounts(id) ON DELETE RESTRICT,
  event_kind text NOT NULL CHECK (event_kind IN ('LINKED', 'UNLINKED', 'LINK_REFUSED', 'UNLINK_REFUSED')),
  provider text NOT NULL CHECK (provider = 'NIHO'),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 256),
  via text NOT NULL CHECK (via IN ('INVITATION', 'SETTINGS', 'OPS')),
  -- Why a refusal was refused; NULL for LINKED and UNLINKED.
  reason text CHECK (reason IN ('IDENTITY_IN_USE', 'ACCOUNT_HAS_IDENTITY', 'RECENT_AUTHENTICATION_REQUIRED', 'LAST_SIGN_IN_METHOD')),
  occurred_at timestamptz NOT NULL,
  CHECK ((event_kind IN ('LINK_REFUSED', 'UNLINK_REFUSED')) = (reason IS NOT NULL))
);

CREATE INDEX host_account_identity_events_account_idx ON host_account_identity_events (host_account_id, occurred_at);

CREATE FUNCTION reject_host_account_identity_event_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'host account identity events are append-only' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER host_account_identity_events_append_only
BEFORE UPDATE OR DELETE ON host_account_identity_events
FOR EACH ROW EXECUTE FUNCTION reject_host_account_identity_event_change();

-- A session opened from a NIHO sign-in carries NIHO's `auth_time` as authenticated_at: the person proved who they are
-- at NIHO before this session was created, never after it. (The sessions opened from an emailed link have both equal.)
DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'host_sessions'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) = 'CHECK ((authenticated_at >= created_at))'
  LOOP
    EXECUTE format('ALTER TABLE host_sessions DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE host_sessions ADD CONSTRAINT host_sessions_authenticated_before_created_check CHECK (authenticated_at <= created_at);

COMMIT;
