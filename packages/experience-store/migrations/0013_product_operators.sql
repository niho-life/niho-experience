BEGIN;

CREATE TABLE product_operator_invitations (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL,
  product_id text NOT NULL,
  token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  assignment_label text NOT NULL CHECK (length(assignment_label) BETWEEN 1 AND 100),
  invited_by_niho_user_id text NOT NULL CHECK (length(invited_by_niho_user_id) BETWEEN 1 AND 256),
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'ACCEPTED', 'REVOKED')),
  accepted_niho_user_id text CHECK (accepted_niho_user_id IS NULL OR length(accepted_niho_user_id) BETWEEN 1 AND 256),
  accepted_at timestamptz,
  revoked_at timestamptz,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, provider_id, product_id),
  UNIQUE (id, provider_id, product_id, accepted_niho_user_id),
  FOREIGN KEY (provider_id, product_id)
    REFERENCES experience_products(provider_id, id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days'),
  CHECK ((accepted_niho_user_id IS NULL) = (accepted_at IS NULL)),
  CHECK (
    (state = 'PENDING' AND accepted_niho_user_id IS NULL AND accepted_at IS NULL AND revoked_at IS NULL)
    OR (state = 'ACCEPTED' AND accepted_niho_user_id IS NOT NULL AND accepted_at IS NOT NULL AND revoked_at IS NULL)
    OR (state = 'REVOKED' AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX product_operator_invitations_product_idx
  ON product_operator_invitations (provider_id, product_id, created_at DESC);

CREATE TABLE product_operator_grants (
  provider_id text NOT NULL,
  product_id text NOT NULL,
  niho_user_id text NOT NULL CHECK (length(niho_user_id) BETWEEN 1 AND 256),
  invitation_id uuid NOT NULL,
  assignment_label text NOT NULL CHECK (length(assignment_label) BETWEEN 1 AND 100),
  active boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, product_id, niho_user_id),
  UNIQUE (invitation_id),
  FOREIGN KEY (provider_id, product_id)
    REFERENCES experience_products(provider_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (invitation_id, provider_id, product_id)
    REFERENCES product_operator_invitations(id, provider_id, product_id) ON DELETE RESTRICT,
  FOREIGN KEY (invitation_id, provider_id, product_id, niho_user_id)
    REFERENCES product_operator_invitations(id, provider_id, product_id, accepted_niho_user_id) ON DELETE RESTRICT,
  CHECK ((active AND revoked_at IS NULL) OR (NOT active AND revoked_at IS NOT NULL)),
  CHECK (expires_at IS NULL OR expires_at > granted_at)
);

CREATE INDEX product_operator_grants_active_user_idx
  ON product_operator_grants (niho_user_id, provider_id, product_id)
  WHERE active;

CREATE TABLE product_operator_commands (
  command_id uuid PRIMARY KEY,
  actor_niho_user_id text NOT NULL CHECK (length(actor_niho_user_id) BETWEEN 1 AND 256),
  action text NOT NULL CHECK (action IN ('INVITATION_CREATE', 'INVITATION_REVOKE', 'GRANT_REVOKE')),
  request_fingerprint text NOT NULL CHECK (length(request_fingerprint) BETWEEN 1 AND 128),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE product_operator_audit_events (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL REFERENCES experience_providers(id) ON DELETE RESTRICT,
  product_id text NOT NULL,
  invitation_id uuid,
  grant_niho_user_id text,
  actor_niho_user_id text NOT NULL CHECK (length(actor_niho_user_id) BETWEEN 1 AND 256),
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 80),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (provider_id, product_id)
    REFERENCES experience_products(provider_id, id) ON DELETE RESTRICT,
  CHECK (grant_niho_user_id IS NULL OR length(grant_niho_user_id) BETWEEN 1 AND 256)
);

CREATE INDEX product_operator_audit_product_idx
  ON product_operator_audit_events (provider_id, product_id, created_at DESC);

COMMIT;
