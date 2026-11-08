BEGIN;

-- Experience-native provider teams. COHOST is deliberately separate from the legacy EDITOR role:
-- existing memberships are not promoted, and product-scoped OPERATOR grants remain product scoped.
ALTER TABLE provider_memberships DROP CONSTRAINT provider_memberships_role_check;
ALTER TABLE provider_memberships ADD CONSTRAINT provider_memberships_role_check
  CHECK (role IN ('OWNER', 'COHOST', 'EDITOR', 'VIEWER'));

CREATE TABLE provider_team_revisions (
  provider_id text PRIMARY KEY REFERENCES experience_providers(id) ON DELETE RESTRICT,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- A receipt contains no email or member snapshot. It binds the authenticated actor and exact command payload.
CREATE TABLE provider_team_commands (
  provider_id text NOT NULL REFERENCES experience_providers(id) ON DELETE RESTRICT,
  command_id uuid NOT NULL,
  actor_host_account_id text NOT NULL REFERENCES host_accounts(id) ON DELETE RESTRICT,
  operation text NOT NULL CHECK (operation IN ('ADD_COHOST', 'REMOVE_COHOST')),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  result_version bigint NOT NULL CHECK (result_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, command_id)
);

-- Fixed one-hour buckets are sufficient for the UI lookup guard. The queried address is never stored.
CREATE TABLE provider_team_resolve_buckets (
  provider_id text NOT NULL REFERENCES experience_providers(id) ON DELETE RESTRICT,
  owner_host_account_id text NOT NULL REFERENCES host_accounts(id) ON DELETE RESTRICT,
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 12),
  PRIMARY KEY (provider_id, owner_host_account_id, window_started_at)
);

CREATE INDEX provider_team_resolve_buckets_age_idx ON provider_team_resolve_buckets (window_started_at);

COMMIT;
