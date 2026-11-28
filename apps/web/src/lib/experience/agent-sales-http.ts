import "server-only";
import { HOST_ACCOUNT_LIMITS, StoreAccessDeniedError, StoreConflictError, StoreNotFoundError, StoreValidationError, type SalesPlanState } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { reauthenticationHref } from "@/lib/host/niho-identity-server";
import { HOST_EMAIL_SIGN_IN_PATH, hostPayoutSettingsPath, withQuery } from "@/lib/host/routes";
import { noStoreJson, readHostSession } from "@/lib/host/server";
import { recentlyAuthenticated } from "@/lib/host/session";
import { readBoundedJson } from "@/lib/read-bounded-json";
import { publicationHostBoundary, publicationHostMutationAllowed } from "./publication-host-boundary";
import { requestedProviderId } from "./provider-context";
import { experiencePublicationRepository, providerAgentSales, providerSellerDisclosureRepository } from "./store-server";

/*
 * 代理受領で売る (#725, docs/host-payouts.md): the OWNER of a host that has no seller profile chooses "サポート 15%（NIHO が代金を受け取る）" for
 * a product. 404 until EXPERIENCE_HOST_AGENT_SALES_ENABLED. Same-origin only, the OWNER only, from a sign-in within the last 30 minutes (an
 * older one answers 401 REAUTH_REQUIRED with the page to sign in again), and only with the consent wording of the configured version.
 * Everything that decides the terms (the platform account, the receiving party, the payout delay) is configuration, never the request.
 */

const BODY_LIMIT = 4 * 1024;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRODUCT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const INVALID_INPUT = { code: "INVALID_INPUT", status: 400 } as const;
const error = (code: string, status: number) => noStoreJson({ error: { code } }, status);

type Context = { params: Promise<{ productId: string }> };

export function agentSalesPlanDto(state: SalesPlanState) {
  const revision = (value: SalesPlanState["current"]) => ({ revision: value.revision, plan: value.plan, feeBasisPoints: value.feeBasisPoints,
    agreementVersion: value.agreementVersion, chargeMode: value.chargeMode, sellerParty: value.sellerParty });
  return { current: revision(state.current), phase: state.phase, pending: state.pending ? revision(state.pending) : null,
    transitionCommandId: state.transitionCommandId, version: state.version };
}

export const agentSalesEnabled = () => config.hostAgentSalesEnabled && config.hostAccountsEnabled && config.experienceHostPublicationApiEnabled;

export async function agentSalesRequest(request: Request, context: Context): Promise<Response> {
  if (!agentSalesEnabled()) return error("NOT_FOUND", 404);
  if (!publicationHostMutationAllowed(request) || request.method === "GET") return error("FORBIDDEN", 403);
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return error("INVALID_INPUT", 400);
  const requested = requestedProviderId(request, INVALID_INPUT); if (!requested.ok) return requested.response;
  const { productId } = await context.params;
  if (!PRODUCT_ID.test(productId)) return error("NOT_FOUND", 404);

  let body: Record<string, unknown>;
  try {
    const value = await readBoundedJson(request, BODY_LIMIT, { fatalUtf8: true });
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("shape");
    body = value as Record<string, unknown>;
  } catch { return error("INVALID_INPUT", 400); }
  const keys = ["commandId", "expectedStateVersion", "agreementVersion", "accepted"];
  if (Object.keys(body).length !== keys.length || !keys.every((key) => Object.hasOwn(body, key))
    || typeof body.commandId !== "string" || !UUID_V4.test(body.commandId)
    || (body.expectedStateVersion !== null && (!Number.isSafeInteger(body.expectedStateVersion) || Number(body.expectedStateVersion) < 1))
    || typeof body.agreementVersion !== "string" || body.agreementVersion.length < 1 || body.agreementVersion.length > 160
    || typeof body.accepted !== "boolean") return error("INVALID_INPUT", 400);
  if (body.accepted !== true) return error("CONSENT_REQUIRED", 422);

  let session: Awaited<ReturnType<typeof readHostSession>>;
  try { session = await readHostSession(); } catch { return error("UNAVAILABLE", 503); }
  if (!session || session.kind !== "experience") return error("SESSION_ENDED", 401);
  if (!recentlyAuthenticated(session, Date.now(), HOST_ACCOUNT_LIMITS.recentAuthenticationMinutes)) {
    // The page to sign in again at (NIHO's re-login for a bound account, else the emailed link); it comes back to 設定.
    const returnTo = hostPayoutSettingsPath(requested.providerId);
    const fallback = withQuery(HOST_EMAIL_SIGN_IN_PATH, { reauth: "1", next: returnTo });
    const href = await reauthenticationHref(session.hostAccountId, returnTo).catch(() => fallback);
    return noStoreJson({ error: { code: "REAUTH_REQUIRED", href } }, 401);
  }

  const boundary = await publicationHostBoundary("OWNER", { providerId: requested.providerId, sales: "none" });
  if (!boundary.ok) return boundary.response;
  const { actor } = boundary.value;
  if (body.agreementVersion !== config.hostAgentSalesAgreementVersion) return error("CONSENT_OUTDATED", 409);

  const publications = experiencePublicationRepository();
  const disclosures = providerSellerDisclosureRepository();
  const agentSales = providerAgentSales();
  const platformAccountId = process.env.EXPERIENCE_MANAGED_PLATFORM_ACCOUNT_ID?.trim() ?? "";
  if (!publications || !disclosures || !agentSales || !platformAccountId) return error("UNAVAILABLE", 503);
  try {
    if (await publications.providerHasSellerProfile(actor.providerId)) return error("SELLER_EXISTS", 409);
    const disclosure = (await disclosures.getForOwner(actor, { agentSales: true })).disclosure;
    if (disclosure === null || disclosure.method !== "NATIVE") return error("SELLER_DISCLOSURE_REQUIRED", 409);
    const product = await publications.getProduct(actor, productId);
    const chosen = await agentSales.choose(actor, productId, {
      commandId: body.commandId, expectedStateVersion: body.expectedStateVersion as number | null,
      agreementVersion: body.agreementVersion, accepted: true, platformAccountId,
      receivingAgentName: config.hostAgentReceiverName, payoutDelayDays: config.hostAgentPayoutDelayDays,
      sellerDisclosureUrl: `${config.siteUrl}/experiences/${encodeURIComponent(product.slug)}/seller`,
    });
    return noStoreJson({ salesPlan: agentSalesPlanDto(chosen.state), productVersion: chosen.productVersion, replayed: chosen.replayed });
  } catch (caught) {
    if (caught instanceof StoreAccessDeniedError) return error("FORBIDDEN", 403);
    if (caught instanceof StoreNotFoundError) return error("NOT_FOUND", 404);
    if (caught instanceof StoreConflictError) {
      if (caught.message === "SELLER_EXISTS" || caught.message === "SELLER_DISCLOSURE_REQUIRED") return error(caught.message, 409);
      return error("VERSION_CONFLICT", 409);
    }
    if (caught instanceof StoreValidationError) return error("INVALID_INPUT", 422);
    console.error("Experience agent-sales choice failed", { error: caught instanceof Error ? caught.name : typeof caught });
    return error("UNAVAILABLE", 503);
  }
}
