BEGIN;

-- Legacy grants created by 0005 remain effective at source_version=0. NIHO sends only
-- accepted invitation projections, so newer rows keep the correlation UUID but no
-- invitation body, email, token, or profile data.
ALTER TABLE guide_writer_grants
  ADD COLUMN source_version bigint NOT NULL DEFAULT 0
    CHECK (source_version BETWEEN 0 AND 9007199254740991),
  ADD COLUMN source_invitation_id uuid,
  ADD CONSTRAINT guide_writer_grants_source_check CHECK (
    (source_version = 0 AND source_invitation_id IS NULL)
    OR (source_version > 0 AND source_invitation_id IS NOT NULL)
  );

-- Existing categories are the first revision. The stable slug remains protected by
-- the immutable-slug trigger installed in 0005.
ALTER TABLE guide_categories
  ADD COLUMN revision bigint NOT NULL DEFAULT 1
    CHECK (revision BETWEEN 1 AND 9007199254740991);

-- A committed receipt is both the idempotency record and the minimal append-only
-- audit. result contains only the contract response; it must not contain identity
-- profile, email, token, or invitation content.
CREATE TABLE guide_admin_command_receipts (
  idempotency_key uuid PRIMARY KEY,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  actor_niho_user_id text NOT NULL CHECK (length(actor_niho_user_id) BETWEEN 1 AND 256),
  target_kind text NOT NULL CHECK (target_kind IN ('WRITER', 'CATEGORY')),
  target_id text NOT NULL CHECK (length(target_id) BETWEEN 1 AND 256),
  action text NOT NULL CHECK (action IN ('writer.put', 'category.put')),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX guide_admin_command_receipts_target_idx
  ON guide_admin_command_receipts (target_kind, target_id, created_at);

CREATE FUNCTION protect_guide_admin_command_receipts() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'guide admin command receipts are append-only' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER guide_admin_command_receipts_immutable
BEFORE UPDATE OR DELETE ON guide_admin_command_receipts
FOR EACH ROW EXECUTE FUNCTION protect_guide_admin_command_receipts();

COMMIT;
