import { yen } from "./format";
import type { StatusLabel } from "./status";
import type { HostSale, HostSaleStatus } from "./types";

/*
 * 売上 (#91, mock v2 `screenSales`): one month of the ledger at a time. The numbers and the
 * lines are worked out here from the lines alone, so the screen and the home card agree.
 */

/** A calendar month in Japan. `month` is 1–12. */
export interface SalesMonth {
  year: number;
  month: number;
}

/**
 * The months the sales screen moves between (`first` to `last`, both included) and the one it
 * opens on. The preview's are fixed in mock/sales.ts; NIHO's sales API will give its own.
 */
export interface SalesPeriod {
  first: SalesMonth;
  last: SalesMonth;
  current: SalesMonth;
}

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;

const indexOf = ({ year, month }: SalesMonth) => year * 12 + month - 1;
const fromIndex = (index: number): SalesMonth => ({ year: Math.floor(index / 12), month: (index % 12) + 1 });

/** "2026-10": the month as `?month=` carries it. */
export function monthKey({ year, month }: SalesMonth): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

export function parseMonthKey(value: unknown): SalesMonth | null {
  const match = typeof value === "string" ? MONTH_KEY.exec(value) : null;
  return match ? { year: Number(match[1]), month: Number(match[2]) } : null;
}

export function addMonths(month: SalesMonth, count: number): SalesMonth {
  return fromIndex(indexOf(month) + count);
}

/** "2026年10月" */
export function monthLabelJa({ year, month }: SalesMonth): string {
  return `${year}年${month}月`;
}

/** The month `?month=` asks for when the period has it; otherwise the month the screen opens on. */
export function salesMonthOf(period: SalesPeriod, requested: unknown): SalesMonth {
  const month = parseMonthKey(Array.isArray(requested) ? requested[0] : requested);
  return month && indexOf(month) >= indexOf(period.first) && indexOf(month) <= indexOf(period.last) ? month : period.current;
}

/** ‹ and ›: the months next to this one inside the period; null at either end. */
export function salesMonthNav(period: SalesPeriod, month: SalesMonth): { previous: SalesMonth | null; next: SalesMonth | null } {
  const at = indexOf(month);
  return {
    previous: at > indexOf(period.first) ? fromIndex(at - 1) : null,
    next: at < indexOf(period.last) ? fromIndex(at + 1) : null,
  };
}

function inMonth(date: string, month: SalesMonth): boolean {
  return date.startsWith(`${monthKey(month)}-`);
}

/** The month's numbers (yen, all positive; the screen writes refunds and fees with a minus). */
export interface SalesSummary {
  /** 売上: the guests' payments. */
  salesYen: number;
  /** 手数料: what NIHO and Stripe keep of them. */
  feeYen: number;
  /** 返金: what went back to guests. */
  refundsYen: number;
  /** 入金済み: payouts that reached the bank. */
  paidOutYen: number;
  /** 入金予定: what is still to reach the bank (売上 − 手数料 − 返金 − 入金済み), payouts on their way included. */
  expectedYen: number;
  /** 確定した予約: the payments counted in 売上. */
  bookings: number;
}

export function salesSummary(sales: readonly HostSale[], month: SalesMonth): SalesSummary {
  const summary: SalesSummary = { salesYen: 0, feeYen: 0, refundsYen: 0, paidOutYen: 0, expectedYen: 0, bookings: 0 };
  for (const line of sales) {
    if (!inMonth(line.date, month)) continue;
    if (line.kind === "sale") {
      summary.salesYen += line.amountYen;
      summary.feeYen += line.feeYen;
      summary.bookings += 1;
    } else if (line.kind === "refund") {
      summary.refundsYen += line.amountYen;
    } else if (line.status === "paid") {
      summary.paidOutYen += line.amountYen;
    }
  }
  summary.expectedYen = summary.salesYen - summary.feeYen - summary.refundsYen - summary.paidOutYen;
  return summary;
}

/** Ledger states as pills: quiet once settled, amber while 保留 (a payout on its way is 送金中). */
const SALE_STATUS: Record<HostSaleStatus, StatusLabel> = {
  posted: { label: "計上済み", tone: "draft" },
  paid: { label: "入金済み", tone: "draft" },
  pending: { label: "保留", tone: "wait" },
};
const PAYOUT_ON_ITS_WAY: StatusLabel = { label: "送金中", tone: "wait" };

