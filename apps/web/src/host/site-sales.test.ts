import type { HostSaleEntry } from "@niho-experience/experience-store";
import { describe, expect, it } from "vitest";
import { MOCK_SITE_SALES } from "./mock/site-sales";
import {
  entryAmount,
  japanMonthOf,
  japanMonthWindow,
  requestedSiteSalesMonth,
  SITE_SALES_FEE_ESTIMATE_NOTE,
  SITE_SALES_FEE_UNKNOWN_NOTE,
  SITE_SALES_HOME_SCOPE_TEXT,
  SITE_SALES_RECEIVED_NOTE,
  siteHomeMonth,
  siteSalesPage,
  siteSalesPeriod,
  siteSalesRows,
  siteSalesSummary,
} from "./site-sales";

/** 売上 for bookings made on this site (#91): the ledger's entries as the screen and ホーム's card show them. */
const SEPTEMBER = { year: 2026, month: 9 };
const OCTOBER = { year: 2026, month: 10 };
const PERIOD = { first: SEPTEMBER, last: OCTOBER, current: OCTOBER };
const inMonth = (month: { year: number; month: number }) => {
  const { from, to } = japanMonthWindow(month);
  return MOCK_SITE_SALES.filter((entry) => entry.occurredAtUtc >= from && entry.occurredAtUtc < to);
};

function entry(fields: Partial<HostSaleEntry> = {}): HostSaleEntry {
  return {
    key: "payment:00000000-0000-4000-8000-000000000001", kind: "PAYMENT", amount: 7500, currency: "JPY", occurredAtUtc: "2026-11-02T01:00:00.000Z",
    publicBookingId: "00000000-0000-4000-8000-000000000001", productTitle: "Synthetic walk", bookingStatus: "CONFIRMED", localDate: "2026-11-05",
    localStartTime: "10:00", adultCount: 2, childCount: 1, guestName: "Sample Guest", platformFeeAmount: 750, providerAmount: 6750, feeEstimated: false, refund: null,
    ...fields,
  };
}

describe("months in Japan", () => {
  it("reads a month in Japan as UTC instants, across a year too", () => {
    expect(japanMonthWindow({ year: 2026, month: 11 })).toEqual({ from: "2026-10-31T15:00:00.000Z", to: "2026-11-30T15:00:00.000Z" });
    expect(japanMonthWindow({ year: 2026, month: 12 })).toEqual({ from: "2026-11-30T15:00:00.000Z", to: "2026-12-31T15:00:00.000Z" });
    expect(japanMonthOf("2026-10-31T14:59:59.999Z")).toEqual(OCTOBER);
    expect(japanMonthOf("2026-10-31T15:00:00.000Z")).toEqual({ year: 2026, month: 11 });
  });

  it("moves from the first entry's month to this month, and opens on this month for any other", () => {
    expect(siteSalesPeriod(null, "2026-10-21")).toEqual({ first: OCTOBER, last: OCTOBER, current: OCTOBER });
    expect(siteSalesPeriod("2026-09-20T03:00:00.000Z", "2026-10-21")).toEqual(PERIOD);
    // The last evening of September in Japan is September.
    expect(siteSalesPeriod("2026-09-30T14:59:59.000Z", "2026-10-01").first).toEqual(SEPTEMBER);
    expect(siteSalesPeriod("2026-11-03T00:00:00.000Z", "2026-10-21").first).toEqual(OCTOBER);
    expect(requestedSiteSalesMonth("2026-09", "2026-10-21")).toEqual(SEPTEMBER);
    expect(requestedSiteSalesMonth(["2025-12"], "2026-10-21")).toEqual({ year: 2025, month: 12 });
    expect(requestedSiteSalesMonth("2026-11", "2026-10-21")).toEqual(OCTOBER);
    expect(requestedSiteSalesMonth("2026-1", "2026-10-21")).toEqual(OCTOBER);
    expect(requestedSiteSalesMonth(undefined, "2026-10-21")).toEqual(OCTOBER);
  });
});

