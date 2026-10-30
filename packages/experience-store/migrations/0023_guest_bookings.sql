BEGIN;

-- 旅行者の予約 (#285 slice 1): the sale terms a product needs before travelers can book it on this
-- site, and the guest's details for a booking made here. Additive only (new tables and an index): the
-- current writer neither reads nor writes them, so this migration may run before the new revision.

-- One row per product sold to travelers. A PUBLISHED product without a row is not offered (fail
-- closed). Child pricing is all or nothing. The store validates booking_questions against NIHO's
-- public question shape (PublicExperienceBookingQuestion) and keeps the SHA-256 of their canonical
-- JSON, the same computation NIHO uses. Bounds follow the agreed public contract v1.2.
CREATE TABLE experience_product_sale_terms (
  provider_id text NOT NULL,
  product_id text NOT NULL,
  child_price_amount bigint CHECK (child_price_amount BETWEEN 0 AND 9999999999),
  child_min_age integer CHECK (child_min_age BETWEEN 0 AND 17),
  child_max_age integer CHECK (child_max_age BETWEEN 0 AND 17),
  child_adult_required boolean,
  minimum_participants integer NOT NULL CHECK (minimum_participants BETWEEN 1 AND 500),
  max_party_size integer NOT NULL CHECK (max_party_size BETWEEN 1 AND 500),
  cancellation_policy text NOT NULL CHECK (cancellation_policy IN ('FREE_UNTIL_24H', 'FREE_UNTIL_48H', 'NONE')),
  booking_questions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(booking_questions) = 'array' AND jsonb_array_length(booking_questions) <= 5
  ),
  booking_questions_fingerprint text NOT NULL CHECK (booking_questions_fingerprint ~ '^[0-9a-f]{64}$'),
  -- 参加の条件の版 (#110): the SHA-256 of the conditions' text. Null while the product has none.
  conditions_version text CHECK (conditions_version ~ '^[0-9a-f]{64}$'),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, product_id),
  FOREIGN KEY (provider_id, product_id) REFERENCES experience_products(provider_id, id) ON DELETE RESTRICT,
  CHECK (max_party_size >= minimum_participants),
  CHECK (
    (child_price_amount IS NULL AND child_min_age IS NULL AND child_max_age IS NULL AND child_adult_required IS NULL)
    OR (child_price_amount IS NOT NULL AND child_min_age IS NOT NULL AND child_max_age IS NOT NULL
        AND child_adult_required IS NOT NULL AND child_min_age <= child_max_age)
  )
);

