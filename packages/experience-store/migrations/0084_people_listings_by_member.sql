BEGIN;

-- 街の人は「提供者 × メンバー（ホストアカウント）」に付ける (#589, owner decision 2026-11-14). Until now a listing was one provider's
-- (0077: provider_id was the key), so showing a person meant making a provider for them. A provider is the owner of content,
-- the people who sign in belong to it (provider_memberships), and a 街の人 listing is one of those people: it has its own
-- name, photo, role, area, line, introduction and linked experiences, and it is shown only while that person is a current
-- OWNER or COHOST of the provider. A message from the person's page lands in the provider's inbox addressed to them.
--
-- The listing gets its own id. provider_id is now "the provider the person belongs to" (where a message goes); member_id is
-- the member's account (provider_memberships.niho_user_id: a host account id) and is NULL for a draft that waits for the
-- person's account. Existing rows keep their provider and become drafts (member_id NULL) until the Admin moves them.

-- Links reference the listing by id.
ALTER TABLE experience_people_listing_experiences DROP CONSTRAINT experience_people_listing_experiences_listing_provider_id_fkey;
ALTER TABLE experience_people_listing_experiences DROP CONSTRAINT experience_people_listing_experiences_pkey;

ALTER TABLE experience_people_listings ADD COLUMN id text;
UPDATE experience_people_listings SET id = 'plg_' || replace(gen_random_uuid()::text, '-', '');
ALTER TABLE experience_people_listings ALTER COLUMN id SET NOT NULL;
ALTER TABLE experience_people_listings DROP CONSTRAINT experience_people_listings_provider_id_fkey;
ALTER TABLE experience_people_listings DROP CONSTRAINT experience_people_listings_pkey;
ALTER TABLE experience_people_listings ADD CONSTRAINT experience_people_listings_pkey PRIMARY KEY (id);
ALTER TABLE experience_people_listings ADD CONSTRAINT experience_people_listings_id_check CHECK (id ~ '^plg_[0-9a-f]{32}$');
ALTER TABLE experience_people_listings
  ADD CONSTRAINT experience_people_listings_provider_fkey FOREIGN KEY (provider_id) REFERENCES experience_providers(id) ON DELETE RESTRICT;

ALTER TABLE experience_people_listing_experiences ADD COLUMN listing_id text;
UPDATE experience_people_listing_experiences link
   SET listing_id = listing.id
  FROM experience_people_listings listing
 WHERE listing.provider_id = link.listing_provider_id;
ALTER TABLE experience_people_listing_experiences ALTER COLUMN listing_id SET NOT NULL;
ALTER TABLE experience_people_listing_experiences DROP COLUMN listing_provider_id;
ALTER TABLE experience_people_listing_experiences
  ADD CONSTRAINT experience_people_listing_experiences_pkey PRIMARY KEY (listing_id, product_provider_id, product_id);
ALTER TABLE experience_people_listing_experiences
  ADD CONSTRAINT experience_people_listing_experiences_listing_fkey FOREIGN KEY (listing_id) REFERENCES experience_people_listings(id) ON DELETE CASCADE;

-- The person's own name, photo and (below) introduction no longer come from the provider's public profile, which may be a
-- business. Existing rows copy what they showed, so nothing on the pages changes at the migration.
ALTER TABLE experience_people_listings
  ADD COLUMN member_id text,
  ADD COLUMN name_ja text,
  ADD COLUMN photo_provider_id text,
  ADD COLUMN photo_asset_id uuid,
  ADD COLUMN photo_alt_ja text,
  ADD COLUMN photo_credit text;

UPDATE experience_people_listings listing
   SET name_ja = btrim(left(btrim(regexp_replace(profile.public_display_name, '[[:cntrl:]]', '', 'g')), 40))
  FROM experience_provider_public_profiles profile
 WHERE profile.provider_id = listing.provider_id;
UPDATE experience_people_listings SET name_ja = provider_id WHERE name_ja IS NULL OR name_ja = '';

UPDATE experience_people_listings listing
   SET photo_provider_id = selection.provider_id, photo_asset_id = selection.asset_id,
       photo_alt_ja = selection.alt_text_ja, photo_credit = selection.public_credit
  FROM experience_provider_media_selection selection
 WHERE selection.provider_id = listing.provider_id AND selection.placement = 'PROVIDER_PHOTO';

-- A person with no introduction of their own showed the provider's bio: keep it as their own.
UPDATE experience_people_listings listing
   SET intro_ja = bio.bio_ja
  FROM provider_host_bios bio
 WHERE bio.provider_id = listing.provider_id AND listing.intro_ja IS NULL;

-- The provider's own experiences used to appear on the page without being chosen: link them, so the pages stay the same.
INSERT INTO experience_people_listing_experiences (listing_id, product_provider_id, product_id, sort_order)
SELECT listing.id, product.provider_id, product.id, LEAST(900 + (row_number() OVER (PARTITION BY listing.id ORDER BY product.slug))::int, 999)
  FROM experience_people_listings listing
  JOIN experience_products product ON product.provider_id = listing.provider_id AND product.status <> 'ARCHIVED'
ON CONFLICT DO NOTHING;

ALTER TABLE experience_people_listings
  ALTER COLUMN name_ja SET NOT NULL,
  ADD CONSTRAINT experience_people_listings_name_check CHECK (char_length(name_ja) BETWEEN 1 AND 40 AND name_ja !~ '^\s|\s$' AND name_ja !~ '[[:cntrl:]]'),
  ADD CONSTRAINT experience_people_listings_member_fkey
    FOREIGN KEY (provider_id, member_id) REFERENCES provider_memberships(provider_id, niho_user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT experience_people_listings_photo_fkey
    FOREIGN KEY (photo_asset_id, photo_provider_id) REFERENCES experience_provider_media_assets(id, provider_id) ON DELETE RESTRICT,
  ADD CONSTRAINT experience_people_listings_photo_check CHECK (
    (photo_asset_id IS NULL AND photo_provider_id IS NULL AND photo_alt_ja IS NULL AND photo_credit IS NULL)
    OR (photo_asset_id IS NOT NULL AND photo_provider_id IS NOT NULL AND photo_alt_ja IS NOT NULL
        AND char_length(photo_alt_ja) BETWEEN 1 AND 500 AND (photo_credit IS NULL OR char_length(photo_credit) BETWEEN 1 AND 300))
  );

-- One listing per member of a provider (drafts without a member are not bound by it).
CREATE UNIQUE INDEX experience_people_listings_member_idx
  ON experience_people_listings (provider_id, member_id) WHERE member_id IS NOT NULL;
CREATE INDEX experience_people_listings_photo_idx ON experience_people_listings (photo_asset_id) WHERE photo_asset_id IS NOT NULL;

-- A message from a person's page is addressed to the listing (and keeps the name it was addressed to, for when the listing is
-- withdrawn or renamed later). Only person threads (no product, no booking) have them.
ALTER TABLE guest_question_threads
  ADD COLUMN person_listing_id text REFERENCES experience_people_listings(id) ON DELETE SET NULL,
  ADD COLUMN person_name text CHECK (person_name IS NULL OR char_length(person_name) BETWEEN 1 AND 40);
ALTER TABLE guest_question_threads
  ADD CONSTRAINT guest_question_threads_person_check CHECK (
    (person_listing_id IS NULL AND person_name IS NULL) OR (product_id IS NULL AND booking_id IS NULL)
  );
CREATE INDEX guest_question_threads_person_listing_idx
  ON guest_question_threads (person_listing_id, created_at) WHERE person_listing_id IS NOT NULL;

COMMIT;
