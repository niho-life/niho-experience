/**
 * Static SQL shared by every anonymous Experience publication reader. Keep user input in query
 * parameters: these fragments contain table and column names only.
 *
 * These are PAGE readers (#705): a page is public from the state's current_publication_id, whether or not bookings are
 * open. Whether it can be booked is `booking_available` (the state's booking_publication_id names this very version);
 * nothing here may be used to admit a booking.
 */
export const VISIBLE_PUBLICATION_COLUMNS = `
  p.id AS publication_id,p.provider_id,p.product_id,p.draft_version,p.publisher_kind,
  p.slug,p.public_title,p.content,p.currency,p.unit_amount,
  -- The legal seller is shown only while bookings are open on this very version (#705); a page without bookings has none.
  CASE WHEN s.booking_publication_id=p.id AND product.status='PUBLISHED' THEN p.seller_display_name END AS seller_display_name,
  -- Actually taking bookings: this CTE already excludes a stopped, suspended or restart-required listing.
  (s.booking_publication_id=p.id AND product.status='PUBLISHED') AS booking_available,
  p.published_at,s.first_published_at,
  (SELECT jsonb_build_object(
      'contentFingerprint',audit.content_fingerprint,
      'japaneseFingerprint',audit.japanese_fingerprint,
      'englishFingerprint',audit.english_fingerprint
    )
     FROM admin_proxy_publication_audit_events audit
    WHERE audit.publication_id=p.id AND audit.provider_id=p.provider_id AND audit.product_id=p.product_id
      AND audit.draft_version=p.draft_version AND audit.actor_niho_user_id=p.published_by_admin_niho_user_id
  ) AS admin_proxy_review`;

export const VISIBLE_PUBLICATIONS_CTE = `
  visible_publications AS (
    SELECT ${VISIBLE_PUBLICATION_COLUMNS}
      FROM experience_product_publication_states s
      JOIN experience_product_publications p ON p.id=s.current_publication_id
      JOIN experience_products product ON product.provider_id=s.provider_id AND product.id=s.product_id
     WHERE s.self_stopped_at IS NULL
       AND s.operations_suspended_at IS NULL
       AND s.owner_resume_required=false
       AND product.status<>'ARCHIVED'
       AND NOT EXISTS (
         SELECT 1 FROM experience_product_publication_media media
         JOIN experience_product_media_assets asset ON asset.id=media.asset_id
          WHERE media.publication_id=p.id AND asset.state<>'READY'
       )
  )`;

/**
 * Current, historical and draft slugs of a native Experience provider remain reserved (so a same-slug legacy NIHO page
 * cannot become visible again): a provider with a seller profile, a provider with a host account member (it may have no
 * seller yet, #705), and every slug that was ever published here.
 */
export const CLAIMED_PUBLICATION_SLUGS_CTE = `
  claimed_publication_slugs AS (
    SELECT product.slug
      FROM experience_products product
     WHERE EXISTS (SELECT 1 FROM experience_host_seller_profiles seller WHERE seller.provider_id=product.provider_id)
        OR EXISTS (SELECT 1 FROM provider_memberships member
                     JOIN host_accounts account ON account.id=member.niho_user_id
                    WHERE member.provider_id=product.provider_id)
        OR EXISTS (SELECT 1 FROM experience_product_publications ever
                    WHERE ever.provider_id=product.provider_id AND ever.product_id=product.id)
    UNION
    SELECT publication.slug
      FROM experience_product_publications publication
  )`;
