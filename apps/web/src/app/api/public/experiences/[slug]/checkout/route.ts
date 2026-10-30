import type { ExperienceCheckoutResponse } from "@niho-experience/api-client";
import { createDirectCheckout, ExperiencePaymentsHoldTooShortError, retrieveDirectCheckout, type DirectCheckoutResult, type RetrievedDirectCheckout } from "@niho-experience/experience-payments";
import { GuestCheckoutError, StoreNotFoundError, type GuestBookingStart } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { checkoutError, readGuestCheckout, storeCheckoutError } from "@/lib/experience/guest-booking-http";
import { fromThisSite, publicEmpty, publicJson } from "@/lib/experience/public-http";
import { guestBookingRepository } from "@/lib/experience/store-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where Stripe returns a guest who paid: the page BookingReturn renders (`readReturnType`). Every offer
 * sold here is INSTANT (the store's PublicBookingOffer), so the type is fixed.
 */
const RETURN_PATH = "/booking/return?type=instant";

/** The class name only: Stripe's and the database's messages may repeat what was sent (an address, a session). */
function logFailure(stage: "store" | "stripe", error: unknown): void {
  console.error("Experience guest checkout failed", { stage, error: error instanceof Error ? error.name : typeof error });
}

/**
 * 予約の開始 of an experience sold on this site (#285, docs/guest-booking.md), at NIHO's path with NIHO's
 * request, answers and statuses (docs/api-contract.md §6-§7): the store holds the seats and records the
 * guest, Stripe Checkout is created on the provider's account with NIHO's fee from the booking's snapshot,
 * and the page goes to `checkoutUrl` (201). Only this site's pages post here. The same clientRequestKey with
 * the same content returns the same booking and, through Stripe's idempotency key per booking, the same
 * Session. A failure after the hold leaves it in place (503, retryable): the retry reuses it, and an
 * abandoned hold expires by itself. Nothing the guest sent is logged.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  if (!config.guestBookingEnabled) return publicEmpty(404);
  const { slug } = await params;
  if (slug.length < 1 || slug.length > 160) return publicEmpty(404);
  if (!fromThisSite(request)) return publicEmpty(403);
  // The incident switch (#15) stops new bookings here as it hides the booking entrance.
  if (!config.bookingsEnabled) return checkoutError("UNAVAILABLE");
  const bookings = guestBookingRepository();
  const stripeKey = process.env.EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY;
  if (!bookings || !stripeKey) return checkoutError("CHECKOUT_UNAVAILABLE");
  const parsed = await readGuestCheckout(request);
  if (!parsed.ok) return parsed.response;

  let started: GuestBookingStart;
  try {
    started = await bookings.startGuestBooking({
      ...parsed.fields,
      slug,
      // The Japanese path comes with #285 slice 10.
      guestLanguage: "EN",
      currentConsentVersion: config.guestBookingConsentVersion,
    });
  } catch (error) {
    if (error instanceof GuestCheckoutError) return storeCheckoutError(error);
    if (error instanceof StoreNotFoundError) return publicEmpty(404);
    logFailure("store", error);
    return checkoutError("CHECKOUT_UNAVAILABLE");
  }

  const siteOrigin = new URL(config.siteUrl).origin;
  // A repeated request of a booking already paid: NIHO answers with its booking page (PublicExperienceCheckoutResponse);
  // here that is the page Stripe returned the guest to. It names no booking and says only what to expect next.
  if (started.status === "CONFIRMED" || started.status === "PAYMENT_REVIEW") {
    return publicJson(201, { checkoutUrl: `${siteOrigin}${RETURN_PATH}` } satisfies ExperienceCheckoutResponse);
  }
  // Expired or cancelled: these seats are gone. The page reads availability again and starts a new request.
  if (started.status !== "HOLD" || Date.parse(started.holdExpiresAt) <= Date.now()) return checkoutError("UNAVAILABLE");

  // The same request again (back from Stripe, a second click): the Session made for this hold, even once the
  // hold is too short for a new one. Paid but not confirmed yet (the webhook is on its way): the return page.
  if (started.checkoutSessionRef !== null) {
    let previous: RetrievedDirectCheckout;
    try {
      previous = await retrieveDirectCheckout({ booking: started.booking, checkoutSessionId: started.checkoutSessionRef, platformStripeKey: stripeKey });
    } catch (error) {
      logFailure("stripe", error);
      return checkoutError("CHECKOUT_UNAVAILABLE");
    }
    if (previous.status === "open") return publicJson(201, { checkoutUrl: previous.checkoutUrl } satisfies ExperienceCheckoutResponse);
    if (previous.status === "complete") return publicJson(201, { checkoutUrl: `${siteOrigin}${RETURN_PATH}` } satisfies ExperienceCheckoutResponse);
    return checkoutError("UNAVAILABLE");
  }

  let session: DirectCheckoutResult;
  try {
    session = await createDirectCheckout({
      booking: started.booking,
      returnOrigin: siteOrigin,
      returnPath: RETURN_PATH,
      cancelPath: `/experiences/${encodeURIComponent(slug)}?checkout=cancelled`,
      ...(started.guestEmail === null ? {} : { customerEmail: started.guestEmail }),
      platformStripeKey: stripeKey,
    });
  } catch (error) {
    // A hold too close to its end for Stripe's 30-minute Session is as good as expired.
    if (error instanceof ExperiencePaymentsHoldTooShortError) return checkoutError("UNAVAILABLE");
    logFailure("stripe", error);
    return checkoutError("CHECKOUT_UNAVAILABLE");
  }
  try {
    await bookings.attachCheckoutSession(started.publicBookingId, session.checkoutSessionId);
  } catch (error) {
    logFailure("store", error);
    return checkoutError("CHECKOUT_UNAVAILABLE");
  }
  return publicJson(201, { checkoutUrl: session.checkoutUrl } satisfies ExperienceCheckoutResponse);
}
