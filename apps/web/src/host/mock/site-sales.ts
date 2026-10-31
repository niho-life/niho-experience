import type { HostSaleEntry } from "@niho-experience/experience-store";

/*
 * 売上 as the experience DB's ledger gives it (#91), invented for the preview's `?mock=site-sales` sign-in: the
 * sample kitchen's bookings made on this site in September and October 2026, with NIHO's 10 % (support off). Nothing
 * here is a real payment, booking or guest; the store's integration test checks the real reads.
 */

const DINNER = "Kamakura Community Dinner";
const TEA = "Kamakura tea time";

type Fields = Pick<HostSaleEntry, "occurredAtUtc" | "publicBookingId" | "productTitle" | "localDate" | "localStartTime" | "adultCount" | "guestName" | "amount"> &
  Partial<Pick<HostSaleEntry, "bookingStatus" | "childCount">>;

/** A payment with NIHO's 10 %, kept whole. */
function payment(fields: Fields): HostSaleEntry {
  const fee = Math.floor(fields.amount / 10);
  return {
    key: `payment:${fields.publicBookingId}`, kind: "PAYMENT", currency: "JPY", bookingStatus: "CONFIRMED", childCount: 0, refund: null,
    platformFeeAmount: fee, providerAmount: fields.amount - fee, feeEstimated: false, ...fields,
  };
}

/** A refund of the payment `paid` (amount negative), giving back `feeBack` of NIHO's fee. */
function refund(paid: HostSaleEntry, fields: Pick<HostSaleEntry, "occurredAtUtc" | "amount" | "refund"> & { key: string; feeBack: number; feeEstimated?: boolean }): HostSaleEntry {
  const { key, feeBack, feeEstimated = false, ...rest } = fields;
  return { ...paid, key, kind: "REFUND", platformFeeAmount: -feeBack, providerAmount: rest.amount + feeBack, feeEstimated, ...rest };
}

const hannah = payment({ occurredAtUtc: "2026-10-12T01:20:00.000Z", publicBookingId: "00000000-0000-4000-8000-00000000a012", productTitle: DINNER, localDate: "2026-10-24", localStartTime: "18:00", adultCount: 2, guestName: "Hannah Kim", amount: 30000, bookingStatus: "CANCELLED" });
const lucas = payment({ occurredAtUtc: "2026-10-07T23:40:00.000Z", publicBookingId: "00000000-0000-4000-8000-00000000a008", productTitle: TEA, localDate: "2026-10-19", localStartTime: "14:00", adultCount: 1, childCount: 1, guestName: "Lucas Martin", amount: 12000, bookingStatus: "CANCELLED" });

/** The latest first, as the store reads them. */
export const MOCK_SITE_SALES: readonly HostSaleEntry[] = [
  payment({ occurredAtUtc: "2026-10-18T05:10:00.000Z", publicBookingId: "00000000-0000-4000-8000-00000000a018", productTitle: TEA, localDate: "2026-10-25", localStartTime: "14:00", adultCount: 2, guestName: "Mateo García", amount: 12000 }),
  payment({ occurredAtUtc: "2026-10-16T09:30:00.000Z", publicBookingId: "00000000-0000-4000-8000-00000000a016", productTitle: DINNER, localDate: "2026-10-31", localStartTime: "18:00", adultCount: 3, guestName: "Sofia Rossi", amount: 45000 }),
  refund(hannah, { key: "refund:00000000-0000-4000-8000-0000000fa012", occurredAtUtc: "2026-10-14T02:00:00.000Z", amount: -30000, feeBack: 3000, refund: { kind: "FULL", status: "SUCCEEDED" } }),
  hannah,
  // Support gave back ¥5,000 of ¥12,000; Stripe has not finished it. Its share of the fee is worked out.
  refund(lucas, { key: "refund:00000000-0000-4000-8000-0000000fa008", occurredAtUtc: "2026-10-10T04:00:00.000Z", amount: -5000, feeBack: 500, feeEstimated: true, refund: { kind: "PARTIAL", status: "PENDING" } }),
  lucas,
  // Paid after the hold ended: under review, no seat kept.
  payment({ occurredAtUtc: "2026-10-04T15:30:00.000Z", publicBookingId: "00000000-0000-4000-8000-00000000a005", productTitle: TEA, localDate: "2026-10-11", localStartTime: "10:00", adultCount: 1, guestName: "Emma Wilson", amount: 6000, bookingStatus: "PAYMENT_REVIEW" }),
  // September: the last day's evening in Japan is still September.
  payment({ occurredAtUtc: "2026-09-30T14:30:00.000Z", publicBookingId: "00000000-0000-4000-8000-00000000a930", productTitle: TEA, localDate: "2026-10-03", localStartTime: "10:00", adultCount: 1, guestName: "Ava Johnson", amount: 6000 }),
  payment({ occurredAtUtc: "2026-09-20T03:00:00.000Z", publicBookingId: "00000000-0000-4000-8000-00000000a920", productTitle: DINNER, localDate: "2026-09-26", localStartTime: "18:00", adultCount: 2, guestName: "Noah Schmidt", amount: 30000 }),
];
