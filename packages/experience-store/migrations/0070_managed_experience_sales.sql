BEGIN;

ALTER TABLE booking_refunds DROP CONSTRAINT booking_refunds_check;
ALTER TABLE booking_refunds ADD CONSTRAINT booking_refunds_application_fee_mode_check
  CHECK (kind IN ('FULL','PARTIAL'));

-- Product-scoped seller/fee terms.  A revision is immutable and is copied into
-- every new booking.  Existing products have no row and keep the legacy Direct
-- behavior; no current setting is ever used to repair an old booking snapshot.
CREATE TABLE experience_product_sales_plan_versions (
  provider_id text NOT NULL,
  product_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  plan text NOT NULL CHECK (plan IN ('MANAGED_20','SUPPORTED_15','INDEPENDENT_10')),
  charge_mode text NOT NULL CHECK (charge_mode IN ('PLATFORM','CONNECT_DIRECT')),
  provider_public_profile_version bigint NOT NULL CHECK (provider_public_profile_version > 0),
  seller_display_name text NOT NULL CHECK (length(seller_display_name) BETWEEN 1 AND 300),
  seller_disclosure_url text NOT NULL CHECK (seller_disclosure_url ~ '^https://'),
  seller_niho_account_ref text NOT NULL CHECK (length(seller_niho_account_ref) BETWEEN 1 AND 256),
  stripe_account_ref text NOT NULL CHECK (stripe_account_ref ~ '^acct_[A-Za-z0-9]{8,}$'),
  fee_basis_points integer NOT NULL CHECK (fee_basis_points IN (1000,1500,2000)),
  agreement_version text NOT NULL CHECK (length(agreement_version) BETWEEN 1 AND 160),
  agreement_confirmed_by text NOT NULL CHECK (length(agreement_confirmed_by) BETWEEN 1 AND 256),
  agreement_confirmation_method text NOT NULL CHECK (agreement_confirmation_method IN ('VERBAL','WRITTEN','OWNER_WEB')),
  agreement_confirmed_at timestamptz NOT NULL,
  payment_due_days integer CHECK (payment_due_days BETWEEN 0 AND 180),
  pilot_approved boolean NOT NULL DEFAULT false,
  activated_by_admin_niho_user_id text CHECK (
    activated_by_admin_niho_user_id IS NULL OR length(activated_by_admin_niho_user_id) BETWEEN 1 AND 256
  ),
  activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  owner_switch_command_id uuid,
  PRIMARY KEY (provider_id, product_id, revision),
  UNIQUE (provider_id, product_id, owner_switch_command_id),
  FOREIGN KEY (provider_id, product_id)
    REFERENCES experience_products(provider_id, id) ON DELETE RESTRICT,
  CHECK (
    (plan='MANAGED_20' AND charge_mode='PLATFORM' AND fee_basis_points=2000
      AND payment_due_days IS NOT NULL AND pilot_approved AND activated_by_admin_niho_user_id IS NOT NULL)
    OR
    (plan='SUPPORTED_15' AND charge_mode='CONNECT_DIRECT' AND fee_basis_points=1500
      AND payment_due_days IS NULL AND NOT pilot_approved)
    OR
    (plan='INDEPENDENT_10' AND charge_mode='CONNECT_DIRECT' AND fee_basis_points=1000
      AND payment_due_days IS NULL AND NOT pilot_approved)
  )
);

CREATE TABLE experience_product_sales_plan_states (
  provider_id text NOT NULL,
  product_id text NOT NULL,
  current_revision bigint NOT NULL,
  phase text NOT NULL DEFAULT 'ACTIVE' CHECK (phase IN ('ACTIVE','EXPIRING_OLD_CHECKOUTS','RECONCILING')),
  pending_revision bigint,
  transition_command_id uuid,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, product_id),
  FOREIGN KEY (provider_id, product_id, current_revision)
    REFERENCES experience_product_sales_plan_versions(provider_id, product_id, revision) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id, product_id, pending_revision)
    REFERENCES experience_product_sales_plan_versions(provider_id, product_id, revision) ON DELETE RESTRICT,
  CHECK (
    (phase='ACTIVE' AND pending_revision IS NULL AND transition_command_id IS NULL)
    OR
    (phase<>'ACTIVE' AND pending_revision IS NOT NULL AND transition_command_id IS NOT NULL
      AND pending_revision<>current_revision)
  )
);

-- One row per old open Session found while a plan switch is fenced.  UNKNOWN
-- keeps the product closed until an operator reconciles Stripe; retries update
-- this same row and cannot create a second transition outcome.
CREATE TABLE experience_sales_plan_transition_checkouts (
  provider_id text NOT NULL,
  product_id text NOT NULL,
  command_id uuid NOT NULL,
  booking_id bigint NOT NULL,
  checkout_session_ref text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING','EXPIRED','PAID','UNKNOWN')),
  checked_at timestamptz,
  PRIMARY KEY (provider_id, product_id, command_id, booking_id),
  UNIQUE (checkout_session_ref),
  FOREIGN KEY (provider_id, product_id) REFERENCES experience_products(provider_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id, booking_id) REFERENCES bookings(provider_id, id) ON DELETE RESTRICT
);

