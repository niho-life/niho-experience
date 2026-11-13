BEGIN;

-- #585: which experiences a person on 街の人 can be met through. A listing is one provider's person, but the people the owner
-- wants to show are often individuals who run (or guide) another provider's product (a business's 禅と空手, a community
-- dinner of NIHO kamakura). This links a listing to any provider's product, apart from the provider's own products,
-- which the person's page already shows. The public readers show a link only while that product's publication is visible,
-- so a stopped or unpublished product takes itself off the page and off the card. Replaced as a whole by the Admin.
CREATE TABLE experience_people_listing_experiences (
  listing_provider_id text NOT NULL REFERENCES experience_people_listings(provider_id) ON DELETE CASCADE,
  product_provider_id text NOT NULL,
  product_id text NOT NULL,
  sort_order integer NOT NULL CHECK (sort_order BETWEEN 0 AND 999),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (listing_provider_id, product_provider_id, product_id),
  FOREIGN KEY (product_provider_id, product_id) REFERENCES experience_products(provider_id, id) ON DELETE RESTRICT
);

CREATE INDEX experience_people_listing_experiences_product_idx
  ON experience_people_listing_experiences (product_provider_id, product_id);

COMMIT;
