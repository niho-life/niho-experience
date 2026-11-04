BEGIN;

-- Shared across Experience replicas; only a keyed digest is stored, never a client address.
CREATE TABLE booking_checkout_ip_buckets (
  ip_digest text NOT NULL CHECK (ip_digest ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  PRIMARY KEY (ip_digest, window_started_at),
  CHECK (mod(extract(epoch FROM window_started_at)::bigint, 600) = 0)
);

CREATE INDEX booking_checkout_ip_buckets_expiry
  ON booking_checkout_ip_buckets(window_started_at);

COMMIT;
