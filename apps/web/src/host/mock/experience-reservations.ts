import type { HostGuestBooking } from "@niho-experience/experience-store";
import type { HostThread } from "../types";
import { MOCK_SITE_BOOKINGS } from "./site-bookings";
import { MOCK_KITCHEN_THREADS } from "./threads";

/** One synthetic Experience reservation set for the ordinary preview and its deep links. */
export function mockExperienceBookings(providerId: string): readonly HostGuestBooking[] {
  return providerId === "sample-provider-kitchen" ? MOCK_SITE_BOOKINGS : [];
}

/** Questions remain synthetic; the booked conversation joins the same native reservation as the list. */
export function mockExperienceThreads(providerId: string): HostThread[] {
  const booking = mockExperienceBookings(providerId)[0];
  if (!booking) return [];
  return MOCK_KITCHEN_THREADS.map((thread) => thread.booking ? {
    ...thread,
    guest: booking.guest!.name,
    booking: {
      id: booking.publicBookingId,
      date: booking.localDate,
      start: booking.localStartTime,
      guests: booking.adultCount + booking.childCount,
      site: true,
    },
  } : thread);
}
