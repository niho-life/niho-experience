import { StoreValidationError } from "@niho-experience/experience-store";
import { guestBookingAccess } from "@/lib/experience/store-server";
import { fromThisSite } from "@/lib/experience/public-http";
import { bookingEmpty, bookingJson, bookingPagesEnabled, readBookingAccessBody } from "@/lib/experience/booking-access-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Find your booking" (#285 slice 6): `{ email }`. The store queues a link email for each open booking of the
 * address (the mail job sends them, so no email goes out during the request) and the answer is the same 202
 * whether or not anything matched or the address reached its limit. 422 only for something that is not an
 * address. The address is not logged.
 */
export async function POST(request: Request): Promise<Response> {
  if (!bookingPagesEnabled()) return bookingEmpty(404);
  if (!fromThisSite(request)) return bookingEmpty(403);
  const access = guestBookingAccess();
  if (!access) return bookingEmpty(503);
  const body = await readBookingAccessBody(request);
  if (!body.ok) return body.response;
  const email = body.value.email;
  if (typeof email !== "string") return bookingEmpty(422);
  try {
    await access.requestBookingLink({ email });
  } catch (error) {
    return bookingEmpty(error instanceof StoreValidationError ? 422 : 503);
  }
  return bookingJson(202, { accepted: true });
}
