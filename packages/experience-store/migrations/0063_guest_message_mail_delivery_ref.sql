BEGIN;

-- A booking thread's host reply or NIHO support contact is mailed to the booking's guest record. The same
-- single-recipient opaque reference as outbox_messages (0057) is stamped on its first claim and kept across
-- retries, so NIHO's bounce inbox can return the outcome to guest_mail_delivery_feedback. A reply to a
-- question before booking has no booking guest record to suppress and keeps this NULL.
ALTER TABLE guest_question_messages
  ADD COLUMN mail_delivery_ref text
    CHECK (mail_delivery_ref IS NULL OR mail_delivery_ref ~ '^ex1_[0-9a-f]{32}$');

CREATE UNIQUE INDEX guest_question_messages_mail_delivery_ref_uq
  ON guest_question_messages (mail_delivery_ref)
  WHERE mail_delivery_ref IS NOT NULL;

COMMIT;
