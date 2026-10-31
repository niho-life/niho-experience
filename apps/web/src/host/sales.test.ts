import { describe, expect, it } from "vitest";
import { MOCK_KITCHEN_BOOKINGS } from "./mock/bookings";
import { MOCK_FEE_RATE, MOCK_KITCHEN_SALES, MOCK_SALES_PERIOD } from "./mock/sales";
import { addMonths, monthKey, monthLabelJa, parseMonthKey, saleStatus, salesMonthNav, salesMonthOf, salesPage, salesRows, salesSummary, type SalesPeriod } from "./sales";
import type { HostSale } from "./types";

const OCTOBER = { year: 2026, month: 10 };
const SEPTEMBER = { year: 2026, month: 9 };
const NOVEMBER = { year: 2026, month: 11 };

describe("sales months", () => {
  it("reads and writes ?month= as YYYY-MM, and nothing else", () => {
    expect(monthKey(OCTOBER)).toBe("2026-10");
    expect(monthKey({ year: 2026, month: 9 })).toBe("2026-09");
    expect(parseMonthKey("2026-09")).toEqual(SEPTEMBER);
    for (const value of ["2026-13", "2026-00", "2026-9", "26-09", "2026-09-01", " 2026-09", "", null, 202609, ["2026-09"]]) expect(parseMonthKey(value), String(value)).toBeNull();
    expect(monthLabelJa(OCTOBER)).toBe("2026年10月");
    expect(addMonths({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(addMonths({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
  });

  it("opens the month asked for when the period has it, else the current one", () => {
    expect(salesMonthOf(MOCK_SALES_PERIOD, undefined)).toEqual(OCTOBER);
    expect(salesMonthOf(MOCK_SALES_PERIOD, "2026-09")).toEqual(SEPTEMBER);
    expect(salesMonthOf(MOCK_SALES_PERIOD, "2026-11")).toEqual(NOVEMBER);
    // The first ?month= counts, as the page reads it.
    expect(salesMonthOf(MOCK_SALES_PERIOD, ["2026-09", "2026-11"])).toEqual(SEPTEMBER);
    for (const outside of ["2026-08", "2026-12", "2025-10", "october"]) expect(salesMonthOf(MOCK_SALES_PERIOD, outside), outside).toEqual(OCTOBER);
  });

  it("moves one month at a time inside the period and stops at both ends", () => {
    expect(salesMonthNav(MOCK_SALES_PERIOD, OCTOBER)).toEqual({ previous: SEPTEMBER, next: NOVEMBER });
    expect(salesMonthNav(MOCK_SALES_PERIOD, SEPTEMBER)).toEqual({ previous: null, next: OCTOBER });
    expect(salesMonthNav(MOCK_SALES_PERIOD, NOVEMBER)).toEqual({ previous: OCTOBER, next: null });
    const acrossYears: SalesPeriod = { first: { year: 2026, month: 12 }, last: { year: 2027, month: 1 }, current: { year: 2027, month: 1 } };
    expect(salesMonthNav(acrossYears, acrossYears.current)).toEqual({ previous: { year: 2026, month: 12 }, next: null });
    const single: SalesPeriod = { first: OCTOBER, last: OCTOBER, current: OCTOBER };
    expect(salesMonthNav(single, OCTOBER)).toEqual({ previous: null, next: null });
  });
});

describe("sales summary", () => {
  it("sums October: sales and their fees, refunds, payouts that arrived, and what is still to come", () => {
    expect(salesSummary(MOCK_KITCHEN_SALES, OCTOBER)).toEqual({
      salesYen: 390000,
      feeYen: 19500,
      refundsYen: 60000,
      paidOutYen: 171000,
      // 390,000 − 19,500 − 60,000 − 171,000: the payout on its way (¥54,000, 送金中) is still to come.
      expectedYen: 139500,
      bookings: 8,
    });
  });

  it("sums a month that was paid out in full, and an empty one", () => {
    expect(salesSummary(MOCK_KITCHEN_SALES, SEPTEMBER)).toEqual({ salesYen: 225000, feeYen: 11250, refundsYen: 0, paidOutYen: 213750, expectedYen: 0, bookings: 4 });
    expect(salesSummary(MOCK_KITCHEN_SALES, NOVEMBER)).toEqual({ salesYen: 0, feeYen: 0, refundsYen: 0, paidOutYen: 0, expectedYen: 0, bookings: 0 });
  });

  it("counts a payout only once it has reached the bank", () => {
    const lines: HostSale[] = [
      { id: "a", kind: "sale", date: "2026-10-01", status: "posted", experience: "Dinner", guest: "A", channel: "NIHO", offer: "Dinner", guests: 1, amountYen: 10000, feeYen: 500 },
      { id: "b", kind: "payout", date: "2026-10-03", status: "pending", from: "2026-10-01", to: "2026-10-02", amountYen: 9500 },
    ];
    expect(salesSummary(lines, OCTOBER)).toMatchObject({ paidOutYen: 0, expectedYen: 9500 });
    expect(salesSummary([...lines.slice(0, 1), { ...lines[1]!, status: "paid" } as HostSale], OCTOBER)).toMatchObject({ paidOutYen: 9500, expectedYen: 0 });
  });

  it("keeps the preview's payouts in step with its sales, fees and refunds", () => {
    const net = (from: string, to: string) =>
      MOCK_KITCHEN_SALES.filter((line) => line.date >= from && line.date <= to).reduce((sum, line) => {
        if (line.kind === "sale") return sum + line.amountYen - Math.round(line.amountYen * MOCK_FEE_RATE);
        return line.kind === "refund" ? sum - line.amountYen : sum;
      }, 0);
    for (const payout of MOCK_KITCHEN_SALES.filter((line) => line.kind === "payout")) {
      expect(payout.amountYen, payout.id).toBe(net(payout.from, payout.to));
    }
  });

  it("dates the payments and the refund of the bookings 予約 lists as the bookings do", () => {
    for (const line of MOCK_KITCHEN_SALES) {
      if (line.kind === "payout" || !line.bookingId) continue;
      const booking = MOCK_KITCHEN_BOOKINGS.find((candidate) => candidate.id === line.bookingId);
      expect(booking, line.id).toBeDefined();
      expect(line.guest, line.id).toBe(booking!.guest);
      expect(line.channel, line.id).toBe(booking!.channel);
      if (line.kind === "sale") {
        expect([line.date, line.amountYen, line.offer, line.guests], line.id).toEqual([booking!.paidAt!.slice(0, 10), booking!.amountYen, booking!.offer, booking!.guests]);
      } else {
        expect([line.date, line.amountYen], line.id).toEqual([booking!.cancelledAt!.slice(0, 10), booking!.refundedYen]);
      }
    }
    // Every booking that was charged has its payment in the ledger (Sofia Rossi and Mateo García included).
    const paid = MOCK_KITCHEN_BOOKINGS.filter((booking) => booking.paidAt).map((booking) => booking.id).sort();
    expect(MOCK_KITCHEN_SALES.filter((line) => line.kind === "sale" && line.bookingId).map((line) => (line.kind === "sale" ? line.bookingId : "")).sort()).toEqual(paid);
  });
});

describe("sales rows", () => {
  it("lists the month newest first: only a refund is written with a minus, a payout is money received", () => {
    const rows = salesRows(MOCK_KITCHEN_SALES, OCTOBER);
    expect(rows.map((row) => [row.shortDate, row.title, row.detail, row.amount, row.negative, row.status.label])).toEqual([
      ["10/20", "口座入金", "Stripe · 10月10日〜16日分", "¥54,000", false, "送金中"],
      ["10/18", "Kamakura Community Dinner · Emma Larsson", "体験サイト · Dinner 2名", "¥60,000", false, "計上済み"],
      ["10/18", "Kamakura Community Dinner · Noah Williams", "体験サイト · Dinner 1名", "¥30,000", false, "計上済み"],
      ["10/16", "Kamakura Community Dinner · Mateo García", "体験サイト · tea time 2名", "¥30,000", false, "計上済み"],
      ["10/15", "Kamakura Community Dinner · Sofia Rossi", "NIHO · Dinner 3名", "¥90,000", false, "計上済み"],
      ["10/12", "返金 · Hannah Kim", "体験サイト · 取消", "−¥60,000", true, "計上済み"],
      ["10/10", "口座入金", "Stripe · 10月1日〜9日分", "¥171,000", false, "入金済み"],
      ["10/09", "Kamakura Community Dinner · Oliver Brown", "体験サイト · Dinner 2名", "¥60,000", false, "計上済み"],
      ["10/05", "Kamakura Community Dinner · Hannah Kim", "体験サイト · Dinner 2名", "¥60,000", false, "計上済み"],
      ["10/04", "Kamakura Community Dinner · Liam Walker", "NIHO · Dinner 1名", "¥30,000", false, "計上済み"],
      ["10/02", "Kamakura Community Dinner · Aiko Tanaka", "NIHO · tea time 2名", "¥30,000", false, "計上済み"],
    ]);
    expect(rows[0]).toMatchObject({ date: "2026-10-20", dateLabel: "10月20日", status: { tone: "wait" } });
    expect(rows.find((row) => row.status.label === "入金済み")!.status.tone).toBe("draft");
  });

  it("calls a payout on its way 送金中, and any other line not settled yet 保留", () => {
    expect(saleStatus({ kind: "payout", status: "pending" })).toEqual({ label: "送金中", tone: "wait" });
    expect(saleStatus({ kind: "payout", status: "paid" })).toEqual({ label: "入金済み", tone: "draft" });
    expect(saleStatus({ kind: "sale", status: "pending" })).toEqual({ label: "保留", tone: "wait" });
    expect(saleStatus({ kind: "refund", status: "posted" })).toEqual({ label: "計上済み", tone: "draft" });
  });

  it("names a payout's days across two months, and has nothing for an empty month", () => {
    const across: HostSale = { id: "p", kind: "payout", date: "2026-10-02", status: "paid", from: "2026-09-28", to: "2026-10-01", amountYen: 1000 };
    expect(salesRows([across], OCTOBER)[0]!.detail).toBe("Stripe · 9月28日〜10月1日分");
    expect(salesRows(MOCK_KITCHEN_SALES, NOVEMBER)).toEqual([]);
  });

  it("puts one month's page together from ?month=", () => {
    const september = salesPage(MOCK_KITCHEN_SALES, MOCK_SALES_PERIOD, "2026-09");
    expect([september.label, september.previous, september.next, september.rows.length, september.figures.find((figure) => figure.label === "入金予定")?.value]).toEqual(["2026年9月", null, OCTOBER, 6, "¥0"]);
    const november = salesPage(MOCK_KITCHEN_SALES, MOCK_SALES_PERIOD, "2026-11");
    expect([november.label, november.previous, november.next, november.rows]).toEqual(["2026年11月", OCTOBER, null, []]);
    expect(salesPage([], MOCK_SALES_PERIOD, undefined)).toMatchObject({ label: "2026年10月", rows: [], notes: [] });
    expect(salesPage([], MOCK_SALES_PERIOD, undefined).figures.map((figure) => figure.value)).toEqual(["¥0", "¥0", "¥0", "¥0", "¥0"]);
  });
});
