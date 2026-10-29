BEGIN;

ALTER TABLE guide_articles
  ADD CONSTRAINT guide_articles_id_creator_unique UNIQUE (id, creator_niho_user_id);

CREATE TABLE guide_media_assets (
  id uuid PRIMARY KEY,
  article_id text NOT NULL,
  creator_niho_user_id text NOT NULL CHECK (length(creator_niho_user_id) BETWEEN 1 AND 256),
  object_key text NOT NULL UNIQUE CHECK (length(object_key) BETWEEN 1 AND 512),
  state text NOT NULL DEFAULT 'UPLOADING' CHECK (state IN ('UPLOADING', 'READY', 'REVOKED')),
  width integer CHECK (width BETWEEN 1 AND 2400),
  height integer CHECK (height BETWEEN 1 AND 2400),
  byte_size integer CHECK (byte_size BETWEEN 1 AND 10485760),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ready_at timestamptz,
  revoked_at timestamptz,
  UNIQUE (article_id, id),
  UNIQUE (article_id, creator_niho_user_id, id),
  FOREIGN KEY (article_id, creator_niho_user_id)
    REFERENCES guide_articles(id, creator_niho_user_id) ON DELETE RESTRICT,
  CHECK (
    (state = 'UPLOADING' AND width IS NULL AND height IS NULL AND byte_size IS NULL AND ready_at IS NULL AND revoked_at IS NULL)
    OR (state = 'READY' AND width IS NOT NULL AND height IS NOT NULL AND byte_size IS NOT NULL AND ready_at IS NOT NULL AND revoked_at IS NULL)
    OR (state = 'REVOKED' AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX guide_media_assets_article_created_idx
  ON guide_media_assets (article_id, created_at DESC);

ALTER TABLE guide_articles
  ADD COLUMN cover_asset_id uuid,
  ADD COLUMN cover_alt text,
  ADD COLUMN cover_credit text,
  ADD COLUMN cover_web_confirmed boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT guide_articles_cover_asset_fk
    FOREIGN KEY (id, creator_niho_user_id, cover_asset_id)
    REFERENCES guide_media_assets(article_id, creator_niho_user_id, id)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT guide_articles_cover_fields CHECK (
    (cover_asset_id IS NULL AND cover_alt IS NULL AND cover_credit IS NULL AND cover_web_confirmed = false)
    OR (
      cover_asset_id IS NOT NULL
      AND cover_alt IS NOT NULL
      AND cover_credit IS NOT NULL
      AND length(cover_alt) BETWEEN 1 AND 300
      AND length(cover_credit) BETWEEN 1 AND 300
    )
  );

CREATE TABLE guide_publication_media (
  article_id text NOT NULL,
  publication_id bigint PRIMARY KEY,
  asset_id uuid NOT NULL,
  alt_text text NOT NULL CHECK (length(alt_text) BETWEEN 1 AND 300),
  public_credit text NOT NULL CHECK (length(public_credit) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (article_id, publication_id)
    REFERENCES guide_publications(article_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (article_id, asset_id)
    REFERENCES guide_media_assets(article_id, id) ON DELETE RESTRICT
);

CREATE INDEX guide_publication_media_asset_idx
  ON guide_publication_media (asset_id, publication_id);

CREATE FUNCTION protect_guide_media_asset() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.article_id IS DISTINCT FROM OLD.article_id
     OR NEW.creator_niho_user_id IS DISTINCT FROM OLD.creator_niho_user_id
     OR NEW.object_key IS DISTINCT FROM OLD.object_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR OLD.state = 'REVOKED'
     OR (OLD.state = 'READY' AND NEW.state <> 'REVOKED')
     OR (NEW.state = 'REVOKED' AND (
       NEW.width IS DISTINCT FROM OLD.width
       OR NEW.height IS DISTINCT FROM OLD.height
       OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
       OR NEW.ready_at IS DISTINCT FROM OLD.ready_at
     ))
     OR (OLD.state = 'UPLOADING' AND NEW.state NOT IN ('READY', 'REVOKED')) THEN
    RAISE EXCEPTION 'guide media asset identity and state are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guide_media_assets_protect
BEFORE UPDATE OR DELETE ON guide_media_assets
FOR EACH ROW EXECUTE FUNCTION protect_guide_media_asset();

CREATE FUNCTION protect_guide_publication_media() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'guide publication media snapshots are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM guide_publications WHERE id = NEW.publication_id AND sealed) THEN
    RAISE EXCEPTION 'sealed guide publication media snapshots are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM guide_media_assets
     WHERE id = NEW.asset_id AND article_id = NEW.article_id AND state = 'READY'
  ) THEN
    RAISE EXCEPTION 'guide publication media requires an active ready asset'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guide_publication_media_protect
BEFORE INSERT OR UPDATE OR DELETE ON guide_publication_media
FOR EACH ROW EXECUTE FUNCTION protect_guide_publication_media();

COMMIT;
