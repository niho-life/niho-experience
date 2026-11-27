-- #704 (host registration, stage 1a): an experience draft can be made and edited before its provider has a seller
-- profile (a payout account). The three seller columns of a product become NULL-able AS ONE GROUP: all NULL (a draft of
-- a provider with no seller) or all set. They are copied from the provider's seller profile when it is registered
-- (attachSellerToSellerlessProducts, in the registration transaction).
--
-- Everything that sells stays closed to a product with no seller:
--   * experience_product_publications keeps its NOT NULL seller columns (no publication can be copied from such a
--     product); provider_publication_readiness is untouched and stays seller-only; managed sales plans keep theirs.
--   * Rows with a seller are the only ones that can leave DRAFT: legacy readers (checkout, booking terms, OTA/channel
--     feeds, reviews, article links) all select status='PUBLISHED'.
-- Page-only publishing (no seller) is the next stage (#705) and replaces the second constraint then.

BEGIN;

ALTER TABLE experience_products
  ALTER COLUMN seller_niho_account_ref DROP NOT NULL,
  ALTER COLUMN stripe_connect_account_ref DROP NOT NULL,
  ALTER COLUMN seller_display_name DROP NOT NULL;

ALTER TABLE experience_products
  ADD CONSTRAINT experience_products_seller_all_or_none CHECK (
    (seller_niho_account_ref IS NULL AND stripe_connect_account_ref IS NULL AND seller_display_name IS NULL)
    OR (seller_niho_account_ref IS NOT NULL AND stripe_connect_account_ref IS NOT NULL AND seller_display_name IS NOT NULL)
  ),
  ADD CONSTRAINT experience_products_sellerless_is_draft CHECK (
    seller_niho_account_ref IS NOT NULL OR status = 'DRAFT'
  );

COMMIT;
