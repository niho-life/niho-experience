BEGIN;

-- Web Push subscriptions of the host app (#177 P2). One row per browser push endpoint: the device
-- belongs to whoever subscribed on it last. The endpoint and keys are capability secrets for that
-- device; they are never logged. Rows go with the NIHO connection (logout, revocation) and when the
-- push service answers 404/410.
CREATE TABLE host_push_subscriptions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  niho_user_id text NOT NULL CHECK (length(niho_user_id) BETWEEN 1 AND 256),
  connection_id text NOT NULL CHECK (length(connection_id) BETWEEN 1 AND 256),
  endpoint text NOT NULL UNIQUE CHECK (endpoint LIKE 'https://%' AND length(endpoint) <= 2048),
  -- base64url without padding: a 65-octet P-256 point and a 16-octet secret.
  p256dh text NOT NULL CHECK (p256dh ~ '^[A-Za-z0-9_-]{87}$'),
  auth text NOT NULL CHECK (auth ~ '^[A-Za-z0-9_-]{22}$'),
  device_label text NOT NULL CHECK (device_label IN ('iphone', 'ipad', 'android', 'mac', 'windows', 'other')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_success_at timestamptz,
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0)
);

CREATE INDEX host_push_subscriptions_user_idx ON host_push_subscriptions (niho_user_id);
CREATE INDEX host_push_subscriptions_connection_idx ON host_push_subscriptions (connection_id);

COMMIT;
