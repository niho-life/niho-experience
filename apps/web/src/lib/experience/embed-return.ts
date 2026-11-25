import "server-only";
import type { BookingReturnBackTo } from "@/lib/booking-return-copy";
import { config } from "@/lib/config";
import { guestBookingRepository } from "@/lib/experience/store-server";

/** A Stripe Checkout Session ID, as the store accepts it. Anything else never reaches the database. */
const CHECKOUT_SESSION_ID = /^cs_[A-Za-z0-9_]{1,250}$/;
/** The return page does not wait longer than this for the link: without it, the page is the same as before. */
export const EMBED_RETURN_LOOKUP_TIMEOUT_MS = 1_500;

/**
 * The return page's "Back to {host}" link (#638, docs/embed.md「旅行者の流れ」): only for a booking made from the widget
 * on a host's site whose origin was kept, right after it was paid or while its hold is active (the store decides). Stripe
 * sends the traveler back with `cs` (the Checkout Session's ID); the link is the origin stored with that booking, never a
 * value from the URL or the framing page. Off (EXPERIENCE_EMBED_ENABLED or guest bookings), without one well-formed `cs`,
 * after 1.5 s or on any failure there is no link. `cs` is not logged.
 */
export async function embedReturnLink(cs: string | string[] | undefined): Promise<BookingReturnBackTo | undefined> {
  if (typeof cs !== "string" || !CHECKOUT_SESSION_ID.test(cs) || !config.embedEnabled || !config.guestBookingEnabled) return undefined;
  const repository = guestBookingRepository();
  if (!repository) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let origin: string | null;
  try {
    origin = await Promise.race([
      repository.findEmbedReturnOrigin(cs),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), EMBED_RETURN_LOOKUP_TIMEOUT_MS); }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (origin === null) return undefined;
  let url: URL;
  try { url = new URL(origin); } catch { return undefined; }
  if (url.protocol !== "https:" || url.origin !== origin) return undefined;
  return { href: url.origin, host: url.host };
}
