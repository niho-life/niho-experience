BEGIN;

-- Admin のログイン (ADR 0003 decision 4, slice 4): with EXPERIENCE_ADMIN_GOOGLE_LOGIN_ENABLED, /admin signs staff in with
-- Google (a niho.life Workspace account) and Experience's own allowlist decides who is an admin; NIHO's Admin session is
-- not used. These are the sessions opened after that sign-in. Nothing from Google (no token) is kept.
--
-- Only the SHA-256 of a session ID is stored; the raw value exists only in the admin's HttpOnly cookie. session_ref is
-- not a secret and never opens a session. admin_actor_id is what the `*_niho_user_id` columns record for this admin
-- until they are renamed: `adm_` + 32 hex derived from the Google account's stable subject (never the address), so it
-- matches neither a NIHO user ID nor a host account ID (`hst_`). The address is kept so the web layer can check it
-- against the allowlist on every request. Additive only (a new table and indexes): the current writer neither reads
-- nor writes it.
--
-- A session ends after 2 idle hours, 12 hours after it opened (absolute), or when signed out (revoked_at). The mail
-- job deletes ended sessions.
CREATE TABLE admin_sessions (
  session_hash bytea PRIMARY KEY CHECK (octet_length(session_hash) = 32),
  session_ref uuid NOT NULL UNIQUE,
  admin_actor_id text NOT NULL CHECK (admin_actor_id ~ '^adm_[0-9a-f]{32}$'),
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 254 AND email = lower(email) AND position('@' IN email) > 1),
  created_at timestamptz NOT NULL,
  authenticated_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (authenticated_at >= created_at),
  CHECK (last_seen_at >= created_at),
  CHECK (idle_expires_at > created_at AND idle_expires_at <= absolute_expires_at),
  CHECK (absolute_expires_at > created_at AND absolute_expires_at <= created_at + interval '12 hours'),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

-- An admin's sessions (sign out everywhere); the job deletes ended sessions.
CREATE INDEX admin_sessions_actor_idx ON admin_sessions (admin_actor_id, created_at);
CREATE INDEX admin_sessions_expires_idx ON admin_sessions (absolute_expires_at);

COMMIT;
