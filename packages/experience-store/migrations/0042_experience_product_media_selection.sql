BEGIN;

-- Keep uploaded gallery assets and already-published media immutable. This
-- product-scoped selection is the mutable draft gallery; seller profile media
-- has its own provider-scoped lifecycle in 0043.
ALTER TABLE experience_product_publication_media
  ADD COLUMN placement text NOT NULL DEFAULT 'GALLERY'
    CHECK (placement = 'GALLERY'),
  ADD COLUMN source_position integer NOT NULL DEFAULT 0
    CHECK (source_position BETWEEN 0 AND 999),
  ADD COLUMN alt_text_ja text NOT NULL DEFAULT ''
    CHECK (length(alt_text_ja) <= 500);

UPDATE experience_product_publication_media
   SET source_position=position;

ALTER TABLE experience_product_media_assets
  DROP CONSTRAINT experience_product_media_assets_source_position_check,
  ADD CONSTRAINT experience_product_media_assets_source_position_check
    CHECK (source_position BETWEEN 0 AND 999);

CREATE TABLE experience_product_media_selection (
  provider_id text NOT NULL,
  product_id text NOT NULL,
  asset_id uuid NOT NULL,
  placement text NOT NULL CHECK (placement IN ('GALLERY','PROVIDER_PHOTO','BUSINESS_LOGO')),
  position integer NOT NULL CHECK (position BETWEEN 0 AND 19),
  alt_text text NOT NULL CHECK (length(alt_text) <= 500),
  alt_text_ja text NOT NULL CHECK (length(alt_text_ja) <= 500),
  public_credit text CHECK (public_credit IS NULL OR length(public_credit) BETWEEN 1 AND 300),
  PRIMARY KEY (provider_id, product_id, asset_id),
  UNIQUE (provider_id, product_id, placement, position),
  FOREIGN KEY (asset_id, provider_id, product_id)
    REFERENCES experience_product_media_assets(id, provider_id, product_id) ON DELETE RESTRICT,
  CHECK ((placement = 'GALLERY') OR position = 0)
);

INSERT INTO experience_product_media_selection
  (provider_id,product_id,asset_id,placement,position,alt_text,alt_text_ja,public_credit)
SELECT provider_id,product_id,id,'GALLERY',source_position,alt_text,'',public_credit
  FROM experience_product_media_assets
 WHERE state='READY';

COMMIT;
