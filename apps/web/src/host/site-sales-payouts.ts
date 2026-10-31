import type { ConnectedBalanceAmount, ConnectedPayout, ConnectedPayoutStatus } from "@niho-experience/experience-payments";
import { todayInJapan, yen } from "./format";
import { monthKey, rowDate, type SalesFigure, type SalesMonth, type SalesRow } from "./sales";
import { entryAmount, japanMonthOf } from "./site-sales";
import type { StatusLabel } from "./status";

/*
 * この口座への入金 on 売上 (#91): Stripe's balance and payouts of the Connect accounts the OWNER's sales here go to,
 * as the screen shows them: the mock's 入金予定・入金済み and 口座入金 lines (src/host/sales.ts), with what Stripe says.
 * Those accounts also take what the provider sells through NIHO, so this is the account's money, never this site's:
 * it has its own heading, apart from this site's numbers, and says so. Plain data and rules; the read is
 * site-sales-payouts-server.ts. Type-only use of the payments package: the preview's synthetic payouts go through the
 * same rules.
 */

export const SITE_PAYOUTS_TITLE = "この口座への入金";
export const SITE_PAYOUTS_SCOPE_TEXT = "Stripe の口座に入る入金です。NIHO で販売している体験の分も同じ口座に入るため、このサイトの売上・受取額とは一致しません。";
export const SITE_PAYOUTS_EXPECTED_NOTE = "入金予定は、Stripe の残高と送金中の入金の合計です。入金の日は Stripe の入金スケジュールで決まります。";
export const SITE_PAYOUTS_MORE_NOTE = "この月の入金が多いため、一部だけを出しています。すべての入金は Stripe で確認できます。";
export const SITE_PAYOUTS_EMPTY_TEXT = "この月の口座への入金はありません";
export const SITE_PAYOUTS_LOADING_TEXT = "この口座への入金を Stripe から読み込んでいます…";
export const SITE_PAYOUTS_FAILED_TEXT = "この口座への入金を Stripe から読み込めませんでした。時間をおいて、もう一度お試しください。";
export const SITE_PAYOUTS_SLOW_TEXT = "Stripe の応答が遅いため、この口座への入金を出せませんでした。時間をおいて、もう一度お試しください。";
export const SITE_PAYOUTS_UNREACHABLE_TEXT = "この口座の入金を Stripe から読めませんでした。口座のつながりを NIHO サポートへお問い合わせください。";
const accountsNote = (count: number) => `Stripe の口座が ${count} つあり、その合計です。`;
const otherCurrencyNote = (count: number) => `円以外の通貨の入金・残高が ${count} 件あります。集計には含めていません。`;

const JPY = "JPY";
const STRIPE = "Stripe";

/** What the server read from Stripe for the month (all the provider's accounts together). */
export interface SitePayoutsRead {
  /** How many Stripe accounts were read. */
  accounts: number;
  balance: readonly ConnectedBalanceAmount[];
  /** The latest arrival first. */
  payouts: readonly ConnectedPayout[];
  /** Stripe has more payouts in the month than one read takes. */
  more: boolean;
}

/** この口座への入金 as the screen shows it. */
export interface SitePayoutsPanel {
  figures: SalesFigure[];
  notes: string[];
  rows: SalesRow[];
}

const ON_ITS_WAY: ReadonlySet<ConnectedPayoutStatus> = new Set(["PENDING", "IN_TRANSIT"]);

const STATUS: Record<ConnectedPayoutStatus, StatusLabel> = {
  PENDING: { label: "送金中", tone: "wait" },
  IN_TRANSIT: { label: "送金中", tone: "wait" },
  PAID: { label: "入金済み", tone: "draft" },
  FAILED: { label: "入金できず", tone: "stop" },
  CANCELED: { label: "取消", tone: "draft" },
};

const DETAIL: Record<ConnectedPayoutStatus, string> = {
  PENDING: `${STRIPE} · 着金予定`,
  IN_TRANSIT: `${STRIPE} · 着金予定`,
  PAID: STRIPE,
  FAILED: `${STRIPE} · 口座に届きませんでした。Stripe で口座を確かめてください`,
  CANCELED: `${STRIPE} · 取り消されました`,
};

const arrivalMonth = (payout: ConnectedPayout) => monthKey(japanMonthOf(payout.arrivalDateUtc));

/**
 * The month's payouts: those arriving in it, and in this month also every one still on its way, whether due on a later
 * day or on an earlier one Stripe has not marked paid yet (due 10/31, still in transit on 11/1: it has left the balance,
 * so 入金予定 counts it here). An earlier month's payout that is paid, failed or canceled stays that month's.
 */
function monthPayouts(read: SitePayoutsRead, month: SalesMonth, current: boolean): ConnectedPayout[] {
  const key = monthKey(month);
  return read.payouts.filter((payout) => arrivalMonth(payout) === key || (current && ON_ITS_WAY.has(payout.status)));
}

function rowOf(payout: ConnectedPayout): SalesRow {
  const debit = payout.amount < 0;
  return {
    key: `payout:${payout.key}`,
    ...rowDate(todayInJapan(Date.parse(payout.arrivalDateUtc))),
    title: debit ? "口座からの引き落とし" : "口座入金",
    detail: payout.currency === JPY ? DETAIL[payout.status] : `${DETAIL[payout.status]} · 集計に含めていません`,
    amount: entryAmount(payout.amount, payout.currency),
    negative: debit,
    status: STATUS[payout.status],
  };
}

/**
 * The month's 入金済み (payouts in yen Stripe paid that month) and, for this month only, 入金予定: the yen balance
 * (available and not yet available) and the payouts still on their way (each once, whatever month it is due in: a
 * payout out of the balance is not in it any more). A paid payout may still turn failed: Stripe's
 * word at the time of reading is what is shown. 明細: each payout on its arrival day in Japan, the latest first.
 */
export function sitePayoutsPanel(read: SitePayoutsRead, month: SalesMonth, current: boolean): SitePayoutsPanel {
  const payouts = monthPayouts(read, month, current);
  const key = monthKey(month);
  const yenPayouts = payouts.filter((payout) => payout.currency === JPY);
  const paidYen = yenPayouts.filter((payout) => payout.status === "PAID" && arrivalMonth(payout) === key).reduce((sum, payout) => sum + payout.amount, 0);
  const onItsWayYen = yenPayouts.filter((payout) => ON_ITS_WAY.has(payout.status)).reduce((sum, payout) => sum + payout.amount, 0);
  const balanceYen = read.balance.filter((amount) => amount.currency === JPY).reduce((sum, amount) => sum + amount.available + amount.pending, 0);
  const otherCurrencies = payouts.length - yenPayouts.length + (current ? read.balance.filter((amount) => amount.currency !== JPY && (amount.available || amount.pending)).length : 0);
  return {
    figures: [...(current ? [{ label: "入金予定", value: yen(balanceYen + onItsWayYen) }] : []), { label: "入金済み", value: yen(paidYen) }],
    notes: [
      ...(current ? [SITE_PAYOUTS_EXPECTED_NOTE] : []),
      ...(read.accounts > 1 ? [accountsNote(read.accounts)] : []),
      ...(read.more ? [SITE_PAYOUTS_MORE_NOTE] : []),
      ...(otherCurrencies ? [otherCurrencyNote(otherCurrencies)] : []),
    ],
    rows: payouts.map(rowOf),
  };
}
