BEGIN;

-- 出欠 of OTA bookings (#194 PR B, owner decision 2026-11-01): この回 lists the guests of bookings made on a reservation
-- site next to this site's, and the product's OWNER and its operators mark them 来た / 来なかった from the session's start,
-- as this site's bookings are (0033). One row per external reservation with its latest mark and the host who made it; a
-- reservation without one is 未記録. Nothing about the guest (their details stay in external_reservation_guests, erased a
-- year after the experience). Additive only (one new table): the current writer neither reads nor writes it, so this may
-- run before the new revision, which reads it only with EXPERIENCE_HOST_ATTENDANCE_ENABLED and
-- EXPERIENCE_OTA_GUEST_DETAILS_ENABLED.

CREATE TABLE external_reservation_attendance (
  host_ref uuid PRIMARY KEY REFERENCES external_reservations(host_ref) ON DELETE RESTRICT,
  provider_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('ATTENDED', 'NO_SHOW')),
  recorded_by text NOT NULL CHECK (length(recorded_by) BETWEEN 1 AND 256),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

COMMIT;
