BEGIN;

-- #725 (Epic #700 stage 3b-2, docs/host-payouts.md「3b-2 送金」): the ledger of the payouts NIHO sends a host for an agent-sales (サポート 15%・代理受領)
-- booking: one row per booking. The guest paid NIHO's platform account; after the experience (plus the revision's delay) NIHO sends the host's
-- share (the payment less 15% of what is left after refunds and lost disputes) to the host's own payout account with one Transfer.
-- Amounts are whole yen. Rows are never deleted. The job claims due rows with FOR UPDATE SKIP LOCKED and a lease; every change is logged
-- in experience_agent_payout_events (append-only).

CREATE TABLE experience_agent_payouts (
  provider_id text NOT NULL,
  booking_id bigint NOT NULL,
  id uuid NOT NULL UNIQUE,
  currency text NOT NULL CHECK (currency = 'JPY'),
  captured_amount bigint NOT NULL CHECK (captured_amount > 0),
  refunded_amount bigint NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
  disputed_amount bigint NOT NULL DEFAULT 0 CHECK (disputed_amount >= 0),
  niho_fee_amount bigint NOT NULL CHECK (niho_fee_amount >= 0),
  payout_amount bigint NOT NULL CHECK (payout_amount >= 0),
  stripe_payment_ref text NOT NULL CHECK (length(stripe_payment_ref) BETWEEN 1 AND 256),
  stripe_charge_ref text CHECK (stripe_charge_ref IS NULL OR stripe_charge_ref ~ '^(ch|py)_[A-Za-z0-9_]{8,250}$'),
  sales_plan_revision bigint NOT NULL CHECK (sales_plan_revision > 0),
  payout_delay_days integer NOT NULL CHECK (payout_delay_days BETWEEN 1 AND 30),
  experience_end_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('SCHEDULED', 'AWAITING_ACCOUNT', 'SUBMITTING', 'RESULT_UNKNOWN', 'TRANSFERRED', 'REVIEW_REQUIRED', 'CANCELLED')),
  -- Only a scheduled payout is held; every other state says why in its own way.
  hold_reason text CHECK (hold_reason IN ('REFUND_PENDING', 'REFUND_FAILED', 'DISPUTE_OPEN', 'PROVIDER_SUSPENDED')),
  -- The transfer: fixed before Stripe is asked (SUBMITTING), so an unknown result is looked up by it, never sent again blindly.
  command_id uuid UNIQUE,
  command_created_at timestamptz,
  destination_connect_account_id uuid REFERENCES experience_connect_accounts(id) ON DELETE RESTRICT,
  destination_account_ref text CHECK (destination_account_ref IS NULL OR destination_account_ref ~ '^acct_[A-Za-z0-9]{8,250}$'),
  -- What is sent, and what was kept back from it to cover earlier amounts owed (offsets): submitted_amount + offset_amount = payout_amount at the time.
  submitted_amount bigint CHECK (submitted_amount IS NULL OR submitted_amount >= 0),
  offset_amount bigint NOT NULL DEFAULT 0 CHECK (offset_amount >= 0),
  stripe_transfer_ref text UNIQUE CHECK (stripe_transfer_ref IS NULL OR stripe_transfer_ref ~ '^tr_[A-Za-z0-9_]{8,250}$'),
  transferred_at timestamptz,
  -- How much of the transfer was taken back by Stripe reversals.
  reversed_amount bigint NOT NULL DEFAULT 0 CHECK (reversed_amount >= 0),
  issue_code text CHECK (issue_code IS NULL OR issue_code ~ '^[a-z0-9_]{1,80}$'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_check_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claimed_until timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, booking_id),
  FOREIGN KEY (provider_id, booking_id) REFERENCES bookings(provider_id, id) ON DELETE RESTRICT,
  CHECK (refunded_amount + disputed_amount <= captured_amount),
  -- 15% of what is left after refunds and lost disputes, rounded down (the payment's own fee is in it).
  CHECK (niho_fee_amount = ((captured_amount - refunded_amount - disputed_amount) * 1500) / 10000),
  CHECK (payout_amount = (captured_amount - refunded_amount - disputed_amount) - niho_fee_amount),
  CHECK (hold_reason IS NULL OR status = 'SCHEDULED'),
  CHECK (due_at >= experience_end_at),
  CHECK (status NOT IN ('SUBMITTING', 'RESULT_UNKNOWN', 'TRANSFERRED') OR (
    command_id IS NOT NULL AND command_created_at IS NOT NULL AND destination_connect_account_id IS NOT NULL
    AND destination_account_ref IS NOT NULL AND submitted_amount IS NOT NULL AND stripe_charge_ref IS NOT NULL)),
  CHECK (status <> 'TRANSFERRED' OR (transferred_at IS NOT NULL AND (stripe_transfer_ref IS NOT NULL OR submitted_amount = 0))),
  CHECK (status = 'TRANSFERRED' OR (stripe_transfer_ref IS NULL AND transferred_at IS NULL)),
  CHECK (status <> 'REVIEW_REQUIRED' OR issue_code IS NOT NULL),
  CHECK (reversed_amount <= COALESCE(submitted_amount, 0))
);

