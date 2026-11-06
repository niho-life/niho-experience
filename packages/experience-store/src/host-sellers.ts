/*
 * 販売者 for Experience host accounts (ADR 0003 slice 3, migration 0065). A seller registered for host accounts has no
 * NIHO legacy Connect lookup key (`legacy_provider_id` is NULL) and its `seller_niho_account_ref` is a provider-scoped
 * seller reference, `sel_` + 32 lower-case hex, minted once when Admin/ops register the profile. The reference names the
 * seller (the provider's business), never a person: products, publications and readiness snapshots keep matching it when
 * the provider's OWNER changes. Its shape never matches a NIHO user ID or a host account ID (`hst_`).
 *
 * The seller's OWNER is then any active OWNER membership held by an ACTIVE host account. A seller mapped to a NIHO user
 * keeps the old rule: the OWNER is the membership whose NIHO user ID is the seller reference itself.
 */

const HOST_SELLER_REF = /^sel_[0-9a-f]{32}$/;
/** The same rule in SQL (also the CHECK of migration 0065). */
export const HOST_SELLER_REF_SQL = "^sel_[0-9a-f]{32}$";
/** A host account ID in SQL (host_accounts.id's CHECK). */
export const HOST_ACCOUNT_ID_SQL = "^hst_[0-9a-f]{32}$";

/** A host-account seller's reference: `sel_` and 32 lower-case hex digits. */
export const isHostSellerRef = (value: unknown): value is string => typeof value === "string" && HOST_SELLER_REF.test(value);

/** True for a value that has the shape of an Experience host account or host-account seller reference. */
export const hasExperienceActorShape = (value: unknown): boolean => typeof value === "string" && /^(?:hst|sel)_[0-9a-f]{32}$/.test(value);

/**
 * SQL that is true when `membership` (a provider_memberships row, already restricted to an active OWNER of the profile's
 * provider) is the seller OWNER of `profile` (an experience_host_seller_profiles row): the NIHO user the profile maps, or,
 * for a host-account seller, an ACTIVE host account.
 */
export function sellerOwnerSql(membership: string, profile: string): string {
  return `(${profile}.seller_niho_account_ref=${membership}.niho_user_id
    OR (${profile}.legacy_provider_id IS NULL AND ${profile}.seller_niho_account_ref ~ '${HOST_SELLER_REF_SQL}'
      AND ${membership}.niho_user_id ~ '${HOST_ACCOUNT_ID_SQL}'
      AND EXISTS (SELECT 1 FROM host_accounts seller_owner_account
                   WHERE seller_owner_account.id=${membership}.niho_user_id AND seller_owner_account.status='ACTIVE')))`;
}
