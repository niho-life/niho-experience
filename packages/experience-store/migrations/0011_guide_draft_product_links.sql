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

-- Existing sealed publications have no recorded order. Keep their links untouched;
-- new snapshots write an ordinal, while older rows retain the former stable sort.
ALTER TABLE guide_publication_product_links
  ADD COLUMN display_order smallint CHECK (display_order BETWEEN 1 AND 3);

CREATE UNIQUE INDEX guide_publication_product_links_display_order_idx
  ON guide_publication_product_links (publication_id, display_order)
  WHERE display_order IS NOT NULL;

COMMIT;