describe("the month's numbers", () => {
  it("sums sales, NIHO's fee net of what refunds gave back, refunds and what the provider receives", () => {
    const page = siteSalesPage(inMonth(OCTOBER), PERIOD, OCTOBER);
    expect(page.figures).toEqual([
      { label: "売上", value: "¥105,000" },
      { label: "手数料", value: "−¥7,000" },
      { label: "返金", value: "−¥35,000" },
      { label: "受取額", value: "¥63,000" },
    ]);
    // A partial refund's fee is worked out: the page says so.
    expect(page.notes).toEqual([SITE_SALES_RECEIVED_NOTE, SITE_SALES_FEE_ESTIMATE_NOTE]);
    expect([page.label, page.previous, page.next]).toEqual(["2026年10月", SEPTEMBER, null]);
    const september = siteSalesPage(inMonth(SEPTEMBER), PERIOD, SEPTEMBER);
    expect(september.figures.map((figure) => figure.value)).toEqual(["¥36,000", "−¥3,600", "¥0", "¥32,400"]);
    expect(september.notes).toEqual([SITE_SALES_RECEIVED_NOTE]);
    expect([september.previous, september.next]).toEqual([null, OCTOBER]);
  });

  it("has zeros for a month without entries", () => {
    const page = siteSalesPage([], { first: OCTOBER, last: OCTOBER, current: OCTOBER }, OCTOBER);
    expect(page.figures.map((figure) => figure.value)).toEqual(["¥0", "¥0", "¥0", "¥0"]);
    expect([page.rows, page.previous, page.next]).toEqual([[], null, null]);
  });

  it("adds a reversed refund as 調整, keeps the fee unknown when one entry's is, and leaves another currency out", () => {
    const refundId = "00000000-0000-4000-8000-0000000000f1";
    const entries = [
      entry({ key: `refund-reversal:${refundId}`, kind: "REFUND_REVERSAL", amount: 7500, platformFeeAmount: 750, providerAmount: 6750, refund: { kind: "FULL", status: "FAILED" } }),
      entry({ key: `refund:${refundId}`, kind: "REFUND", amount: -7500, platformFeeAmount: -750, providerAmount: -6750, refund: { kind: "FULL", status: "FAILED" } }),
      entry(),
    ];
    const summary = siteSalesSummary(entries);
    expect(summary).toMatchObject({ salesYen: 7500, feeYen: 750, refundsYen: 7500, adjustmentsYen: 7500, receivedYen: 6750, payments: 1, feeEstimated: false, otherCurrencies: 0 });
    expect(siteSalesPage(entries, PERIOD, OCTOBER).figures.map((figure) => [figure.label, figure.value])).toEqual([
      ["売上", "¥7,500"], ["手数料", "−¥750"], ["返金", "−¥7,500"], ["調整", "¥7,500"], ["受取額", "¥6,750"],
    ]);

    const unknown = siteSalesPage([entry({ platformFeeAmount: null, providerAmount: null }), entry({ currency: "USD", amount: 5000, platformFeeAmount: null, providerAmount: null, bookingStatus: "PAYMENT_REVIEW" })], PERIOD, OCTOBER);
    expect(unknown.figures.map((figure) => figure.value)).toEqual(["¥7,500", "—", "¥0", "—"]);
    expect(unknown.notes).toEqual([SITE_SALES_RECEIVED_NOTE, SITE_SALES_FEE_UNKNOWN_NOTE, "円以外の通貨の取引が 1 件あります。集計には含めていません。"]);
  });
});

