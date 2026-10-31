BEGIN;

-- 予約ごとのメッセージ (#285 slice 6b, owner decisions 2026-10-27 and 2026-10-31): a guest who booked on this site
-- writes to the host on their booking page, and the host answers in メッセージ. One thread per booking, in the
-- questions' tables (0022): a booking's thread names its booking and keeps no name, address, topic or request key of
-- its own. The guest's name and address are read from booking_guests, so erasing the booking's guest data
-- (eraseGuestData) deletes the thread and its messages with it. guest_language is copied from the booking (not
-- personal): the translation step reads it. Additive: the current writer only writes question threads, which keep
-- every column they had, and the widened CHECKs accept every row it writes, so this may run before the new revision.

ALTER TABLE guest_question_threads
  ADD COLUMN booking_id bigint,
  ALTER COLUMN topic DROP NOT NULL,
  ALTER COLUMN guest_name DROP NOT NULL,
  ALTER COLUMN guest_email DROP NOT NULL,
  ALTER COLUMN guest_email_key DROP NOT NULL,
  ALTER COLUMN client_request_key DROP NOT NULL;

ALTER TABLE guest_question_threads
  -- Only a booking made on this site (it has a guest record); its thread goes with it.
  ADD CONSTRAINT guest_question_threads_booking_fkey
    FOREIGN KEY (provider_id, booking_id) REFERENCES booking_guests(provider_id, booking_id) ON DELETE CASCADE,
  -- One thread per booking. Question threads (booking_id NULL) are not limited by it.
  ADD CONSTRAINT guest_question_threads_provider_id_booking_id_key UNIQUE (provider_id, booking_id),
  -- A question keeps who asked and what about; a booking's thread keeps none of it.
  ADD CONSTRAINT guest_question_threads_kind_check CHECK (
    (booking_id IS NULL AND topic IS NOT NULL AND guest_name IS NOT NULL AND guest_email IS NOT NULL
      AND guest_email_key IS NOT NULL AND client_request_key IS NOT NULL)
    OR (booking_id IS NOT NULL AND topic IS NULL AND guest_name IS NULL AND guest_email IS NULL
      AND guest_email_key IS NULL AND client_request_key IS NULL)
  );

-- BOOKING_PAGE: what a guest wrote on their booking page. Like an answer from the reply page, it carries the page's
-- idempotency key (the same key in the thread is the same message).
ALTER TABLE guest_question_messages DROP CONSTRAINT guest_question_messages_source_check;
ALTER TABLE guest_question_messages
  ADD CONSTRAINT guest_question_messages_source_check CHECK (source IN ('SITE_FORM', 'REPLY_PAGE', 'BOOKING_PAGE', 'HOST_CONSOLE'));

ALTER TABLE guest_question_messages DROP CONSTRAINT guest_question_messages_check1;
ALTER TABLE guest_question_messages
  ADD CONSTRAINT guest_question_messages_author_source_check CHECK (
    (author = 'GUEST' AND source IN ('SITE_FORM', 'REPLY_PAGE', 'BOOKING_PAGE')) OR (author = 'HOST' AND source = 'HOST_CONSOLE')
  );

ALTER TABLE guest_question_messages DROP CONSTRAINT guest_question_messages_check4;
ALTER TABLE guest_question_messages
  ADD CONSTRAINT guest_question_messages_request_key_check CHECK (
    (source IN ('REPLY_PAGE', 'BOOKING_PAGE')) = (client_request_key IS NOT NULL)
  );

COMMIT;
