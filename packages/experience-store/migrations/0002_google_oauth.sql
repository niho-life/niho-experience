BEGIN;

-- Ciphertext is encrypted with a runtime Secret Manager key, never with a value from Git.
-- The refresh token is the only OAuth credential persisted. Access tokens are short lived.
CREATE TABLE provider_google_connections (
  provider_id text PRIMARY KEY REFERENCES experience_providers(id) ON DELETE RESTRICT,
  connected_by_niho_user_id text NOT NULL,
  encrypted_refresh_token text NOT NULL CHECK (length(encrypted_refresh_token) BETWEEN 40 AND 8192),
  granted_scopes text[] NOT NULL,
  busy_calendar_id text NOT NULL CHECK (length(busy_calendar_id) BETWEEN 1 AND 512),
  booking_calendar_id text NOT NULL CHECK (length(booking_calendar_id) BETWEEN 1 AND 512),
  connected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (provider_id, connected_by_niho_user_id)
    REFERENCES provider_memberships(provider_id, niho_user_id) ON DELETE RESTRICT
);

COMMIT;
