BEGIN;

ALTER TABLE experience_provider_media_assets
  ADD COLUMN cleanup_attempted_at timestamptz,
  ADD COLUMN object_deleted_at timestamptz;

CREATE INDEX experience_provider_media_assets_cleanup_idx
  ON experience_provider_media_assets (cleanup_attempted_at NULLS FIRST, imported_at, id)
  WHERE state = 'REVOKED' AND object_deleted_at IS NULL;

COMMIT;
