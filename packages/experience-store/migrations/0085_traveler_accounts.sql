BEGIN;

-- 旅行者のアカウント (Epic #591, #597, ADR 0004 §8): a traveler signs in with Google, Apple or LINE (the NIHO account behind it
-- is made on the way) and gets an Experience account and session of their own. These tables are separate from the host
-- accounts (`host_accounts`, `host_sessions`): a traveler account is never a host account, holds no provider role, and its
-- session cookie is another cookie, so a traveler session can never open the host console or /write, and a host session
-- is not a traveler session. Guest bookings and their per-booking sessions are untouched: an account is optional, and
-- nothing here ties a booking, a message or a review to it (that is decided apart, #597 / Epic #591).
--
-- The one personal datum kept is the NIHO user ID (`subject`), which is the traveler's identity at NIHO; no name, address or
-- profile is stored. As with host accounts, only the SHA-256 of a session ID is stored.

CREATE TABLE traveler_accounts (
  id text PRIMARY KEY CHECK (id ~ '^trv_[0-9a-f]{32}$'),
  provider text NOT NULL CHECK (provider = 'NIHO'),
  -- The NIHO user ID. Read by the store only; never shown to a browser or written to a log.
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 256 AND subject !~ '[[:cntrl:]]' AND subject !~ '^(hst|sel|trv)_'),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  -- Raising it ends every session ("sign out everywhere", suspension).
  session_version integer NOT NULL DEFAULT 1 CHECK (session_version >= 1),
  created_at timestamptz NOT NULL,
  last_login_at timestamptz,
  suspended_at timestamptz,
  UNIQUE (provider, subject),
  CHECK (last_login_at IS NULL OR last_login_at >= created_at),
  CHECK ((status = 'SUSPENDED') = (suspended_at IS NOT NULL))
);

-- Sessions: 14 idle days, 30 days at most, signed out (revoked_at) or ended by the account's session_version.
-- `authenticated_at` is when the traveler signed in at NIHO (its `authTime`), never after the session opened.
CREATE TABLE traveler_sessions (
  session_hash bytea PRIMARY KEY CHECK (octet_length(session_hash) = 32),
  session_ref uuid NOT NULL UNIQUE,
  traveler_account_id text NOT NULL REFERENCES traveler_accounts(id) ON DELETE CASCADE,
  session_version integer NOT NULL CHECK (session_version >= 1),
  created_at timestamptz NOT NULL,
  authenticated_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (authenticated_at <= created_at),
  CHECK (last_seen_at >= created_at),
  CHECK (idle_expires_at > created_at AND idle_expires_at <= absolute_expires_at),
  CHECK (absolute_expires_at > created_at AND absolute_expires_at <= created_at + interval '30 days'),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX traveler_sessions_account_idx ON traveler_sessions (traveler_account_id, created_at);
CREATE INDEX traveler_sessions_expires_idx ON traveler_sessions (absolute_expires_at);

COMMIT;
