BEGIN;

-- 予約者のレビュー (#104 traveler, #108 host; owner decisions 2026-10-22 / 2026-10-31): reviews live in the
-- experience DB. Only the guest of a booking made here writes one, through a one-time link. One review per
-- booking. A review is shown as soon as it is written: NIHO does not check it first, and a host's report does
-- not hide it. When operations must take one down, they set hidden_at in the database (there is no screen for
-- it). The name shown is what the guest typed when writing (the booking's guest details are erased later and are
-- never read for it). No email, phone or IP address is kept. Additive only (new tables): no current code reads
-- or writes them.
CREATE TABLE guest_reviews (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL,
  product_id text NOT NULL,
  booking_id bigint NOT NULL,
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body text NOT NULL CHECK (btrim(body) <> '' AND length(body) <= 2000),
  -- The Japanese translation for the host, filled once by a later slice.
  body_ja text CHECK (body_ja IS NULL OR (btrim(body_ja) <> '' AND length(body_ja) <= 4000)),
  language text NOT NULL CHECK (language IN ('EN', 'JA')),
  -- よかった点: GUEST_REVIEW_TAGS identifiers; the store removes duplicates and keeps their order.
  tags text[] NOT NULL DEFAULT '{}' CHECK (
    cardinality(tags) <= 5
    AND tags <@ ARRAY['CALM_ATMOSPHERE', 'GOOD_FOR_BEGINNERS', 'EASY_TO_FIND', 'GREAT_HOST', 'GOOD_VALUE']::text[]
  ),
  display_name text NOT NULL CHECK (
    length(display_name) BETWEEN 1 AND 60 AND display_name = btrim(display_name)
    AND display_name !~ '[[:cntrl:]]' AND position('@' IN display_name) = 0
  ),
  origin_label text CHECK (
    origin_label IS NULL
    OR (length(origin_label) BETWEEN 1 AND 60 AND origin_label = btrim(origin_label) AND origin_label !~ '[[:cntrl:]]')
  ),
  -- あなただけへのメモ: for the host only, never published.
  note_to_host text CHECK (note_to_host IS NULL OR (btrim(note_to_host) <> '' AND length(note_to_host) <= 500)),
  -- Also when the review was published.
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Null while shown. Set by operations in the database only; the runtime never sets it.
  hidden_at timestamptz,
  -- 返信: the host's one public reply, corrected but never removed. reply_body is the English the page shows;
  -- reply_body_ja the Japanese the host wrote, or null when they wrote the English directly. reply_revision
  -- counts the saves (0: no reply); reply_command_id is the last save's idempotency key.
  reply_body text CHECK (reply_body IS NULL OR (btrim(reply_body) <> '' AND length(reply_body) <= 2000)),
  reply_body_ja text CHECK (reply_body_ja IS NULL OR length(reply_body_ja) <= 2000),
  reply_author_niho_user_id text CHECK (reply_author_niho_user_id IS NULL OR length(reply_author_niho_user_id) BETWEEN 1 AND 256),
  reply_command_id uuid,
  reply_revision integer NOT NULL DEFAULT 0 CHECK (reply_revision >= 0),
  replied_at timestamptz,
  reply_edited_at timestamptz,
  -- 報告: the host's one report to NIHO. It does not hide the review.
  report_reason text CHECK (report_reason IN ('PERSONAL', 'UNTRUE', 'INAPPROPRIATE', 'OTHER')),
  report_note text CHECK (report_note IS NULL OR (btrim(report_note) <> '' AND length(report_note) <= 500)),
  report_command_id uuid,
  reported_by_niho_user_id text CHECK (reported_by_niho_user_id IS NULL OR length(reported_by_niho_user_id) BETWEEN 1 AND 256),
  reported_at timestamptz,
  UNIQUE (provider_id, id),
  -- One review per booking.
  UNIQUE (provider_id, booking_id),
  FOREIGN KEY (provider_id, product_id) REFERENCES experience_products(provider_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id, booking_id) REFERENCES bookings(provider_id, id) ON DELETE RESTRICT,
  CHECK (
    (reply_body IS NULL) = (reply_revision = 0)
    AND (reply_body IS NULL) = (replied_at IS NULL)
    AND (reply_body IS NULL) = (reply_author_niho_user_id IS NULL)
    AND (reply_body IS NULL) = (reply_command_id IS NULL)
  ),
  CHECK (reply_body_ja IS NULL OR reply_body IS NOT NULL),
  CHECK ((reply_edited_at IS NOT NULL) = (reply_revision >= 2)),
  CHECK (
    (report_reason IS NULL) = (report_command_id IS NULL)
    AND (report_reason IS NULL) = (reported_by_niho_user_id IS NULL)
    AND (report_reason IS NULL) = (reported_at IS NULL)
  ),
  CHECK (report_note IS NULL OR report_reason IS NOT NULL)
);

-- The experience page: its shown reviews, the latest first.
CREATE INDEX guest_reviews_public_idx
  ON guest_reviews (provider_id, product_id, submitted_at DESC, id DESC)
  WHERE hidden_at IS NULL;

-- レビュー's list: the provider's reviews, the latest first (keyset on submitted_at, id).
CREATE INDEX guest_reviews_host_list_idx
  ON guest_reviews (provider_id, submitted_at DESC, id DESC);

-- What the guest wrote stays as it was. The translation and the report are set once; the first reply keeps its
-- date and author, and a reply is never removed.
CREATE FUNCTION protect_guest_reviews() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
     OR NEW.product_id IS DISTINCT FROM OLD.product_id OR NEW.booking_id IS DISTINCT FROM OLD.booking_id
     OR NEW.rating IS DISTINCT FROM OLD.rating OR NEW.body IS DISTINCT FROM OLD.body
     OR NEW.tags IS DISTINCT FROM OLD.tags OR NEW.language IS DISTINCT FROM OLD.language
     OR NEW.display_name IS DISTINCT FROM OLD.display_name OR NEW.origin_label IS DISTINCT FROM OLD.origin_label
     OR NEW.note_to_host IS DISTINCT FROM OLD.note_to_host OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
    RAISE EXCEPTION 'what a guest wrote in a review is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.body_ja IS NOT NULL AND NEW.body_ja IS DISTINCT FROM OLD.body_ja THEN
    RAISE EXCEPTION 'a review translation is set once' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.report_reason IS NOT NULL AND (
       NEW.report_reason IS DISTINCT FROM OLD.report_reason OR NEW.report_note IS DISTINCT FROM OLD.report_note
       OR NEW.report_command_id IS DISTINCT FROM OLD.report_command_id
       OR NEW.reported_by_niho_user_id IS DISTINCT FROM OLD.reported_by_niho_user_id
       OR NEW.reported_at IS DISTINCT FROM OLD.reported_at) THEN
    RAISE EXCEPTION 'a review is reported once' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.replied_at IS NOT NULL AND (
       NEW.replied_at IS DISTINCT FROM OLD.replied_at
       OR NEW.reply_author_niho_user_id IS DISTINCT FROM OLD.reply_author_niho_user_id) THEN
    RAISE EXCEPTION 'the first reply keeps its date and author' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.reply_revision < OLD.reply_revision THEN
    RAISE EXCEPTION 'a reply revision only grows' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guest_reviews_protect
BEFORE UPDATE ON guest_reviews
FOR EACH ROW EXECUTE FUNCTION protect_guest_reviews();

-- One-time links to write a review, for the thank-you email after the experience (a later slice). Only the
-- SHA-256 of the token is kept; the token itself exists only in the email. A link takes one review; the same
-- review sent again (the same client_request_key) is not a second one.
CREATE TABLE guest_review_invitations (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  provider_id text NOT NULL,
  booking_id bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_client_request_key text CHECK (used_client_request_key IS NULL OR length(used_client_request_key) BETWEEN 8 AND 120),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (provider_id, booking_id) REFERENCES bookings(provider_id, id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '60 days'),
  CHECK ((used_at IS NULL) = (used_client_request_key IS NULL))
);

CREATE INDEX guest_review_invitations_booking_idx
  ON guest_review_invitations (provider_id, booking_id);

COMMIT;
