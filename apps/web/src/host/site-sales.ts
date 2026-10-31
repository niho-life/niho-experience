import type { HostSaleEntry } from "@niho-experience/experience-store";
import { todayInJapan, yen } from "./format";
import type { HomeMonth } from "./home";
import { addMonths, monthKey, monthLabelJa, parseMonthKey, rowDate, salesMonthNav, type SalesFigure, type SalesMonth, type SalesPage, type SalesPeriod, type SalesRow } from "./sales";
import type { StatusLabel } from "./status";

/*
 * 売上 for the bookings travelers made on this site (#91, ADR 0002): the experience DB's payment ledger, one month in
 * Japan at a time. The store gives each entry with NIHO's fee it moved and what it moved for the provider; this sums
 * and words them. Only this site's bookings: what is still sold through NIHO is not here, and the screen says so.
 * Payouts to the bank are Stripe's (the Connect account's): no 入金予定 or 入金済み is made up here. Type-only use of
 * the store: the preview's synthetic ledger goes through the same rules.
 */

export const SITE_SALES_SCOPE_TEXT = "このサイトで受けた予約の売上です。NIHO で販売している体験の売上は含みません。";
export const SITE_SALES_HOME_SCOPE_TEXT = "このサイトで受けた予約の分";
export const SITE_SALES_LOAD_FAILED_TEXT = "売上を読み込めませんでした。時間をおいて、もう一度お試しください。";
export const SITE_SALES_HOME_LOAD_FAILED_TEXT = "今月の売上を読み込めませんでした。";
export const SITE_SALES_RECEIVED_NOTE = "受取額は、売上から NIHO の手数料と返金を引いた額です。口座への入金の予定と実績は Stripe で確認できます。";
export const SITE_SALES_FEE_ESTIMATE_NOTE = "一部返金で戻る NIHO の手数料は、返金額に比例した見込みです。Stripe の計算と 1 円ずれることがあります。";
export const SITE_SALES_FEE_UNKNOWN_NOTE = "手数料を確認できない取引があります。手数料と受取額は NIHO サポートへお問い合わせください。";
const otherCurrencyNote = (count: number) => `円以外の通貨の取引が ${count} 件あります。集計には含めていません。`;

const CHANNEL = "体験サイト";
const JPY = "JPY";
const UNKNOWN = "—";

/** The instants [from, to) the ledger is read with for a month in Japan (Japan keeps no summer time). */
export function japanMonthWindow(month: SalesMonth): { from: string; to: string } {
  const start = (at: SalesMonth) => new Date(`${monthKey(at)}-01T00:00:00+09:00`).toISOString();
  return { from: start(month), to: start(addMonths(month, 1)) };
}

/** The month in Japan an instant falls in. */
export function japanMonthOf(utc: string): SalesMonth {
  const date = todayInJapan(Date.parse(utc));
  return { year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)) };
}

const monthOfDay = (today: string): SalesMonth => ({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) });
const before = (a: SalesMonth, b: SalesMonth) => monthKey(a) < monthKey(b);

/** The months 売上 moves between: from the provider's first entry (this month without one) to this month in Japan. */
export function siteSalesPeriod(firstEntryAtUtc: string | null, today: string): SalesPeriod {
  const current = monthOfDay(today);
  const first = firstEntryAtUtc ? japanMonthOf(firstEntryAtUtc) : current;
  return { first: before(first, current) ? first : current, last: current, current };
}

/**
 * The month to read for `?month=`: the one it names when that is not after this month, otherwise this month. Whether
 * it is before the provider's first entry is known only once read (siteSalesPeriod).
 */
export function requestedSiteSalesMonth(requested: unknown, today: string): SalesMonth {
  const current = monthOfDay(today);
  const month = parseMonthKey(Array.isArray(requested) ? requested[0] : requested);
  return month && !before(current, month) ? month : current;
}

