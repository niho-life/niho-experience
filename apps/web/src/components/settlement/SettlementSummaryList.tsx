import type { ExperienceSettlementSummary } from "@niho-experience/experience-store";

const yen = (currency: string, amount: number) => `${new Intl.NumberFormat("ja-JP", { style: "currency", currency }).format(amount)}`;

function statusLabel(item: ExperienceSettlementSummary): { label: string; style: string } {
  if (item.status === "REVIEW_REQUIRED" || item.failedRefundCount) return { label: "要対応", style: "bg-warn-pale text-warn" };
  if (item.final) return { label: "実費確定", style: "bg-leaf-pale text-moss" };
  if (item.status === "RESULT_UNKNOWN") return { label: "結果確認中", style: "bg-warn-pale text-warn" };
  if (item.issueCode) return { label: "要対応", style: "bg-warn-pale text-warn" };
  return { label: "見込・照合中", style: "bg-sand text-ink-soft" };
}

/** Same safe summary for Admin and the host OWNER. Stripe identifiers and guest details are never shown here. */
export function SettlementSummaryList({ items, heading = "決済費用の精算", provider = false, admin = false }: { items: readonly ExperienceSettlementSummary[]; heading?: string; provider?: boolean; admin?: boolean }) {
  return <section aria-label={heading} className="mt-4 rounded-2xl border border-line bg-canvas p-4 md:p-5">
    <h2 className="font-display text-lg font-medium">{heading}</h2>
    <p className="mt-1 text-sm text-ink-soft">合計手数料の見込と、Stripeの実取引費用・返金状況を照合した結果です。返金処理中や照合中は最終額ではありません。</p>
    {items.length === 0 ? <p className="mt-3 text-sm text-muted">照合するExperience予約はありません。</p> : <ul className="mt-3 grid gap-2">
      {items.map((item) => {
        const status = statusLabel(item);
        return <li key={`${item.providerId}:${item.publicBookingId}`} className="min-w-0 rounded-xl border border-line p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0"><p className="break-all text-sm font-extrabold">予約 {item.publicBookingId}</p>{provider ? <p className="text-xs text-muted">提供者 {item.providerId}</p> : null}</div>
            <span className={`rounded-full px-2.5 py-1 text-xs font-extrabold ${status.style}`}>{status.label}</span>
          </div>
          <p className="mt-2 text-sm text-ink-soft">支払額 {yen(item.currency, item.grossAmount)} · 合計料率 {item.feeRateBasisPoints / 100}% · 手数料見込 {yen(item.currency, item.estimatedPlatformFee)}</p>
          <p className="mt-1 text-sm text-ink-soft">
            {item.actualProcessingFee === null ? "決済費用 実費照合待ち" : `決済費用 実費 ${yen(item.currency, item.actualProcessingFee)}${item.processingFeePayer === "ACCOUNT" ? "（提供者口座負担・NIHO補填対象）" : item.processingFeePayer === "APPLICATION" ? "（NIHO負担）" : "（負担者確認中）"}`}
            {item.successfulRefundAmount === null ? " · 返金照合待ち" : ` · 成功返金 ${yen(item.currency, item.successfulRefundAmount)}`}
            {item.pendingRefundAmount ? ` · 返金処理中 ${yen(item.currency, item.pendingRefundAmount)}` : ""}
            {item.failedRefundCount ? ` · 未解決の失敗返金 ${item.failedRefundCount}件` : ""}
          </p>
          {item.final ? <p className="mt-1 text-sm font-bold">ホスト最終受取 {yen(item.currency, item.hostNetAfterRefunds!)} · NIHOの手数料差引後 {yen(item.currency, item.nihoNetAfterProcessing!)}</p> : item.status === "RESULT_UNKNOWN" ? <p className="mt-1 break-words text-sm font-bold text-warn">Stripe送金結果を照合中です。重複送金せず、記録を再確認しています。{admin && item.issueCode ? ` (${item.issueCode})` : ""}</p> : item.issueCode ? <p className="mt-1 break-words text-sm font-bold text-warn">{admin ? `要確認コード: ${item.issueCode}` : "要確認です。NIHOが決済記録を確認しています。"}</p> : item.compensationAmount !== null && item.compensationAmount > 0 ? <p className="mt-1 text-sm text-ink-soft">決済費用補填 {yen(item.currency, item.compensationAmount)} · {item.compensationStatus === "TRANSFERRED" ? "送金済み・最終照合待ち" : "送金または照合待ち"}</p> : null}
        </li>;
      })}
    </ul>}
  </section>;
}
