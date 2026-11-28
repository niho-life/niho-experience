import { StoreConflictError, StoreValidationError, type BookingChangeResult } from "@niho-experience/experience-store";
import { fromThisSite } from "@/lib/experience/public-http";
import {
  accessSecret,
  bookingChangesEnabled,
  bookingEmpty,
  bookingJson,
  bookingSessionCookie,
  bookingSessionCookieName,
  publicBookingIdOrNull,
  readBookingAccessBody,
  requestCookie,
} from "@/lib/experience/booking-access-http";
import { bookingChanges } from "@/lib/experience/store-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * "Change date" on the guest's booking page (予約の日時変更, #720, docs/guest-booking.md): `{ publicBookingId, commandId,
 * toDate, shownFromStartUtc, shownToStartUtc, shownNewDeadlineUtc }`, same-origin only, with the booking's session
 * cookie. The page sends what it showed; the store reads the booking and the new date again and answers CHANGED when
 * they are no longer so. 200 `{ outcome }` (OK, CHANGED, FULL or NOT_CHANGEABLE). Nothing is paid or refunded. Without a
 * session for the booking, the same 404 as the page's neutral answer. Nothing the page sends is logged.
 */
export async function POST(request: Request): Promise<Response> {
  if (!bookingChangesEnabled()) return bookingEmpty(404);
  if (!fromThisSite(request)) return bookingEmpty(403);
  const changes = bookingChanges();
  if (!changes) return bookingEmpty(503);
  const body = await readBookingAccessBody(request);
  if (!body.ok) return body.response;
  const { commandId, toDate, shownFromStartUtc, shownToStartUtc, shownNewDeadlineUtc } = body.value;
  const bookingId = publicBookingIdOrNull(body.value.publicBookingId);
  if (
    !bookingId
    || typeof commandId !== "string" || !UUID.test(commandId)
    || typeof toDate !== "string" || !DATE.test(toDate)
    || typeof shownFromStartUtc !== "string" || !INSTANT.test(shownFromStartUtc)
    || typeof shownToStartUtc !== "string" || !INSTANT.test(shownToStartUtc)
    || typeof shownNewDeadlineUtc !== "string" || !INSTANT.test(shownNewDeadlineUtc)
  ) return bookingEmpty(400);
  const sessionId = accessSecret(requestCookie(request, bookingSessionCookieName(bookingId)));
  if (!sessionId) return bookingEmpty(404);

  let result: BookingChangeResult | null;
  try {
    result = await changes.changeAsGuest(sessionId, bookingId, { commandId, toDate, shownFromStartUtc, shownToStartUtc, shownNewDeadlineUtc });
  } catch (error) {
    // Input the store refuses (a date that does not exist): as any other malformed body.
    if (error instanceof StoreValidationError) return bookingEmpty(400);
    // The same command ID with other input: the page starts over.
    if (error instanceof StoreConflictError) return bookingEmpty(409);
    console.error("Experience guest booking change failed", { error: error instanceof Error ? error.name : typeof error });
    return bookingEmpty(503);
  }
  if (!result) return bookingEmpty(404);
  // The move extended the session to 30 days past the new end: the cookie follows, or the browser drops it at the old end.
  const headers: Record<string, string> = result.sessionExpiresAtUtc ? { "set-cookie": bookingSessionCookie(bookingId, sessionId, result.sessionExpiresAtUtc) } : {};
  return bookingJson(200, { outcome: result.outcome }, headers);
}