/** The month's sums in yen. Entries in another currency are counted apart and left out. */
export interface SiteSalesSummary {
  /** 売上: the guests' payments (also those under review). */
  salesYen: number;
  /** 手数料: NIHO's fee, net of what it gave back with refunds; null when an entry's fee is not known. */
  feeYen: number | null;
  /** 返金: refunds Stripe accepted (pending or done). */
  refundsYen: number;
  /** Refunds Stripe reversed, and anything else the ledger has: added as they are. */
  adjustmentsYen: number;
  /** 受取額: 売上 − 手数料 − 返金 + 調整; null with the fee. */
  receivedYen: number | null;
  /** How many payments. */
  payments: number;
  /** A partial refund's fee is worked out (siteSalesRows marks it 見込み). */
  feeEstimated: boolean;
  /** Entries not in yen. */
  otherCurrencies: number;
}

export function siteSalesSummary(entries: readonly HostSaleEntry[]): SiteSalesSummary {
  const summary: SiteSalesSummary = { salesYen: 0, feeYen: 0, refundsYen: 0, adjustmentsYen: 0, receivedYen: 0, payments: 0, feeEstimated: false, otherCurrencies: 0 };
  for (const entry of entries) {
    if (entry.currency !== JPY) {
      summary.otherCurrencies += 1;
      continue;
    }
    if (entry.kind === "PAYMENT") {
      summary.salesYen += entry.amount;
      summary.payments += 1;
    } else if (entry.kind === "REFUND") {
      summary.refundsYen -= entry.amount;
    } else {
      summary.adjustmentsYen += entry.amount;
    }
    summary.feeYen = summary.feeYen === null || entry.platformFeeAmount === null ? null : summary.feeYen + entry.platformFeeAmount;
    summary.receivedYen = summary.receivedYen === null || entry.providerAmount === null ? null : summary.receivedYen + entry.providerAmount;
    summary.feeEstimated ||= entry.feeEstimated;
  }
  return summary;
}

/** 売上, 手数料, 返金, 調整 (only when there is any) and 受取額: each written with the way it moves 受取額. */
export function siteSalesFigures(summary: SiteSalesSummary): SalesFigure[] {
  return [
    { label: "売上", value: yen(summary.salesYen) },
    { label: "手数料", value: summary.feeYen === null ? UNKNOWN : yen(-summary.feeYen) },
    { label: "返金", value: yen(-summary.refundsYen) },
    ...(summary.adjustmentsYen ? [{ label: "調整", value: yen(summary.adjustmentsYen) }] : []),
    { label: "受取額", value: summary.receivedYen === null ? UNKNOWN : yen(summary.receivedYen) },
  ];
}

export function siteSalesNotes(summary: SiteSalesSummary): string[] {
  return [
    SITE_SALES_RECEIVED_NOTE,
    ...(summary.feeEstimated ? [SITE_SALES_FEE_ESTIMATE_NOTE] : []),
    ...(summary.feeYen === null ? [SITE_SALES_FEE_UNKNOWN_NOTE] : []),
    ...(summary.otherCurrencies ? [otherCurrencyNote(summary.otherCurrencies)] : []),
  ];
}

/** An amount in its currency: "¥7,500" / "−¥7,500" in yen; Intl's own form for another currency's minor units. */
export function entryAmount(amount: number, currency: string): string {
  if (currency === JPY) return yen(amount);
  try {
    const format = new Intl.NumberFormat("ja-JP", { style: "currency", currency });
    return format.format(amount / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 0)).replace("-", "−");
  } catch {
    return `${amount < 0 ? "−" : ""}${Math.abs(amount)} ${currency}`;
  }
}

const RECORDED: StatusLabel = { label: "計上済み", tone: "draft" };
const UNDER_REVIEW: StatusLabel = { label: "確認待ち", tone: "wait" };
const REFUNDING: StatusLabel = { label: "返金中", tone: "wait" };
const REFUNDED: StatusLabel = { label: "返金済み", tone: "draft" };
const REFUND_FAILED: StatusLabel = { label: "返金に失敗", tone: "stop" };
const ADJUSTED: StatusLabel = { label: "調整", tone: "draft" };

