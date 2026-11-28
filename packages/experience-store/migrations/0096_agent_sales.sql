BEGIN;

-- #725 (Epic #700 stage 3b-1, docs/host-payouts.md): "サポート 15% を NIHO が代理で受領する". The host is the seller and NIHO
-- takes the guest's payment on the platform account (the PLATFORM charge path of MANAGED_20) and sends the host's share after
-- the experience (3b-2). Nothing here changes a MANAGED_20 or Direct row.

-- Who the seller is, computed from the plan so an existing row is filled by the database: MANAGED_20 is NIHO's own sale, every
-- other plan is the provider's. The payout delay (days after the experience ends) and the receiving agent's legal name are fixed
-- by the revision the host agreed to, and only an agent-sales revision has them.
ALTER TABLE experience_product_sales_plan_versions
  ADD COLUMN seller_party text GENERATED ALWAYS AS (CASE WHEN plan = 'MANAGED_20' THEN 'NIHO' ELSE 'PROVIDER' END) STORED,
  ADD COLUMN payout_delay_days integer CHECK (payout_delay_days BETWEEN 1 AND 30),
  ADD COLUMN receiving_agent_name text CHECK (length(receiving_agent_name) BETWEEN 1 AND 300);

ALTER TABLE experience_product_sales_plan_versions
  DROP CONSTRAINT experience_product_sales_plan_versions_terms_check,
  ADD CONSTRAINT experience_product_sales_plan_versions_terms_check CHECK (
    (plan='MANAGED_20' AND charge_mode='PLATFORM' AND fee_basis_points=2000
      AND ((payment_due_days IS NOT NULL) <> (payment_due_policy IS NOT NULL))
      AND pilot_approved AND activated_by_admin_niho_user_id IS NOT NULL
      AND payout_delay_days IS NULL AND receiving_agent_name IS NULL)
    OR
    (plan='SUPPORTED_15' AND charge_mode='CONNECT_DIRECT' AND fee_basis_points=1500
      AND payment_due_days IS NULL AND payment_due_policy IS NULL AND NOT pilot_approved
      AND payout_delay_days IS NULL AND receiving_agent_name IS NULL)
    OR
    (plan='INDEPENDENT_10' AND charge_mode='CONNECT_DIRECT' AND fee_basis_points=1000
      AND payment_due_days IS NULL AND payment_due_policy IS NULL AND NOT pilot_approved
      AND payout_delay_days IS NULL AND receiving_agent_name IS NULL)
    OR
    -- 代理受領: the host sells, the platform account takes the payment, the seller reference is the provider's `agt_` reference.
    (plan='SUPPORTED_15' AND charge_mode='PLATFORM' AND fee_basis_points=1500
      AND payment_due_days IS NULL AND payment_due_policy IS NULL AND NOT pilot_approved
      AND activated_by_admin_niho_user_id IS NULL AND agreement_confirmation_method='OWNER_WEB'
      AND payout_delay_days IS NOT NULL AND payout_delay_days BETWEEN 1 AND 30 AND receiving_agent_name IS NOT NULL
      AND seller_niho_account_ref ~ '^agt_[0-9a-f]{32}$')
  );

-- The OWNER's versioned consent to agent sales (NIHO takes the payment as the host's agent, and sends the host's share later).
-- The same shape as provider_payout_account_consents: rows are the history, at most one is active per provider, nothing is
-- deleted, and a withdrawal only marks the active row revoked. `seller_ref` is the provider's agent seller reference, minted by
-- the first consent and never changed for that provider (a trigger), so versions, products and bookings keep matching it when
-- the OWNER changes. What the public sees of the seller (特定商取引法の表示) stays in provider_seller_disclosures.
CREATE TABLE provider_agent_sales_consents (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL REFERENCES experience_providers(id) ON DELETE RESTRICT,
  seller_ref text NOT NULL CHECK (seller_ref ~ '^agt_[0-9a-f]{32}$'),
  consent_version text NOT NULL CHECK (length(consent_version) BETWEEN 1 AND 160 AND consent_version = btrim(consent_version)),
  consented_by_host_account_id text NOT NULL CHECK (consented_by_host_account_id ~ '^hst_[0-9a-f]{32}$')
    REFERENCES host_accounts(id) ON DELETE RESTRICT,
  consented_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by_host_account_id text CHECK (revoked_by_host_account_id ~ '^hst_[0-9a-f]{32}$')
    REFERENCES host_accounts(id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id, consented_by_host_account_id)
    REFERENCES provider_memberships(provider_id, niho_user_id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id, revoked_by_host_account_id)
    REFERENCES provider_memberships(provider_id, niho_user_id) ON DELETE RESTRICT,
  CHECK ((revoked_at IS NULL) = (revoked_by_host_account_id IS NULL)),
  CHECK (revoked_at IS NULL OR revoked_at >= consented_at)
);

CREATE UNIQUE INDEX provider_agent_sales_consents_active_idx
  ON provider_agent_sales_consents (provider_id) WHERE revoked_at IS NULL;
CREATE INDEX provider_agent_sales_consents_provider_idx
  ON provider_agent_sales_consents (provider_id, consented_at);

CREATE FUNCTION protect_provider_agent_sales_consents() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'agent sales consents are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- One seller reference per provider, for good.
    IF EXISTS (SELECT 1 FROM provider_agent_sales_consents c WHERE c.provider_id = NEW.provider_id AND c.seller_ref <> NEW.seller_ref) THEN
      RAISE EXCEPTION 'the agent seller reference of a provider never changes' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.provider_id IS DISTINCT FROM OLD.provider_id OR NEW.seller_ref IS DISTINCT FROM OLD.seller_ref
     OR NEW.consent_version IS DISTINCT FROM OLD.consent_version
     OR NEW.consented_by_host_account_id IS DISTINCT FROM OLD.consented_by_host_account_id
     OR NEW.consented_at IS DISTINCT FROM OLD.consented_at THEN
    RAISE EXCEPTION 'agent sales consent facts are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
     OR NEW.revoked_by_host_account_id IS DISTINCT FROM OLD.revoked_by_host_account_id) THEN
    RAISE EXCEPTION 'a revoked agent sales consent stays revoked' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_agent_sales_consents_protect
BEFORE INSERT OR UPDATE OR DELETE ON provider_agent_sales_consents
FOR EACH ROW EXECUTE FUNCTION protect_provider_agent_sales_consents();

COMMIT;
