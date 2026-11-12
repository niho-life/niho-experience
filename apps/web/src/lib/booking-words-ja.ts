import type { GuestCancellationPolicy } from "@niho-experience/experience-store";

/*
 * 日本語で申し込んだ予約の言葉（#59）。booking-words.ts の日本語版：確定メール・集合案内・取消／返金のお知らせが、
 * 日付・人数・金額・取消条件を同じ言い回しで言う。英語版と同じ事実だけを言い、言い回しを足さない。
 */

const DATE_JA = new Intl.DateTimeFormat("ja-JP", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric", weekday: "short" });

/** 「2026年11月15日(日)」。日付そのものを言い、サーバーのタイムゾーンによらない。 */
export function calendarDateJa(localDate: string): string {
  const [year, month, day] = localDate.split("-").map(Number);
  return DATE_JA.format(new Date(Date.UTC(year!, month! - 1, day!)));
}

export const zoneNameJa = (timeZone: string) => (timeZone === "Asia/Tokyo" ? "日本時間" : timeZone);

/** 「11月13日(金) 10:00」。体験のタイムゾーンでの時刻。 */
export function zonedMomentJa(instant: number, timeZone: string): string {
  const date = new Intl.DateTimeFormat("ja-JP", { timeZone, month: "long", day: "numeric", weekday: "short" }).format(instant);
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(instant);
  return `${date} ${clock}`;
}

/** 円は「7,500円」、ほかの通貨は Intl の通貨表記。 */
export function moneyJa(amount: number, currency: string): string {
  const format = new Intl.NumberFormat("ja-JP", { style: "currency", currency, currencyDisplay: currency === "JPY" ? "name" : "symbol" });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 0;
  const value = amount / 10 ** digits;
  return currency === "JPY" ? `${new Intl.NumberFormat("ja-JP").format(value)}円` : format.format(value);
}

export function partyJa(adults: number, children: number): string {
  return [...(adults ? [`大人${adults}名`] : []), ...(children ? [`子ども${children}名`] : [])].join("、");
}

/** 予約時に固定した取消条件と、無料取消が終わる時刻（確定メール用）。条件が無ければ null。 */
export function cancellationTermsWordsJa(
  booking: {
    readonly cancellationPolicy: GuestCancellationPolicy | null;
    readonly cancellationWindowMinutesBeforeStart: number | null;
    readonly cancellationRefundBasisPoints: number;
    readonly startUtc: string;
    readonly timeZone: string;
  },
  now: Date,
): string | null {
  if (booking.cancellationPolicy === null) return null;
  const window = booking.cancellationWindowMinutesBeforeStart;
  const refundBasisPoints = booking.cancellationRefundBasisPoints;
  if (window === null) return "このご予約は返金できません。";
  const deadline = Date.parse(booking.startUtc) - window * 60_000;
  if (!Number.isFinite(deadline)) return "このご予約の取消・返金の条件を表示できません。このメールに返信してください。NIHO事務局が日本語でご案内します。";
  const period = window % 1_440 === 0 ? `${window / 1_440}日` : window % 60 === 0 ? `${window / 60}時間` : `${window}分`;
  const percent = refundBasisPoints % 100 === 0
    ? `${refundBasisPoints / 100}%`
    : `${(refundBasisPoints / 100).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
  if (deadline <= now.getTime()) {
    const label = refundBasisPoints === 10_000 ? "無料キャンセル" : `${percent}返金のキャンセル`;
    return `${label}の受付は、開始の${period}前に終了しました。キャンセルをご希望の場合は、このメールに返信してください。NIHO事務局が日本語でご案内します。`;
  }
  const moment = `${zonedMomentJa(deadline, booking.timeZone)}（${zoneNameJa(booking.timeZone)}）`;
  if (refundBasisPoints === 10_000) return `${moment}（開始の${period}前）まで無料でキャンセルできます。それ以降は返金できません。`;
  if (refundBasisPoints === 0) return `${moment}（開始の${period}前）までは返金なしでキャンセルできます。それ以降のキャンセルは、NIHO事務局へご連絡ください。`;
  return `${moment}（開始の${period}前）までのキャンセルは${percent}を返金します。それ以降のキャンセルは、NIHO事務局へご連絡ください。`;
}

/** カードの返金が明細に出るまでの目安。 */
export const REFUND_TIMING_JA = "カード会社によっては、明細に反映されるまで5〜10営業日かかることがあります。";

function cancelledBecauseJa(reason: string | null): string {
  switch (reason) {
    case "WEATHER":
      return "天候のため、";
    case "ILLNESS":
      return "ホストの体調不良のため、";
    case "HOST_UNAVAILABLE":
      return "ホストの都合でこの日に開催できなくなったため、";
    default:
      return "";
  }
}

/** 取消のお知らせの最初の一文。ホスト・事務局が選んだ定型の理由だけを言い、自由記入のメモは出さない。 */
export function cancelledByJa(
  booking: { readonly cancelledBy: "GUEST" | "HOST" | "SUPPORT" | null; readonly cancellationReason: string | null; readonly hostDisplayName: string },
): string {
  if (booking.cancellationReason === "LATE_PAYMENT") return "確保していた席の期限が過ぎた後にお支払いを確認したため、ご予約を確定できませんでした。";
  if (booking.cancelledBy === "GUEST") return "ご予約をキャンセルしました。";
  if (booking.cancelledBy === "HOST") return `${cancelledBecauseJa(booking.cancellationReason)}${booking.hostDisplayName}がご予約をキャンセルしました。申し訳ありません。`;
  if (booking.cancelledBy === "SUPPORT") {
    return booking.cancellationReason === "GUEST_REQUEST"
      ? "ご依頼のとおり、NIHO事務局がご予約をキャンセルしました。"
      : `${cancelledBecauseJa(booking.cancellationReason)}NIHO事務局がご予約をキャンセルしました。`;
  }
  return "ご予約はキャンセルされました。";
}
