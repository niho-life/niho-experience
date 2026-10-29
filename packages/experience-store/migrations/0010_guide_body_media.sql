BEGIN;

ALTER TABLE guide_media_assets
  ADD COLUMN public_credit text,
  ADD COLUMN web_confirmed_at timestamptz,
  ADD COLUMN web_confirmed_by_niho_user_id text,
  ADD CONSTRAINT guide_media_assets_figure_rights CHECK (
    (public_credit IS NULL AND web_confirmed_at IS NULL AND web_confirmed_by_niho_user_id IS NULL)
    OR (
      public_credit IS NOT NULL
      AND length(public_credit) BETWEEN 1 AND 300
      AND web_confirmed_at IS NOT NULL
      AND web_confirmed_by_niho_user_id IS NOT NULL
      AND length(web_confirmed_by_niho_user_id) BETWEEN 1 AND 256
    )
  );

ALTER TABLE guide_publication_media
  DROP CONSTRAINT guide_publication_media_pkey,
  ADD COLUMN slot integer NOT NULL DEFAULT 0,
  ADD COLUMN placement text NOT NULL DEFAULT 'COVER',
  ADD CONSTRAINT guide_publication_media_slot CHECK (
    (placement = 'COVER' AND slot = 0)
    OR (placement = 'FIGURE' AND slot BETWEEN 1 AND 10)
  ),
  ADD PRIMARY KEY (publication_id, slot);

ALTER TABLE guide_publication_media
  ALTER COLUMN slot DROP DEFAULT,
  ALTER COLUMN placement DROP DEFAULT;

CREATE OR REPLACE FUNCTION protect_guide_media_asset() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.article_id IS DISTINCT FROM OLD.article_id
     OR NEW.creator_niho_user_id IS DISTINCT FROM OLD.creator_niho_user_id
     OR NEW.object_key IS DISTINCT FROM OLD.object_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR OLD.state = 'REVOKED'
     OR (OLD.state = 'READY' AND NEW.state NOT IN ('READY', 'REVOKED'))
     OR (OLD.state = 'READY' AND NEW.state = 'READY' AND (
       NEW.width IS DISTINCT FROM OLD.width
       OR NEW.height IS DISTINCT FROM OLD.height
       OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
       OR NEW.ready_at IS DISTINCT FROM OLD.ready_at
       OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
     ))
     OR (OLD.state = 'UPLOADING' AND NEW.state NOT IN ('READY', 'REVOKED'))
     OR (NEW.state = 'REVOKED' AND (
       NEW.width IS DISTINCT FROM OLD.width
       OR NEW.height IS DISTINCT FROM OLD.height
       OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
       OR NEW.ready_at IS DISTINCT FROM OLD.ready_at
       OR NEW.public_credit IS DISTINCT FROM OLD.public_credit
       OR NEW.web_confirmed_at IS DISTINCT FROM OLD.web_confirmed_at
       OR NEW.web_confirmed_by_niho_user_id IS DISTINCT FROM OLD.web_confirmed_by_niho_user_id
     ))
     OR (OLD.public_credit IS NOT NULL AND (
       NEW.public_credit IS DISTINCT FROM OLD.public_credit
       OR NEW.web_confirmed_at IS DISTINCT FROM OLD.web_confirmed_at
       OR NEW.web_confirmed_by_niho_user_id IS DISTINCT FROM OLD.web_confirmed_by_niho_user_id
     ))
     OR (OLD.public_credit IS NULL AND NEW.public_credit IS NOT NULL AND OLD.state <> 'READY')
     OR (OLD.public_credit IS NULL AND NEW.public_credit IS NULL AND (
       NEW.web_confirmed_at IS NOT NULL OR NEW.web_confirmed_by_niho_user_id IS NOT NULL
     )) THEN
    RAISE EXCEPTION 'guide media asset identity, rights, and state are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION protect_guide_publication_media() RETURNS trigger
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
       AND (
         NEW.placement = 'COVER'
         OR (public_credit IS NOT NULL AND public_credit = NEW.public_credit)
       )
  ) THEN
    RAISE EXCEPTION 'guide publication media requires an active ready asset and figure rights'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
