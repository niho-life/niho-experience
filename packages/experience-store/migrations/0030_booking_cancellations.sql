BEGIN;

-- 取消と返金 (#285 slice 7, docs/guest-booking.md「取消と返金（第7段）」): a guest, the provider's OWNER or NIHO
-- support cancels a guest booking made on this site, and the payment goes back through Stripe on the seller's
-- account (Direct charge). Every cancellation or support action is one command (a UUID) whose first result
-- the same command gets again. A refund is its own row: REQUESTED before Stripe answers, PENDING once Stripe
-- accepted it, then SUCCEEDED or FAILED from Stripe's answer or its webhook. A guest who is past free
-- cancellation asks support instead (a cancellation request); the booking stays confirmed until support acts.
-- Additive only (nullable columns, new tables and indexes, one CHECK widened): the current writer neither reads
-- nor writes them and still records only outcomes the widened CHECK allows, so this may run before the new revision.

-- Who cancelled and why. cancellation_note is the host's or support's own words, never shown to the guest.
ALTER TABLE bookings
  ADD COLUMN cancelled_by text CHECK (cancelled_by IN ('GUEST', 'HOST', 'SUPPORT')),
  ADD COLUMN cancellation_reason text CHECK (cancellation_reason ~ '^[A-Z][A-Z_]{0,39}$'),
  ADD COLUMN cancellation_note text CHECK (length(cancellation_note) BETWEEN 1 AND 1000);

-- Refund events are recorded like payment events, with three more outcomes.
ALTER TABLE stripe_webhook_events DROP CONSTRAINT stripe_webhook_events_outcome_check;
ALTER TABLE stripe_webhook_events
  ADD CONSTRAINT stripe_webhook_events_outcome_check CHECK (
    outcome IN ('CONFIRMED', 'PAYMENT_REVIEW', 'DUPLICATE', 'EXPIRED', 'IGNORED', 'REFUND_PENDING', 'REFUNDED', 'REFUND_FAILED')
  );

-- One row per command: who sent it (a guest's booking page has no account, so no actor_ref), what for, and
-- what it did. Another command with the same ID and different input is refused.
CREATE TABLE booking_cancellation_commands (
  command_id uuid PRIMARY KEY,
  provider_id text NOT NULL REFERENCES experience_providers(id) ON DELETE RESTRICT,
  actor_kind text NOT NULL CHECK (actor_kind IN ('GUEST', 'HOST', 'SUPPORT')),
  actor_ref text CHECK (actor_ref IS NULL OR length(actor_ref) BETWEEN 1 AND 256),
  action text NOT NULL CHECK (action ~ '^[A-Z][A-Z_]{0,39}$'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((actor_kind = 'GUEST') = (actor_ref IS NULL))
);

-- The refunds of a booking. Stripe's idempotency key is the row's id, so sending a row again never makes a
-- second refund. A full refund is the whole amount paid; a partial one is an amount support entered. NIHO's fee
-- goes back with both, in proportion to the refund (refund_application_fee; owner decision 2026-10-31). A booking has at most one
-- full refund that has not failed. A failed refund support tried again or settled by hand is closed.
CREATE TABLE booking_refunds (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL,
  booking_id bigint NOT NULL,
  command_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('FULL', 'PARTIAL')),
  amount bigint NOT NULL CHECK (amount > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  refund_application_fee boolean NOT NULL,
  requested_by text NOT NULL CHECK (requested_by IN ('GUEST', 'HOST', 'SUPPORT')),
  stripe_payment_ref text NOT NULL CHECK (length(stripe_payment_ref) BETWEEN 1 AND 256),
  status text NOT NULL CHECK (status IN ('REQUESTED', 'PENDING', 'SUCCEEDED', 'FAILED')),
  stripe_refund_ref text CHECK (length(stripe_refund_ref) BETWEEN 1 AND 256),
  failure_code text CHECK (failure_code ~ '^[a-z0-9_]{1,80}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  submitted_at timestamptz,
  settled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at timestamptz,
  close_note text CHECK (length(close_note) BETWEEN 1 AND 1000),
  superseded_by uuid REFERENCES booking_refunds(id) ON DELETE RESTRICT,
  UNIQUE (command_id, booking_id),
  FOREIGN KEY (provider_id, booking_id) REFERENCES bookings(provider_id, id) ON DELETE RESTRICT,
  CHECK (kind <> 'FULL' OR refund_application_fee),
  CHECK (status IN ('REQUESTED', 'FAILED') OR stripe_refund_ref IS NOT NULL),
  CHECK ((status IN ('SUCCEEDED', 'FAILED')) = (settled_at IS NOT NULL)),
  CHECK (closed_at IS NULL OR status = 'FAILED')
);

CREATE UNIQUE INDEX booking_refunds_stripe_ref_idx
  ON booking_refunds (provider_id, stripe_refund_ref)
  WHERE stripe_refund_ref IS NOT NULL;
CREATE UNIQUE INDEX booking_refunds_one_full_idx
  ON booking_refunds (provider_id, booking_id)
  WHERE kind = 'FULL' AND status <> 'FAILED';
CREATE INDEX booking_refunds_booking_idx ON booking_refunds (provider_id, booking_id, created_at);
-- Support's list: refunds Stripe has not answered or finished for a while, and failed ones nobody closed.
CREATE INDEX booking_refunds_attention_idx
  ON booking_refunds (created_at)
  WHERE status IN ('REQUESTED', 'PENDING') OR (status = 'FAILED' AND closed_at IS NULL);

-- "Ask to cancel": a guest past free cancellation asks support. One open request per booking. CLOSED: the
-- booking was cancelled another way while the request was open. decline_message is support's words to the
-- guest; it is blanked with the guest's data a year on.
CREATE TABLE booking_cancellation_requests (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL,
  booking_id bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN', 'APPROVED', 'DECLINED', 'CLOSED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  resolved_by text CHECK (length(resolved_by) BETWEEN 1 AND 256),
  decline_message text CHECK (length(decline_message) BETWEEN 1 AND 2000),
  FOREIGN KEY (provider_id, booking_id) REFERENCES bookings(provider_id, id) ON DELETE RESTRICT,
  CHECK ((status = 'OPEN') = (resolved_at IS NULL))
);

CREATE UNIQUE INDEX booking_cancellation_requests_open_idx
  ON booking_cancellation_requests (provider_id, booking_id)
  WHERE status = 'OPEN';
CREATE INDEX booking_cancellation_requests_booking_idx ON booking_cancellation_requests (provider_id, booking_id, created_at);
CREATE INDEX booking_cancellation_requests_queue_idx ON booking_cancellation_requests (created_at) WHERE status = 'OPEN';

-- Support's list of payments under review.
CREATE INDEX bookings_payment_review_idx ON bookings (created_at) WHERE status = 'PAYMENT_REVIEW';

COMMIT;
