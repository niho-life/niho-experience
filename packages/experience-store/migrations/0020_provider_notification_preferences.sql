BEGIN;

-- 設定 › 通知 (#109). The provider's choice for the three notifications a host may stop; the other
-- four (new booking, approval deadline, cancellation, listing review) always come and have no row.
-- A missing row means on, so existing providers need no backfill. Only the OWNER changes these
-- rows; senders read them before a push or an email. No addresses, names or message text here.
CREATE TABLE provider_notification_preferences (
  provider_id text NOT NULL REFERENCES experience_providers(id) ON DELETE RESTRICT,
  notification_key text NOT NULL CHECK (notification_key IN ('GUEST_MESSAGE', 'DAY_BEFORE_SUMMARY', 'NEW_REVIEW')),
  enabled boolean NOT NULL,
  updated_by_niho_user_id text NOT NULL CHECK (length(updated_by_niho_user_id) BETWEEN 1 AND 256),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, notification_key)
);

COMMIT;
