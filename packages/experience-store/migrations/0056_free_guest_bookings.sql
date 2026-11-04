BEGIN;

ALTER TABLE experience_offer_prices
  DROP CONSTRAINT IF EXISTS experience_offer_prices_adult_price_amount_check,
  ADD CONSTRAINT experience_offer_prices_adult_price_amount_check
    CHECK (adult_price_amount = 0 OR adult_price_amount BETWEEN 50 AND 9999999999);

COMMIT;
