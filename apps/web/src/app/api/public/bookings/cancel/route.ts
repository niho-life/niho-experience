import { StoreConflictError, StoreValidationError, type CancellationResult } from "@niho-experience/experience-store";
import { sendRefunds, stripeRefundSubmitter } from "@/lib/experience/booking-refunds";
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
import { bookingCancellations } from "@/lib/experience/store-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * "Cancel and get a full refund" / "Ask to cancel" on the guest's booking page (#285 slice 7, docs/guest-booking.md
 * 「取消と返金（第7段）」): `{ publicBookingId, commandId, choice, shownDeadlineUtc }`, same-origin only, with the
 * booking's session cookie. The page sends the deadline it showed; the store reads the booking and its terms again
 * and answers CHANGED when they are no longer what the page showed. The refund is then sent to Stripe; one that
 * cannot be sent now stays requested (the page says it is on its way). 200 `{ outcome }`; without a session for the
 * booking, the same 404 as the page's neutral answer. Nothing the page sends is logged.
 */
export async function POST(request: Request): Promise<Response> {
  if (!bookingPagesEnabled()) return bookingEmpty(404);
  if (!fromThisSite(request)) return bookingEmpty(403);
  const cancellations = bookingCancellations();
  if (!cancellations) return bookingEmpty(503);
  const body = await readBookingAccessBody(request);
  if (!body.ok) return body.response;
  const { commandId, choice, shownDeadlineUtc } = body.value;
  const bookingId = publicBookingIdOrNull(body.value.publicBookingId);
  if (
    !bookingId
    || typeof commandId !== "string" || !UUID.test(commandId)
    || (choice !== "FULL_REFUND" && choice !== "REQUEST")
    || (shownDeadlineUtc !== null && (typeof shownDeadlineUtc !== "string" || !INSTANT.test(shownDeadlineUtc)))
  ) return bookingEmpty(400);
  const sessionId = accessSecret(requestCookie(request, bookingSessionCookieName(bookingId)));
  if (!sessionId) return bookingEmpty(404);

  let result: CancellationResult | null;
  try {
    result = await cancellations.cancelAsGuest(sessionId, bookingId, { commandId, choice, shownDeadlineUtc });
  } catch (error) {
    // The same command ID with other input, or input the store refuses: the page starts over.
    if (error instanceof StoreConflictError || error instanceof StoreValidationError) return bookingEmpty(409);
    console.error("Experience guest cancellation failed", { error: error instanceof Error ? error.name : typeof error });
    return bookingEmpty(503);
  }
  if (!result) return bookingEmpty(404);
  await sendRefunds(result.refunds, { cancellations, submit: stripeRefundSubmitter() });
  return bookingJson(200, { outcome: result.outcome });
}
