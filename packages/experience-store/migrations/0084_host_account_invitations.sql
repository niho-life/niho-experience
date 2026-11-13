BEGIN;

-- ホストの招待リンク (Epic #591, #596): Admin/ops invites a registered host account to bind its NIHO account. The host opens a
-- one-time link from an email, signs in at NIHO, and the NIHO account that comes back is bound to the host account in the
-- same transaction that uses the invitation up. Only the SHA-256 of the link token is stored; the raw token exists in the
-- email's URL fragment only (the mail job mints it right before sending, as it does for a sign-in link, so ops never holds it).
--
-- The link works until `expires_at`, once, and only in the browser that opened it first: the first open stores the SHA-256
-- of a random value that browser keeps in an HttpOnly cookie, and the NIHO sign-in has to come back with the same one.
-- A host account has one open invitation at a time: a new one supersedes (revokes) the earlier unused one. Rows are never
-- deleted (the history of who invited whom), and nothing here changes a host account, its roles or anything it authored.
CREATE TABLE host_account_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_account_id text NOT NULL REFERENCES host_accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  -- Minted by the mail job right before the email; NULL until then.
  token_hash bytea UNIQUE CHECK (token_hash IS NULL OR octet_length(token_hash) = 32),
  issued_at timestamptz,
  -- The browser the link was first opened in.
  browser_binding_hash bytea CHECK (browser_binding_hash IS NULL OR octet_length(browser_binding_hash) = 32),
  opened_at timestamptz,
  consumed_at timestamptz,
  revoked_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 days'),
  CHECK ((token_hash IS NULL) = (issued_at IS NULL)),
  CHECK (issued_at IS NULL OR (issued_at >= created_at AND issued_at < expires_at)),
  CHECK ((browser_binding_hash IS NULL) = (opened_at IS NULL)),
  CHECK (opened_at IS NULL OR (issued_at IS NOT NULL AND opened_at >= issued_at AND opened_at < expires_at)),
  CHECK (consumed_at IS NULL OR (opened_at IS NOT NULL AND consumed_at >= opened_at AND consumed_at < expires_at)),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (consumed_at IS NULL OR revoked_at IS NULL)
);

-- One open invitation per host account (a new one revokes the earlier one first).
CREATE UNIQUE INDEX host_account_invitations_open_idx
  ON host_account_invitations (host_account_id) WHERE consumed_at IS NULL AND revoked_at IS NULL;
-- A browser belongs to one open invitation at a time. A used or replaced invitation keeps the value it was bound to (history)
-- and does not hold it: the same browser can open the next invitation of the same host.
CREATE UNIQUE INDEX host_account_invitations_browser_open_idx
  ON host_account_invitations (browser_binding_hash) WHERE browser_binding_hash IS NOT NULL AND consumed_at IS NULL AND revoked_at IS NULL;
-- The invitation emails still to send.
CREATE INDEX host_account_invitations_pending_idx
  ON host_account_invitations (created_at) WHERE token_hash IS NULL AND consumed_at IS NULL AND revoked_at IS NULL;

CREATE FUNCTION reject_host_account_invitation_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'host account invitations are never deleted' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER host_account_invitations_never_deleted
BEFORE DELETE ON host_account_invitations
FOR EACH ROW EXECUTE FUNCTION reject_host_account_invitation_delete();

COMMIT;
