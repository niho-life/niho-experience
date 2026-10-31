BEGIN;

-- 返金の自動再送 (#285 slice 7b, docs/guest-booking.md「取消と返金（第7段）」): a refund that Stripe has not accepted
-- (REQUESTED) is sent again by the mail job, and by support's 「もう一度送る」, one sender at a time. Two columns keep
-- that bookkeeping: how many times a sender took the refund (the job's automatic attempts stop at a fixed number and
-- leave the refund to support) and when it last did (a sender holds a lease for a short while, and the job waits
-- longer after each try). Neither says anything about Stripe: the refund's status and Stripe's idempotency key
-- (the refund's id) stay what decide whether money moves, so a sender that ignored the lease would still not refund twice.
-- Additive only (a column with a default and a nullable one): the current writer neither reads nor writes them,
-- so this may run before the new revision.
ALTER TABLE booking_refunds
  ADD COLUMN send_attempts integer NOT NULL DEFAULT 0 CHECK (send_attempts >= 0),
  ADD COLUMN send_claimed_at timestamptz;

COMMIT;