function statusOf(entry: HostSaleEntry): StatusLabel {
  if (entry.kind === "PAYMENT") return entry.bookingStatus === "PAYMENT_REVIEW" ? UNDER_REVIEW : RECORDED;
  if (entry.kind === "REFUND_REVERSAL") return REFUND_FAILED;
  if (entry.kind === "ADJUSTMENT") return ADJUSTED;
  return entry.refund?.status === "SUCCEEDED" ? REFUNDED : entry.refund?.status === "FAILED" ? REFUND_FAILED : REFUNDING;
}

/** "11/5 10:00 の回 · 3名": the session as booked. */
function sessionOf(entry: HostSaleEntry): string {
  const [, month = 0, day = 0] = entry.localDate.split("-").map(Number);
  return `${month}/${day} ${entry.localStartTime} の回 · ${entry.adultCount + entry.childCount}名`;
}

/** The fee the entry moved, as the row says it; null where an entry moves none. */
function feeOf(entry: HostSaleEntry): string | null {
  if (entry.kind === "ADJUSTMENT") return null;
  if (entry.platformFeeAmount === null) return "手数料は確認できません";
  if (entry.kind === "REFUND") return `手数料の戻り ${yen(-entry.platformFeeAmount)}${entry.feeEstimated ? "（見込み）" : ""}`;
  return `手数料 ${yen(-entry.platformFeeAmount)}${entry.feeEstimated ? "（見込み）" : ""}`;
}

const withGuest = (title: string, guest: string | null) => (guest ? `${title} · ${guest}` : title);

function wordsOf(entry: HostSaleEntry): Pick<SalesRow, "title" | "detail"> {
  const parts: (string | null)[] =
    entry.kind === "PAYMENT"
      ? [CHANNEL, sessionOf(entry), feeOf(entry)]
      : entry.kind === "REFUND"
        ? [CHANNEL, entry.productTitle, entry.refund?.kind === "PARTIAL" ? "一部返金" : "全額返金", feeOf(entry)]
        : entry.kind === "REFUND_REVERSAL"
          ? [CHANNEL, entry.productTitle, "Stripe が返金を取り消しました", feeOf(entry)]
          : [CHANNEL, entry.productTitle, "内容は NIHO サポートへお問い合わせください"];
  if (entry.currency !== JPY) parts.push("集計に含めていません");
  const title =
    entry.kind === "PAYMENT" ? withGuest(entry.productTitle, entry.guestName)
    : entry.kind === "REFUND" ? withGuest("返金", entry.guestName)
    : entry.kind === "REFUND_REVERSAL" ? withGuest("返金の取り消し", entry.guestName)
    : withGuest("調整", entry.guestName);
  return { title, detail: parts.filter(Boolean).join(" · ") };
}

/** 明細: each entry as the store gives them (the latest first), dated in Japan. Only money going back is red. */
export function siteSalesRows(entries: readonly HostSaleEntry[]): SalesRow[] {
  return entries.map((entry) => ({
    key: entry.key,
    ...rowDate(todayInJapan(Date.parse(entry.occurredAtUtc))),
    ...wordsOf(entry),
    amount: entryAmount(entry.amount, entry.currency),
    negative: entry.amount < 0,
    status: statusOf(entry),
  }));
}

/** One month of 売上 from the month's entries. */
export function siteSalesPage(entries: readonly HostSaleEntry[], period: SalesPeriod, month: SalesMonth): SalesPage {
  const summary = siteSalesSummary(entries);
  return {
    month,
    label: monthLabelJa(month),
    ...salesMonthNav(period, month),
    figures: siteSalesFigures(summary),
    notes: siteSalesNotes(summary),
    rows: siteSalesRows(entries),
  };
}

/** ホーム's card: this month's 売上, 返金, 受取額 and payments, said to be this site's. */
export function siteHomeMonth(entries: readonly HostSaleEntry[], month: SalesMonth): HomeMonth {
  const summary = siteSalesSummary(entries);
  return {
    label: `${month.month}月`,
    figures: [
      { label: "売上", value: yen(summary.salesYen) },
      { label: "返金", value: yen(-summary.refundsYen) },
      { label: "受取額", value: summary.receivedYen === null ? UNKNOWN : yen(summary.receivedYen) },
      { label: "支払い", value: `${summary.payments}件` },
    ],
    note: SITE_SALES_HOME_SCOPE_TEXT,
  };
}
