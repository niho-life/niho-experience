import { bookingEmpty, bookingPagesEnabled, bookingSessionCookieName, publicBookingIdOrNull, requestCookie, accessSecret } from "@/lib/experience/booking-access-http";
import { guestBookingAccess } from "@/lib/experience/store-server";
import { experiencePublicMediaStorage } from "@/lib/experience/public-media-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A private guide image is served only to the current session for this confirmed booking. */
export async function GET(request: Request, context: { params: Promise<{ publicBookingId: string }> }): Promise<Response> {
  if (!bookingPagesEnabled()) return bookingEmpty(404);
  const publicBookingId = publicBookingIdOrNull((await context.params).publicBookingId);
  if (!publicBookingId || new URL(request.url).search) return bookingEmpty(404);
  const sessionId = accessSecret(requestCookie(request, bookingSessionCookieName(publicBookingId)));
  if (!sessionId) return bookingEmpty(404);
  const access = guestBookingAccess();
  const storage = experiencePublicMediaStorage();
  if (!access || !storage) return bookingEmpty(503);
  try {
    const photo = await access.readBookingMeetingPhoto(sessionId, publicBookingId);
    if (!photo) return bookingEmpty(404);
    const bytes = await storage.read(photo.objectKey);
    if (bytes.byteLength !== photo.byteSize) return bookingEmpty(503);
    return new Response(Uint8Array.from(bytes).buffer, { headers: {
      "cache-control": "private, no-store",
      "content-type": "image/jpeg",
      "content-length": String(bytes.byteLength),
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
    } });
  } catch {
    return bookingEmpty(503);
  }
}
