BEGIN;

-- NIHO Admin may prepare only never-published Experience drafts for an
-- operator-provisioned seller. Every write is attributed to the verified
-- Admin actor; the actor is never inserted into provider_memberships.
CREATE TABLE admin_product_draft_audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_niho_user_id text NOT NULL CHECK (length(actor_niho_user_id) BETWEEN 1 AND 256),
  provider_id text NOT NULL,
  product_id text NOT NULL,
  action text NOT NULL CHECK (action IN (
    'DRAFT_CREATED','DRAFT_SAVED','SALE_TERMS_SAVED',
    'MEDIA_ADDED','MEDIA_SELECTION_SAVED','SCHEDULE_SAVED'
  )),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (provider_id, product_id)
    REFERENCES experience_products(provider_id, id) ON DELETE RESTRICT
);

CREATE INDEX admin_product_draft_audit_product_idx
  ON admin_product_draft_audit_events (provider_id, product_id, created_at DESC, id DESC);

CREATE FUNCTION reject_admin_product_draft_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'admin product draft audit events are immutable';
END;
$$;

CREATE TRIGGER admin_product_draft_audit_immutable
BEFORE UPDATE OR DELETE ON admin_product_draft_audit_events
FOR EACH ROW EXECUTE FUNCTION reject_admin_product_draft_audit_mutation();

COMMIT;
