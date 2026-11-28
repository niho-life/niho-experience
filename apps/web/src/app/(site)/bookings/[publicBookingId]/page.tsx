import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import type { GuestBookingConversation, GuestBookingView } from "@niho-experience/experience-store";
import { BookingNotOpen, BookingUnavailable, GuestBookingDetails } from "@/components/GuestBookingDetails";
import { config } from "@/lib/config";
import { accessSecret, bookingChangesEnabled, bookingPagesEnabled, bookingSessionCookieName, publicBookingIdOrNull } from "@/lib/experience/booking-access-http";
import { bookingChanges, guestBookingAccess, guestBookingMessages } from "@/lib/experience/store-server";
import { translationNoticeShown } from "@/lib/translation-notice";

// Never prerendered or cached: each request reads its own cookie. next.config.ts sends no-store and noindex for /bookings.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Your booking", robots: { index: false, follow: false }, referrer: "no-referrer" };

/**
 * The guest's booking page (#285 slice 6, docs/guest-booking.md). It reads the session cookie for this booking only;
 * without a session for it, or with an ID that is no booking, the page is the same neutral one, so nothing tells
 * whether the booking exists. The cookie holds a session for one booking: another booking's cookie never opens this
 * one. When the database does not answer, the page says so whatever the booking (that too tells nothing). The messages
 * with the host (#285 slice 6b) are read with the same session; when only they cannot be read, the page shows the
 * booking and says so where they would be.
 */
export default async function GuestBookingPage({ params, searchParams }: { params: Promise<{ publicBookingId: string }>; searchParams?: Promise<{ lang?: string | string[] }> }) {
  if (!bookingPagesEnabled()) notFound();
  // Before a session opens the booking its language is unknown: `?lang=ja` (from a Japanese booking's email) picks it (#59).
  const unknown = (await searchParams)?.lang === "ja" ? "ja" : "en";
  const bookingId = publicBookingIdOrNull((await params).publicBookingId);
  if (!bookingId) return <BookingNotOpen locale={unknown} />;
  const sessionId = accessSecret((await cookies()).get(bookingSessionCookieName(bookingId))?.value);
  if (!sessionId) return <BookingNotOpen locale={unknown} />;
  const access = guestBookingAccess();
  if (!access) return <BookingUnavailable locale={unknown} />;
  let booking: GuestBookingView | null;
  try {
    booking = await access.readBookingSession(sessionId, bookingId);
  } catch {
    return <BookingUnavailable locale={unknown} />;
  }
  if (!booking) return <BookingNotOpen locale={unknown} />;
  let conversation: GuestBookingConversation | null = null;
  try {
    conversation = (await guestBookingMessages()?.readConversation(sessionId, bookingId)) ?? null;
  } catch {
    conversation = null;
  }
  // 予約の日時変更 (#720): "Change date" shows only when the store says this booking may be moved now; a failure hides it.
  let changeable = false;
  if (booking.status === "CONFIRMED" && bookingChangesEnabled()) {
    try {
      changeable = (await bookingChanges()?.isChangeable(sessionId, bookingId)) === true;
    } catch {
      changeable = false;
    }
  }
  return <GuestBookingDetails booking={booking} now={new Date()} conversation={conversation} translationNotice={translationNoticeShown(config)} changeable={changeable} />;
}
