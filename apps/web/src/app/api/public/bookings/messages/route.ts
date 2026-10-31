import { BookingMessagesClosedError, StoreConflictError, StoreRateLimitedError, StoreValidationError } from "@niho-experience/experience-store";
import { fromThisSite } from "@/lib/experience/public-http";
import {
  accessSecret,
  bookingEmpty,
  bookingJson,
  bookingPagesEnabled,
  bookingSessionCookieName,
  publicBookingIdOrNull,
  readBookingAccessBody,
  requestCookie,
} from "@/lib/experience/booking-access-http";
import { guestBookingMessages } from "@/lib/experience/store-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Write to your host" on the guest's booking page (#285 slice 6b, docs/guest-booking.md「予約ごとのメッセージ」):
 * `{ publicBookingId, clientRequestKey, message }`, same-origin only, with the booking's session cookie. The page keeps
 * the same key for a retry of the same words, so a lost answer never sends twice.
 *
 * - 200 `{ status: "received" }`: in the thread (again: the same message).
 * - 409 `{ error: "CLOSED" }`: the booking takes no more messages (cancelled, or 30 days after the experience).
 * - 409 `{ error: "CONFLICT" }`: the key was used with other words: the page starts the message again.
 * - 422: an empty or too long message. 429 with Retry-After: 10 messages an hour per booking.
 * - 404 without a session for the booking (the page's neutral answer), and while the page is off.
 *
 * Nothing the guest wrote is logged.
 */
export async function POST(request: Request): Promise<Response> {
  if (!bookingPagesEnabled()) return bookingEmpty(404);
  if (!fromThisSite(request)) return bookingEmpty(403);
  const messages = guestBookingMessages();
  if (!messages) return bookingEmpty(503);
  const body = await readBookingAccessBody(request);
  if (!body.ok) return body.response;
  const bookingId = publicBookingIdOrNull(body.value.publicBookingId);
  const { message, clientRequestKey } = body.value;
  if (!bookingId || typeof message !== "string" || typeof clientRequestKey !== "string") return bookingEmpty(400);
  const sessionId = accessSecret(requestCookie(request, bookingSessionCookieName(bookingId)));
  if (!sessionId) return bookingEmpty(404);

  try {
    const result = await messages.sendMessage(sessionId, bookingId, { message, clientRequestKey });
    return result ? bookingJson(200, { status: "received" }) : bookingEmpty(404);
  } catch (error) {
    if (error instanceof BookingMessagesClosedError) return bookingJson(409, { error: "CLOSED" });
    if (error instanceof StoreConflictError) return bookingJson(409, { error: "CONFLICT" });
    if (error instanceof StoreRateLimitedError) return bookingEmpty(429, { "retry-after": String(error.retryAfterSeconds) });
    if (error instanceof StoreValidationError) return bookingEmpty(422);
    console.error("Experience booking message failed", { error: error instanceof Error ? error.name : typeof error });
    return bookingEmpty(503);
  }
}
