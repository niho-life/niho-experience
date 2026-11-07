BEGIN;

ALTER TABLE guide_articles
  DROP CONSTRAINT guide_articles_title_check,
  ADD CONSTRAINT guide_articles_title_check CHECK (length(title) BETWEEN 0 AND 110),
  DROP CONSTRAINT guide_articles_cover_fields,
  ADD CONSTRAINT guide_articles_cover_fields CHECK (
    (cover_asset_id IS NULL AND cover_alt IS NULL AND cover_credit IS NULL AND cover_web_confirmed = false)
    OR (
      cover_asset_id IS NOT NULL
      AND cover_alt IS NOT NULL
      AND cover_credit IS NOT NULL
      AND length(cover_alt) BETWEEN 0 AND 300
      AND length(cover_credit) BETWEEN 0 AND 300
    )
  ),
  DROP CONSTRAINT guide_articles_status_check,
  ADD CONSTRAINT guide_articles_status_check CHECK (status IN ('DRAFT', 'PUBLISHED', 'STOPPED', 'OPS_STOPPED')),
  DROP CONSTRAINT guide_articles_publication_state,
  ADD CONSTRAINT guide_articles_publication_state CHECK (
    (status = 'PUBLISHED' AND current_publication_id IS NOT NULL)
    OR (status IN ('DRAFT', 'STOPPED', 'OPS_STOPPED') AND current_publication_id IS NULL)
  ),
  ADD COLUMN ops_stop_reason text,
  ADD COLUMN ops_stop_contact text,
  ADD CONSTRAINT guide_articles_ops_stop_details CHECK (
    (
      status = 'OPS_STOPPED'
      AND ops_stop_reason IS NOT NULL
      AND length(ops_stop_reason) BETWEEN 1 AND 500
      AND ops_stop_contact IS NOT NULL
      AND length(ops_stop_contact) BETWEEN 1 AND 300
    )
    OR (
      status <> 'OPS_STOPPED'
      AND ops_stop_reason IS NULL
      AND ops_stop_contact IS NULL
    )
  );

ALTER TABLE guide_media_assets
  ADD COLUMN uploaded_by_actor_id text;

ALTER TABLE guide_media_assets DISABLE TRIGGER guide_media_assets_protect;

UPDATE guide_media_assets
   SET uploaded_by_actor_id = creator_niho_user_id;

ALTER TABLE guide_media_assets ENABLE TRIGGER guide_media_assets_protect;

ALTER TABLE guide_media_assets
  ALTER COLUMN uploaded_by_actor_id SET NOT NULL,
  ADD CONSTRAINT guide_media_assets_uploaded_by_actor_check
    CHECK (length(uploaded_by_actor_id) BETWEEN 1 AND 256);

CREATE OR REPLACE FUNCTION protect_guide_media_asset() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.article_id IS DISTINCT FROM OLD.article_id
     OR NEW.creator_niho_user_id IS DISTINCT FROM OLD.creator_niho_user_id
     OR NEW.uploaded_by_actor_id IS DISTINCT FROM OLD.uploaded_by_actor_id
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
    RAISE EXCEPTION 'guide media asset identity, uploader, rights, and state are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
