BEGIN;

-- ホストへのメールの宛先 (#194, owner decision 2026-11-01): where this site emails a host (a provider's OWNER, a product's
-- operator). By default the NIHO account's verified address, copied here when the host signs in to /host; the host may
-- set another address in 設定 › 通知, which takes effect only once a link sent to it is opened. One row per NIHO user,
-- whatever their providers: the address is the person's, not the provider's. The mail job deletes the row once the user
-- has no active membership and no active product-operator grant left. Additive only: no current writer reads it.
CREATE TABLE host_notification_addresses (
  niho_user_id text PRIMARY KEY CHECK (length(niho_user_id) BETWEEN 1 AND 256),
  -- The NIHO account's address as the last sign-in gave it, only when NIHO (Firebase) marked it verified.
  login_email text CHECK (
    length(login_email) BETWEEN 3 AND 254 AND login_email ~ '^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+\.[^[:space:][:cntrl:]@]+$'
  ),
  login_email_at timestamptz,
  -- The address the host chose in 設定 › 通知, once its confirmation link was opened.
  override_email text CHECK (
    length(override_email) BETWEEN 3 AND 254 AND override_email ~ '^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+\.[^[:space:][:cntrl:]@]+$'
  ),
  override_confirmed_at timestamptz,
  -- A sign-in for a product-operator invitation copies the address before the grant exists (it is accepted right after);
  -- until this time the row stays even without access.
  access_grace_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((login_email IS NULL) = (login_email_at IS NULL)),
  CHECK ((override_email IS NULL) = (override_confirmed_at IS NULL))
);

-- A request to send this site's emails to another address. The mail job sends the link: it makes the one-time token right
-- before the email goes out and keeps only its SHA-256 here (the raw token is in the link's fragment only). The request
-- is good for an hour and once; a newer request, 「ログインのメールに戻す」 or the confirmation cancels the others.
CREATE TABLE host_notification_address_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  niho_user_id text NOT NULL CHECK (length(niho_user_id) BETWEEN 1 AND 256),
  email text NOT NULL CHECK (
    length(email) BETWEEN 3 AND 254 AND email ~ '^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+\.[^[:space:][:cntrl:]@]+$'
  ),
  token_hash bytea UNIQUE CHECK (octet_length(token_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  used_at timestamptz,
  cancelled_at timestamptz,
  CHECK (used_at IS NULL OR cancelled_at IS NULL)
);

CREATE INDEX host_notification_address_confirmations_user_idx
  ON host_notification_address_confirmations (niho_user_id, created_at);

COMMIT;
