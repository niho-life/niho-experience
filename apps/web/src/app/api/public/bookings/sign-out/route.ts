import { guestBookingAccess } from "@/lib/experience/store-server";
import { fromThisSite } from "@/lib/experience/public-http";
import {
  accessSecret,
  bookingEmpty,
  bookingPagesEnabled,
  bookingSessionCookieName,
  clearedBookingSessionCookie,
  publicBookingIdOrNull,
  readBookingAccessBody,
  requestCookie,
} from "@/lib/experience/booking-access-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Sign out on this device" on the guest's booking page (#285 slice 6): `{ publicBookingId }` names the booking whose
 * cookie to end. The session ends and the cookie goes. 204 whether or not there was a session, so the answer says
 * nothing about the booking; 503 when the session could not be ended (the cookie stays, and the page says so).
 */
export async function POST(request: Request): Promise<Response> {
  if (!bookingPagesEnabled()) return bookingEmpty(404);
  if (!fromThisSite(request)) return bookingEmpty(403);
  const access = guestBookingAccess();
  if (!access) return bookingEmpty(503);
  const body = await readBookingAccessBody(request);
  if (!body.ok) return body.response;
  const bookingId = publicBookingIdOrNull(body.value.publicBookingId);
  if (!bookingId) return bookingEmpty(400);
  const sessionId = accessSecret(requestCookie(request, bookingSessionCookieName(bookingId)));
  try {
    if (sessionId) await access.endBookingSession(sessionId);
  } catch {
    return bookingEmpty(503);
  }
  return bookingEmpty(204, { "set-cookie": clearedBookingSessionCookie(bookingId) });
}
