import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BookingOpen } from "@/components/BookingOpen";
import { bookingPagesEnabled } from "@/lib/experience/booking-access-http";

// Never prerendered: the flags are read per request. next.config.ts sends no-store and noindex for /bookings.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Open your booking", robots: { index: false, follow: false }, referrer: "no-referrer" };

/**
 * The link in the guest's emails (#285 slice 6, docs/guest-booking.md): `/bookings/open#g=<grant>`. The server never
 * sees the grant (it is in the fragment); the page reads it in the browser and opens the booking on a button press.
 */
export default function BookingOpenPage() {
  if (!bookingPagesEnabled()) notFound();
  return <BookingOpen />;
}
