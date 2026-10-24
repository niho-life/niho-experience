import type { SalesPeriod } from "../sales";
import type { HostSale, HostSaleCharge, HostSalePayout } from "../types";

/*
 * Invented ledger lines for the sample kitchen; nothing here is a real payment. The payments of
 * the bookings 予約 lists are dated on their 支払い and the refund on its 取消 (bookingId ties them,
 * and a unit test keeps them in step; today's tea time was paid in September and on 2 October).
 * August is before the preview's months: no screen shows it, but the first dinners with a review
 * (#108) were paid then.
 */

/** The preview's sales screen: September to November 2026, opened on October (the preview's "today"). November has nothing yet. */
export const MOCK_SALES_PERIOD: SalesPeriod = {
  first: { year: 2026, month: 9 },
  last: { year: 2026, month: 11 },
  current: { year: 2026, month: 10 },
};

/** The share NIHO and Stripe keep of a payment in the preview. Invented: the real fees come from NIHO. */
export const MOCK_FEE_RATE = 0.05;

const DINNER = "Kamakura Community Dinner";

type Charge = Pick<HostSaleCharge, "id" | "date" | "guest" | "channel" | "offer" | "guests" | "amountYen"> & Partial<Pick<HostSaleCharge, "bookingId" | "status">>;

/** A payment, posted, with the preview's fee. */
const charge = (fields: Charge): HostSaleCharge => ({ kind: "sale", experience: DINNER, status: "posted", feeYen: Math.round(fields.amountYen * MOCK_FEE_RATE), ...fields });

const payout = (fields: Pick<HostSalePayout, "id" | "date" | "from" | "to" | "amountYen" | "status">): HostSalePayout => ({ kind: "payout", ...fields });

export const MOCK_KITCHEN_SALES: readonly HostSale[] = [
  // October: still being paid out. The payout of the 10th–16th (its refund taken off) is on its way.
  payout({ id: "sl-1020", date: "2026-10-20", from: "2026-10-10", to: "2026-10-16", amountYen: 54000, status: "pending" }),
  charge({ id: "sl-1018a", date: "2026-10-18", guest: "Emma Larsson", channel: "体験サイト", offer: "Dinner", guests: 2, amountYen: 60000, bookingId: "bk-2038" }),
  charge({ id: "sl-1018b", date: "2026-10-18", guest: "Noah Williams", channel: "体験サイト", offer: "Dinner", guests: 1, amountYen: 30000, bookingId: "bk-2035" }),
  charge({ id: "sl-1016", date: "2026-10-16", guest: "Mateo García", channel: "体験サイト", offer: "tea time", guests: 2, amountYen: 30000, bookingId: "bk-2033" }),
  charge({ id: "sl-1015", date: "2026-10-15", guest: "Sofia Rossi", channel: "NIHO", offer: "Dinner", guests: 3, amountYen: 90000, bookingId: "bk-2031" }),
  { id: "sl-1012", kind: "refund", date: "2026-10-12", guest: "Hannah Kim", channel: "体験サイト", amountYen: 60000, status: "posted", bookingId: "bk-2012" },
  payout({ id: "sl-1010", date: "2026-10-10", from: "2026-10-01", to: "2026-10-09", amountYen: 171000, status: "paid" }),
  charge({ id: "sl-1009", date: "2026-10-09", guest: "Oliver Brown", channel: "体験サイト", offer: "Dinner", guests: 2, amountYen: 60000, bookingId: "bk-2020" }),
  charge({ id: "sl-1005", date: "2026-10-05", guest: "Hannah Kim", channel: "体験サイト", offer: "Dinner", guests: 2, amountYen: 60000, bookingId: "bk-2012" }),
  charge({ id: "sl-1004", date: "2026-10-04", guest: "Liam Walker", channel: "NIHO", offer: "Dinner", guests: 1, amountYen: 30000, bookingId: "bk-2010" }),
  charge({ id: "sl-1002", date: "2026-10-02", guest: "Aiko Tanaka", channel: "NIHO", offer: "tea time", guests: 2, amountYen: 30000, bookingId: "bk-2006" }),
  // September: all paid out.
  payout({ id: "sl-0930", date: "2026-09-30", from: "2026-09-16", to: "2026-09-29", amountYen: 142500, status: "paid" }),
  charge({ id: "sl-0927", date: "2026-09-27", guest: "佐藤 由紀", channel: "NIHO", offer: "Dinner", guests: 2, amountYen: 60000, bookingId: "bk-2005" }),
  charge({ id: "sl-0920", date: "2026-09-20", guest: "Lena Novak", channel: "体験サイト", offer: "Dinner", guests: 3, amountYen: 90000, bookingId: "bk-2004" }),
  payout({ id: "sl-0916", date: "2026-09-16", from: "2026-09-01", to: "2026-09-15", amountYen: 71250, status: "paid" }),
  charge({ id: "sl-0913", date: "2026-09-13", guest: "Tom Becker", channel: "NIHO", offer: "tea time", guests: 2, amountYen: 15000, bookingId: "bk-2003" }),
  charge({ id: "sl-0906", date: "2026-09-06", guest: "Grace Lee", channel: "体験サイト", offer: "Dinner", guests: 2, amountYen: 60000, bookingId: "bk-2001" }),
  // August (before the preview's months): paid out on the 31st.
  payout({ id: "sl-0831", date: "2026-08-31", from: "2026-08-16", to: "2026-08-30", amountYen: 85500, status: "paid" }),
  charge({ id: "sl-0828", date: "2026-08-28", guest: "Ella Martin", channel: "体験サイト", offer: "Dinner", guests: 1, amountYen: 30000, bookingId: "bk-1998" }),
  charge({ id: "sl-0825", date: "2026-08-25", guest: "Jonas Weber", channel: "体験サイト", offer: "Dinner", guests: 2, amountYen: 60000, bookingId: "bk-1996" }),
];
