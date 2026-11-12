import type { NextRequest } from "next/server";
import { ExperiencePaymentsValidationError, isEndedCheckoutEvent, isManagedPlatformPaymentIntent, isRefundEvent, verifyPlatformCheckoutWebhook } from "@niho-experience/experience-payments";
import { StoreNotFoundError } from "@niho-experience/experience-store";
import { bookingCancellations, experiencePool, experienceStore, guestHoldReleases, managedExperienceSalesRepository } from "@/lib/experience/store-server";

export const runtime = "nodejs";
const MAX_WEBHOOK_BYTES = 256 * 1024;
const reply = (status: number) => new Response(null, { status, headers: { "cache-control": "no-store" } });

/** Separate account-level endpoint for MANAGED_20. It never accepts Connect events. */
export async function POST(request: NextRequest): Promise<Response> {
  const secret = process.env.EXPERIENCE_STRIPE_PLATFORM_WEBHOOK_SECRET?.trim();
  const key = process.env.EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY?.trim();
  const accountId = process.env.EXPERIENCE_MANAGED_PLATFORM_ACCOUNT_ID?.trim();
  const signature = request.headers.get("stripe-signature");
  const pool = experiencePool(); const store = experienceStore(); const releases = guestHoldReleases(); const managed = managedExperienceSalesRepository(); const cancellations = bookingCancellations();
  if (!secret || !key || !accountId || !signature || !pool || !store || !releases || !managed || !cancellations) return reply(503);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_WEBHOOK_BYTES) return reply(413);
  const rawBody = new Uint8Array(await request.arrayBuffer());
  if (rawBody.byteLength > MAX_WEBHOOK_BYTES) return reply(413);
  let event;
  try {
    event = verifyPlatformCheckoutWebhook({ rawBody, stripeSignature: signature, endpointSecret: secret,
      expectedPlatformAccountId: accountId, platformStripeKey: key });
  } catch (error) { return reply(error instanceof ExperiencePaymentsValidationError ? 400 : 503); }
  if (!event) return reply(204);
  try {
    if ("stripeDisputeRef" in event) {
      try {
        await managed.recordDispute({ ...event, stripeEventId: event.eventId });
      } catch (error) {
        // Disputes from other services on this account can arrive here. Retry our own
        // disputes when their payment confirmation has yet to link the PaymentIntent.
        if (!(error instanceof StoreNotFoundError)
          || await isManagedPlatformPaymentIntent({ paymentIntentId: event.paymentIntentRef, platformStripeKey: key })) throw error;
      }
      return reply(204);
    }
    const booking = await pool.query<{ provider_id: string; seller_snapshot: Record<string, unknown> }>(
      "SELECT provider_id,seller_snapshot FROM bookings WHERE public_booking_id=$1::uuid", [event.publicBookingId],
    );
    const original = booking.rows[0];
    if (!original) return reply(503);
    if (original.seller_snapshot.chargeMode !== "PLATFORM"
      || original.seller_snapshot.stripeConnectAccountRef !== accountId) return reply(204);
    if (isRefundEvent(event)) {
      await cancellations.applyRefundEvent({ publicBookingId: event.publicBookingId, refundId: event.refundId,
        stripeRefundRef: event.stripeRefundRef, connectedAccountId: accountId, stripePaymentRef: event.paymentIntentRef,
        amount: event.amount, currency: event.currency, status: event.status, failureCode: event.failureCode,
        stripeEventId: event.eventId, stripeEventType: event.eventType, eventOccurredAtUtc: event.eventOccurredAtUtc });
      return reply(204);
    }
    if (isEndedCheckoutEvent(event)) {
      await releases.releaseGuestHold({ publicBookingId: event.publicBookingId, checkoutSessionRef: event.checkoutSessionId,
        connectedAccountId: event.connectedAccountId, stripeEventId: event.eventId, stripeEventType: event.eventType,
        eventOccurredAtUtc: event.eventOccurredAtUtc });
      return reply(204);
    }
    await store.confirmBookingPayment({ providerId: original.provider_id }, {
      publicBookingId: event.publicBookingId, connectedAccountId: accountId, stripePaymentRef: event.paymentIntentRef,
      stripeEventId: event.eventId, stripeEventType: event.eventType, eventOccurredAtUtc: event.eventOccurredAtUtc,
      amount: event.amountTotal, currency: event.currency,
    });
    return reply(204);
  } catch {
    console.error("Experience platform Stripe webhook could not be recorded");
    return reply(503);
  }
}
