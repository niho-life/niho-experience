import type { HostGuestBooking } from "@niho-experience/experience-store";

/*
 * 予約 as the experience DB gives the bookings made on this site (#285 slice 8), invented for the preview's
 * `?mock=site-bookings` sign-in: the sample kitchen's Community Dinner and tea time around the preview's day
 * (MOCK_TODAY, 10/21), with NIHO's fee fixed at booking (10 % with support off, 15 % with it on). One is a payment
 * under review, three are cancelled (refunded in full, in part, and still on its way) and one has passed. Nothing
 * here is a real booking, payment or guest; the store's integration tests check the real reads.
 */

const DINNER = { productId: "community-dinner", productTitle: "Kamakura Community Dinner with Locals", offerId: "offer-dinner", adultUnitAmount: 30000, childUnitAmount: 12000 } as const;
const TEA = { productId: "community-dinner", productTitle: "Kamakura Community Dinner with Locals", offerId: "offer-tea", adultUnitAmount: 15000, childUnitAmount: null } as const;

type Fields = Pick<HostGuestBooking, "publicBookingId" | "productId" | "productTitle" | "offerId" | "adultUnitAmount" | "childUnitAmount" | "localDate" | "localStartTime" | "adultCount" | "bookedAtUtc"> &
  Partial<Omit<HostGuestBooking, "platformFee" | "providerAmount" | "totalAmount">> & { name: string; support?: boolean };

/** A booking with its total and NIHO's fee worked out as the store fixes them (floor of total × rate). */
function booking({ name, support = false, ...fields }: Fields): HostGuestBooking {
  const childCount = fields.childCount ?? 0;
  const totalAmount = fields.adultUnitAmount * fields.adultCount + (fields.childUnitAmount ?? 0) * childCount;
  const basisPoints = support ? 1500 : 1000;
  const fee = Math.floor((totalAmount * basisPoints) / 10000);
  // Japan has no summer time: the local start is 9 hours ahead of UTC.
  const startUtc = new Date(`${fields.localDate}T${fields.localStartTime}:00+09:00`).toISOString();
  const endUtc = new Date(Date.parse(startUtc) + 2 * 60 * 60 * 1000).toISOString();
  return {
    status: "CONFIRMED",
    timeZone: "Asia/Tokyo",
    startUtc,
    endUtc,
    childCount,
    language: "EN",
    guest: { name, phone: null, note: null, answers: [] },
    currency: "JPY",
    totalAmount,
    platformFee: { supportEnabled: support, basisPoints, amount: fee },
    providerAmount: totalAmount - fee,
    cancellationPolicy: "FREE_UNTIL_48H",
    paidAtUtc: fields.bookedAtUtc,
    cancelledAtUtc: null,
    cancelledBy: null,
    cancellationReason: null,
    cancellationNote: null,
    refundedAmount: 0,
    refundPendingAmount: 0,
    refundFailed: false,
    cancellationRequested: false,
    ...fields,
  };
}

/** Upcoming first (the nearest first), then past (the latest first), as the store lists them. */
export const MOCK_SITE_BOOKINGS: readonly HostGuestBooking[] = [
  booking({ ...DINNER, publicBookingId: "00000000-0000-4000-8000-00000000b101", name: "Hannah Kim", localDate: "2026-10-24", localStartTime: "18:00", adultCount: 2, bookedAtUtc: "2026-10-12T01:20:00.000Z" }),
  // Refunded in full by the host (雨・荒天): NIHO's fee goes back with it.
  booking({
    ...TEA, publicBookingId: "00000000-0000-4000-8000-00000000b102", name: "Kenji Sato", language: "JA", localDate: "2026-10-25", localStartTime: "13:00", adultCount: 2, bookedAtUtc: "2026-10-09T10:00:00.000Z",
    status: "CANCELLED", cancelledAtUtc: "2026-10-20T23:10:00.000Z", cancelledBy: "HOST", cancellationReason: "WEATHER", refundedAmount: 30000,
  }),
  // NIHO support on (15 %), with a child.
  booking({ ...DINNER, publicBookingId: "00000000-0000-4000-8000-00000000b103", name: "Noah Park", support: true, localDate: "2026-10-27", localStartTime: "18:00", adultCount: 1, childCount: 1, cancellationPolicy: "FREE_UNTIL_24H", bookedAtUtc: "2026-10-15T08:30:00.000Z" }),
  // Support gave back half: Stripe gives back half of NIHO's fee too.
  booking({
    ...DINNER, publicBookingId: "00000000-0000-4000-8000-00000000b104", name: "Maya Cohen", localDate: "2026-10-27", localStartTime: "18:00", adultCount: 1, bookedAtUtc: "2026-10-05T04:00:00.000Z",
    status: "CANCELLED", cancelledAtUtc: "2026-10-19T02:00:00.000Z", cancelledBy: "SUPPORT", cancellationReason: "OTHER", refundedAmount: 15000,
  }),
  // The payment arrived after the hold was released: no seat until NIHO support settles it.
  booking({ ...DINNER, publicBookingId: "00000000-0000-4000-8000-00000000b105", name: "Léa Dubois", status: "PAYMENT_REVIEW", localDate: "2026-10-29", localStartTime: "18:00", adultCount: 2, bookedAtUtc: "2026-10-21T03:00:00.000Z" }),
  // The guest cancelled for free; Stripe has not finished the refund.
  booking({
    ...DINNER, publicBookingId: "00000000-0000-4000-8000-00000000b106", name: "Oscar Lind", localDate: "2026-10-29", localStartTime: "18:00", adultCount: 1, bookedAtUtc: "2026-10-14T11:00:00.000Z",
    status: "CANCELLED", cancelledAtUtc: "2026-10-21T05:00:00.000Z", cancelledBy: "GUEST", cancellationReason: "GUEST_REQUEST", refundPendingAmount: 30000,
  }),
  booking({ ...DINNER, publicBookingId: "00000000-0000-4000-8000-00000000b107", name: "Priya Nair", localDate: "2026-10-17", localStartTime: "18:00", adultCount: 2, bookedAtUtc: "2026-10-02T06:45:00.000Z" }),
];
