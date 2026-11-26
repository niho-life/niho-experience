BEGIN;

CREATE TABLE experience_provider_member_profiles (
  provider_id text NOT NULL,
  member_id text NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  name_ja text NOT NULL CHECK (char_length(name_ja) BETWEEN 1 AND 40),
  content_ja jsonb NOT NULL,
  content_en jsonb,
  english_source_fingerprint text CHECK (english_source_fingerprint ~ '^[0-9a-f]{64}$'),
  photo_provider_id text,
  photo_asset_id uuid,
  photo_alt_ja text,
  photo_credit text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by text NOT NULL,
  updated_by_kind text NOT NULL CHECK (updated_by_kind IN ('MEMBER','ADMIN')),
  pending_consent_method text CHECK (pending_consent_method IN ('ORAL','WRITTEN')),
  pending_consent_at timestamptz,
  pending_consent_by text,
  PRIMARY KEY (provider_id, member_id),
  FOREIGN KEY (provider_id, member_id) REFERENCES provider_memberships(provider_id, niho_user_id) ON DELETE RESTRICT,
  FOREIGN KEY (photo_asset_id, photo_provider_id) REFERENCES experience_provider_media_assets(id, provider_id) MATCH FULL ON DELETE RESTRICT,
  CHECK ((content_en IS NULL) = (english_source_fingerprint IS NULL)),
  CHECK ((photo_asset_id IS NULL AND photo_alt_ja IS NULL AND photo_credit IS NULL)
      OR (photo_asset_id IS NOT NULL AND photo_alt_ja IS NOT NULL AND char_length(photo_alt_ja) BETWEEN 1 AND 500)),
  CHECK ((pending_consent_method IS NULL AND pending_consent_at IS NULL AND pending_consent_by IS NULL)
      OR (pending_consent_method IS NOT NULL AND pending_consent_at IS NOT NULL AND pending_consent_by IS NOT NULL))
);

CREATE TABLE experience_provider_member_profile_publications (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL,
  member_id text NOT NULL,
  draft_version bigint NOT NULL CHECK (draft_version > 0),
  name_ja text NOT NULL CHECK (char_length(name_ja) BETWEEN 1 AND 40),
  content_ja jsonb NOT NULL,
  content_en jsonb,
  photo_provider_id text NOT NULL,
  photo_asset_id uuid NOT NULL,
  photo_alt_ja text NOT NULL,
  photo_credit text,
  consent_method text NOT NULL CHECK (consent_method IN ('SELF','ORAL','WRITTEN')),
  consent_at timestamptz NOT NULL,
  consent_recorded_by text NOT NULL,
  photo_consented_at timestamptz NOT NULL,
  verified_by_admin text,
  verified_at timestamptz,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  withdrawn_at timestamptz,
  photo_consent_withdrawn_at timestamptz,
  FOREIGN KEY (provider_id, member_id) REFERENCES experience_provider_member_profiles(provider_id, member_id) ON DELETE RESTRICT,
  FOREIGN KEY (photo_asset_id, photo_provider_id) REFERENCES experience_provider_media_assets(id, provider_id) ON DELETE RESTRICT,
  CHECK ((consent_method = 'SELF' AND consent_recorded_by = member_id AND verified_by_admin IS NULL AND verified_at IS NULL)
      OR (consent_method IN ('ORAL','WRITTEN') AND verified_by_admin IS NOT NULL AND verified_at IS NOT NULL)),
  CHECK (photo_consent_withdrawn_at IS NULL OR withdrawn_at IS NOT NULL)
);

CREATE UNIQUE INDEX experience_member_profile_current_idx ON experience_provider_member_profile_publications (provider_id, member_id)
  WHERE withdrawn_at IS NULL;
CREATE INDEX experience_member_profile_photo_idx ON experience_provider_member_profile_publications (photo_asset_id)
  WHERE withdrawn_at IS NULL;

CREATE TABLE experience_provider_member_proxy_permissions (
  provider_id text NOT NULL,
  member_id text NOT NULL,
  method text NOT NULL CHECK (method IN ('SELF','ORAL','WRITTEN')),
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  granted_by text NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (provider_id, member_id),
  FOREIGN KEY (provider_id, member_id) REFERENCES provider_memberships(provider_id, niho_user_id) ON DELETE RESTRICT,
  CHECK (method <> 'SELF' OR granted_by = member_id)
);

CREATE TABLE experience_product_member_profiles (
  product_provider_id text NOT NULL,
  product_id text NOT NULL,
  profile_provider_id text NOT NULL,
  member_id text NOT NULL,
  sort_order integer NOT NULL CHECK (sort_order BETWEEN 0 AND 2),
  PRIMARY KEY (product_provider_id, product_id, sort_order),
  UNIQUE (product_provider_id, product_id, profile_provider_id, member_id),
  FOREIGN KEY (product_provider_id, product_id) REFERENCES experience_products(provider_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (profile_provider_id, member_id) REFERENCES experience_provider_member_profiles(provider_id, member_id) ON DELETE RESTRICT
);

CREATE INDEX experience_product_member_profile_idx ON experience_product_member_profiles (profile_provider_id, member_id);

-- The old copy is a draft until the person consents to publish the exact version and its photo.
INSERT INTO experience_provider_member_profiles
  (provider_id, member_id, name_ja, content_ja, photo_provider_id, photo_asset_id, photo_alt_ja, photo_credit, updated_at, updated_by, updated_by_kind)
SELECT provider_id, member_id, name_ja, jsonb_build_object('role', role_ja, 'area', area_ja, 'quote', quote_ja, 'intro', intro_ja),
       photo_provider_id, photo_asset_id, photo_alt_ja, photo_credit, updated_at, updated_by_admin_niho_user_id, 'ADMIN'
  FROM experience_people_listings WHERE member_id IS NOT NULL;

WITH ranked AS (
  SELECT link.product_provider_id, link.product_id, listing.provider_id, listing.member_id,
         row_number() OVER (
           PARTITION BY link.product_provider_id, link.product_id
           ORDER BY listing.sort_order, listing.slug COLLATE "C"
         ) - 1 AS position
    FROM experience_people_listing_experiences link
    JOIN experience_people_listings listing ON listing.id = link.listing_id
   WHERE listing.member_id IS NOT NULL
)
INSERT INTO experience_product_member_profiles (product_provider_id, product_id, profile_provider_id, member_id, sort_order)
SELECT product_provider_id, product_id, provider_id, member_id, position::int FROM ranked WHERE position < 3;

-- Preserve legacy text for rows whose person was never identified. The listing only manages placement.
ALTER TABLE experience_people_listings
  ALTER COLUMN name_ja DROP NOT NULL,
  ALTER COLUMN role_ja DROP NOT NULL,
  ALTER COLUMN area_ja DROP NOT NULL;
UPDATE experience_people_listings SET name_ja=NULL,role_ja=NULL,area_ja=NULL,quote_ja=NULL,intro_ja=NULL,
  photo_provider_id=NULL,photo_asset_id=NULL,photo_alt_ja=NULL,photo_credit=NULL WHERE member_id IS NOT NULL;
-- Old links remain for pre-migration editorial history. Public and Admin writes use the new relations.
COMMIT;
