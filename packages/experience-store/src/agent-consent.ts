import type { PoolClient } from "pg";
import type { DbRow } from "./rows.ts";

/*
 * What decides whether an agent-sales product may be sold or opened (#725): the OWNER's consent and the host's public seller
 * disclosure. Kept apart from agent-sales.ts so the sale readers (guest-bookings.ts, experience-publication.ts) import no
 * store that imports them back.
 */

/** The consent that counts now for `sellerRef`: active, and given by a host account that is still an active OWNER of the provider. */
export async function countingAgentConsent(client: Pick<PoolClient, "query">, providerId: string, sellerRef: string, lock = false): Promise<DbRow | null> {
  const found = await client.query<DbRow>(
    `SELECT consent.seller_ref,consent.consent_version,consent.consented_at,consent.consented_by_host_account_id
       FROM provider_agent_sales_consents consent
       JOIN provider_memberships membership ON membership.provider_id=consent.provider_id
        AND membership.niho_user_id=consent.consented_by_host_account_id AND membership.active=true AND membership.role='OWNER'
       JOIN host_accounts account ON account.id=consent.consented_by_host_account_id AND account.status='ACTIVE'
      WHERE consent.provider_id=$1 AND consent.seller_ref=$2 AND consent.revoked_at IS NULL${lock ? " FOR SHARE OF consent" : ""}`,
    [providerId, sellerRef],
  );
  return found.rows[0] ?? null;
}

/** The provider's NATIVE seller disclosure name when it is public now (not withdrawn), else null. */
export async function nativeDisclosureName(client: Pick<PoolClient, "query">, providerId: string, lock = false): Promise<string | null> {
  const found = await client.query<DbRow>(
    `SELECT seller_display_name FROM provider_seller_disclosures
      WHERE provider_id=$1 AND method='NATIVE' AND withdrawn_at IS NULL${lock ? " FOR SHARE" : ""}`,
    [providerId],
  );
  return found.rows[0] ? String(found.rows[0].seller_display_name) : null;
}
