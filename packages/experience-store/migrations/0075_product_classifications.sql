BEGIN;

-- #529: how the Japanese site sorts and filters a product (docs/product-classification.md). One category and one area per
-- product, and a few だれと / こんな日に values. The ids are the keys of packages/experience-domain/src/classification.ts.
-- Deliberately not part of the publication snapshot: it is listing metadata the owner or the office can change at once, and
-- the public site reads it only for products it already shows. Unclassified products have no row.
CREATE TABLE experience_product_classifications (
  provider_id text NOT NULL,
  product_id text NOT NULL,
  category text CHECK (category IN ('walk', 'food', 'craft', 'zen', 'time', 'sea', 'people', 'group')),
  area text CHECK (area IN ('kamakura', 'kita', 'hase', 'zai', 'east', 'kosh', 'ofuna', 'zushi', 'hayama')),
  companions text[] NOT NULL DEFAULT '{}' CHECK (companions <@ ARRAY['solo', 'date', 'friends', 'family']::text[]),
  occasions text[] NOT NULL DEFAULT '{}' CHECK (occasions <@ ARRAY['rain', 'anniv']::text[]),
  updated_by text NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 256),
  -- Who changed it: the product's OWNER, or NIHO's office.
  updated_by_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, product_id),
  FOREIGN KEY (provider_id, product_id) REFERENCES experience_products(provider_id, id) ON DELETE RESTRICT,
  CHECK (cardinality(companions) <= 4 AND cardinality(occasions) <= 2)
);

CREATE INDEX experience_product_classifications_category_idx ON experience_product_classifications (category) WHERE category IS NOT NULL;

COMMIT;
