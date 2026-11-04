/**
 * Static SQL shared by every anonymous Experience publication reader. Keep user input in query
 * parameters: these fragments contain table and column names only.
 */
export const VISIBLE_PUBLICATION_COLUMNS = `
  p.id AS publication_id,p.provider_id,p.product_id,p.slug,p.public_title,p.content,p.currency,
  p.unit_amount,p.seller_display_name,p.published_at,s.first_published_at`;

export const VISIBLE_PUBLICATIONS_CTE = `
  visible_publications AS (
    SELECT ${VISIBLE_PUBLICATION_COLUMNS}
      FROM experience_product_publication_states s
      JOIN experience_product_publications p ON p.id=s.current_publication_id
      JOIN experience_products product ON product.provider_id=s.provider_id AND product.id=s.product_id
     WHERE s.self_stopped_at IS NULL
       AND s.operations_suspended_at IS NULL
       AND s.owner_resume_required=false
       AND product.status='PUBLISHED'
       AND NOT EXISTS (
         SELECT 1 FROM experience_product_publication_media media
         JOIN experience_product_media_assets asset ON asset.id=media.asset_id
          WHERE media.publication_id=p.id AND asset.state<>'READY'
       )
  )`;

/** Current, historical and draft slugs owned by a native host seller remain reserved. */
export const CLAIMED_PUBLICATION_SLUGS_CTE = `
  claimed_publication_slugs AS (
    SELECT product.slug
      FROM experience_products product
      JOIN experience_host_seller_profiles seller ON seller.provider_id=product.provider_id
    UNION
    SELECT publication.slug
      FROM experience_product_publications publication
      JOIN experience_host_seller_profiles seller ON seller.provider_id=publication.provider_id
  )`;
