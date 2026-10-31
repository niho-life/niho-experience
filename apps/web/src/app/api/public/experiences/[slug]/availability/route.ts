import type { PublicErrorResponse } from "@niho-experience/api-client";
import { config } from "@/lib/config";
import { publicEmpty, publicJson } from "@/lib/experience/public-http";
import { guestBookingRepository } from "@/lib/experience/store-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OFFER_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 開催回と残席 of an experience sold on this site (#285, docs/guest-booking.md), at NIHO's path and in its
 * shape (PublicExperienceAvailabilityResponse, docs/api-contract.md §3): today through 89 days in Tokyo,
 * counted per request and never cached (`no-store`, as NIHO). `?offerId=` narrows it to one offer. An
 * experience that is not for sale here is 404 without a body, as NIHO's.
 */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  if (!config.guestBookingEnabled) return publicEmpty(404);
  const { slug } = await params;
  if (slug.length < 1 || slug.length > 160) return publicEmpty(404);
  const offerId = new URL(request.url).searchParams.get("offerId");
  if (offerId !== null && !OFFER_ID.test(offerId)) {
    return publicJson(400, { error: { code: "VALIDATION_ERROR", message: "offerId is invalid." } } satisfies PublicErrorResponse);
  }
  const bookings = guestBookingRepository();
  if (!bookings) return publicEmpty(503);
  try {
    const availability = await bookings.listPublicAvailability(slug, offerId === null ? {} : { offerId });
    return availability === null ? publicEmpty(404) : publicJson(200, availability);
  } catch (error) {
    console.error("Experience guest availability failed", { error: error instanceof Error ? error.name : typeof error });
    return publicEmpty(503);
  }
}
