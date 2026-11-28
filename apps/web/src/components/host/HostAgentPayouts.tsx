import type { HostAgentPayoutRow } from "@niho-experience/experience-store";
import { HOST_SURFACE } from "@/components/host/host-ui";

/*
 * 売上の「NIHO からの送金」 (#725, 3b-2): the OWNER's payouts of agent-sales (サポート 15%) bookings, one row each. Never a Stripe reference or an
 * internal state: 予定・登録待ち・送金済み・確認中・取消, and what was taken back after a payout.
 */
const yen = (amount: number) => `${amount.toLocaleString("ja-JP")}円`;
const STATE: Record<HostAgentPayoutRow["state"], string> = {
  SCHEDULED: "予定", AWAITING_ACCOUNT: "登録待ち", TRANSFERRED: "送金済み", REVIEWING: "確認中", CANCELLED: "取消",
};

export function HostAgentPayouts({ rows, settingsHref, paused = false }: { rows: readonly HostAgentPayoutRow[]; settingsHref: string; paused?: boolean }) {
  if (rows.length === 0) return null;
  return <section className={`${HOST_SURFACE} mt-4 p-4 md:p-5`} aria-labelledby="agent-payouts-title">
    <h2 id="agent-payouts-title" className="font-extrabold">NIHO からの送金</h2>
    <p className="mt-1 text-sm text-muted">サポート 15% で受けた予約の売上です。体験のあと、予約ごとに受取口座へ送ります。銀行への入金日は Stripe の入金で確かめられます。</p>
    {paused ? <p role="status" className="mt-2 rounded-xl bg-warn-pale p-3 text-sm text-warn">送金は一時停止中です。再開しだい、予定どおりお送りします。</p> : null}
    <ul className="mt-3 divide-y divide-line">{rows.map((row) => <li key={row.publicBookingId} className="grid gap-1 py-3 text-sm sm:grid-cols-[1fr_auto]">
      <span className="font-bold">体験日 {row.experienceDate || "—"}</span>
      <span className="font-bold">{STATE[row.state]}{row.state === "TRANSFERRED" && row.transferredAtUtc ? `（${row.transferredAtUtc.slice(0, 10)}）` : ""}</span>
      <span className="text-muted">決済額 {yen(row.capturedAmount)}{row.refundedAmount > 0 ? ` · 返金等 ${yen(row.refundedAmount)}` : ""} · NIHO の手数料 {yen(row.nihoFeeAmount)}</span>
      <span>{row.state === "CANCELLED" ? "" : `取り分 ${yen(row.payoutAmount)}`}{row.offsetAmount > 0 ? ` · 差し引き ${yen(row.offsetAmount)}` : ""}</span>
      <span className="font-bold">{row.sentAmount !== null ? `送金額 ${yen(row.sentAmount)}` : ""}</span>
      <span className="text-muted">予定日 {row.dueAtUtc.slice(0, 10)}</span>
      <span>{row.state === "AWAITING_ACCOUNT" ? <a className="underline" href={settingsHref}>設定 › 受取口座 へ</a> : null}</span>
      {row.takenBackAmount > 0 ? <span className="text-warn sm:col-span-2">送金のあとの返金などで、{yen(row.takenBackAmount)} を取り戻しています。</span> : null}
    </li>)}</ul>
  </section>;
}
