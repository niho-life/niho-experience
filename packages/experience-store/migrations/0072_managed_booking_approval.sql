BEGIN;

-- The booking acceptance policy is part of the immutable sales-plan revision.
-- Existing and owner-sold revisions stay instant unless an Admin explicitly
-- creates a MANAGED_20 pilot revision with APPROVAL.
ALTER TABLE experience_product_sales_plan_versions
  ADD COLUMN acceptance_mode text NOT NULL DEFAULT 'INSTANT'
    CHECK (acceptance_mode IN ('INSTANT','APPROVAL')),
  ADD CONSTRAINT experience_sales_plan_managed_approval_check
    CHECK (acceptance_mode <> 'APPROVAL' OR plan = 'MANAGED_20');

-- Approval is deliberately kept beside the private guest details rather than
-- widening the booking status shared by instant bookings, cancellations and
-- settlement.  A request can move from PENDING exactly once; Checkout may be
-- attached only after approval.
ALTER TABLE booking_guests
  ADD COLUMN approval_status text CHECK (approval_status IN ('PENDING','APPROVED','DECLINED')),
  ADD COLUMN approval_decided_by_admin_niho_user_id text CHECK (
    approval_decided_by_admin_niho_user_id IS NULL
    OR length(approval_decided_by_admin_niho_user_id) BETWEEN 1 AND 256
  ),
  ADD COLUMN approval_decided_at timestamptz,
  ADD CONSTRAINT booking_guests_approval_decision_check CHECK (
    (approval_status IS NULL
      AND approval_decided_by_admin_niho_user_id IS NULL AND approval_decided_at IS NULL)
    OR
    (approval_status='PENDING'
      AND approval_decided_by_admin_niho_user_id IS NULL AND approval_decided_at IS NULL
      AND checkout_session_ref IS NULL)
    OR
    (approval_status='APPROVED'
      AND approval_decided_by_admin_niho_user_id IS NOT NULL AND approval_decided_at IS NOT NULL)
    OR
    (approval_status='DECLINED'
      AND approval_decided_by_admin_niho_user_id IS NOT NULL AND approval_decided_at IS NOT NULL
      AND checkout_session_ref IS NULL)
  );

CREATE INDEX booking_guests_pending_approval_idx
  ON booking_guests (created_at, provider_id, booking_id)
  WHERE approval_status='PENDING';

CREATE FUNCTION protect_booking_guest_approval() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.approval_status IS NULL AND NEW.approval_status IS NOT NULL THEN
    RAISE EXCEPTION 'instant bookings cannot become approval requests' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.approval_status IN ('APPROVED','DECLINED')
     AND (NEW.approval_status IS DISTINCT FROM OLD.approval_status
       OR NEW.approval_decided_by_admin_niho_user_id IS DISTINCT FROM OLD.approval_decided_by_admin_niho_user_id
       OR NEW.approval_decided_at IS DISTINCT FROM OLD.approval_decided_at) THEN
    RAISE EXCEPTION 'a booking approval decision is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.approval_status='PENDING'
     AND NEW.approval_status IS DISTINCT FROM 'PENDING'
     AND NEW.approval_status IS DISTINCT FROM 'APPROVED'
     AND NEW.approval_status IS DISTINCT FROM 'DECLINED' THEN
    RAISE EXCEPTION 'a booking approval request has an invalid transition' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER booking_guests_approval_protect
BEFORE UPDATE ON booking_guests
FOR EACH ROW EXECUTE FUNCTION protect_booking_guest_approval();

COMMIT;
