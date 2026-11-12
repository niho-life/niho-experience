import {
  createPlatformCheckout,
  expirePlatformCheckout,
  retrievePlatformAccount,
  retrievePlatformCheckout,
} from "@niho-experience/experience-payments";
import { StoreConflictError, StoreNotFoundError, StoreValidationError } from "@niho-experience/experience-store";
import { adminJson, adminMutationAllowed, isAdminHttp, loadAdminHttpSession } from "@/lib/admin/server";
import { config } from "@/lib/config";
import { guestBookingRepository, managedBookingApprovalRepository } from "@/lib/experience/store-server";
import { readBoundedJson } from "@/lib/read-bounded-json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BODY_LIMIT = 4 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function enabled(): boolean {
  return isAdminHttp() && config.guestBookingEnabled && config.managedSalesEnabled && config.managedSalesWebhooksEnabled;
}

function failure(error: unknown): Response {
  if (error instanceof StoreConflictError) return adminJson({ error: "conflict" }, 409);
  if (error instanceof StoreNotFoundError) return adminJson({ error: "not_found" }, 404);
  if (error instanceof StoreValidationError) return adminJson({ error: "invalid_input" }, 400);
  console.error("Managed booking approval failed", { error: error instanceof Error ? error.name : typeof error });
  return adminJson({ error: "unavailable" }, 503);
}

async function boundary(request: Request, mutation: boolean) {
  if (!enabled() || new URL(request.url).search) return { ok: false as const, response: adminJson({ error: "not_found" }, 404) };
  const loaded = await loadAdminHttpSession();
  if (loaded.status !== "ok") return { ok: false as const, response: adminJson({ error: loaded.status === "error" ? "unavailable" : "unauthenticated" }, loaded.status === "error" ? 503 : 401) };
  if (mutation && !adminMutationAllowed(request)) return { ok: false as const, response: adminJson({ error: "forbidden" }, 403) };
  const approvals = managedBookingApprovalRepository();
  const bookings = guestBookingRepository();
  if (!approvals || !bookings) return { ok: false as const, response: adminJson({ error: "unavailable" }, 503) };
  return { ok: true as const, actor: { nihoUserId: loaded.actor.id }, approvals, bookings };
}

export async function GET(request: Request): Promise<Response> {
  const current = await boundary(request, false); if (!current.ok) return current.response;
  try { return adminJson({ requests: await current.approvals.listPending(current.actor) }); }
  catch (error) { return failure(error); }
}

export async function POST(request: Request): Promise<Response> {
  const current = await boundary(request, true); if (!current.ok) return current.response;
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return adminJson({ error: "invalid_input" }, 400);
  }
  let body: Record<string, unknown>;
  try {
    const value = await readBoundedJson(request, BODY_LIMIT, { fatalUtf8: true });
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("shape");
    body = value as Record<string, unknown>;
  } catch { return adminJson({ error: "invalid_input" }, 400); }
  if (Object.keys(body).some((key) => !["action", "publicBookingId"].includes(key))
    || typeof body.publicBookingId !== "string" || !UUID.test(body.publicBookingId)
    || (body.action !== "APPROVE" && body.action !== "DECLINE")) {
    return adminJson({ error: "invalid_input" }, 400);
  }
  try {
    if (body.action === "DECLINE") {
      await current.approvals.decline(current.actor, body.publicBookingId);
      return adminJson({ decision: "DECLINED" });
    }

    // The transaction marks APPROVED before any Stripe call. A failed call is recoverable by repeating this
    // same Admin action; Stripe's booking idempotency key returns the same Session.
    const approved = await current.approvals.approve(current.actor, body.publicBookingId);
    const key = process.env.EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY?.trim();
    const accountId = process.env.EXPERIENCE_MANAGED_PLATFORM_ACCOUNT_ID?.trim();
    if (!key || !accountId || approved.booking.sellerSnapshot.stripeConnectAccountRef !== accountId) {
      return adminJson({ error: "unavailable" }, 503);
    }
    const account = await retrievePlatformAccount({ expectedAccountId: accountId, platformStripeKey: key });
    if (!account.chargesEnabled || !account.detailsSubmitted || account.country !== "JP" || account.defaultCurrency !== "JPY") {
      return adminJson({ error: "unavailable" }, 503);
    }
    if (approved.checkoutSessionRef !== null) {
      const prior = await retrievePlatformCheckout({ booking: approved.booking, checkoutSessionId: approved.checkoutSessionRef, platformStripeKey: key });
      if (prior.status === "open") return adminJson({ decision: "APPROVED", paymentUrl: prior.checkoutUrl });
      if (prior.status === "complete") return adminJson({ decision: "APPROVED", paymentUrl: null, checkoutCompleted: true });
      return adminJson({ error: "conflict" }, 409);
    }

    const origin = new URL(config.siteUrl).origin;
    const session = await createPlatformCheckout({
      booking: approved.booking,
      returnOrigin: origin,
      returnPath: "/booking/return?type=instant",
      cancelPath: "/booking/return?type=approval",
      locale: "auto",
      ...(approved.guestEmail === null ? {} : { customerEmail: approved.guestEmail }),
      platformStripeKey: key,
    });
    try {
      await current.bookings.attachCheckoutSession(approved.booking.publicBookingId, session.checkoutSessionId);
    } catch (error) {
      // Two Admins can approve after the durable decision but before either Stripe call finishes. Stripe's
      // booking idempotency key gives both calls the same Session; if the other request attached that exact
      // Session, this request succeeded too and must not expire the guest's usable payment URL.
      try {
        const reconciled = await current.approvals.approve(current.actor, body.publicBookingId);
        if (reconciled.checkoutSessionRef === session.checkoutSessionId) {
          return adminJson({ decision: "APPROVED", paymentUrl: session.checkoutUrl });
        }
      } catch { /* Preserve the original attachment failure and keep the URL private. */ }
      try { await expirePlatformCheckout({ booking: approved.booking, checkoutSessionId: session.checkoutSessionId, platformStripeKey: key }); }
      catch { /* The URL is not returned; a later Admin retry reconciles the same Session. */ }
      throw error;
    }
    return adminJson({ decision: "APPROVED", paymentUrl: session.checkoutUrl });
  } catch (error) { return failure(error); }
}
