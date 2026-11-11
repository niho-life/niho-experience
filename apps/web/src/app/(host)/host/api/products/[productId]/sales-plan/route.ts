import { StoreAccessDeniedError, StoreConflictError, StoreNotFoundError, StoreValidationError, type SalesPlanState } from "@niho-experience/experience-store";
import { expireDirectCheckout, expirePlatformCheckout } from "@niho-experience/experience-payments";
import { config } from "@/lib/config";
import { noStoreJson } from "@/lib/host/server";
import { readBoundedJson } from "@/lib/read-bounded-json";
import {
  experiencePublicationRepository,
  experienceStore,
  guestHoldReleases,
  managedExperienceSalesRepository,
  providerSellerDisclosureRepository,
} from "@/lib/experience/store-server";
import { publicationHostBoundary, publicationHostMutationAllowed } from "@/lib/experience/publication-host-boundary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ productId: string }> };
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION = /^[\x21-\x7e]{1,160}$/;
const BODY_LIMIT = 8 * 1024;

function salesPlanDto(state: SalesPlanState | null) {
  if (!state) return null;
  const revision = (value: SalesPlanState["current"]) => ({ revision: value.revision, plan: value.plan,
    feeBasisPoints: value.feeBasisPoints, agreementVersion: value.agreementVersion });
  return { current: revision(state.current), phase: state.phase, pending: state.pending ? revision(state.pending) : null, version: state.version };
}

function failure(error: unknown): Response {
  if (error instanceof StoreAccessDeniedError) return noStoreJson({ error: { code: "FORBIDDEN" } }, 403);
  if (error instanceof StoreNotFoundError) return noStoreJson({ error: { code: "NOT_FOUND" } }, 404);
  if (error instanceof StoreConflictError) return noStoreJson({ error: { code: "VERSION_CONFLICT" } }, 409);
  if (error instanceof StoreValidationError) return noStoreJson({ error: { code: "INVALID_INPUT" } }, 422);
  console.error("Experience sales-plan switch failed", { error: error instanceof Error ? error.name : typeof error });
  return noStoreJson({ error: { code: "UNAVAILABLE" } }, 503);
}

export async function GET(request: Request, context: Context): Promise<Response> {
  if (new URL(request.url).search) return noStoreJson({ error: { code: "INVALID_INPUT" } }, 400);
  const boundary = await publicationHostBoundary("OWNER"); if (!boundary.ok) return boundary.response;
  const repository = managedExperienceSalesRepository(); if (!repository) return noStoreJson({ error: { code: "UNAVAILABLE" } }, 503);
  try {
    const { productId } = await context.params;
    return noStoreJson({ salesPlan: salesPlanDto(await repository.get(boundary.value.actor.providerId, productId)) });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request, context: Context): Promise<Response> {
  if (process.env.EXPERIENCE_MANAGED_SALES_ENABLED !== "true") return noStoreJson({ error: { code: "NOT_FOUND" } }, 404);
  if (!publicationHostMutationAllowed(request)) return noStoreJson({ error: { code: "FORBIDDEN" } }, 403);
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" || new URL(request.url).search) return noStoreJson({ error: { code: "INVALID_INPUT" } }, 400);
  const boundary = await publicationHostBoundary("OWNER"); if (!boundary.ok) return boundary.response;
  if (!boundary.value.readiness.accountUsable || !boundary.value.readiness.connectReady
    || !boundary.value.readiness.paymentReuseConsentAccepted
    || boundary.value.readiness.stripeConnectAccountRef !== boundary.value.provider.stripeConnectAccountRef) {
    return noStoreJson({ error: { code: "CONNECT_NOT_READY" } }, 409);
  }
  let body: Record<string, unknown>;
  try {
    const value = await readBoundedJson(request, BODY_LIMIT);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("shape");
    body = value as Record<string, unknown>;
  } catch { return noStoreJson({ error: { code: "INVALID_INPUT" } }, 400); }
  if (Object.keys(body).some((key) => !["commandId", "expectedVersion", "plan", "agreementVersion"].includes(key))
    || typeof body.commandId !== "string" || !UUID_V4.test(body.commandId)
    || !Number.isSafeInteger(body.expectedVersion) || (body.plan !== "SUPPORTED_15" && body.plan !== "INDEPENDENT_10")
    || typeof body.agreementVersion !== "string" || !VERSION.test(body.agreementVersion)) {
    return noStoreJson({ error: { code: "INVALID_INPUT" } }, 400);
  }
  const requiredAgreementVersion = process.env.EXPERIENCE_OWNER_SALES_PLAN_AGREEMENT_VERSION;
  if (!requiredAgreementVersion || body.agreementVersion !== requiredAgreementVersion) {
    return noStoreJson({ error: { code: "CONSENT_OUTDATED" } }, 409);
  }
  const repository = managedExperienceSalesRepository();
  const publications = experiencePublicationRepository();
  const disclosures = providerSellerDisclosureRepository();
  const bookings = experienceStore();
  if (!repository || !publications || !disclosures || !bookings) return noStoreJson({ error: { code: "UNAVAILABLE" } }, 503);
  try {
    const { productId } = await context.params;
    const product = await publications.getProduct(boundary.value.actor, productId);
    const disclosure = (await disclosures.getForOwner(boundary.value.actor)).disclosure;
    if (!disclosure || disclosure.sellerDisplayName !== boundary.value.provider.sellerDisplayName) throw new StoreConflictError("Seller disclosure is not current.");
    const sellerDisclosureUrl = disclosure.method === "EXTERNAL"
      ? disclosure.externalUrl ?? ""
      : `${config.siteUrl}/experiences/${encodeURIComponent(product.slug)}/seller`;
    let transition = await repository.beginOwnerSwitch(boundary.value.actor, productId, {
      commandId: body.commandId, expectedVersion: body.expectedVersion as number, plan: body.plan,
      agreementVersion: body.agreementVersion, agreementConfirmedAtUtc: new Date().toISOString(),
      sellerDisclosureUrl, stripeReady: true,
    });
    for (const checkout of transition.openCheckouts) {
      const booking = await bookings.getBooking(boundary.value.actor, checkout.publicBookingId);
      const expireCheckout = booking.sellerSnapshot.chargeMode === "PLATFORM" ? expirePlatformCheckout : expireDirectCheckout;
      const outcome = await expireCheckout({
        booking, checkoutSessionId: checkout.checkoutSessionRef,
        platformStripeKey: process.env.EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY,
      });
      if (outcome === "expired") await guestHoldReleases()?.expireGuestHoldForSalesPlanSwitch(boundary.value.actor, checkout.publicBookingId, checkout.checkoutSessionRef);
      transition = {
        state: await repository.recordCheckoutOutcome(boundary.value.actor, productId, body.commandId, checkout.checkoutSessionRef,
          outcome === "paid" ? "PAID" : outcome === "expired" ? "EXPIRED" : "UNKNOWN"),
        openCheckouts: [],
      };
    }
    if (transition.state.phase !== "ACTIVE") {
      const finalized = await repository.finalizeSwitch(boundary.value.actor, productId, body.commandId, transition.state.version);
      return noStoreJson({ salesPlan: salesPlanDto(finalized), switched: true });
    }
    return noStoreJson({ salesPlan: salesPlanDto(transition.state), switched: false });
  } catch (error) { return failure(error); }
}
