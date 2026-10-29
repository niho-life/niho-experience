BEGIN;

-- Categories are administered independently from articles. Their stable slug is the identity;
-- publication snapshots copy both labels so later edits or deactivation do not rewrite history.
CREATE TABLE guide_categories (
  slug text PRIMARY KEY CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 80),
  label_en text NOT NULL CHECK (length(label_en) BETWEEN 1 AND 120),
  label_ja text NOT NULL CHECK (length(label_ja) BETWEEN 1 AND 120),
  display_order integer NOT NULL CHECK (display_order BETWEEN 0 AND 1000000),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX guide_categories_active_order_idx
  ON guide_categories (display_order, slug)
  WHERE active;

-- The code-backed article remains the public source until #189 migrates it.
-- Remove its reservation in the same transaction that imports the article.
CREATE TABLE guide_legacy_slug_reservations (
  slug text PRIMARY KEY CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 160)
);

INSERT INTO guide_legacy_slug_reservations (slug) VALUES ('kamakura-after-4-pm');

-- NIHO owns account identity, email verification, invitations, and acceptance. Only the stable
-- user ID of an already accepted grant is copied here; invitation email/state is deliberately absent.
CREATE TABLE guide_writer_grants (
  niho_user_id text PRIMARY KEY CHECK (length(niho_user_id) BETWEEN 1 AND 256),
  granted_by_niho_user_id text NOT NULL CHECK (length(granted_by_niho_user_id) BETWEEN 1 AND 256),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- This membership permits only article/product linking. It is intentionally separate from
-- provider_memberships and confers no product editing, booking, guest, or payout access.
CREATE TABLE guide_product_link_memberships (
  provider_id text NOT NULL REFERENCES experience_providers(id) ON DELETE RESTRICT,
  niho_user_id text NOT NULL CHECK (length(niho_user_id) BETWEEN 1 AND 256),
  granted_by_niho_user_id text NOT NULL CHECK (length(granted_by_niho_user_id) BETWEEN 1 AND 256),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, niho_user_id)
);

CREATE INDEX guide_product_link_memberships_active_user_idx
  ON guide_product_link_memberships (niho_user_id, provider_id)
  WHERE active;

CREATE TABLE guide_articles (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 160),
  creator_niho_user_id text NOT NULL CHECK (length(creator_niho_user_id) BETWEEN 1 AND 256),
  subject_kind text NOT NULL CHECK (subject_kind IN ('WRITER', 'PROVIDER')),
  subject_provider_id text REFERENCES experience_providers(id) ON DELETE RESTRICT,
  category_slug text REFERENCES guide_categories(slug) ON DELETE RESTRICT,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 110),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 160),
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'STOPPED')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (subject_kind = 'WRITER' AND subject_provider_id IS NULL)
    OR (subject_kind = 'PROVIDER' AND subject_provider_id IS NOT NULL)
  )
);

CREATE INDEX guide_articles_creator_updated_idx
  ON guide_articles (creator_niho_user_id, updated_at DESC, id);

-- A publication row is assembled privately, receives all of its product links, and is then sealed.
-- Only a sealed row can become an article's current public snapshot.
CREATE TABLE guide_publications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  article_id text NOT NULL REFERENCES guide_articles(id) ON DELETE RESTRICT,
  publication_number bigint NOT NULL CHECK (publication_number > 0),
  source_revision bigint NOT NULL CHECK (source_revision > 0),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 160),
  subject_kind text NOT NULL CHECK (subject_kind IN ('WRITER', 'PROVIDER')),
  subject_provider_id text REFERENCES experience_providers(id) ON DELETE RESTRICT,
  category_slug text NOT NULL REFERENCES guide_categories(slug) ON DELETE RESTRICT,
  category_label_en text NOT NULL CHECK (length(category_label_en) BETWEEN 1 AND 120),
  category_label_ja text NOT NULL CHECK (length(category_label_ja) BETWEEN 1 AND 120),
  category_display_order integer NOT NULL CHECK (category_display_order BETWEEN 0 AND 1000000),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 110),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 160),
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  visibility text NOT NULL CHECK (visibility IN ('PUBLIC', 'UNLISTED')),
  published_by_niho_user_id text NOT NULL CHECK (length(published_by_niho_user_id) BETWEEN 1 AND 256),
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sealed boolean NOT NULL DEFAULT false,
  UNIQUE (article_id, publication_number),
  UNIQUE (article_id, id),
  CHECK (
    (subject_kind = 'WRITER' AND subject_provider_id IS NULL)
    OR (subject_kind = 'PROVIDER' AND subject_provider_id IS NOT NULL)
  )
);

CREATE INDEX guide_publications_slug_idx ON guide_publications (slug, published_at DESC);

