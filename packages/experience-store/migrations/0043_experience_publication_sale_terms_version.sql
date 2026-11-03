BEGIN;

-- A public publication is identified by both the editable manuscript and the
-- exact immutable sale-terms row it captured. Existing publication snapshots
-- predate this explicit version and keep the sentinel 0; new snapshots use the
-- current sale-terms version.
ALTER TABLE experience_product_publications
  ADD COLUMN sale_terms_version bigint NOT NULL DEFAULT 0
    CHECK (sale_terms_version >= 0);

DO $$
DECLARE
  previous_constraint text;
BEGIN
  SELECT conname INTO previous_constraint
    FROM pg_constraint
   WHERE conrelid = 'experience_product_publications'::regclass
     AND contype = 'u'
     AND pg_get_constraintdef(oid) = 'UNIQUE (provider_id, product_id, draft_version, consent_version)';
  IF previous_constraint IS NULL THEN
    RAISE EXCEPTION 'the publication manuscript/consent uniqueness constraint is missing';
  END IF;
  EXECUTE format('ALTER TABLE experience_product_publications DROP CONSTRAINT %I', previous_constraint);
END $$;

ALTER TABLE experience_product_publications
  ADD CONSTRAINT experience_product_publications_sale_terms_version_key
    UNIQUE (provider_id, product_id, draft_version, sale_terms_version, consent_version);

COMMIT;
