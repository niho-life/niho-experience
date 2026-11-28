import type { BookingChangeOptions } from "@niho-experience/experience-store";
import { fromThisSite } from "@/lib/experience/public-http";
import {
  accessSecret,
  bookingChangesEnabled,
  bookingEmpty,
  bookingJson,
  bookingSessionCookieName,
  publicBookingIdOrNull,
  readBookingAccessBody,
  requestCookie,
} from "@/lib/experience/booking-access-http";
import { bookingChanges } from "@/lib/experience/store-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The dates the guest's booking may move to (予約の日時変更, #720, docs/guest-booking.md): `{ publicBookingId }`,
 * same-origin only, with the booking's session cookie. 200 `{ changeable, fromStartUtc?, changesUsed?, maxChanges?,
 * options }`: each option is a date of the same offer with room for the whole party, its times and its new free
 * cancellation deadline. Nothing personal. Without a session for the booking, the same 404 as the page's neutral answer.
 * Nothing the page sends is logged.
 */
export async function POST(request: Request): Promise<Response> {
  if (!bookingChangesEnabled()) return bookingEmpty(404);
  if (!fromThisSite(request)) return bookingEmpty(403);
  const changes = bookingChanges();
  if (!changes) return bookingEmpty(503);
  const body = await readBookingAccessBody(request);
  if (!body.ok) return body.response;
  const bookingId = publicBookingIdOrNull(body.value.publicBookingId);
  if (!bookingId) return bookingEmpty(400);
  const sessionId = accessSecret(requestCookie(request, bookingSessionCookieName(bookingId)));
  if (!sessionId) return bookingEmpty(404);

  let found: BookingChangeOptions | null;
  try {
    found = await changes.listChangeOptions(sessionId, bookingId);
  } catch (error) {
    console.error("Experience guest change options failed", { error: error instanceof Error ? error.name : typeof error });
    return bookingEmpty(503);
  }
  if (!found) return bookingEmpty(404);
  return bookingJson(200, found.changeable ? found : { changeable: false, options: [] });
}
