BEGIN;

-- An absent set preserves the legacy product.unit_amount price. Once a set is
-- present, every active schedule rule must have exactly one row; application
-- writes replace the complete set under the sale-terms CAS.
ALTER TABLE experience_product_sale_terms
  ADD COLUMN offer_prices_configured boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT experience_product_sale_terms_version_key
    UNIQUE (provider_id, product_id, version);

ALTER TABLE schedule_rules
  ADD CONSTRAINT schedule_rules_product_rule_key
    UNIQUE (provider_id, product_id, id);

CREATE TABLE experience_offer_prices (
  provider_id text NOT NULL,
  product_id text NOT NULL,
  rule_id text NOT NULL,
  adult_price_amount bigint NOT NULL CHECK (adult_price_amount BETWEEN 50 AND 9999999999),
  sale_terms_version bigint NOT NULL CHECK (sale_terms_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, product_id, rule_id),
  FOREIGN KEY (provider_id, product_id, rule_id)
    REFERENCES schedule_rules(provider_id, product_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id, product_id, sale_terms_version)
    REFERENCES experience_product_sale_terms(provider_id, product_id, version)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX experience_offer_prices_terms_idx
  ON experience_offer_prices (provider_id, product_id, sale_terms_version);

COMMIT;
