import { describe, expect, it } from "vitest";
import { refundedFeeShare, type HostGuestBooking } from "@niho-experience/experience-store";
import { bookingActions, bookingGroups, bookingRequestRows, bookingsHref, bookingStateRows, bookingStatusLabel, matchesBookingFilter, refundedFeeShareYen, siteFeeBreakdown } from "./bookings";
import { mergeSiteBookings, mergeSiteExperiences, SITE_BOOKING_ERASED_TEXT, siteBooking, siteBookingExperiences, siteCancellationLines } from "./site-bookings";

/** 予約 for this site's bookings (#285 slice 8): the experience DB's booking as the screen shows it. Synthetic data. */
const STORED: HostGuestBooking = {
  publicBookingId: "00000000-0000-4000-8000-000000000285",
  productId: "tea",
  productTitle: "Synthetic tea ceremony",
  offerId: "sample-am",
  status: "CONFIRMED",
  localDate: "2026-11-05",
  localStartTime: "10:00",
  timeZone: "Asia/Tokyo",
  startUtc: "2026-11-05T01:00:00.000Z",
  endUtc: "2026-11-05T02:30:00.000Z",
  adultCount: 2,
  childCount: 1,
  language: "EN",
  guest: {
    name: "Sample Guest",
    phone: "+81 90 0000 0000",
    note: "Sample note",
    answers: [
      { questionId: "diet", prompt: "Food needs", text: null, options: [{ id: "veg", label: "Vegetarian" }, { id: "gone", label: null }] },
      { questionId: "arrival", prompt: null, text: "Kamakura", options: [] },
    ],
  },
  currency: "JPY",
  adultUnitAmount: 4000,
  childUnitAmount: 2000,
  totalAmount: 10000,
  platformFee: { supportEnabled: false, basisPoints: 1000, amount: 1000 },
  providerAmount: 9000,
  cancellationPolicy: "FREE_UNTIL_24H",
  bookedAtUtc: "2026-10-31T03:04:00.000Z",
  paidAtUtc: "2026-10-31T03:06:00.000Z",
  cancelledAtUtc: null,
  cancelledBy: null,
  cancellationReason: null,
  cancellationNote: null,
  refundedAmount: 0,
  refundPendingAmount: 0,
  refundFailed: false,
  cancellationRequested: false,
};

