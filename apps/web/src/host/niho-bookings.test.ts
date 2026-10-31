import { describe, expect, it } from "vitest";
import { bookingGroups, matchesBookingFilter } from "./bookings";
import type { HostLiveBookingListItem } from "./live-bookings";
import { nihoBookingExperiences, nihoBookingRow, nihoChannelLabel, nihoExperienceId, nihoRowStatusLabel } from "./niho-bookings";
import { siteBooking, siteBookingExperiences } from "./site-bookings";
import type { HostGuestBooking } from "@niho-experience/experience-store";

/** NIHO's bookings on 予約's one list beside this site's (#84). Synthetic data. */
const ITEM: HostLiveBookingListItem = {
  id: "niho-booking-1", pageId: "page-1", offerId: "offer-1", occurrenceDate: "2026-11-05",
  startAt: "2026-11-05T09:00:00.000Z", endAt: "2026-11-05T11:00:00.000Z", headCount: 3, offerName: "Dinner",
  totalYen: 90000, guestName: "Synthetic Guest", pageTitle: "Synthetic dinner", status: "PROVISIONAL", salesChannel: "NIHO_PAGE",
};

describe("nihoBookingRow", () => {
  it("puts NIHO's booking on its session in Japan's time, with NIHO's channel and 予約's state", () => {
    expect(nihoBookingRow(ITEM)).toEqual({
      id: "niho-booking-1", experienceId: "niho:page-1", offerId: "offer-1", guest: "Synthetic Guest",
      date: "2026-11-05", start: "18:00", end: "20:00", guests: 3, amountYen: 90000, channel: "NIHO", status: "pending",
      niho: { status: "PROVISIONAL" },
    });
    expect([nihoChannelLabel("NIHO_PAGE"), nihoChannelLabel("EMBED"), nihoChannelLabel("EXPERIENCE_SITE"), nihoChannelLabel(null)]).toEqual(["NIHO", "NIHO（埋め込み）", "NIHO（体験サイト）", "NIHO（確認中）"]);
  });

  it("counts NIHO's states in 予約's filters, and keeps NIHO's words where 予約 has none", () => {
    const row = (status: HostLiveBookingListItem["status"], date = "2026-11-05") => nihoBookingRow({ ...ITEM, status, occurrenceDate: date });
    const today = "2026-11-01";
    expect(matchesBookingFilter(row("PROVISIONAL"), "pending", today)).toBe(true);
    expect(matchesBookingFilter(row("CONFIRMED"), "upcoming", today)).toBe(true);
    expect(matchesBookingFilter(row("CANCELLED"), "cancelled", today)).toBe(true);
    for (const status of ["DECLINED", "EXPIRED"] as const) expect(matchesBookingFilter(row(status), "past", today)).toBe(true);
    // A payment NIHO is waiting for or checking, or a state NIHO added since: これから until its day, holding no seat.
    for (const status of ["PENDING", "PAYMENT_PENDING", "UNKNOWN"] as const) {
      expect(matchesBookingFilter(row(status), "upcoming", today)).toBe(true);
      expect(matchesBookingFilter(row(status, "2026-10-30"), "past", today)).toBe(true);
    }
    expect(nihoRowStatusLabel(row("PENDING"), today)).toEqual({ label: "支払い確認中", tone: "wait" });
    expect(nihoRowStatusLabel(row("PAYMENT_PENDING"), today)).toEqual({ label: "支払い待ち", tone: "wait" });
    expect(nihoRowStatusLabel(row("PROVISIONAL"), today)).toEqual({ label: "承認待ち", tone: "wait" });
    expect(nihoRowStatusLabel(row("CONFIRMED", "2026-10-30"), today)).toEqual({ label: "確定", tone: "draft" });
    expect(nihoRowStatusLabel(row("REFUND_NEEDED"), today)).toEqual({ label: "要返金", tone: "wait" });
  });
});

describe("one list of NIHO's bookings and this site's", () => {
  const SITE: HostGuestBooking = {
    publicBookingId: "00000000-0000-4000-8000-000000000084", productId: "dinner", productTitle: "Synthetic dinner", offerId: "site-dinner", status: "CONFIRMED",
    localDate: "2026-11-05", localStartTime: "18:00", timeZone: "Asia/Tokyo", startUtc: "2026-11-05T09:00:00.000Z", endUtc: "2026-11-05T11:00:00.000Z",
    adultCount: 2, childCount: 0, language: "EN", guest: { name: "Site Guest", phone: null, note: null, answers: [] }, currency: "JPY",
    adultUnitAmount: 30000, childUnitAmount: null, totalAmount: 60000, platformFee: { supportEnabled: false, basisPoints: 1000, amount: 6000 }, providerAmount: 54000,
    cancellationPolicy: "FREE_UNTIL_48H", bookedAtUtc: "2026-10-31T03:04:00.000Z", paidAtUtc: "2026-10-31T03:06:00.000Z", cancelledAtUtc: null, cancelledBy: null,
    cancellationReason: null, cancellationNote: null, refundedAmount: 0, refundPendingAmount: 0, refundFailed: false, cancellationRequested: false,
  };

  it("keeps NIHO's page and this site's product of one experience apart, each session under its own heading, in time order", () => {
    const later = { ...ITEM, id: "niho-booking-2", occurrenceDate: "2026-11-07", startAt: "2026-11-07T09:00:00.000Z", endAt: "2026-11-07T11:00:00.000Z", status: "CONFIRMED" as const };
    const experiences = [...siteBookingExperiences([SITE]), ...nihoBookingExperiences([ITEM, later])];
    expect(nihoBookingExperiences([ITEM, later])).toEqual([{ id: nihoExperienceId("page-1"), title: "Synthetic dinner", offers: [{ id: "offer-1", capacity: null, durationMinutes: 120 }] }]);
    const groups = bookingGroups([siteBooking(SITE), nihoBookingRow(ITEM), nihoBookingRow(later)], experiences, { filter: "upcoming", experienceId: null }, "2026-11-01");
    expect(groups.map((group) => [group.date, group.experience, group.title, group.seats, group.bookings.map((booking) => booking.id)])).toEqual([
      ["2026-11-05", "dinner", "Synthetic dinner", "2名", [SITE.publicBookingId]],
      ["2026-11-05", "niho:page-1", "Synthetic dinner", "3名", ["niho-booking-1"]],
      ["2026-11-07", "niho:page-1", "Synthetic dinner", "3名", ["niho-booking-2"]],
    ]);
  });
});
