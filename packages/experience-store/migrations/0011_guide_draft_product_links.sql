BEGIN;

-- Mutable article-scoped selections. Public links are copied into the existing immutable
-- publication snapshot inside GuideRepository.commitPublication.
CREATE TABLE guide_draft_product_links (
  article_id text NOT NULL REFERENCES guide_articles(id) ON DELETE RESTRICT,
  provider_id text NOT NULL,
  product_id text NOT NULL,
  display_order smallint NOT NULL CHECK (display_order BETWEEN 1 AND 3),
  PRIMARY KEY (article_id, provider_id, product_id),
  UNIQUE (article_id, display_order),
  FOREIGN KEY (provider_id, product_id)
    REFERENCES experience_products(provider_id, id) ON DELETE RESTRICT
);

COMMIT;
