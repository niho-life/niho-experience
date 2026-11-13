BEGIN;

-- 人物ページから本人へのメッセージ (#589, owner decision 2026-11-13): a person listed on 街の人 (0077) can be written to
-- directly, like a host on Airbnb. The message is a thread of the person's provider in the same tables as 予約前の質問
-- (0022): the OWNER reads and answers it in メッセージ, the mail job sends the answer with a reply link, the guest answers
-- on the reply page. It is about no experience, so product_id is optional; a question keeps its experience, a person's
-- thread has none, and neither keeps a booking. Additive: every row the current writer makes still passes, and the new rows
-- (no product) are only made by the revision that also reads them.
ALTER TABLE guest_question_threads ALTER COLUMN product_id DROP NOT NULL;

ALTER TABLE guest_question_threads DROP CONSTRAINT guest_question_threads_kind_check;
ALTER TABLE guest_question_threads
  ADD CONSTRAINT guest_question_threads_kind_check CHECK (
    -- A question about an experience, before booking.
    (booking_id IS NULL AND product_id IS NOT NULL AND topic IS NOT NULL AND guest_name IS NOT NULL AND guest_email IS NOT NULL
      AND guest_email_key IS NOT NULL AND client_request_key IS NOT NULL)
    -- A message to a person from their page: who wrote it, but no experience and no topic.
    OR (booking_id IS NULL AND product_id IS NULL AND topic IS NULL AND guest_name IS NOT NULL AND guest_email IS NOT NULL
      AND guest_email_key IS NOT NULL AND client_request_key IS NOT NULL)
    -- A booking's thread: its experience, and who wrote it is read from the booking.
    OR (booking_id IS NOT NULL AND product_id IS NOT NULL AND topic IS NULL AND guest_name IS NULL AND guest_email IS NULL
      AND guest_email_key IS NULL AND client_request_key IS NULL)
  );

-- The same message sent again (a retry) is one thread. (A NULL product_id never collides in the question's own unique key.)
CREATE UNIQUE INDEX guest_question_threads_person_request_key
  ON guest_question_threads (provider_id, client_request_key)
  WHERE product_id IS NULL AND booking_id IS NULL;

-- Rate limits: a person's new threads per guest address and in all, in the last hour.
CREATE INDEX guest_question_threads_person_rate_idx
  ON guest_question_threads (provider_id, guest_email_key, created_at)
  WHERE product_id IS NULL AND booking_id IS NULL;

COMMIT;