describe("siteBooking", () => {
  it("shows the occurrence, the party, the guest's words and the snapshot's money, never a phone or an address", () => {
    const booking = siteBooking(STORED);
    expect(booking).toEqual({
      id: STORED.publicBookingId,
      experienceId: "tea",
      offerId: "sample-am",
      offer: "Synthetic tea ceremony",
      guest: "Sample Guest",
      language: "en",
      country: null,
      dietary: [],
      phone: null,
      attendance: null,
      date: "2026-11-05",
      start: "10:00",
      end: "11:30",
      adults: 2,
      children: 1,
      guests: 3,
      adultPriceYen: 4000,
      childPriceYen: 2000,
      amountYen: 10000,
      status: "confirmed",
      channel: "体験サイト",
      note: "Sample note",
      answers: [
        { question: "Food needs", answer: "Vegetarian、（削除された選択肢）" },
        { question: "（削除された質問）", answer: "Kamakura" },
      ],
      meetingGuide: null,
      authorizedAt: null,
      paidAt: "2026-10-31T12:06",
      respondBy: null,
      cancelRequestedAt: null,
      cancelledAt: null,
      cancelReason: null,
      cancelMessage: null,
      refundedYen: 0,
      timeline: [{ at: "2026-10-31T12:04", text: "申込" }, { at: "2026-10-31T12:06", text: "支払い" }],
      site: {
        fee: { amountYen: 1000, percent: 10, supportEnabled: false }, payoutYen: 9000, cancellationPolicy: "FREE_UNTIL_24H",
        cancellation: { by: null, reason: null, note: null, refundedYen: 0, refundPendingYen: 0, refundFailed: false, requested: false },
      },
    });
    expect(JSON.stringify(booking)).not.toMatch(/@|\+81/);
  });

  it("reads 確認待ち and 取消済み, and an erased guest by the retention text only", () => {
    const review = siteBooking({ ...STORED, status: "PAYMENT_REVIEW", language: "JA" });
    expect({ status: review.status, language: review.language, timeline: review.timeline.map((event) => event.text) }).toEqual({ status: "payment_review", language: "ja", timeline: ["申込", "支払い · 確認待ち"] });
    expect(bookingStatusLabel(review, "2026-10-31")).toEqual({ label: "確認待ち", tone: "wait" });
    expect(bookingActions(review.status)).toMatchObject({ approve: false, decline: false, cancel: false });

    const cancelled = siteBooking({ ...STORED, status: "CANCELLED", cancelledAtUtc: "2026-11-01T00:00:00.000Z" });
    expect({ status: cancelled.status, cancelledAt: cancelled.cancelledAt, last: cancelled.timeline.at(-1) }).toEqual({ status: "cancelled", cancelledAt: "2026-11-01T09:00", last: { at: "2026-11-01T09:00", text: "取消" } });

    const erased = siteBooking({ ...STORED, guest: null, platformFee: null, cancellationPolicy: null, paidAtUtc: null, childCount: 0, childUnitAmount: null });
    expect({ guest: erased.guest, note: erased.note, answers: erased.answers, site: erased.site, timeline: erased.timeline.length }).toEqual({
      guest: SITE_BOOKING_ERASED_TEXT, note: "", answers: [], site: { fee: null, payoutYen: 9000, cancellationPolicy: null, cancellation: { by: null, reason: null, note: null, refundedYen: 0, refundPendingYen: 0, refundFailed: false, requested: false } }, timeline: 1,
    });
  });

  it("says who cancelled, why and where the refund is, with the host's own note (#285 slice 7)", () => {
    const cancelled = siteBooking({
      ...STORED, status: "CANCELLED", cancelledAtUtc: "2026-11-01T00:00:00.000Z", cancelledBy: "HOST", cancellationReason: "WEATHER",
      cancellationNote: "Typhoon", refundedAmount: 4000, refundPendingAmount: 6000,
    });
    expect(cancelled.refundedYen).toBe(4000);
    expect(cancelled.timeline.at(-1)).toEqual({ at: "2026-11-01T09:00", text: "取消（ホスト）" });
    expect(cancelled.site?.cancellation).toEqual({ by: "host", reason: "雨・荒天", note: "Typhoon", refundedYen: 4000, refundPendingYen: 6000, refundFailed: false, requested: false });
    expect(siteCancellationLines(cancelled)).toEqual(["11/1 に取消（ホスト · 雨・荒天）", "¥4,000 を返金済み", "¥6,000 を返金中（Stripe の処理待ち）"]);
    const failed = siteBooking({ ...STORED, status: "CANCELLED", cancelledAtUtc: "2026-11-01T00:00:00.000Z", cancelledBy: "SUPPORT", cancellationReason: "LATE_PAYMENT", refundFailed: true });
    expect(siteCancellationLines(failed)).toEqual(["11/1 に取消（NIHO サポート · 支払いの遅れ）", "返金に失敗しました。NIHO サポートが対応します"]);
    const guest = siteBooking({ ...STORED, status: "CANCELLED", cancelledAtUtc: "2026-11-01T00:00:00.000Z", cancelledBy: "GUEST", cancellationReason: "GUEST_REQUEST" });
    expect(siteCancellationLines(guest)).toEqual(["11/1 に取消（予約者 · 予約者からの依頼）", "返金なし"]);
    const asked = siteBooking({ ...STORED, cancellationRequested: true });
    expect([asked.site?.cancellation?.requested, siteCancellationLines(asked)]).toEqual([true, []]);
  });

  it("adds the cancellation policy to 申込内容 (the fee is 料金・精算状況), and no refund total to 状態", () => {
    const booking = siteBooking(STORED);
    expect(bookingRequestRows(booking, "Synthetic tea ceremony")).toEqual([
      { label: "体験", value: "Synthetic tea ceremony" },
      { label: "人数", value: "3名（大人 2・子ども 1）" },
      { label: "金額", value: "¥10,000" },
      { label: "内訳", value: "大人 ¥4,000 × 2 ＋ 子ども ¥2,000 × 1" },
      { label: "言語", value: "英語" },
      { label: "申込経路", value: "体験サイト" },
      { label: "取消条件", value: "24時間前まで無料" },
      { label: "申込メモ", value: "Sample note", multiline: true },
      { label: "回答", answers: booking.answers },
    ]);
    const support = siteBooking({ ...STORED, platformFee: { supportEnabled: true, basisPoints: 1500, amount: 1500 }, providerAmount: 8500, cancellationPolicy: "NONE" });
    expect(bookingRequestRows(support, "").filter((row) => ["手数料", "受取額", "取消条件"].includes(row.label))).toEqual([{ label: "取消条件", value: "無料取消なし" }]);
    const cancelled = siteBooking({ ...STORED, status: "CANCELLED", cancelledAtUtc: "2026-11-01T00:00:00.000Z" });
    expect(bookingStateRows(cancelled).map((row) => row.label)).toEqual(["予約", "支払い", "取消"]);
  });

  it("breaks the money down as the experience DB fixed it at booking: what the guest paid, NIHO's fee and the host's amount", () => {
    expect(siteFeeBreakdown(siteBooking(STORED))).toEqual({
      supportEnabled: false, percent: 10, totalYen: 10000, feeYen: 1000, payoutYen: 9000,
      refundedYen: 0, refundPendingYen: 0, feeReturnedYen: 0, feeEstimated: false, netFeeYen: 1000, netPayoutYen: 9000,
    });
    // Support on: 15 %, and floor(total × rate) as the store fixed it (¥1,666 of ¥11,111), whatever the screen would round.
    const support = siteBooking({ ...STORED, totalAmount: 11111, platformFee: { supportEnabled: true, basisPoints: 1500, amount: 1666 }, providerAmount: 9445 });
    expect(siteFeeBreakdown(support)).toMatchObject({ supportEnabled: true, percent: 15, totalYen: 11111, feeYen: 1666, payoutYen: 9445, netPayoutYen: 9445 });
    // NIHO's bookings, and a snapshot without a fee, have no breakdown here.
    expect(siteFeeBreakdown({ amountYen: 10000 })).toBeNull();
    expect(siteFeeBreakdown(siteBooking({ ...STORED, platformFee: null }))).toBeNull();
  });

  it("gives NIHO's fee back with a refund in proportion, as Stripe does, and counts only the refunds Stripe finished", () => {
    const cancelled = { ...STORED, status: "CANCELLED" as const, cancelledAtUtc: "2026-11-01T00:00:00.000Z", cancelledBy: "HOST" as const };
    // A full refund gives the whole fee back: nothing is left to anyone.
    expect(siteFeeBreakdown(siteBooking({ ...cancelled, refundedAmount: 10000 }))).toMatchObject({ refundedYen: 10000, feeReturnedYen: 1000, feeEstimated: false, netFeeYen: 0, netPayoutYen: 0 });
    // A partial one: ¥3,333 of ¥10,000 gives back round(1,000 × 0.3333) = ¥333, worked out (Stripe may differ by ¥1).
    expect(siteFeeBreakdown(siteBooking({ ...STORED, refundedAmount: 3333 }))).toMatchObject({ refundedYen: 3333, feeReturnedYen: 333, feeEstimated: true, netFeeYen: 667, netPayoutYen: 6000 });
    // On its way: shown apart, the fee and the host's amount wait for Stripe.
    expect(siteFeeBreakdown(siteBooking({ ...cancelled, refundPendingAmount: 10000 }))).toMatchObject({ refundedYen: 0, refundPendingYen: 10000, feeReturnedYen: 0, netFeeYen: 1000, netPayoutYen: 9000 });
    expect(siteFeeBreakdown(siteBooking({ ...cancelled, refundedAmount: 4000, refundPendingAmount: 6000 }))).toMatchObject({ refundedYen: 4000, refundPendingYen: 6000, feeReturnedYen: 400, netPayoutYen: 5400 });
  });

  it("shares the fee back by 売上's own rule, half up, to the yen", () => {
    for (const [fee, refunded, paid] of [[1000, 3333, 10000], [1500, 5, 10000], [1666, 5555, 11111], [3000, 15000, 30000], [1, 1, 3], [7, 1, 2], [150000, 999999, 1000000], [1000, 0, 10000], [1000, 10000, 10000]] as const) {
      expect(refundedFeeShareYen(fee, refunded, paid), `${fee} ${refunded} ${paid}`).toBe(refundedFeeShare(fee, refunded, paid));
    }
    // More than was paid counts as all of it; nothing paid gives nothing back.
    expect(refundedFeeShareYen(1000, 20000, 10000)).toBe(1000);
    expect(refundedFeeShareYen(1000, 100, 0)).toBe(0);
  });

  it("lists a payment under review among これから while its day is ahead, keeping no seat", () => {
    const review = siteBooking({ ...STORED, publicBookingId: "00000000-0000-4000-8000-000000000286", status: "PAYMENT_REVIEW" });
    const confirmed = siteBooking(STORED);
    expect(matchesBookingFilter(review, "upcoming", "2026-11-01")).toBe(true);
    expect(matchesBookingFilter(review, "past", "2026-11-06")).toBe(true);
    const [group] = bookingGroups([confirmed, review], siteBookingExperiences([STORED]), { filter: "upcoming", experienceId: null }, "2026-11-01");
    expect({ seats: group?.seats, bookings: group?.bookings.length }).toEqual({ seats: "3名", bookings: 2 });
  });
});

