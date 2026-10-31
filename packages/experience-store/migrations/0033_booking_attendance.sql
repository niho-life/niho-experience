BEGIN;

-- 出欠 (#107, Epic #103): the provider's OWNER marks who came to a session of the guest bookings made on this site
-- (来た / 来なかった), from the session's start, and after its end too so that a mistake can be put right. One row per
-- booking with its latest mark and the host who made it; a confirmed booking without one is 未記録. Nothing about the
-- guest: their name and contact stay in booking_guests (erased a year after the experience), and recorded_by is the
-- host's NIHO user ID. Additive only (one new table): the current writer neither reads nor writes it, so this may run
-- before the new revision, which reads it only with EXPERIENCE_HOST_ATTENDANCE_ENABLED.

CREATE TABLE booking_attendance (
  provider_id text NOT NULL,
  booking_id bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('ATTENDED', 'NO_SHOW')),
  recorded_by text NOT NULL CHECK (length(recorded_by) BETWEEN 1 AND 256),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, booking_id),
  FOREIGN KEY (provider_id, booking_id) REFERENCES bookings(provider_id, id) ON DELETE RESTRICT
);

COMMIT;
