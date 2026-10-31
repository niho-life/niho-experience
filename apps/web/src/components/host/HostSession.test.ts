import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HostGuestBooking } from "@niho-experience/experience-store";
import { siteSessionView } from "@/host/site-sessions";
import { HostSession } from "./HostSession";

/** この回 of this site's bookings (#285 slice 8b): read only, with the guests' phones. Synthetic data. */
const CONFIRMED: HostGuestBooking = {
  publicBookingId: "00000000-0000-4000-8000-000000000285", productId: "tea", productTitle: "Synthetic tea ceremony", offerId: "sample-am", status: "CONFIRMED",
  localDate: "2026-11-01", localStartTime: "10:00", timeZone: "Asia/Tokyo", startUtc: "2026-11-01T01:00:00.000Z", endUtc: "2026-11-01T02:30:00.000Z",
  adultCount: 2, childCount: 1, language: "EN",
  guest: { name: "Sample Guest", phone: "+81 90 0000 0000", note: "Sample note", answers: [{ questionId: "arrival", prompt: "Arrival station", text: "Kamakura", options: [] }] },
  currency: "JPY", adultUnitAmount: 4000, childUnitAmount: 2000, totalAmount: 10000, platformFee: { supportEnabled: false, basisPoints: 1000, amount: 1000 },
  providerAmount: 9000, cancellationPolicy: "FREE_UNTIL_24H", bookedAtUtc: "2026-10-31T03:04:00.000Z", paidAtUtc: "2026-10-31T03:06:00.000Z", cancelledAtUtc: null,
};
const REVIEW: HostGuestBooking = { ...CONFIRMED, publicBookingId: "00000000-0000-4000-8000-000000000286", status: "PAYMENT_REVIEW", adultCount: 1, childCount: 0, guest: { name: "Review Guest", phone: null, note: null, answers: [] } };
const CANCELLED: HostGuestBooking = { ...CONFIRMED, publicBookingId: "00000000-0000-4000-8000-000000000287", status: "CANCELLED", guest: { name: "Cancelled Guest", phone: "+81 90 1111 1111", note: null, answers: [] } };
const ERASED: HostGuestBooking = { ...CONFIRMED, publicBookingId: "00000000-0000-4000-8000-000000000288", adultCount: 1, childCount: 0, guest: null };
const QUERY = { date: "2026-11-01", start: "10:00", experience: "tea", offer: "sample-am" };

function render(now: string, besideNiho: boolean): string {
  const session = siteSessionView([CONFIRMED, REVIEW, CANCELLED, ERASED], QUERY)!;
  return renderToStaticMarkup(createElement(HostSession, { session, now, conversations: [], providerId: "sample-provider", site: { besideNiho } }));
}

describe("HostSession for this site's bookings", () => {
  it("lists the confirmed guests and the payment under review with the phone, words and counts, and nothing that changes a booking", () => {
    const html = render("2026-11-01T09:00", false);
    expect(html).toContain("このサイトで受けた予約です");
    expect(html).toContain("参加 5 名");
    expect(html).toContain("うち確認待ち 1 名（席は確保されていません）");
    expect(html).toContain('href="tel:+819000000000"');
    expect(html).toContain("Sample note");
    expect(html).toContain("Kamakura");
    expect(html).toContain("Review Guest");
    expect(html).toContain("仮押さえの期限のあとに支払いが届きました。席は確保されていません");
    expect(html).toContain("保存期間を過ぎたため表示できません");
    expect(html).toContain("取消・返金は NIHO サポートへご連絡ください");
    // Cancelled guests are not on the day's list; nothing pretends to reach or change a booking.
    for (const absent of ["Cancelled Guest", "+81 90 1111 1111", "メッセージ", "参加者に連絡する", "この回を中止する", "出欠は開始後に付けられます", "食べもの", "@"]) {
      expect(html, absent).not.toContain(absent);
    }
    expect(html).toContain('href="/host/bookings?providerId=sample-provider"');
  });

  it("records no attendance once the session started, and goes back to this site's bookings beside NIHO's", () => {
    const html = render("2026-11-01T12:00", true);
    expect(html).toContain("終了しました");
    expect(html).not.toContain("来なかった");
    expect(html).not.toContain("出欠");
    expect(html).toContain('href="/host/bookings?providerId=sample-provider&amp;source=site"');
  });
});
