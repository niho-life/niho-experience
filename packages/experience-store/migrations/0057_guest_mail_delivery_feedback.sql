BEGIN;

-- A single-recipient mail reference is stamped onto each guest booking mail before SMTP is called.
-- NIHO's bounce inbox returns only the opaque reference and classified outcome to this store.
ALTER TABLE outbox_messages
  ADD COLUMN mail_delivery_ref text
    CHECK (mail_delivery_ref IS NULL OR mail_delivery_ref ~ '^ex1_[0-9a-f]{32}$');

CREATE UNIQUE INDEX outbox_messages_mail_delivery_ref_uq
  ON outbox_messages (mail_delivery_ref)
  WHERE mail_delivery_ref IS NOT NULL;

-- Hard-bounce suppression belongs to the provider's guest booking record and is cleared with guest PII.
ALTER TABLE booking_guests
  ADD COLUMN mail_suppressed_at timestamptz,
  ADD COLUMN mail_suppression_classification text
    CHECK (mail_suppression_classification IS NULL OR mail_suppression_classification IN ('NO_SUCH_ADDRESS','NO_SUCH_DOMAIN')),
  ADD CONSTRAINT booking_guests_mail_suppression_pair_check CHECK (
    (mail_suppressed_at IS NULL) = (mail_suppression_classification IS NULL)
  ),
  ADD CONSTRAINT booking_guests_mail_suppression_erasure_check CHECK (
    pii_erased_at IS NULL OR mail_suppressed_at IS NULL
  );

-- This ledger contains no guest address, message body, subject, or diagnostic text. Its lifetime and
-- ownership follow the booking guest row; an unverified ARF candidate is recorded without suppression.
CREATE TABLE guest_mail_delivery_feedback (
  external_event_id text PRIMARY KEY CHECK (length(external_event_id) BETWEEN 10 AND 80),
  mail_delivery_ref text NOT NULL CHECK (mail_delivery_ref ~ '^ex1_[0-9a-f]{32}$'),
  provider_id text NOT NULL,
  booking_id bigint NOT NULL,
  report_type text NOT NULL CHECK (report_type IN ('BOUNCE','COMPLAINT')),
  verification text NOT NULL CHECK (verification IN ('CORRELATED_DSN','UNVERIFIED_ARF')),
  classification text NOT NULL CHECK (classification IN (
    'NO_SUCH_ADDRESS','NO_SUCH_DOMAIN','REJECTED_BY_SERVER','MAILBOX_FULL','TEMPORARY_FAILED','SPAM_COMPLAINT','OTHER'
  )),
  reported_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (provider_id, booking_id) REFERENCES booking_guests(provider_id, booking_id) ON DELETE CASCADE,
  UNIQUE (mail_delivery_ref, report_type),
  CHECK (
    (report_type='BOUNCE' AND verification='CORRELATED_DSN' AND classification <> 'SPAM_COMPLAINT')
    OR (report_type='COMPLAINT' AND verification='UNVERIFIED_ARF' AND classification='SPAM_COMPLAINT')
  )
);

CREATE INDEX guest_mail_delivery_feedback_booking_idx
  ON guest_mail_delivery_feedback (provider_id, booking_id, reported_at DESC);

COMMIT;
