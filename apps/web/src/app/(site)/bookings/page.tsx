import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FindBookingForm } from "@/components/FindBookingForm";
import { bookingPagesEnabled } from "@/lib/experience/booking-access-http";

// Never prerendered: the flags are read per request. next.config.ts sends no-store and noindex for /bookings.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Find your booking", robots: { index: false, follow: false }, referrer: "no-referrer" };

/**
 * "Find your booking" (#285 slice 6, docs/guest-booking.md): there are no traveler accounts and no list of bookings.
 * The guest gets a new link to each booking by email; the page says the same whatever the address.
 */
export default function FindBookingPage() {
  if (!bookingPagesEnabled()) notFound();
  return (
    <div className="container-page max-w-2xl py-12">
      <p className="hand text-[1.75rem]">your booking</p>
      <h1 className="mt-1 text-3xl">Find your booking</h1>
      <p className="mt-3 text-ink-soft">
        Enter the email address you booked with. We&apos;ll email you a link to each booking you made on this site. Each link opens the booking once, on the device you open it on.
      </p>
      <FindBookingForm />
    </div>
  );
}
