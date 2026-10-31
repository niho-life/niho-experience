import { guestBookingAccess } from "@/lib/experience/store-server";
import { fromThisSite } from "@/lib/experience/public-http";
import { accessSecret, bookingEmpty, bookingJson, bookingPagesEnabled, bookingSessionCookie, readBookingAccessBody } from "@/lib/experience/booking-access-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `/bookings/open` (#285 slice 6) opens the link from the guest's email: `{ grant }` in the body (never in the URL).
 * A grant opens one session: the answer sets that booking's HttpOnly session cookie and names the booking. 404,
 * with no body, when the grant is unknown, used or expired, or the booking cannot be opened; the page does not
 * say which.
 */
export async function POST(request: Request): Promise<Response> {
  if (!bookingPagesEnabled()) return bookingEmpty(404);
  if (!fromThisSite(request)) return bookingEmpty(403);
  const access = guestBookingAccess();
  if (!access) return bookingEmpty(503);
  const body = await readBookingAccessBody(request);
  if (!body.ok) return body.response;
  const grant = accessSecret(body.value.grant);
  if (!grant) return bookingEmpty(404);
  try {
    const session = await access.openBookingSession(grant);
    if (!session) return bookingEmpty(404);
    return bookingJson(200, { publicBookingId: session.publicBookingId }, {
      "set-cookie": bookingSessionCookie(session.publicBookingId, session.sessionId, session.expiresAtUtc),
    });
  } catch {
    return bookingEmpty(503);
  }
}
