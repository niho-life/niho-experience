import { describe, expect, it } from "vitest";
import type { ConnectedPayout } from "@niho-experience/experience-payments";
import { MOCK_SITE_PAYOUTS } from "./mock/site-sales";
import { SITE_PAYOUTS_EXPECTED_NOTE, SITE_PAYOUTS_MORE_NOTE, sitePayoutsPanel, type SitePayoutsRead } from "./site-sales-payouts";

/** この口座への入金 as the screen shows Stripe's balance and payouts (#91). Synthetic amounts only. */
const NOVEMBER = { year: 2026, month: 11 };
const payout = (fields: Partial<ConnectedPayout> & Pick<ConnectedPayout, "arrivalDateUtc">): ConnectedPayout => ({ key: "0123456789abcdef", amount: 10_000, currency: "JPY", status: "PAID", ...fields });
const read = (fields: Partial<SitePayoutsRead> = {}): SitePayoutsRead => ({ accounts: 1, balance: [], payouts: [], more: false, ...fields });

describe("この口座への入金", () => {
  it("this month: 入金予定 is the yen balance and what is on its way; 入金済み what Stripe paid this month", () => {
    const panel = sitePayoutsPanel(read({
      balance: [{ currency: "JPY", available: 12_000, pending: 8_000 }],
      payouts: [
        payout({ key: "a000000000000001", amount: 20_000, status: "IN_TRANSIT", arrivalDateUtc: "2026-12-02T00:00:00.000Z" }),
        payout({ key: "a000000000000002", amount: 3_000, status: "PENDING", arrivalDateUtc: "2026-11-28T00:00:00.000Z" }),
        payout({ key: "a000000000000003", amount: 7_000, status: "FAILED", arrivalDateUtc: "2026-11-19T00:00:00.000Z" }),
        payout({ key: "a000000000000004", amount: 40_500, status: "PAID", arrivalDateUtc: "2026-11-05T00:00:00.000Z" }),
        payout({ key: "a000000000000005", amount: 5_000, status: "CANCELED", arrivalDateUtc: "2026-11-01T00:00:00.000Z" }),
      ],
    }), NOVEMBER, true);
    expect(panel.figures).toEqual([{ label: "入金予定", value: "¥43,000" }, { label: "入金済み", value: "¥40,500" }]);
    expect(panel.notes).toEqual([SITE_PAYOUTS_EXPECTED_NOTE]);
    expect(panel.rows.map(({ key, shortDate, dateLabel, title, detail, amount, negative, status }) => [key, shortDate, dateLabel, title, detail, amount, negative, status.label, status.tone])).toEqual([
      ["payout:a000000000000001", "12/02", "12月2日", "口座入金", "Stripe · 着金予定", "¥20,000", false, "送金中", "wait"],
      ["payout:a000000000000002", "11/28", "11月28日", "口座入金", "Stripe · 着金予定", "¥3,000", false, "送金中", "wait"],
      ["payout:a000000000000003", "11/19", "11月19日", "口座入金", "Stripe · 口座に届きませんでした。Stripe で口座を確かめてください", "¥7,000", false, "入金できず", "stop"],
      ["payout:a000000000000004", "11/05", "11月5日", "口座入金", "Stripe", "¥40,500", false, "入金済み", "draft"],
      ["payout:a000000000000005", "11/01", "11月1日", "口座入金", "Stripe · 取り消されました", "¥5,000", false, "取消", "draft"],
    ]);
  });

  it("an earlier month: only what was paid in it, on the arrival day in Japan", () => {
    const panel = sitePayoutsPanel(read({
      balance: [{ currency: "JPY", available: 99_000, pending: 0 }],
      payouts: [
        payout({ amount: 1_000, arrivalDateUtc: "2026-12-01T00:00:00.000Z" }),
        // Stripe's day, at midnight UTC or in Japan, is the same day in Japan.
        payout({ amount: 2_000, arrivalDateUtc: "2026-11-30T00:00:00.000Z" }),
        payout({ amount: 4_000, arrivalDateUtc: "2026-10-31T15:00:00.000Z" }),
        payout({ amount: 8_000, arrivalDateUtc: "2026-10-31T00:00:00.000Z" }),
      ],
    }), NOVEMBER, false);
    expect(panel.figures).toEqual([{ label: "入金済み", value: "¥6,000" }]);
    expect(panel.notes).toEqual([]);
    expect(panel.rows.map((row) => row.date)).toEqual(["2026-11-30", "2026-11-01"]);
  });

  it("this month: a payout due last month and still on its way is in 入金予定 and the 明細, once; when paid, it is last month's", () => {
    const OCTOBER = { year: 2026, month: 10 };
    // What this month's read has: last month's payouts too (the read looks back to October 1).
    const lastMonth = (status: ConnectedPayout["status"]) => read({
      balance: [{ currency: "JPY", available: 5_000, pending: 1_000 }],
      payouts: [
        payout({ key: "b000000000000001", amount: 40_500, status: "PAID", arrivalDateUtc: "2026-11-05T00:00:00.000Z" }),
        // Due 10/31 in Japan, and Stripe still says in transit on 11/1: it has left the balance already.
        payout({ key: "b000000000000002", amount: 12_000, status, arrivalDateUtc: "2026-10-31T00:00:00.000Z" }),
        payout({ key: "b000000000000003", amount: 9_000, status: "PAID", arrivalDateUtc: "2026-10-20T00:00:00.000Z" }),
        payout({ key: "b000000000000004", amount: 6_000, status: "FAILED", arrivalDateUtc: "2026-10-15T00:00:00.000Z" }),
      ],
    });
    const inTransit = sitePayoutsPanel(lastMonth("IN_TRANSIT"), NOVEMBER, true);
    expect(inTransit.figures).toEqual([{ label: "入金予定", value: "¥18,000" }, { label: "入金済み", value: "¥40,500" }]);
    expect(inTransit.rows.map((row) => [row.key, row.date, row.status.label])).toEqual([["payout:b000000000000001", "2026-11-05", "入金済み"], ["payout:b000000000000002", "2026-10-31", "送金中"]]);
    expect(sitePayoutsPanel(lastMonth("PENDING"), NOVEMBER, true).figures[0]).toEqual({ label: "入金予定", value: "¥18,000" });
    // October itself still shows it on its day, not yet in 入金済み.
    expect(sitePayoutsPanel(lastMonth("IN_TRANSIT"), OCTOBER, false).figures).toEqual([{ label: "入金済み", value: "¥9,000" }]);

    const paid = sitePayoutsPanel(lastMonth("PAID"), NOVEMBER, true);
    expect(paid.figures).toEqual([{ label: "入金予定", value: "¥6,000" }, { label: "入金済み", value: "¥40,500" }]);
    expect(paid.rows.map((row) => row.date)).toEqual(["2026-11-05"]);
    expect(sitePayoutsPanel(lastMonth("PAID"), OCTOBER, false).figures).toEqual([{ label: "入金済み", value: "¥21,000" }]);
  });

  it("a debit is red with a minus; another currency stays out of the numbers, with a note", () => {
    const panel = sitePayoutsPanel(read({
      balance: [{ currency: "JPY", available: -3_000, pending: 0 }, { currency: "USD", available: 0, pending: 500 }],
      payouts: [
        payout({ amount: -3_000, status: "PENDING", arrivalDateUtc: "2026-11-10T00:00:00.000Z" }),
        payout({ amount: 1_250, currency: "USD", arrivalDateUtc: "2026-11-09T00:00:00.000Z" }),
      ],
    }), NOVEMBER, true);
    expect(panel.figures).toEqual([{ label: "入金予定", value: "−¥6,000" }, { label: "入金済み", value: "¥0" }]);
    expect(panel.rows[0]).toMatchObject({ title: "口座からの引き落とし", amount: "−¥3,000", negative: true });
    expect(panel.rows[1]).toMatchObject({ title: "口座入金", detail: "Stripe · 集計に含めていません", amount: "$12.50", negative: false });
    expect(panel.notes).toContain("円以外の通貨の入金・残高が 2 件あります。集計には含めていません。");
  });

  it("says when it sums several accounts or Stripe had more than one read takes, and when the month has none", () => {
    const panel = sitePayoutsPanel(read({ accounts: 2, more: true }), NOVEMBER, false);
    expect(panel.notes).toEqual(["Stripe の口座が 2 つあり、その合計です。", SITE_PAYOUTS_MORE_NOTE]);
    expect(panel.rows).toEqual([]);
    expect(panel.figures).toEqual([{ label: "入金済み", value: "¥0" }]);
  });

  it("is the preview's synthetic account for October", () => {
    const panel = sitePayoutsPanel(MOCK_SITE_PAYOUTS, { year: 2026, month: 10 }, true);
    expect(panel.figures).toEqual([{ label: "入金予定", value: "¥80,500" }, { label: "入金済み", value: "¥52,300" }]);
    expect(panel.rows.map((row) => [row.shortDate, row.status.label])).toEqual([["10/23", "送金中"], ["10/09", "入金済み"]]);
  });
});
