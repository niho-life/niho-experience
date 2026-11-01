BEGIN;

-- 予約者の情報つきの OTA の予約 (#194, owner decision 2026-11-01): what a reservation site says about the guest of an
-- external reservation, shown to the product's OWNER and its operators in /host. This replaces the earlier rule that
-- the external ledger keeps no name or contact; the amount is still never kept. One row per external reservation, filled
-- in only with what that site's reader has (every column is optional), and only while EXPERIENCE_OTA_GUEST_DETAILS_ENABLED
-- is on. The personal columns are blanked by the mail job's erasure a year after the experience (a cancelled one: a year
-- after the cancellation was read), as this site's guests are (#285). Additive only: the current writer neither reads
-- nor writes the new table, and inserts into external_reservations keep working through host_ref's default.

-- The handle a host uses for an external reservation (a push's link, the bookings list). It names no external account
-- or reservation ID, so neither has to reach a browser.
ALTER TABLE external_reservations ADD COLUMN host_ref uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE external_reservations ADD CONSTRAINT external_reservations_host_ref_key UNIQUE (host_ref);

CREATE TABLE external_reservation_guests (
  source_site text NOT NULL,
  source_external_account_id text NOT NULL,
  external_reservation_id text NOT NULL,
  guest_name text CHECK (
    length(guest_name) BETWEEN 1 AND 200 AND guest_name = btrim(guest_name) AND guest_name !~ '[[:cntrl:]]'
  ),
  -- The party by age band when the site gives it: [{"band":"ADULT","count":2}, …], bands unique, counts adding up to
  -- the reservation's seats (the store checks the sum against the observation).
  party_breakdown jsonb CHECK (
    jsonb_typeof(party_breakdown) = 'array' AND jsonb_array_length(party_breakdown) BETWEEN 1 AND 6
    AND octet_length(party_breakdown::text) <= 512
  ),
  guest_email text CHECK (
    length(guest_email) BETWEEN 3 AND 254 AND guest_email ~ '^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+\.[^[:space:][:cntrl:]@]+$'
  ),
  guest_phone text CHECK (length(guest_phone) BETWEEN 1 AND 32 AND guest_phone ~ '^\+?[0-9 ().-]+$'),
  -- A BCP 47 tag as the site gives it (en, ja, en-US, zh-Hant-TW).
  guest_language text CHECK (length(guest_language) BETWEEN 2 AND 35 AND guest_language ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$'),
  -- The site's own booking reference, which a host may see to find the booking on that site.
  booking_reference text CHECK (length(booking_reference) BETWEEN 1 AND 64 AND booking_reference ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'),
  -- What the guest wrote to the site (special requests and the like), never an amount.
  source_notes text CHECK (
    length(source_notes) BETWEEN 1 AND 1000 AND source_notes = btrim(source_notes) AND source_notes !~ '[\x01-\x08\x0b-\x1f\x7f]'
  ),
  pii_erased_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (source_site, source_external_account_id, external_reservation_id),
  FOREIGN KEY (source_site, source_external_account_id, external_reservation_id)
    REFERENCES external_reservations(source_site, source_external_account_id, external_reservation_id) ON DELETE RESTRICT,
  CHECK (
    pii_erased_at IS NULL
    OR (guest_name IS NULL AND party_breakdown IS NULL AND guest_email IS NULL AND guest_phone IS NULL
        AND guest_language IS NULL AND booking_reference IS NULL AND source_notes IS NULL)
  )
);

-- Erased details stay erased: a later read cannot bring them back.
CREATE FUNCTION protect_external_reservation_guests() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_site IS DISTINCT FROM OLD.source_site OR NEW.source_external_account_id IS DISTINCT FROM OLD.source_external_account_id
     OR NEW.external_reservation_id IS DISTINCT FROM OLD.external_reservation_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'an external reservation guest row keeps its reservation' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.pii_erased_at IS NOT NULL AND (
       NEW.pii_erased_at IS DISTINCT FROM OLD.pii_erased_at OR NEW.guest_name IS NOT NULL OR NEW.party_breakdown IS NOT NULL
       OR NEW.guest_email IS NOT NULL OR NEW.guest_phone IS NOT NULL OR NEW.guest_language IS NOT NULL
       OR NEW.booking_reference IS NOT NULL OR NEW.source_notes IS NOT NULL) THEN
    RAISE EXCEPTION 'erased guest data stays erased' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER external_reservation_guests_protect
BEFORE UPDATE ON external_reservation_guests
FOR EACH ROW EXECUTE FUNCTION protect_external_reservation_guests();

-- A push about an OTA booking carries the guest's name until it is sent (the push job removes it then); the mail job's
-- erasure removes it from a row never sent within 48 hours. This finds those rows without reading the whole outbox.
CREATE INDEX outbox_messages_ota_guest_name_idx
  ON outbox_messages (created_at)
  WHERE topic = 'host.notify.ota_booking' AND payload ? 'guestName';

COMMIT;
