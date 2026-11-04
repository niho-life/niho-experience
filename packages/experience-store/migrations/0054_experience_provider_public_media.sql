BEGIN;

-- Provider identity media is shared by the seller's products. Product galleries
-- remain separately versioned with each immutable product publication.
CREATE TABLE experience_provider_media_state (
  provider_id text PRIMARY KEY REFERENCES experience_providers(id) ON DELETE RESTRICT,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE experience_provider_media_assets (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL REFERENCES experience_providers(id) ON DELETE RESTRICT,
  object_key text NOT NULL UNIQUE CHECK (length(object_key) BETWEEN 1 AND 512),
  source_ref_hash text NOT NULL CHECK (source_ref_hash ~ '^[0-9a-f]{64}$'),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 2400),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 2400),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  rights_confirmed_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'READY' CHECK (state IN ('READY','REVOKED')),
  imported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, provider_id)
);

CREATE TABLE experience_provider_media_selection (
  provider_id text NOT NULL REFERENCES experience_providers(id) ON DELETE RESTRICT,
  placement text NOT NULL CHECK (placement IN ('PROVIDER_PHOTO','BUSINESS_LOGO')),
  asset_id uuid NOT NULL,
  alt_text text NOT NULL CHECK (length(alt_text) BETWEEN 1 AND 500),
  alt_text_ja text NOT NULL CHECK (length(alt_text_ja) BETWEEN 1 AND 500),
  public_credit text CHECK (public_credit IS NULL OR length(public_credit) BETWEEN 1 AND 300),
  PRIMARY KEY (provider_id, placement),
  UNIQUE (provider_id, asset_id),
  FOREIGN KEY (asset_id, provider_id)
    REFERENCES experience_provider_media_assets(id, provider_id) ON DELETE RESTRICT
);

CREATE INDEX experience_provider_media_selection_asset_idx
  ON experience_provider_media_selection (asset_id);

COMMIT;
