BEGIN;

-- メンバーの招待 (#636): a provider's OWNER invites a person to join as COHOST. The person opens a one-time link from an
-- email, signs in at NIHO, and the NIHO account that comes back becomes (or is bound to) a host account that joins the
-- team, all in the transaction that uses the invitation up. It is built like host_account_invitations (0084) but belongs to
-- a provider's team, not to a host account: the invited person may have no host account yet.
--
-- The address is where the email goes, not who the person is. Whoever opens the link and signs in with a NIHO account is the
-- one who joins; the address never decides which host account that is beyond the email-bound account the person's NIHO
-- account may be bound to. Only the SHA-256 of the link token is stored; the raw token exists in the email's URL fragment only
-- (the mail job mints it right before sending). The link works until `expires_at`, once, and only in the browser that opened
-- it first (the SHA-256 of a random value that browser keeps in an HttpOnly cookie).
--
-- An open invitation keeps its address; a closed one (accepted, revoked, replaced or run out) has none, so the table does not
-- hold addresses of people who never joined. Rows are never deleted (the history of who invited whom to what).
CREATE TABLE provider_team_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id text NOT NULL REFERENCES experience_providers(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role = 'COHOST'),
  invited_by_host_account_id text NOT NULL REFERENCES host_accounts(id) ON DELETE RESTRICT,
  -- Where the invitation email goes (as entered: NFKC, trimmed) and the same address in lower case.
  -- Kept only while the invitation is open: accepting, revoking, replacing or running out clears both.
  email text CHECK (email IS NULL OR (length(email) BETWEEN 3 AND 254 AND position('@' IN email) > 1)),
  email_key text CHECK (email_key IS NULL OR (length(email_key) BETWEEN 3 AND 254 AND position('@' IN email_key) > 1)),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  -- Minted by the mail job right before the email; NULL until then.
  token_hash bytea UNIQUE CHECK (token_hash IS NULL OR octet_length(token_hash) = 32),
  issued_at timestamptz,
  -- The browser the link was first opened in.
  browser_binding_hash bytea CHECK (browser_binding_hash IS NULL OR octet_length(browser_binding_hash) = 32),
  opened_at timestamptz,
  accepted_at timestamptz,
  accepted_host_account_id text REFERENCES host_accounts(id) ON DELETE RESTRICT,
  revoked_at timestamptz,
  CHECK ((email IS NULL) = (email_key IS NULL)),
  -- An open invitation has its address; a closed one (accepted or revoked) has none.
  CHECK ((accepted_at IS NULL AND revoked_at IS NULL) = (email IS NOT NULL)),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 days'),
  CHECK ((token_hash IS NULL) = (issued_at IS NULL)),
  CHECK (issued_at IS NULL OR (issued_at >= created_at AND issued_at < expires_at)),
  CHECK ((browser_binding_hash IS NULL) = (opened_at IS NULL)),
  CHECK (opened_at IS NULL OR (issued_at IS NOT NULL AND opened_at >= issued_at AND opened_at < expires_at)),
  CHECK ((accepted_at IS NULL) = (accepted_host_account_id IS NULL)),
  CHECK (accepted_at IS NULL OR (opened_at IS NOT NULL AND accepted_at >= opened_at AND accepted_at < expires_at)),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);

-- One open invitation per provider and address (inviting again replaces the earlier one).
CREATE UNIQUE INDEX provider_team_invitations_open_idx
  ON provider_team_invitations (provider_id, email_key) WHERE accepted_at IS NULL AND revoked_at IS NULL;
-- A browser belongs to one open invitation at a time.
CREATE UNIQUE INDEX provider_team_invitations_browser_open_idx
  ON provider_team_invitations (browser_binding_hash) WHERE browser_binding_hash IS NOT NULL AND accepted_at IS NULL AND revoked_at IS NULL;
-- The invitation emails still to send.
CREATE INDEX provider_team_invitations_pending_idx
  ON provider_team_invitations (created_at) WHERE token_hash IS NULL AND accepted_at IS NULL AND revoked_at IS NULL;
-- A provider's open invitations (the member screen), and the ones that ran out (the job closes them).
CREATE INDEX provider_team_invitations_provider_open_idx
  ON provider_team_invitations (provider_id, created_at) WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX provider_team_invitations_expiry_idx
  ON provider_team_invitations (expires_at) WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE FUNCTION reject_provider_team_invitation_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'provider team invitations are never deleted' USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER provider_team_invitations_never_deleted
BEFORE DELETE ON provider_team_invitations
FOR EACH ROW EXECUTE FUNCTION reject_provider_team_invitation_delete();

COMMIT;