-- Platform disputes are booking facts, not Connect payout facts.  Amount and
-- currency are checked against the original booking by the repository.
CREATE TABLE managed_booking_disputes (
  provider_id text NOT NULL,
  booking_id bigint NOT NULL,
  stripe_dispute_ref text NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL CHECK (status IN ('NEEDS_RESPONSE','UNDER_REVIEW','WON','LOST','WARNING_CLOSED')),
  stripe_event_id text NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, booking_id, stripe_dispute_ref),
  FOREIGN KEY (provider_id, booking_id) REFERENCES bookings(provider_id, id) ON DELETE RESTRICT
);

CREATE TABLE managed_booking_dispute_events (
  stripe_event_id text PRIMARY KEY,
  provider_id text NOT NULL,
  booking_id bigint NOT NULL,
  stripe_dispute_ref text NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL CHECK (status IN ('NEEDS_RESPONSE','UNDER_REVIEW','WON','LOST','WARNING_CLOSED')),
  occurred_at timestamptz NOT NULL,
  FOREIGN KEY (provider_id, booking_id) REFERENCES bookings(provider_id, id) ON DELETE RESTRICT
);

-- Manual bank compensation for MANAGED_20.  This stores no bank-account data.
-- A result-unknown preparation must be reconciled by its statement reference
-- before it can be retried or marked paid.
CREATE TABLE managed_provider_compensations (
  provider_id text NOT NULL,
  booking_id bigint NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  captured_amount bigint NOT NULL CHECK (captured_amount >= 0),
  refunded_amount bigint NOT NULL CHECK (refunded_amount >= 0),
  disputed_amount bigint NOT NULL CHECK (disputed_amount >= 0),
  fee_basis_points integer NOT NULL CHECK (fee_basis_points=2000),
  niho_fee_amount bigint NOT NULL CHECK (niho_fee_amount >= 0),
  provider_amount bigint NOT NULL CHECK (provider_amount >= 0),
  due_on date NOT NULL,
  recipient_verified_at timestamptz,
  status text NOT NULL CHECK (status IN ('REVIEW_REQUIRED','READY','PREPARED','RESULT_UNKNOWN','PAID','ADJUSTMENT_REQUIRED')),
  preparation_id uuid,
  prepared_amount bigint CHECK (prepared_amount IS NULL OR prepared_amount >= 0),
  statement_reference text CHECK (statement_reference IS NULL OR length(statement_reference) BETWEEN 1 AND 160),
  paid_amount bigint CHECK (paid_amount IS NULL OR paid_amount >= 0),
  prepared_by_admin_niho_user_id text,
  paid_by_admin_niho_user_id text,
  paid_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, booking_id),
  UNIQUE (preparation_id),
  FOREIGN KEY (provider_id, booking_id) REFERENCES bookings(provider_id, id) ON DELETE RESTRICT,
  CHECK (refunded_amount + disputed_amount <= captured_amount),
  CHECK (niho_fee_amount = ((captured_amount-refunded_amount-disputed_amount)*fee_basis_points)/10000),
  CHECK (provider_amount = captured_amount-refunded_amount-disputed_amount-niho_fee_amount),
  CHECK (
    (status IN ('REVIEW_REQUIRED','READY') AND preparation_id IS NULL AND prepared_amount IS NULL
      AND statement_reference IS NULL AND paid_amount IS NULL)
    OR
    (status IN ('PREPARED','RESULT_UNKNOWN') AND preparation_id IS NOT NULL AND prepared_amount IS NOT NULL
      AND prepared_by_admin_niho_user_id IS NOT NULL AND statement_reference IS NULL AND paid_amount IS NULL)
    OR
    (status IN ('PAID','ADJUSTMENT_REQUIRED') AND preparation_id IS NOT NULL
      AND prepared_amount IS NOT NULL AND statement_reference IS NOT NULL AND paid_amount IS NOT NULL
      AND paid_by_admin_niho_user_id IS NOT NULL AND paid_at IS NOT NULL)
  )
);

CREATE TABLE managed_provider_compensation_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_id text NOT NULL,
  booking_id bigint NOT NULL,
  command_id uuid NOT NULL,
  actor_admin_niho_user_id text NOT NULL CHECK (length(actor_admin_niho_user_id) BETWEEN 1 AND 256),
  action text NOT NULL CHECK (action IN ('CALCULATED','RECIPIENT_VERIFIED','PREPARED','RESULT_UNKNOWN','RECONCILED_PAID','ADJUSTED')),
  amount bigint NOT NULL CHECK (amount >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (provider_id, booking_id, command_id),
  FOREIGN KEY (provider_id, booking_id)
    REFERENCES managed_provider_compensations(provider_id, booking_id) ON DELETE RESTRICT
);

CREATE FUNCTION reject_managed_sales_immutable_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'managed sales history is immutable' USING ERRCODE='check_violation';
END;
$$;

CREATE TRIGGER experience_product_sales_plan_versions_immutable
BEFORE UPDATE OR DELETE ON experience_product_sales_plan_versions
FOR EACH ROW EXECUTE FUNCTION reject_managed_sales_immutable_mutation();

CREATE TRIGGER managed_provider_compensation_events_immutable
BEFORE UPDATE OR DELETE ON managed_provider_compensation_events
FOR EACH ROW EXECUTE FUNCTION reject_managed_sales_immutable_mutation();

CREATE TRIGGER managed_booking_dispute_events_immutable
BEFORE UPDATE OR DELETE ON managed_booking_dispute_events
FOR EACH ROW EXECUTE FUNCTION reject_managed_sales_immutable_mutation();

COMMIT;
