BEGIN;

-- 予約者の予約ページ (#285 slice 6): a guest opens their booking on this site from a link in an email.
-- The link carries a one-time grant; opening it starts a session for that one booking on that device.
-- Neither is an account: the link is a bearer credential for one booking. Only the SHA-256 of a grant
-- token or a session id is kept; the raw values exist only in the email (the URL fragment) and in the
-- guest's HttpOnly cookie. Additive only (new tables, a column with a default and indexes): the current
-- writer neither reads nor writes them, so this migration may run before the new revision.

-- Raising a booking's access_version revokes every grant and session issued before (for support).
ALTER TABLE booking_guests
  ADD COLUMN access_version integer NOT NULL DEFAULT 1 CHECK (access_version >= 1);

-- One-time grants, one per email that carries a link. A grant opens one session and lasts 30 days at
-- most (the store also ends it 30 days after the experience).
CREATE TABLE booking_access_grants (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  provider_id text NOT NULL,
  booking_id bigint NOT NULL,
  access_version integer NOT NULL CHECK (access_version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  FOREIGN KEY (provider_id, booking_id) REFERENCES booking_guests(provider_id, booking_id) ON DELETE CASCADE,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 days'),
  CHECK (used_at IS NULL OR used_at >= created_at)
);

-- Sessions opened from a grant. A session reads its own booking only. It ends after 30 idle days, at
-- absolute_expires_at (30 days after the experience), when the guest signs out on the device
-- (revoked_at) or when the booking's access_version moves past the one it was opened at.
CREATE TABLE booking_sessions (
  session_hash bytea PRIMARY KEY CHECK (octet_length(session_hash) = 32),
  provider_id text NOT NULL,
  booking_id bigint NOT NULL,
  access_version integer NOT NULL CHECK (access_version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY (provider_id, booking_id) REFERENCES booking_guests(provider_id, booking_id) ON DELETE CASCADE,
  CHECK (last_seen_at >= created_at),
  CHECK (idle_expires_at <= absolute_expires_at AND absolute_expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

-- The job deletes what can no longer open or read anything.
CREATE INDEX booking_access_grants_expires_idx ON booking_access_grants (expires_at);
CREATE INDEX booking_sessions_expires_idx ON booking_sessions (absolute_expires_at);

-- "Find your booking": a guest's bookings by address, across providers, and the link emails a booking
-- got in the last hour (its limit). The emails are outbox rows of their own topic, IDs only.
CREATE INDEX booking_guests_email_key_idx
  ON booking_guests (guest_email_key)
  WHERE guest_email_key IS NOT NULL;
CREATE INDEX outbox_messages_booking_link_idx
  ON outbox_messages (provider_id, aggregate_id, created_at)
  WHERE topic = 'booking.access_link';

COMMIT;
