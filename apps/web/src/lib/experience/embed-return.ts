import "server-only";
import type { BookingReturnBackTo } from "@/lib/booking-return-copy";
import { config } from "@/lib/config";
import { guestBookingRepository } from "@/lib/experience/store-server";

/**
 * The return page's "Back to {host}" link (#638, docs/embed.md「旅行者の流れ」): only for a booking made from the widget
 * on a host's site whose origin was kept. Stripe sends the traveler back with `cs` (the Checkout Session's ID); the link
 * is the origin stored with that booking, never a value from the URL or the framing page. Off (EXPERIENCE_EMBED_ENABLED or
 * guest bookings), with no `cs`, or on any failure there is no link and the database is not read. `cs` is not logged.
 */
export async function embedReturnLink(cs: string | string[] | undefined): Promise<BookingReturnBackTo | undefined> {
  if (typeof cs !== "string" || !config.embedEnabled || !config.guestBookingEnabled) return undefined;
  let origin: string | null;
  try {
    origin = await guestBookingRepository()?.findEmbedReturnOrigin(cs) ?? null;
  } catch {
    return undefined;
  }
  if (origin === null) return undefined;
  let url: URL;
  try { url = new URL(origin); } catch { return undefined; }
  if (url.protocol !== "https:" || url.origin !== origin) return undefined;
  return { href: url.origin, host: url.host };
}