describe("明細", () => {
  it("dates each entry in Japan, the latest first, with its fee and its state", () => {
    const rows = siteSalesRows(inMonth(OCTOBER));
    expect(rows.map((row) => [row.shortDate, row.title, row.amount, row.negative, row.status.label])).toEqual([
      ["10/18", "Kamakura tea time · Mateo García", "¥12,000", false, "計上済み"],
      ["10/16", "Kamakura Community Dinner · Sofia Rossi", "¥45,000", false, "計上済み"],
      ["10/14", "返金 · Hannah Kim", "−¥30,000", true, "返金済み"],
      ["10/12", "Kamakura Community Dinner · Hannah Kim", "¥30,000", false, "計上済み"],
      ["10/10", "返金 · Lucas Martin", "−¥5,000", true, "返金中"],
      ["10/08", "Kamakura tea time · Lucas Martin", "¥12,000", false, "計上済み"],
      // Paid at 00:30 on the 5th in Japan (15:30 on the 4th in UTC); under review.
      ["10/05", "Kamakura tea time · Emma Wilson", "¥6,000", false, "確認待ち"],
    ]);
    expect(rows[0]!.detail).toBe("体験サイト · 10/25 14:00 の回 · 2名 · 手数料 −¥1,200");
    expect(rows[2]!.detail).toBe("体験サイト · Kamakura Community Dinner · 全額返金 · 手数料の戻り ¥3,000");
    expect(rows[4]!.detail).toBe("体験サイト · Kamakura tea time · 一部返金 · 手数料の戻り ¥500（見込み）");
    expect(rows[5]!.detail).toBe("体験サイト · 10/19 14:00 の回 · 2名 · 手数料 −¥1,200");
    expect(rows.map((row) => row.key)).toEqual(inMonth(OCTOBER).map((item) => item.key));
    expect(rows[6]!.status.tone).toBe("wait");
  });

  it("drops an erased guest's name and words a reversal, an adjustment, an unknown fee and another currency", () => {
    const rows = siteSalesRows([
      entry({ guestName: null }),
      entry({ kind: "REFUND_REVERSAL", amount: 7500, refund: { kind: "FULL", status: "FAILED" } }),
      entry({ kind: "ADJUSTMENT", amount: -1500, platformFeeAmount: 0, providerAmount: -1500 }),
      entry({ platformFeeAmount: null, providerAmount: null }),
      entry({ currency: "USD", amount: 5000, platformFeeAmount: null, providerAmount: null }),
      entry({ kind: "REFUND", amount: -7500, platformFeeAmount: -750, providerAmount: -6750, refund: { kind: "FULL", status: "FAILED" } }),
    ]);
    expect(rows.map((row) => [row.title, row.detail, row.negative, row.status.label])).toEqual([
      ["Synthetic walk", "体験サイト · 11/5 10:00 の回 · 3名 · 手数料 −¥750", false, "計上済み"],
      ["返金の取り消し · Sample Guest", "体験サイト · Synthetic walk · Stripe が返金を取り消しました · 手数料 −¥750", false, "返金に失敗"],
      ["調整 · Sample Guest", "体験サイト · Synthetic walk · 内容は NIHO サポートへお問い合わせください", true, "調整"],
      ["Synthetic walk · Sample Guest", "体験サイト · 11/5 10:00 の回 · 3名 · 手数料は確認できません", false, "計上済み"],
      ["Synthetic walk · Sample Guest", "体験サイト · 11/5 10:00 の回 · 3名 · 手数料は確認できません · 集計に含めていません", false, "計上済み"],
      ["返金 · Sample Guest", "体験サイト · Synthetic walk · 全額返金 · 手数料の戻り ¥750", true, "返金に失敗"],
    ]);
    expect(rows[2]!.amount).toBe("−¥1,500");
    expect(rows[4]!.amount).toContain("50.00");
  });

  it("writes amounts in their currency", () => {
    expect(entryAmount(-7500, "JPY")).toBe("−¥7,500");
    expect(entryAmount(-1234, "USD")).toMatch(/^−.*12\.34$/);
    expect(entryAmount(5, "ZZZ")).toMatch(/5/);
  });
});

describe("ホーム's month", () => {
  it("is this month's 売上, 返金, 受取額 and payments, said to be this site's", () => {
    expect(siteHomeMonth(inMonth(OCTOBER), OCTOBER)).toEqual({
      label: "10月",
      figures: [{ label: "売上", value: "¥105,000" }, { label: "返金", value: "−¥35,000" }, { label: "受取額", value: "¥63,000" }, { label: "支払い", value: "5件" }],
      note: SITE_SALES_HOME_SCOPE_TEXT,
    });
    expect(siteHomeMonth([], { year: 2026, month: 11 }).figures.map((figure) => figure.value)).toEqual(["¥0", "¥0", "¥0", "0件"]);
  });
});
