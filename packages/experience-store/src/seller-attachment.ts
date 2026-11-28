import type { PoolClient } from "pg";

/*
 * Shared by the office's registration (site-sale-registration.ts, operator-only) and the host's own Stripe account registration
 * (direct-sellers.ts, the runtime): both copy the provider's just-registered seller onto its sellerless products.
 */

/**
 * Copies the provider's registered seller onto its products that have none (#704: drafts made before the provider had a
 * seller profile). Called in the transaction that registers (or confirms) the profile, after the provider inventory lock
 * that creating a draft takes too, so a draft is never created sellerless after the profile exists. The copy comes from
 * the stored profile, never from a client, and leaves the draft's version alone (its content did not change; an open
 * editor keeps its CAS token). A product that already has a seller keeps it (a different profile is SELLER_MISMATCH),
 * and so does one with an agent-sales revision (#725).
 */
export async function attachSellerToSellerlessProducts(client: PoolClient, providerId: string): Promise<number> {
  const result = await client.query(
    `UPDATE experience_products p
        SET seller_niho_account_ref=s.seller_niho_account_ref,stripe_connect_account_ref=s.stripe_connect_account_ref,
            seller_display_name=s.seller_display_name,updated_at=clock_timestamp()
       FROM experience_host_seller_profiles s
      WHERE p.provider_id=$1 AND s.provider_id=p.provider_id AND p.seller_niho_account_ref IS NULL
        -- 代理受領 (#725): a product with an agent-sales revision is sold under the host's own name and the platform account; a registered profile never replaces that.
        AND NOT EXISTS (SELECT 1 FROM experience_product_sales_plan_versions v
                         WHERE v.provider_id=p.provider_id AND v.product_id=p.id AND v.charge_mode='PLATFORM' AND v.plan='SUPPORTED_15' AND v.seller_party='PROVIDER')`,
    [providerId],
  );
  return result.rowCount ?? 0;
}
