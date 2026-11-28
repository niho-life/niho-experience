import "server-only";
import { HOST_ACCOUNT_LIMITS, StoreAccessDeniedError, StoreConflictError, StoreNotFoundError, StoreValidationError, salesKindOf } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { reauthenticationHref } from "@/lib/host/niho-identity-server";
import { HOST_EMAIL_SIGN_IN_PATH, hostPayoutSettingsPath, withQuery } from "@/lib/host/routes";
import { noStoreJson, readHostSession } from "@/lib/host/server";
import { recentlyAuthenticated } from "@/lib/host/session";
import { readBoundedJson } from "@/lib/read-bounded-json";
import { agentSalesPlanDto } from "./agent-sales-http";
import { publicationHostBoundary, publicationHostMutationAllowed } from "./publication-host-boundary";
import { requestedProviderId } from "./provider-context";
import { completeSalesPlanSwitch } from "./sales-plan-switch";
import {
  directSellers, experiencePublicationRepository, experienceStore, guestHoldReleases, managedExperienceSalesRepository, providerSellerDisclosureRepository,
} from "./store-server";

/*
 * 独立 10%（自分の Stripe で販売）(3c-2, #726, docs/host-payouts.md): the OWNER of a host whose seller is its own Stripe account (a DIRECT
 * connected account, 3c-1) chooses 独立 10% for a product. A product with no sales plan gets revision 1; a product that is sold with 代理受領
 * moves through the same switch the sales-plan route runs (beginOwnerSwitch, the old Checkouts expire, finalizeSwitch), also while bookings are open.
 * 404 until EXPERIENCE_HOST_STANDARD_ONBOARDING_ENABLED. Same-origin only, the OWNER only, from a sign-in within the last 30 minutes (401 REAUTH_REQUIRED
 * otherwise), a fresh 受取口座 readiness, and only with the consent wording of the configured version.
 */

const BODY_LIMIT = 4 * 1024;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRODUCT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const INVALID_INPUT = { code: "INVALID_INPUT", status: 400 } as const;
const PASS_THROUGH = new Set(["DIRECT_SELLER_REQUIRED", "PAYOUT_CONSENT_REQUIRED", "SELLER_DISCLOSURE_REQUIRED", "SELLER_MISMATCH", "PUBLIC_PROFILE_MISSING"]);
const error = (code: string, status: number) => noStoreJson({ error: { code } }, status);

type Context = { params: Promise<{ productId: string }> };

export const independentSalesEnabled = () => config.hostStandardOnboardingEnabled && config.hostAccountsEnabled && config.experienceHostPublicationApiEnabled;

export async function independentSalesRequest(request: Request, context: Context): Promise<Response> {
  // The flag is checked after the product's state is read: a switch that stopped half way (the same command, the same terms) can be
  // finished with the flag off or the consent version changed, as the sales-plan route does.
  const enabled = independentSalesEnabled();
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
    const returnTo = hostPayoutSettingsPath(requested.providerId);
    const fallback = withQuery(HOST_EMAIL_SIGN_IN_PATH, { reauth: "1", next: returnTo });
    const href = await reauthenticationHref(session.hostAccountId, returnTo).catch(() => fallback);
    return noStoreJson({ error: { code: "REAUTH_REQUIRED", href } }, 401);
  }

  // Choosing it is a sale: the seller and a fresh 受取口座 readiness (the account usable, connected, consented, the same account).
  const boundary = await publicationHostBoundary("OWNER", { providerId: requested.providerId });
  if (!boundary.ok) return boundary.response;
  const { actor, readiness, provider } = boundary.value;
  if (!readiness.accountUsable || !readiness.connectReady || !readiness.paymentReuseConsentAccepted
    || readiness.stripeConnectAccountRef !== provider.stripeConnectAccountRef) return error("CONNECT_NOT_READY", 409);

  const publications = experiencePublicationRepository();
  const disclosures = providerSellerDisclosureRepository();
  const sellers = directSellers();
  const managed = managedExperienceSalesRepository();
  const bookings = experienceStore();
  const releases = guestHoldReleases();
  if (!publications || !disclosures || !managed || !bookings || !releases) return error("UNAVAILABLE", 503);
  try {
    const state = await managed.get(actor.providerId, productId);
    const resuming = state !== null && state.transitionCommandId === body.commandId
      && state.pending?.plan === "INDEPENDENT_10" && state.pending.agreementVersion === body.agreementVersion;
    if (!resuming) {
      if (!enabled) return error("NOT_FOUND", 404);
      if (body.agreementVersion !== config.hostIndependentSalesAgreementVersion) return error("CONSENT_OUTDATED", 409);
      if (!sellers) return error("UNAVAILABLE", 503);
    }
    const disclosure = (await disclosures.getForOwner(actor)).disclosure;
    if (!disclosure || disclosure.method !== "NATIVE" || disclosure.sellerDisplayName !== provider.sellerDisplayName) return error("SELLER_DISCLOSURE_REQUIRED", 409);
    const product = await publications.getProduct(actor, productId);
    const sellerDisclosureUrl = `${config.siteUrl}/experiences/${encodeURIComponent(product.slug)}/seller`;
    const agent = state !== null && salesKindOf({ chargeMode: state.current.chargeMode, salesPlan: state.current.plan,
      sellerParty: state.current.sellerParty, feeBasisPoints: state.current.feeBasisPoints }) === "AGENT_15";
    if (resuming || agent) {
      // From 代理受領: the switch the sales-plan route runs. The read version must be the state's.
      if (body.expectedStateVersion === null) return error("VERSION_CONFLICT", 409);
      const transition = await managed.beginOwnerSwitch(actor, productId, {
        commandId: body.commandId, expectedVersion: body.expectedStateVersion as number, plan: "INDEPENDENT_10",
        agreementVersion: body.agreementVersion, agreementConfirmedAtUtc: new Date().toISOString(), sellerDisclosureUrl, stripeReady: true, allowAgentToIndependent: true,
      });
      const completed = await completeSalesPlanSwitch({ repository: managed, bookings, releases }, actor, productId, body.commandId, transition);
      return noStoreJson({ salesPlan: agentSalesPlanDto(completed.state), switched: completed.switched, replayed: false });
    }
    const chosen = await sellers!.chooseIndependent(actor, productId, {
      commandId: body.commandId, expectedStateVersion: body.expectedStateVersion as number | null,
      agreementVersion: body.agreementVersion, sellerDisclosureUrl, nowUtc: new Date().toISOString(),
    });
    return noStoreJson({ salesPlan: agentSalesPlanDto(chosen.state), productVersion: chosen.productVersion, switched: false, replayed: chosen.replayed });
  } catch (caught) {
    if (caught instanceof StoreAccessDeniedError) return error("FORBIDDEN", 403);
    if (caught instanceof StoreNotFoundError) return error("NOT_FOUND", 404);
    if (caught instanceof StoreConflictError) return error(PASS_THROUGH.has(caught.message) ? caught.message : "VERSION_CONFLICT", 409);
    if (caught instanceof StoreValidationError) return error("INVALID_INPUT", 422);
    console.error("Experience independent-sales choice failed", { error: caught instanceof Error ? caught.name : typeof caught });
    return error("UNAVAILABLE", 503);
  }
}
