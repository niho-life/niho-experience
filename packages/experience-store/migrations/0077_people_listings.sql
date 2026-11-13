BEGIN;

-- 街の人 (#564, 日本語サイトの「街の人」の一覧と人ごとのページ). Who is shown there is decided here, by the Admin, and is
-- not the same as who delivers an experience or who helps run NIHO behind the scenes (#528): a provider's public profile
-- (name, photo, bio) is reused, and this row only says "show this person on 街の人" and adds what that page needs
-- (role, area, a line in their own words, an introduction, an order). A person with no experience can be listed too
-- (introduction only, or someone the office puts people in touch with); one with experiences shows them on their page.
--
-- Withdrawing deletes the row. The public readers also require the public profile and a READY, rights-confirmed provider
-- photo, so a photo whose permission is withdrawn takes the person off every page without anyone remembering to.
CREATE TABLE experience_people_listings (
  provider_id text PRIMARY KEY REFERENCES experience_provider_public_profiles(provider_id) ON DELETE RESTRICT,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) BETWEEN 2 AND 60),
  role_ja text NOT NULL CHECK (char_length(role_ja) BETWEEN 1 AND 80 AND role_ja !~ '^\s|\s$' AND role_ja !~ '[[:cntrl:]]'),
  area_ja text NOT NULL CHECK (char_length(area_ja) BETWEEN 1 AND 40 AND area_ja !~ '^\s|\s$' AND area_ja !~ '[[:cntrl:]]'),
  -- 本人のひとこと. Optional.
  quote_ja text CHECK (quote_ja IS NULL OR (char_length(quote_ja) BETWEEN 1 AND 160 AND quote_ja !~ '^\s|\s$' AND quote_ja !~ '[[:cntrl:]]')),
  -- The introduction for this page. When null the provider's own bio (provider_host_bios.bio_ja) is shown, if any.
  intro_ja text CHECK (intro_ja IS NULL OR (char_length(intro_ja) BETWEEN 1 AND 1200 AND intro_ja !~ '^\s|\s$' AND intro_ja !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]')),
  sort_order integer NOT NULL DEFAULT 100 CHECK (sort_order BETWEEN 0 AND 9999),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by_admin_niho_user_id text NOT NULL CHECK (char_length(updated_by_admin_niho_user_id) BETWEEN 1 AND 256)
);

CREATE INDEX experience_people_listings_order_idx ON experience_people_listings (sort_order, slug);

COMMIT;
