BEGIN;

ALTER TABLE experience_product_sales_plan_versions
  ADD COLUMN payment_due_policy text CHECK (payment_due_policy IN ('NEXT_MONTH_END')),
  DROP CONSTRAINT experience_product_sales_plan_versions_check,
  ADD CONSTRAINT experience_product_sales_plan_versions_terms_check CHECK (
    (plan='MANAGED_20' AND charge_mode='PLATFORM' AND fee_basis_points=2000
      AND ((payment_due_days IS NOT NULL) <> (payment_due_policy IS NOT NULL))
      AND pilot_approved AND activated_by_admin_niho_user_id IS NOT NULL)
    OR
    (plan='SUPPORTED_15' AND charge_mode='CONNECT_DIRECT' AND fee_basis_points=1500
      AND payment_due_days IS NULL AND payment_due_policy IS NULL AND NOT pilot_approved)
    OR
    (plan='INDEPENDENT_10' AND charge_mode='CONNECT_DIRECT' AND fee_basis_points=1000
      AND payment_due_days IS NULL AND payment_due_policy IS NULL AND NOT pilot_approved)
  );

COMMIT;
