import type { NextRequest } from "next/server";
import { verifyDirectCheckoutWebhook, ExperiencePaymentsValidationError, isEndedCheckoutEvent } from "@niho-experience/experience-payments";
import { experiencePool, experienceStore, guestHoldReleases } from "@/lib/experience/store-server";

export const runtime = "nodejs";
const MAX_WEBHOOK_BYTES = 256 * 1024;

function reply(status: number): Response {
  return new Response(null, { status, headers: { "cache-control": "no-store" } });
}

/**
 * Connect events share the NIHO platform; only events marked for this service are processed. A paid Session
 * confirms its booking; a Session that ended unpaid (expired, or a delayed payment that failed) gives the
 * guest's hold back (#285 slice 4, docs/guest-booking.md). Payloads are never logged.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const secret = process.env.EXPERIENCE_STRIPE_WEBHOOK_SECRET;
  const platformKey = process.env.EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY;
  const pool = experiencePool();
  const store = experienceStore();
  const releases = guestHoldReleases();
  if (!secret || !platformKey || !pool || !store || !releases) return reply(503);
  const signature = request.headers.get("stripe-signature");
  if (!signature) return reply(400);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_WEBHOOK_BYTES) return reply(413);
  const rawBody = new Uint8Array(await request.arrayBuffer());
  if (rawBody.byteLength > MAX_WEBHOOK_BYTES) return reply(413);

  let event;
  try {
    event = verifyDirectCheckoutWebhook({ rawBody, stripeSignature: signature, endpointSecret: secret, platformStripeKey: platformKey });
  } catch (error) {
    return reply(error instanceof ExperiencePaymentsValidationError ? 400 : 503);
  }
  if (!event) return reply(204);

  try {
    if (isEndedCheckoutEvent(event)) {
      await releases.releaseGuestHold({
        publicBookingId: event.publicBookingId,
        checkoutSessionRef: event.checkoutSessionId,
        connectedAccountId: event.connectedAccountId,
        stripeEventId: event.eventId,
        stripeEventType: event.eventType,
        eventOccurredAtUtc: event.eventOccurredAtUtc,
      });
      return reply(204);
    }
    const booking = await pool.query<{ provider_id: string }>(
      "SELECT provider_id FROM bookings WHERE public_booking_id=$1::uuid",
      [event.publicBookingId],
    );
    if (!booking.rows[0]) return reply(503);
    await store.confirmBookingPayment({ providerId: booking.rows[0].provider_id }, {
      publicBookingId: event.publicBookingId,
      connectedAccountId: event.connectedAccountId,
      stripePaymentRef: event.paymentIntentRef,
      stripeEventId: event.eventId,
      stripeEventType: event.eventType,
      eventOccurredAtUtc: event.eventOccurredAtUtc,
      amount: event.amountTotal,
      currency: event.currency,
    });
    return reply(204);
  } catch {
    // Stripe retries transient DB failures; the store handles duplicate delivery of either kind atomically.
    console.error("Experience Stripe webhook could not be recorded");
    return reply(503);
  }
}
