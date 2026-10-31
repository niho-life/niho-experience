import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import type { GuestBookingView } from "@niho-experience/experience-store";
import { BookingNotOpen, BookingUnavailable, GuestBookingDetails } from "@/components/GuestBookingDetails";
import { accessSecret, bookingPagesEnabled, bookingSessionCookieName, publicBookingIdOrNull } from "@/lib/experience/booking-access-http";
import { guestBookingAccess } from "@/lib/experience/store-server";

// Never prerendered or cached: each request reads its own cookie. next.config.ts sends no-store and noindex for /bookings.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Your booking", robots: { index: false, follow: false }, referrer: "no-referrer" };

/**
 * The guest's booking page (#285 slice 6, docs/guest-booking.md). It reads the session cookie for this booking only;
 * without a session for it, or with an ID that is no booking, the page is the same neutral one, so nothing tells
 * whether the booking exists. The cookie holds a session for one booking: another booking's cookie never opens this
 * one. When the database does not answer, the page says so whatever the booking (that too tells nothing).
 */
export default async function GuestBookingPage({ params }: { params: Promise<{ publicBookingId: string }> }) {
  if (!bookingPagesEnabled()) notFound();
  const bookingId = publicBookingIdOrNull((await params).publicBookingId);
  if (!bookingId) return <BookingNotOpen />;
  const sessionId = accessSecret((await cookies()).get(bookingSessionCookieName(bookingId))?.value);
  if (!sessionId) return <BookingNotOpen />;
  const access = guestBookingAccess();
  if (!access) return <BookingUnavailable />;
  let booking: GuestBookingView | null;
  try {
    booking = await access.readBookingSession(sessionId, bookingId);
  } catch {
    return <BookingUnavailable />;
  }
  return booking ? <GuestBookingDetails booking={booking} now={new Date()} /> : <BookingNotOpen />;
}
