import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { HostGuestBooking } from "@niho-experience/experience-store";

vi.mock("@/host/actions", () => ({ cancelSiteSession: vi.fn(), recordSiteAttendance: vi.fn() }));

import { siteSessionView } from "@/host/site-sessions";
import { HostSession } from "./HostSession";

/** この回 of this site's bookings (#285 slices 8b and 7): the guests' phones and, before the start, calling it off. Synthetic data. */
const CONFIRMED: HostGuestBooking = {
  publicBookingId: "00000000-0000-4000-8000-000000000285", productId: "tea", productTitle: "Synthetic tea ceremony", offerId: "sample-am", status: "CONFIRMED",
  localDate: "2026-11-01", localStartTime: "10:00", timeZone: "Asia/Tokyo", startUtc: "2026-11-01T01:00:00.000Z", endUtc: "2026-11-01T02:30:00.000Z",
  adultCount: 2, childCount: 1, language: "EN",
  guest: { name: "Sample Guest", phone: "+81 90 0000 0000", note: "Sample note", answers: [{ questionId: "arrival", prompt: "Arrival station", text: "Kamakura", options: [] }] },
  currency: "JPY", adultUnitAmount: 4000, childUnitAmount: 2000, totalAmount: 10000, platformFee: { supportEnabled: false, basisPoints: 1000, amount: 1000 },
  providerAmount: 9000, cancellationPolicy: "FREE_UNTIL_24H", bookedAtUtc: "2026-10-31T03:04:00.000Z", paidAtUtc: "2026-10-31T03:06:00.000Z", cancelledAtUtc: null, cancelledBy: null, cancellationReason: null, cancellationNote: null, refundedAmount: 0, refundPendingAmount: 0, refundFailed: false, cancellationRequested: false,
};
const REVIEW: HostGuestBooking = { ...CONFIRMED, publicBookingId: "00000000-0000-4000-8000-000000000286", status: "PAYMENT_REVIEW", adultCount: 1, childCount: 0, guest: { name: "Review Guest", phone: null, note: null, answers: [] } };
const CANCELLED: HostGuestBooking = { ...CONFIRMED, publicBookingId: "00000000-0000-4000-8000-000000000287", status: "CANCELLED", guest: { name: "Cancelled Guest", phone: "+81 90 1111 1111", note: null, answers: [] } };
const ERASED: HostGuestBooking = { ...CONFIRMED, publicBookingId: "00000000-0000-4000-8000-000000000288", adultCount: 1, childCount: 0, guest: null };
const QUERY = { date: "2026-11-01", start: "10:00", experience: "tea", offer: "sample-am" };

function render(now: string, besideNiho: boolean, providerId?: string, attendance = false): string {
  const marks = attendance ? { capacity: 8, marks: [{ publicBookingId: CONFIRMED.publicBookingId, status: "ATTENDED" as const, recordedAtUtc: "2026-11-01T01:20:00.000Z" }] } : null;
  const session = siteSessionView([CONFIRMED, REVIEW, CANCELLED, ERASED], QUERY, marks)!;
  return renderToStaticMarkup(createElement(HostSession, { session, now, conversations: [], providerId: "sample-provider", site: { besideNiho, providerId, attendance } }));
}

/** The buttons of a guest's 出欠, as rendered: [label, pressed, disabled]. */
function attendanceButtons(html: string, guest: string): [string, boolean, boolean][] {
  const group = html.match(new RegExp(`aria-label="${guest} さんの出欠"[^>]*>(.*?)</div>`))?.[1] ?? "";
  return [...group.matchAll(/<button([^>]*)>(?:<svg.*?<\/svg>)?([^<]*)<\/button>/g)].map((match) => [match[2]!, match[1]!.includes('aria-pressed="true"'), / disabled=""/.test(match[1]!)]);
}

describe("HostSession for this site's bookings", () => {
  it("lists the confirmed guests and the payment under review with the phone, words and counts, and no NIHO action", () => {
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
    expect(html).toContain("一部だけの返金は NIHO サポートへご連絡ください");
    // Without the provider to send it for, calling it off is not offered.
    // Cancelled guests are not on the day's list; nothing pretends to reach a guest.
    for (const absent of ["Cancelled Guest", "+81 90 1111 1111", "メッセージ", "参加者に連絡する", "この回を中止する（", "出欠は開始後に付けられます", "食べもの", "@"]) {
      expect(html, absent).not.toContain(absent);
    }
    expect(html).toContain('href="/host/bookings?providerId=sample-provider"');
  });

  it("offers calling the session off with full refunds before the start only (#285 slice 7)", () => {
    expect(render("2026-11-01T09:00", false, "sample-provider")).toContain("この回を中止する（全員に全額返金）");
    expect(render("2026-11-01T10:30", false, "sample-provider")).not.toContain("この回を中止する（");
  });

  it("records no attendance once the session started, and goes back to this site's bookings beside NIHO's", () => {
    const html = render("2026-11-01T12:00", true);
    expect(html).toContain("終了しました");
    expect(html).not.toContain("来なかった");
    expect(html).not.toContain("出欠");
    expect(html).toContain('href="/host/bookings?providerId=sample-provider&amp;source=site"');
  });

  it("records 出欠 where it is kept (#107): locked before the start, open after it, with the capacity", () => {
    const before = render("2026-11-01T09:00", false, "sample-provider", true);
    expect(before).toContain("参加 5 名 · 定員 8");
    expect(before).toContain("出欠は開始後に付けられます");
    expect(attendanceButtons(before, "Sample Guest")).toEqual([["来た", true, true], ["来なかった", false, true]]);
    expect(before).not.toContain("来た 1 件");

    const after = render("2026-11-01T10:30", false, "sample-provider", true);
    expect(after).toContain("来た 1 件 · 来なかった 0 件 · 未記録 1 件");
    expect(after).not.toContain("出欠は開始後に付けられます");
    expect(attendanceButtons(after, "Sample Guest")).toEqual([["来た", true, false], ["来なかった", false, false]]);
    // The payment under review keeps no seat and gets no buttons; the cancelled guest is not on the day's list.
    expect(after).not.toContain("Review Guest さんの出欠");
    expect(after).not.toContain("Cancelled Guest");
    // Nothing holds back a no-show's thanks or review request yet: the note is not said here.
    expect(after).not.toContain("お礼とレビュー依頼は届きません");
  });

  it("records nothing without the provider to send it for", () => {
    const html = render("2026-11-01T10:30", false, undefined, true);
    expect(html).not.toContain("さんの出欠");
    expect(html).not.toContain("未記録");
  });
});