-- The guest of a booking made on this site (one row per booking). Personal columns (name, email,
-- phone, note, answers, utm) are blanked by eraseGuestData once the occurrence is long over; only then
-- may they be NULL. guest_email_key (lower(guest_email)) only counts a guest's bookings for the
-- limits. request_fingerprint is the SHA-256 of the canonical request, so the same clientRequestKey
-- with other content is refused. checkout_session_ref is the Stripe Checkout Session, set once.
-- No IP addresses are kept. Bounds match NIHO's checkout request and GUEST_PHONE_LIMITS.
CREATE TABLE booking_guests (
  provider_id text NOT NULL,
  booking_id bigint NOT NULL,
  guest_name text CHECK (
    length(guest_name) BETWEEN 1 AND 100 AND guest_name = btrim(guest_name) AND guest_name !~ '[[:cntrl:]]'
  ),
  guest_email text CHECK (
    length(guest_email) BETWEEN 3 AND 254 AND guest_email ~ '^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+\.[^[:space:][:cntrl:]@]+$'
  ),
  guest_email_key text CHECK (guest_email_key = lower(guest_email)),
  guest_phone text CHECK (length(guest_phone) BETWEEN 1 AND 24 AND guest_phone ~ '^\+?[0-9 ().-]+$'),
  guest_language text NOT NULL CHECK (guest_language IN ('EN', 'JA')),
  note text CHECK (length(note) BETWEEN 1 AND 500 AND btrim(note) <> ''),
  answers jsonb CHECK (
    jsonb_typeof(answers) = 'array' AND jsonb_array_length(answers) <= 5 AND octet_length(answers::text) <= 16384
  ),
  adult_count integer NOT NULL CHECK (adult_count BETWEEN 0 AND 500),
  child_count integer NOT NULL CHECK (child_count BETWEEN 0 AND 500),
  terms_consent_version text NOT NULL CHECK (length(terms_consent_version) BETWEEN 1 AND 100),
  conditions_consent_version text CHECK (conditions_consent_version ~ '^[0-9a-f]{64}$'),
  client_request_key text NOT NULL CHECK (length(client_request_key) BETWEEN 8 AND 120),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  -- Only utmSource/utmMedium/utmCampaign/utmContent, each 1-64 of [a-z0-9_-].
  utm jsonb CHECK (
    jsonb_typeof(utm) = 'object'
    AND (utm - ARRAY['utmSource', 'utmMedium', 'utmCampaign', 'utmContent']) = '{}'::jsonb
    AND NOT jsonb_path_exists(utm, '$.* ? (@.type() != "string" || !(@ like_regex "^[a-z0-9_-]{1,64}$"))')
  ),
  checkout_session_ref text CHECK (length(checkout_session_ref) BETWEEN 1 AND 256),
  pii_erased_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, booking_id),
  FOREIGN KEY (provider_id, booking_id) REFERENCES bookings(provider_id, id) ON DELETE RESTRICT,
  CHECK (adult_count + child_count BETWEEN 1 AND 500),
  CHECK (
    pii_erased_at IS NOT NULL
    OR (guest_name IS NOT NULL AND guest_email IS NOT NULL AND guest_email_key IS NOT NULL AND answers IS NOT NULL AND utm IS NOT NULL)
  ),
  CHECK (
    pii_erased_at IS NULL
    OR (guest_name IS NULL AND guest_email IS NULL AND guest_email_key IS NULL AND guest_phone IS NULL
        AND note IS NULL AND answers IS NULL AND utm IS NULL)
  )
);

-- Limits: bookings a guest address started for a provider in the last hour.
CREATE INDEX booking_guests_rate_email_idx
  ON booking_guests (provider_id, guest_email_key, created_at)
  WHERE guest_email_key IS NOT NULL;

-- Limits: a product's active holds.
CREATE INDEX bookings_active_hold_product_idx
  ON bookings (provider_id, product_id, hold_expires_at)
  WHERE status = 'HOLD';

-- What the guest asked for stays as it was. The Checkout Session is set once; personal columns change
-- only by erasure, and erased data stays erased.
CREATE FUNCTION protect_booking_guests() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provider_id IS DISTINCT FROM OLD.provider_id OR NEW.booking_id IS DISTINCT FROM OLD.booking_id
     OR NEW.guest_language IS DISTINCT FROM OLD.guest_language
     OR NEW.adult_count IS DISTINCT FROM OLD.adult_count OR NEW.child_count IS DISTINCT FROM OLD.child_count
     OR NEW.terms_consent_version IS DISTINCT FROM OLD.terms_consent_version
     OR NEW.conditions_consent_version IS DISTINCT FROM OLD.conditions_consent_version
     OR NEW.client_request_key IS DISTINCT FROM OLD.client_request_key
     OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'booking guest requests are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.checkout_session_ref IS NOT NULL AND NEW.checkout_session_ref IS DISTINCT FROM OLD.checkout_session_ref THEN
    RAISE EXCEPTION 'a booking checkout session is set once' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.pii_erased_at IS NOT NULL AND NEW.pii_erased_at IS DISTINCT FROM OLD.pii_erased_at THEN
    RAISE EXCEPTION 'erased guest data stays erased' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.pii_erased_at IS NULL AND (
       NEW.guest_name IS DISTINCT FROM OLD.guest_name OR NEW.guest_email IS DISTINCT FROM OLD.guest_email
       OR NEW.guest_email_key IS DISTINCT FROM OLD.guest_email_key OR NEW.guest_phone IS DISTINCT FROM OLD.guest_phone
       OR NEW.note IS DISTINCT FROM OLD.note OR NEW.answers IS DISTINCT FROM OLD.answers OR NEW.utm IS DISTINCT FROM OLD.utm) THEN
    RAISE EXCEPTION 'guest details change only by erasure' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER booking_guests_protect
BEFORE UPDATE ON booking_guests
FOR EACH ROW EXECUTE FUNCTION protect_booking_guests();

COMMIT;
