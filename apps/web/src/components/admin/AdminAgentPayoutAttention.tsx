import type { AgentPayoutAttentionItem } from "@niho-experience/experience-store";
import { HOST_SURFACE } from "@/components/host/host-ui";

/** 代理受領の送金で、人が見るもの (#725, 3b-2): 要確認・23 時間を過ぎた結果不明・期限を過ぎた登録待ち・長く残る取り戻し。 */
const STATUS: Record<string, string> = {
  REVIEW_REQUIRED: "要確認", RESULT_UNKNOWN: "結果不明", SUBMITTING: "手続きが止まっている", AWAITING_ACCOUNT: "登録待ちが長い",
  OFFSET_PENDING: "差し引き待ちが長い", REVERSAL_PENDING: "取り消しが止まっている",
};

export function AdminAgentPayoutAttention({ items }: { items: readonly AgentPayoutAttentionItem[] }) {
  if (items.length === 0) return null;
  return <section className={`${HOST_SURFACE} mt-3 p-4`} aria-labelledby="agent-payout-attention">
    <h2 id="agent-payout-attention" className="font-extrabold">ホストへの送金：確認が要るもの（{items.length}）</h2>
    <p className="mt-1 text-sm text-muted">予約番号で「すべて」から予約を開き、「ホストへの送金」で操作します。</p>
    <ul className="mt-2 divide-y divide-line text-sm">{items.map((item) => <li key={`${item.kind}:${item.publicBookingId}:${item.status}`} className="grid gap-1 py-2 sm:grid-cols-[1fr_auto]">
      <span className="break-all font-bold">{item.publicBookingId}</span>
      <span>{item.kind === "ADJUSTMENT" ? "取り戻し " : ""}{STATUS[item.status] ?? item.status} · ¥{item.amount.toLocaleString("ja-JP")}</span>
      <span className="text-muted">{item.issueCode ?? ""}</span><span className="text-muted">{item.sinceUtc.slice(0, 10)}〜</span>
    </li>)}</ul>
  </section>;
}
