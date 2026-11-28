/*
 * 販売の種類を 1 か所で決める (Epic #700 stage 3b-1, docs/host-payouts.md「判定を 1 か所に」).
 *
 * 決済の方式 (`chargeMode`) は PLATFORM のまま、販売者が誰かを `sellerParty` で表す:
 *   MANAGED_20  NIHO が販売者（完全代行 20%）
 *   AGENT_15    ホストが販売者で、代金は NIHO が代理で受領する（サポート 15%・代理受領）
 *   DIRECT      ホストの Connect 口座への Direct charge（`chargeMode` が無い古い予約もここ）
 *   null        PLATFORM だが 20% でも代理受領でもない。拒む側に倒す。
 *
 * 古い予約の snapshot に `sellerParty` は補わない。`sellerParty` の無い PLATFORM は 20% だけだった。
 */

export type SalesKind = "MANAGED_20" | "AGENT_15" | "DIRECT";

export interface SalesKindInput {
  readonly chargeMode?: "PLATFORM" | "CONNECT_DIRECT" | null | undefined;
  readonly salesPlan?: "MANAGED_20" | "SUPPORTED_15" | "INDEPENDENT_10" | null | undefined;
  readonly sellerParty?: "NIHO" | "PROVIDER" | null | undefined;
  readonly feeBasisPoints?: number | null | undefined;
}

export function salesKindOf(seller: SalesKindInput | null | undefined): SalesKind | null {
  if (seller === null || seller === undefined) return null;
  const { chargeMode, salesPlan, sellerParty, feeBasisPoints } = seller;
  if (chargeMode === undefined || chargeMode === null || chargeMode === "CONNECT_DIRECT") return "DIRECT";
  if (chargeMode !== "PLATFORM") return null;
  const party = sellerParty ?? undefined;
  if (salesPlan === "MANAGED_20" && (party === undefined || party === "NIHO")
    && (feeBasisPoints === undefined || feeBasisPoints === null || feeBasisPoints === 2000)) return "MANAGED_20";
  if (salesPlan === "SUPPORTED_15" && party === "PROVIDER" && feeBasisPoints === 1500) return "AGENT_15";
  return null;
}

/** SQL: the alias names a sales-plan revision row (experience_product_sales_plan_versions) that is agent sales (the revision-side twin of `salesKindOf` = AGENT_15). */
export const agentPlanSql = (plan: string): string => `(${plan}.charge_mode='PLATFORM' AND ${plan}.plan='SUPPORTED_15' AND ${plan}.seller_party='PROVIDER')`;

/**
 * SQL (an EXISTS): the OWNER's agent-sales consent counts for the revision `plan` of the provider `providerId` (columns or aliases): active,
 * and given by a host account that is still an active OWNER of an ACTIVE account. `countingAgentConsent` (agent-consent.ts) is the same rule as a row read.
 */
export const countedAgentConsentSql = (providerId: string, plan: string): string => `EXISTS (
  SELECT 1 FROM provider_agent_sales_consents consent
    JOIN provider_memberships owner ON owner.provider_id=consent.provider_id AND owner.niho_user_id=consent.consented_by_host_account_id
     AND owner.active=true AND owner.role='OWNER'
    JOIN host_accounts account ON account.id=consent.consented_by_host_account_id AND account.status='ACTIVE'
   WHERE consent.provider_id=${providerId} AND consent.seller_ref=${plan}.seller_niho_account_ref AND consent.revoked_at IS NULL)`;

const AGENT_SELLER_REF_SQL = "^agt_[0-9a-f]{32}$";
const AGENT_SELLER_REF = /^agt_[0-9a-f]{32}$/;
export const isAgentSellerRef = (value: unknown): value is string => typeof value === "string" && AGENT_SELLER_REF.test(value);