describe("siteBookingExperiences and the merges of 続きを見る", () => {
  it("names each experience once with its offers' length and no capacity", () => {
    const pm: HostGuestBooking = { ...STORED, publicBookingId: "00000000-0000-4000-8000-000000000287", offerId: "sample-pm", startUtc: "2026-11-05T05:00:00.000Z", endUtc: "2026-11-05T06:00:00.000Z" };
    expect(siteBookingExperiences([STORED, pm])).toEqual([
      { id: "tea", title: "Synthetic tea ceremony", offers: [{ id: "sample-am", capacity: null, durationMinutes: 90 }, { id: "sample-pm", capacity: null, durationMinutes: 60 }] },
    ]);
  });

  it("keeps a booking already on the list and joins new offers to known experiences", () => {
    const first = siteBooking(STORED);
    const second = siteBooking({ ...STORED, publicBookingId: "00000000-0000-4000-8000-000000000288" });
    expect(mergeSiteBookings([first], [{ ...first, guest: "Changed" }, second]).map((booking) => [booking.id, booking.guest])).toEqual([[first.id, "Sample Guest"], [second.id, "Sample Guest"]]);
    const am = { id: "tea", title: "Synthetic tea ceremony", offers: [{ id: "sample-am", capacity: null, durationMinutes: 90 }] };
    const walk = { id: "walk", title: "Synthetic walk", offers: [{ id: "sample-walk", capacity: null, durationMinutes: 60 }] };
    expect(mergeSiteExperiences([am], [{ ...am, offers: [...am.offers, { id: "sample-pm", capacity: null, durationMinutes: 60 }] }, walk])).toEqual([
      { ...am, offers: [...am.offers, { id: "sample-pm", capacity: null, durationMinutes: 60 }] },
      walk,
    ]);
  });
});

describe("bookingsHref", () => {
  it("keeps ?source=site for this site's bookings beside NIHO's, and leaves it out otherwise", () => {
    expect(bookingsHref({ providerId: "sample-provider", source: "site", filter: "past", booking: "b-1" })).toBe("/host/bookings?providerId=sample-provider&source=site&filter=past&booking=b-1");
    expect(bookingsHref({ providerId: "sample-provider", source: null, filter: "upcoming" })).toBe("/host/bookings?providerId=sample-provider");
  });
});
