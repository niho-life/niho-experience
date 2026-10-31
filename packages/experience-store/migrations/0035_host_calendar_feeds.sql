BEGIN;

-- 設定 › カレンダー's bookings feed (#109): one secret address per provider, issued by its OWNER, that other calendars
-- (Apple, Outlook) read the provider's confirmed bookings made on this site from. The address is
-- HMAC(EXPERIENCE_CALENDAR_FEED_KEY, provider, feed_salt); only its SHA-256 is kept, to find it. Issuing again replaces
-- the row (the old address stops working); stopping it deletes the row; an issuer who is no longer the provider's
-- active OWNER makes it answer nothing. Nothing about the guests here. Additive only (one new table): the current
-- writer neither reads nor writes it, so this may run before the new revision, which reads it only with
-- EXPERIENCE_HOST_CALENDAR_FEED_ENABLED.

CREATE TABLE provider_calendar_feeds (
  provider_id text PRIMARY KEY REFERENCES experience_providers(id) ON DELETE RESTRICT,
  issued_by_niho_user_id text NOT NULL CHECK (length(issued_by_niho_user_id) BETWEEN 1 AND 256),
  feed_salt bytea NOT NULL CHECK (octet_length(feed_salt) = 32),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (provider_id, issued_by_niho_user_id) REFERENCES provider_memberships(provider_id, niho_user_id) ON DELETE RESTRICT
);

COMMIT;