CREATE INDEX experience_agent_payouts_due_idx
  ON experience_agent_payouts (next_check_at)
  WHERE status IN ('SCHEDULED', 'AWAITING_ACCOUNT', 'SUBMITTING', 'RESULT_UNKNOWN', 'TRANSFERRED');
CREATE INDEX experience_agent_payouts_provider_idx ON experience_agent_payouts (provider_id, due_at DESC);
-- The office's list: what needs a person.
CREATE INDEX experience_agent_payouts_attention_idx
  ON experience_agent_payouts (updated_at)
  WHERE status IN ('REVIEW_REQUIRED', 'RESULT_UNKNOWN', 'AWAITING_ACCOUNT');

-- Taking back money after a payout was sent (a refund or a lost dispute that came later): first by reversing the transfer at Stripe, and
-- what Stripe cannot take back from later payouts of the same host (offsets), and at last the office writes it off as NIHO's loss.
CREATE TABLE experience_agent_payout_adjustments (
  id uuid PRIMARY KEY,
  payout_id uuid NOT NULL REFERENCES experience_agent_payouts(id) ON DELETE RESTRICT,
  provider_id text NOT NULL,
  booking_id bigint NOT NULL,
  reason text NOT NULL CHECK (reason IN ('REFUND', 'DISPUTE')),
  status text NOT NULL CHECK (status IN ('REVERSAL_PENDING', 'RESULT_UNKNOWN', 'REVERSED', 'OFFSET_PENDING', 'OFFSET_APPLIED', 'LOSS_RECORDED', 'REVIEW_REQUIRED')),
  -- The whole amount to take back; reversal_amount of it is asked of Stripe, the rest waits for later payouts.
  amount bigint NOT NULL CHECK (amount > 0),
  reversal_amount bigint NOT NULL DEFAULT 0 CHECK (reversal_amount >= 0),
  remaining_amount bigint NOT NULL CHECK (remaining_amount >= 0),
  stripe_reversal_ref text UNIQUE CHECK (stripe_reversal_ref IS NULL OR stripe_reversal_ref ~ '^trr_[A-Za-z0-9_]{8,250}$'),
  issue_code text CHECK (issue_code IS NULL OR issue_code ~ '^[a-z0-9_]{1,80}$'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claimed_until timestamptz,
  -- When it began to wait for later payouts (the 90 days run from here, and start again when the office sends it back to waiting).
  offset_pending_since timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (provider_id, booking_id) REFERENCES bookings(provider_id, id) ON DELETE RESTRICT,
  CHECK (status <> 'OFFSET_PENDING' OR offset_pending_since IS NOT NULL),
  CHECK (reversal_amount <= amount),
  CHECK (remaining_amount <= amount),
  CHECK (status <> 'REVIEW_REQUIRED' OR issue_code IS NOT NULL),
  CHECK (status NOT IN ('REVERSED', 'OFFSET_APPLIED', 'LOSS_RECORDED') OR remaining_amount = 0),
  CHECK (status <> 'REVERSED' OR stripe_reversal_ref IS NOT NULL OR reversal_amount = 0)
);
CREATE INDEX experience_agent_payout_adjustments_payout_idx ON experience_agent_payout_adjustments (payout_id, created_at);
CREATE INDEX experience_agent_payout_adjustments_due_idx ON experience_agent_payout_adjustments (next_attempt_at) WHERE status IN ('REVERSAL_PENDING', 'RESULT_UNKNOWN');
CREATE INDEX experience_agent_payout_adjustments_offset_idx ON experience_agent_payout_adjustments (provider_id, created_at, id) WHERE status = 'OFFSET_PENDING';

-- Which later payout absorbed how much of an adjustment: append-only.
CREATE TABLE experience_agent_payout_offsets (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  adjustment_id uuid NOT NULL REFERENCES experience_agent_payout_adjustments(id) ON DELETE RESTRICT,
  from_payout_id uuid NOT NULL REFERENCES experience_agent_payouts(id) ON DELETE RESTRICT,
  amount bigint NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX experience_agent_payout_offsets_from_idx ON experience_agent_payout_offsets (from_payout_id);
CREATE INDEX experience_agent_payout_offsets_adjustment_idx ON experience_agent_payout_offsets (adjustment_id);

-- Every change of a payout or an adjustment, and who made it ('system' for the job, an Admin's ID for the office): append-only.
CREATE TABLE experience_agent_payout_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payout_id uuid NOT NULL REFERENCES experience_agent_payouts(id) ON DELETE RESTRICT,
  adjustment_id uuid REFERENCES experience_agent_payout_adjustments(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type ~ '^[A-Z_]{1,60}$'),
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 256),
  from_status text,
  to_status text,
  amount bigint,
  issue_code text CHECK (issue_code IS NULL OR issue_code ~ '^[a-z0-9_]{1,80}$'),
  note text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 1000),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX experience_agent_payout_events_payout_idx ON experience_agent_payout_events (payout_id, id);

CREATE FUNCTION experience_agent_payouts_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER experience_agent_payout_events_append_only
  BEFORE UPDATE OR DELETE ON experience_agent_payout_events FOR EACH ROW EXECUTE FUNCTION experience_agent_payouts_append_only();
CREATE TRIGGER experience_agent_payout_offsets_append_only
  BEFORE UPDATE OR DELETE ON experience_agent_payout_offsets FOR EACH ROW EXECUTE FUNCTION experience_agent_payouts_append_only();

-- Facts of a transfer do not change once it is recorded; rows are never deleted.
CREATE FUNCTION experience_agent_payouts_protect() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'agent payouts are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.provider_id IS DISTINCT FROM OLD.provider_id OR NEW.booking_id IS DISTINCT FROM OLD.booking_id
     OR NEW.stripe_payment_ref IS DISTINCT FROM OLD.stripe_payment_ref OR NEW.captured_amount IS DISTINCT FROM OLD.captured_amount
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'agent payout facts are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.stripe_transfer_ref IS NOT NULL AND NEW.stripe_transfer_ref IS DISTINCT FROM OLD.stripe_transfer_ref THEN
    RAISE EXCEPTION 'the transfer of an agent payout is set once' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'TRANSFERRED' AND NEW.status <> 'TRANSFERRED' THEN
    RAISE EXCEPTION 'a transferred agent payout stays transferred' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER experience_agent_payouts_protect_row
  BEFORE UPDATE OR DELETE ON experience_agent_payouts FOR EACH ROW EXECUTE FUNCTION experience_agent_payouts_protect();

CREATE FUNCTION experience_agent_adjustments_protect() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'agent payout adjustments are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.payout_id IS DISTINCT FROM OLD.payout_id OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'agent payout adjustment facts are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER experience_agent_adjustments_protect_row
  BEFORE UPDATE OR DELETE ON experience_agent_payout_adjustments FOR EACH ROW EXECUTE FUNCTION experience_agent_adjustments_protect();

-- A refund or a dispute that changes puts the booking's payout up for a fresh calculation (as 0052 does for the settlement).
CREATE FUNCTION experience_queue_agent_payout_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE experience_agent_payouts
     SET next_check_at = LEAST(next_check_at, clock_timestamp()), updated_at = clock_timestamp()
   WHERE provider_id = NEW.provider_id AND booking_id = NEW.booking_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER booking_refunds_experience_agent_payout_check
  AFTER INSERT OR UPDATE OF amount, status, closed_at ON booking_refunds
  FOR EACH ROW EXECUTE FUNCTION experience_queue_agent_payout_check();
CREATE TRIGGER managed_booking_disputes_experience_agent_payout_check
  AFTER INSERT OR UPDATE OF amount, status ON managed_booking_disputes
  FOR EACH ROW EXECUTE FUNCTION experience_queue_agent_payout_check();

-- The office's suspension of a host (#711) holds its payouts; lifting it wakes them.
CREATE FUNCTION experience_queue_agent_payout_check_for_provider() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE experience_agent_payouts
     SET next_check_at = LEAST(next_check_at, clock_timestamp()), updated_at = clock_timestamp()
   WHERE provider_id = NEW.id AND status IN ('SCHEDULED', 'AWAITING_ACCOUNT');
  RETURN NEW;
END;
$$;
CREATE TRIGGER experience_providers_agent_payout_check
  AFTER UPDATE OF operations_suspended_at ON experience_providers
  FOR EACH ROW WHEN (OLD.operations_suspended_at IS DISTINCT FROM NEW.operations_suspended_at)
  EXECUTE FUNCTION experience_queue_agent_payout_check_for_provider();

COMMIT;
