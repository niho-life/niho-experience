BEGIN;

-- 旅行者の予約 (#285 slice 4): a Stripe Checkout Session that ended unpaid (checkout.session.expired or
-- checkout.session.async_payment_failed) releases the guest's hold, and its event is recorded in
-- stripe_webhook_events like a payment event. Two outcomes join the three a payment records:
--   EXPIRED  the event released the hold (the booking became EXPIRED);
--   IGNORED  it changed nothing (the booking was no longer held, or the Session is not the one recorded).
-- Widening only: the current writer records CONFIRMED, PAYMENT_REVIEW or DUPLICATE, all still allowed,
-- so this migration may run before the new revision.
ALTER TABLE stripe_webhook_events DROP CONSTRAINT stripe_webhook_events_outcome_check;
ALTER TABLE stripe_webhook_events
  ADD CONSTRAINT stripe_webhook_events_outcome_check CHECK (
    outcome IN ('CONFIRMED', 'PAYMENT_REVIEW', 'DUPLICATE', 'EXPIRED', 'IGNORED')
  );

COMMIT;
