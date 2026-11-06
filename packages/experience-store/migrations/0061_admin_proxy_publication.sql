BEGIN;

-- Existing rows remain OWNER publications. Admin proxy actors use a separate
-- column and are never inserted into provider_memberships or stored in the
-- OWNER-only foreign-key column.
ALTER TABLE experience_product_publications
  ADD COLUMN publisher_kind text NOT NULL DEFAULT 'OWNER'
    CHECK (publisher_kind IN ('OWNER', 'ADMIN_PROXY')),
  ADD COLUMN published_by_admin_niho_user_id text
    CHECK (published_by_admin_niho_user_id IS NULL OR length(published_by_admin_niho_user_id) BETWEEN 1 AND 256),
  ALTER COLUMN published_by_niho_user_id DROP NOT NULL;

ALTER TABLE experience_product_publications
  ADD CONSTRAINT experience_product_publications_publisher_check CHECK (
    (publisher_kind = 'OWNER'
      AND published_by_niho_user_id IS NOT NULL
      AND published_by_admin_niho_user_id IS NULL)
    OR
    (publisher_kind = 'ADMIN_PROXY'
      AND published_by_niho_user_id IS NULL
      AND published_by_admin_niho_user_id IS NOT NULL)
  );

-- An Admin review binds the current saved content and both locale manuscripts.
-- It is not OWNER confirmation and becomes stale on any draft-version change.
CREATE TABLE admin_product_english_reviews (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_niho_user_id text NOT NULL CHECK (length(actor_niho_user_id) BETWEEN 1 AND 256),
  provider_id text NOT NULL,
  product_id text NOT NULL,
  draft_version bigint NOT NULL CHECK (draft_version > 0),
  content_fingerprint text NOT NULL CHECK (content_fingerprint ~ '^[0-9a-f]{64}$'),
  japanese_fingerprint text NOT NULL CHECK (japanese_fingerprint ~ '^[0-9a-f]{64}$'),
  english_fingerprint text NOT NULL CHECK (english_fingerprint ~ '^[0-9a-f]{64}$'),
  reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (actor_niho_user_id, provider_id, product_id, draft_version,
    content_fingerprint, japanese_fingerprint, english_fingerprint),
  FOREIGN KEY (provider_id, product_id)
    REFERENCES experience_products(provider_id, id) ON DELETE RESTRICT
);

-- One structured, immutable receipt for the first Admin proxy publication.
-- No free-form text or seller PII is accepted or stored.
CREATE TABLE admin_proxy_publication_audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  publication_id bigint NOT NULL,
  provider_id text NOT NULL,
  product_id text NOT NULL,
  draft_version bigint NOT NULL CHECK (draft_version > 0),
  sale_terms_version bigint NOT NULL CHECK (sale_terms_version > 0),
  consent_version text NOT NULL CHECK (length(consent_version) BETWEEN 1 AND 160),
  actor_niho_user_id text NOT NULL CHECK (length(actor_niho_user_id) BETWEEN 1 AND 256),
  seller_confirmation_method text NOT NULL CHECK (seller_confirmation_method IN ('VERBAL', 'WRITTEN')),
  seller_confirmation_checked boolean NOT NULL CHECK (seller_confirmation_checked),
  photo_rights_confirmed boolean NOT NULL CHECK (photo_rights_confirmed),
  content_fingerprint text NOT NULL CHECK (content_fingerprint ~ '^[0-9a-f]{64}$'),
  japanese_fingerprint text NOT NULL CHECK (japanese_fingerprint ~ '^[0-9a-f]{64}$'),
  english_fingerprint text NOT NULL CHECK (english_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (publication_id),
  FOREIGN KEY (publication_id, provider_id, product_id)
    REFERENCES experience_product_publications(id, provider_id, product_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_niho_user_id, provider_id, product_id, draft_version,
      content_fingerprint, japanese_fingerprint, english_fingerprint)
    REFERENCES admin_product_english_reviews
      (actor_niho_user_id, provider_id, product_id, draft_version,
       content_fingerprint, japanese_fingerprint, english_fingerprint)
    ON DELETE RESTRICT
);

CREATE INDEX admin_proxy_publication_audit_product_idx
  ON admin_proxy_publication_audit_events (provider_id, product_id, created_at DESC, id DESC);

CREATE TRIGGER admin_product_english_reviews_immutable
BEFORE UPDATE OR DELETE ON admin_product_english_reviews
FOR EACH ROW EXECUTE FUNCTION reject_admin_product_draft_audit_mutation();

CREATE TRIGGER admin_proxy_publication_audit_immutable
BEFORE UPDATE OR DELETE ON admin_proxy_publication_audit_events
FOR EACH ROW EXECUTE FUNCTION reject_admin_product_draft_audit_mutation();

-- The audit row follows the publication insert inside the same transaction.
-- A deferred check prevents any Admin publication from committing alone.
CREATE FUNCTION require_admin_proxy_publication_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.publisher_kind = 'ADMIN_PROXY' AND NOT EXISTS (
    SELECT 1
      FROM admin_proxy_publication_audit_events audit
      JOIN admin_product_english_reviews review
        ON review.provider_id = audit.provider_id
       AND review.product_id = audit.product_id
       AND review.draft_version = audit.draft_version
       AND review.actor_niho_user_id = audit.actor_niho_user_id
       AND review.content_fingerprint = audit.content_fingerprint
       AND review.japanese_fingerprint = audit.japanese_fingerprint
       AND review.english_fingerprint = audit.english_fingerprint
     WHERE audit.publication_id = NEW.id
       AND audit.provider_id = NEW.provider_id
       AND audit.product_id = NEW.product_id
       AND audit.actor_niho_user_id = NEW.published_by_admin_niho_user_id
       AND audit.draft_version = NEW.draft_version
       AND audit.sale_terms_version = NEW.sale_terms_version
       AND audit.consent_version = NEW.consent_version
  ) THEN
    RAISE EXCEPTION 'admin proxy publication requires an immutable audit event' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER experience_product_publications_admin_proxy_audit
AFTER INSERT ON experience_product_publications
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_admin_proxy_publication_audit();

COMMIT;