ALTER TABLE guide_articles
  ADD COLUMN current_publication_id bigint,
  ADD CONSTRAINT guide_articles_current_publication_fk
    FOREIGN KEY (id, current_publication_id)
    REFERENCES guide_publications(article_id, id)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT guide_articles_publication_state CHECK (
    (status = 'PUBLISHED' AND current_publication_id IS NOT NULL)
    OR (status IN ('DRAFT', 'STOPPED') AND current_publication_id IS NULL)
  );

CREATE INDEX guide_articles_current_publication_idx
  ON guide_articles (current_publication_id)
  WHERE current_publication_id IS NOT NULL;

CREATE TABLE guide_publication_product_links (
  article_id text NOT NULL,
  publication_id bigint NOT NULL,
  provider_id text NOT NULL,
  product_id text NOT NULL,
  link_created_by_niho_user_id text NOT NULL CHECK (length(link_created_by_niho_user_id) BETWEEN 1 AND 256),
  permission_basis text NOT NULL CHECK (
    permission_basis IN ('PROVIDER_MEMBERSHIP', 'GUIDE_PRODUCT_LINK_MEMBERSHIP')
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (publication_id, provider_id, product_id),
  FOREIGN KEY (article_id, publication_id)
    REFERENCES guide_publications(article_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id, product_id)
    REFERENCES experience_products(provider_id, id) ON DELETE RESTRICT
);

CREATE INDEX guide_publication_product_links_product_idx
  ON guide_publication_product_links (provider_id, product_id, publication_id);

CREATE FUNCTION protect_published_guide_slug() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.slug IS DISTINCT FROM OLD.slug
     AND EXISTS (SELECT 1 FROM guide_publications WHERE article_id = OLD.id) THEN
    RAISE EXCEPTION 'a published guide slug is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION reject_reserved_guide_slug() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM guide_legacy_slug_reservations WHERE slug = NEW.slug) THEN
    RAISE EXCEPTION 'guide slug is reserved by a code-backed article' USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guide_articles_reject_reserved_slug
BEFORE INSERT OR UPDATE OF slug ON guide_articles
FOR EACH ROW EXECUTE FUNCTION reject_reserved_guide_slug();

CREATE FUNCTION protect_guide_category_slug() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.slug IS DISTINCT FROM OLD.slug THEN
    RAISE EXCEPTION 'guide category slugs are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guide_categories_protect_slug
BEFORE UPDATE OF slug ON guide_categories
FOR EACH ROW EXECUTE FUNCTION protect_guide_category_slug();

CREATE TRIGGER guide_articles_protect_published_slug
BEFORE UPDATE OF slug ON guide_articles
FOR EACH ROW EXECUTE FUNCTION protect_published_guide_slug();

CREATE FUNCTION protect_guide_publication_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.sealed THEN
    RAISE EXCEPTION 'guide publication snapshots are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.article_id IS DISTINCT FROM OLD.article_id
     OR NEW.publication_number IS DISTINCT FROM OLD.publication_number
     OR NEW.source_revision IS DISTINCT FROM OLD.source_revision
     OR NEW.slug IS DISTINCT FROM OLD.slug
     OR NEW.subject_kind IS DISTINCT FROM OLD.subject_kind
     OR NEW.subject_provider_id IS DISTINCT FROM OLD.subject_provider_id
     OR NEW.category_slug IS DISTINCT FROM OLD.category_slug
     OR NEW.category_label_en IS DISTINCT FROM OLD.category_label_en
     OR NEW.category_label_ja IS DISTINCT FROM OLD.category_label_ja
     OR NEW.category_display_order IS DISTINCT FROM OLD.category_display_order
     OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.description IS DISTINCT FROM OLD.description
     OR NEW.content IS DISTINCT FROM OLD.content
     OR NEW.visibility IS DISTINCT FROM OLD.visibility
     OR NEW.published_by_niho_user_id IS DISTINCT FROM OLD.published_by_niho_user_id
     OR NEW.published_at IS DISTINCT FROM OLD.published_at
     OR NEW.sealed IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'guide publication snapshots may only be sealed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guide_publications_protect_snapshot
BEFORE UPDATE OR DELETE ON guide_publications
FOR EACH ROW EXECUTE FUNCTION protect_guide_publication_snapshot();

CREATE FUNCTION protect_guide_publication_links() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'guide publication links are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM guide_publications WHERE id = NEW.publication_id AND sealed) THEN
    RAISE EXCEPTION 'sealed guide publication links are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guide_publication_product_links_protect
BEFORE INSERT OR UPDATE OR DELETE ON guide_publication_product_links
FOR EACH ROW EXECUTE FUNCTION protect_guide_publication_links();

CREATE FUNCTION require_sealed_current_guide_publication() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_publication_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM guide_publications
        WHERE id = NEW.current_publication_id AND article_id = NEW.id AND sealed
     ) THEN
    RAISE EXCEPTION 'current guide publication must be a sealed snapshot of the article'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guide_articles_require_sealed_publication
BEFORE UPDATE OF current_publication_id ON guide_articles
FOR EACH ROW EXECUTE FUNCTION require_sealed_current_guide_publication();

COMMIT;
