import "server-only";
import type { SupportEnabledBookingsPage, SupportQueue, SupportQueueBooking } from "@niho-experience/experience-store";

/*
 * サイト予約の合成プレビュー (#121/#128): what /admin/site-bookings draws when ADMIN_SITE_BOOKINGS_PREVIEW_ENABLED is on
 * in mock mode, for Playwright. Synthetic only: no real names, emails, phone numbers or Stripe IDs. The browser's API
 * calls are stubbed by the test; nothing here is saved or sent.
 */

const booking = (overrides: Partial<SupportQueueBooking> & Pick<SupportQueueBooking, "publicBookingId">): SupportQueueBooking => ({
  providerId: "provider-sample",
  experienceTitle: "Synthetic indigo dyeing",
  status: "CONFIRMED",
  localDate: "2026-12-05",
  localStartTime: "10:00",
  timeZone: "Asia/Tokyo",
  startUtc: "2026-12-05T01:00:00.000Z",
  guestName: "Sample Guest A",
  totalAmount: 12000,
  currency: "JPY",
  cancellationPolicy: "FREE_UNTIL_48H",
  cancellationRefundBasisPoints: 10000,
  freeCancellationUntilUtc: "2026-12-03T01:00:00.000Z",
  supportEligible: true,
  ...overrides,
});

export const ADMIN_SITE_BOOKINGS_PREVIEW_IDS = {
  confirmed: "0f8fad5b-d9cb-469f-a165-708677289501",
  review: "1b4e28ba-2fa1-41d2-883f-0016d3cca427",
  cancelled: "6fa459ea-ee8a-4ca4-894e-db77e160355e",
  request: "16fd2706-8baf-433b-82eb-8c7fada847da",
} as const;

export function adminSiteBookingsPreview(): { queue: SupportQueue; supportBookings: SupportEnabledBookingsPage } {
  const ids = ADMIN_SITE_BOOKINGS_PREVIEW_IDS;
  const request = booking({ publicBookingId: ids.request, guestName: "Sample Guest D", experienceTitle: "Synthetic tea ceremony", localDate: "2026-12-08" });
  return {
    queue: {
      cancellationRequests: [{ ...request, requestId: "9a7b3c1d-2e4f-4a6b-8c9d-0e1f2a3b4c5d", requestedAtUtc: "2026-11-05T03:00:00.000Z" }],
      paymentReviews: [],
      refunds: [],
    },
    supportBookings: {
      bookings: [
        booking({ publicBookingId: ids.confirmed }),
        booking({ publicBookingId: ids.review, status: "PAYMENT_REVIEW", guestName: "Sample Guest B", localDate: "2026-12-06", experienceTitle: "Synthetic coastal walk", totalAmount: 6000 }),
        booking({ publicBookingId: ids.cancelled, status: "CANCELLED", guestName: null, localDate: "2026-12-07", cancellationPolicy: "NONE", freeCancellationUntilUtc: null }),
      ],
      nextCursor: ids.cancelled,
    },
  };
}
