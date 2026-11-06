BEGIN;

-- ホストのアカウント (ADR 0003, owner policy 2026-11-07): Experience keeps its own host accounts. A host signs in with a
-- single-use link sent to their email address (no password), and provider roles (provider_memberships) bind to the
-- host account. NIHO accounts are not needed. Until the actor columns are renamed, `*_niho_user_id` columns (among them
-- provider_memberships.niho_user_id) hold the host account ID, whose `hst_` prefix never matches a NIHO user ID.
--
-- Only the SHA-256 of a link token or a session ID is stored; the raw values exist only in the email (the URL fragment)
-- and in the host's HttpOnly cookie. A login request is its own mail queue: the request writes IDs and hashes only, and
-- the mail job mints the token later (token_hash stays NULL until then), so the raw token is never stored. No row
-- holds an IP address. Additive only (new tables and indexes): the current writer neither reads nor writes them.

-- One row per person. Admin/ops register the first OWNER of a provider by email. Raising session_version ends every
-- session and every unused link issued so far ("sign out everywhere", suspension).
CREATE TABLE host_accounts (
  id text PRIMARY KEY CHECK (id ~ '^hst_[0-9a-f]{32}$'),
  -- The address as entered (NFKC, trimmed): where the link email goes.
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 254 AND position('@' IN email) > 1),
  -- The same address in lower case: one account per address.
  email_key text NOT NULL UNIQUE CHECK (length(email_key) BETWEEN 3 AND 254 AND position('@' IN email_key) > 1),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  session_version integer NOT NULL DEFAULT 1 CHECK (session_version >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  -- The first sign-in through a link proved the address.
  email_verified_at timestamptz,
  suspended_at timestamptz,
  CHECK (updated_at >= created_at),
  CHECK ((status = 'SUSPENDED') = (suspended_at IS NOT NULL)),
  CHECK (email_verified_at IS NULL OR email_verified_at >= created_at)
);

-- One row per "email me a sign-in link". It is the link email's queue entry as well: the mail job picks the rows whose
-- token is not minted yet, mints it once and sends it. A link works for 15 minutes, once, in the browser that asked
-- for it (the SHA-256 of a random value in that browser's HttpOnly cookie), while the account's session_version is the
-- one it was requested at. Rows stay an hour for the hourly limit, then the job deletes them.
CREATE TABLE host_login_requests (
  id uuid PRIMARY KEY,
  host_account_id text NOT NULL REFERENCES host_accounts(id) ON DELETE CASCADE,
  session_version integer NOT NULL CHECK (session_version >= 1),
  browser_binding_hash bytea NOT NULL CHECK (octet_length(browser_binding_hash) = 32),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  token_hash bytea UNIQUE CHECK (token_hash IS NULL OR octet_length(token_hash) = 32),
  issued_at timestamptz,
  consumed_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes'),
  CHECK ((token_hash IS NULL) = (issued_at IS NULL)),
  CHECK (issued_at IS NULL OR (issued_at >= created_at AND issued_at < expires_at)),
  CHECK (consumed_at IS NULL OR (issued_at IS NOT NULL AND consumed_at >= issued_at AND consumed_at < expires_at))
);

-- Sessions opened from a link. A session ends after 14 idle days, 30 days after it opened (absolute), when the host
-- signs it out (revoked_at), or when the account's session_version moves past the one it was opened at.
-- session_ref is not a secret: it names the session to push subscriptions, audit records and "sign out that device",
-- and never opens it. authenticated_at is when the host last proved the address (the web layer asks for a recent one
-- before sensitive changes).
CREATE TABLE host_sessions (
  session_hash bytea PRIMARY KEY CHECK (octet_length(session_hash) = 32),
  session_ref uuid NOT NULL UNIQUE,
  host_account_id text NOT NULL REFERENCES host_accounts(id) ON DELETE CASCADE,
  session_version integer NOT NULL CHECK (session_version >= 1),
  created_at timestamptz NOT NULL,
  authenticated_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (authenticated_at >= created_at),
  CHECK (last_seen_at >= created_at),
  CHECK (idle_expires_at > created_at AND idle_expires_at <= absolute_expires_at),
  CHECK (absolute_expires_at > created_at AND absolute_expires_at <= created_at + interval '30 days'),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

-- The hourly limit and the 30-second spacing per account; the job deletes requests by age.
CREATE INDEX host_login_requests_account_idx ON host_login_requests (host_account_id, created_at);
CREATE INDEX host_login_requests_created_idx ON host_login_requests (created_at);
-- The link emails still to send.
CREATE INDEX host_login_requests_pending_idx ON host_login_requests (created_at) WHERE token_hash IS NULL;
-- An account's sessions (sign out everywhere, a list of devices); the job deletes ended sessions.
CREATE INDEX host_sessions_account_idx ON host_sessions (host_account_id, created_at);
CREATE INDEX host_sessions_expires_idx ON host_sessions (absolute_expires_at);

COMMIT;