export function saleStatus(line: Pick<HostSale, "kind" | "status">): StatusLabel {
  return line.kind === "payout" && line.status === "pending" ? PAYOUT_ON_ITS_WAY : SALE_STATUS[line.status];
}

/** One row of 明細. */
export interface SalesRow {
  key: string;
  /** YYYY-MM-DD. */
  date: string;
  /** "10/18", the date column. */
  shortDate: string;
  /** "10月18日", read out instead of the short date. */
  dateLabel: string;
  /** 内容: "Kamakura Community Dinner · Oliver Brown", "返金 · Hannah Kim", "口座入金". */
  title: string;
  /** 補足: "体験サイト · Dinner 2名", "体験サイト · 取消", "Stripe · 10月1日〜9日分". */
  detail: string;
  /**
   * "¥60,000"; "−¥60,000" (in red) only for a refund. A payout is money the host receives, so
   * it stays unsigned ("¥171,000") like a sale.
   */
  amount: string;
  /** A refund: written with a minus, in red. */
  negative: boolean;
  status: StatusLabel;
}

function dateParts(date: string): { month: number; day: number } {
  const [, month = 1, day = 1] = date.split("-").map(Number);
  return { month, day };
}

/** The date column of a row: "10/18", read out as "10月18日". */
export function rowDate(date: string): Pick<SalesRow, "date" | "shortDate" | "dateLabel"> {
  const { month, day } = dateParts(date);
  return { date, shortDate: `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`, dateLabel: `${month}月${day}日` };
}

/** "10月1日〜9日" within a month, "9月16日〜10月9日" across two. */
function daysCovered(from: string, to: string): string {
  const start = dateParts(from);
  const end = dateParts(to);
  return `${start.month}月${start.day}日〜${end.month === start.month ? "" : `${end.month}月`}${end.day}日`;
}

function rowOf(line: HostSale): Pick<SalesRow, "title" | "detail" | "negative"> {
  if (line.kind === "sale") return { title: `${line.experience} · ${line.guest}`, detail: `${line.channel} · ${line.offer} ${line.guests}名`, negative: false };
  if (line.kind === "refund") return { title: `返金 · ${line.guest}`, detail: `${line.channel} · 取消`, negative: true };
  return { title: "口座入金", detail: `Stripe · ${daysCovered(line.from, line.to)}分`, negative: false };
}

/** 明細: the month's lines, newest first (lines of one day keep their order). */
export function salesRows(sales: readonly HostSale[], month: SalesMonth): SalesRow[] {
  return sales
    .filter((line) => inMonth(line.date, month))
    .map((line, order) => ({ line, order }))
    .sort((a, b) => b.line.date.localeCompare(a.line.date) || a.order - b.order)
    .map(({ line }) => {
      const { title, detail, negative } = rowOf(line);
      return {
        key: line.id,
        ...rowDate(line.date),
        title,
        detail,
        amount: yen(negative ? -line.amountYen : line.amountYen),
        negative,
        status: saleStatus(line),
      };
    });
}

/** One of the month's numbers as the summary shows it: 売上 "¥390,000", 手数料 "−¥19,500". */
export interface SalesFigure {
  label: string;
  value: string;
}

/** Everything the sales screen shows for one month. */
export interface SalesPage {
  month: SalesMonth;
  label: string;
  previous: SalesMonth | null;
  next: SalesMonth | null;
  figures: SalesFigure[];
  /** Under the numbers: what they leave out, or work out. */
  notes: string[];
  rows: SalesRow[];
}

/** The preview's numbers: 売上, 手数料, 返金, 入金予定 and 入金済み. */
export function salesFigures(summary: SalesSummary): SalesFigure[] {
  return [
    { label: "売上", value: yen(summary.salesYen) },
    { label: "手数料", value: yen(-summary.feeYen) },
    { label: "返金", value: yen(-summary.refundsYen) },
    { label: "入金予定", value: yen(summary.expectedYen) },
    { label: "入金済み", value: yen(summary.paidOutYen) },
  ];
}

export function salesPage(sales: readonly HostSale[], period: SalesPeriod, requested: unknown): SalesPage {
  const month = salesMonthOf(period, requested);
  return { month, label: monthLabelJa(month), ...salesMonthNav(period, month), figures: salesFigures(salesSummary(sales, month)), notes: [], rows: salesRows(sales, month) };
}
