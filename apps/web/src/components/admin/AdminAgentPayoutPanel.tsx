"use client";

import { useRef, useState, type SyntheticEvent } from "react";
import type { AgentPayoutAdminAction, AgentPayoutDetail } from "@niho-experience/experience-store";
import { INPUT } from "@/components/host/fields";
import { HOST_SURFACE, consoleButtonClass } from "@/components/host/host-ui";

/*
 * 代理受領の送金 (#725, 3b-2): one booking's payout for the office, and its operations. Each operation sends the version it was shown; a changed
 * payout answers 409 and the panel reads it again. An operation on a transfer or reversal whose result is unknown needs "Stripe で送られていないことを確かめた".
 */
const API = "/admin/api/site-bookings/agent-payout";
const BUTTON = `${consoleButtonClass("secondary")} disabled:opacity-50`;
/** The server's clock as the response says it (0 when absent: the 23-hour buttons then stay hidden, the safe side). */
const serverNow = (response: Response): number => Date.parse(response.headers.get("date") ?? "") || 0;
const yen = (amount: number) => `¥${amount.toLocaleString("ja-JP")}`;
const STATUS: Record<string, string> = {
  SCHEDULED: "送金の予定", AWAITING_ACCOUNT: "受取口座の登録待ち", SUBMITTING: "送金の手続き中", RESULT_UNKNOWN: "結果不明（Stripe で確認）",
  TRANSFERRED: "送金済み", REVIEW_REQUIRED: "要確認", CANCELLED: "取消",
};
const HOLD: Record<string, string> = { REFUND_PENDING: "返金の手続き中", REFUND_FAILED: "返金の失敗が未対応", DISPUTE_OPEN: "異議申立て中", PROVIDER_SUSPENDED: "ホストの運営停止中" };
const ADJUSTMENT: Record<string, string> = {
  REVERSAL_PENDING: "送金の取り消し待ち", RESULT_UNKNOWN: "取り消しの結果不明", REVERSED: "取り消し済み", OFFSET_PENDING: "次の送金から差し引き待ち",
  OFFSET_APPLIED: "差し引き済み", LOSS_RECORDED: "NIHO の損失として記録", REVIEW_REQUIRED: "要確認",
};

export function AdminAgentPayoutPanel({ publicBookingId, onSessionExpired, paused = false }: { publicBookingId: string; onSessionExpired: () => void; paused?: boolean }) {
  const requested = useRef(false);
  const [detail, setDetail] = useState<AgentPayoutDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [note, setNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  // When the payout was read: the 23-hour window is judged against it (a button is hidden or shown by the read, and the store checks again).
  const [readAt, setReadAt] = useState(0);
  const endpoint = `${API}/${encodeURIComponent(publicBookingId.toLowerCase())}`;

  const load = async () => {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(endpoint, { cache: "no-store", credentials: "same-origin" });
      if (response.status === 401 || response.status === 403) { onSessionExpired(); return; }
      const body = await response.json().catch(() => ({})) as { detail?: AgentPayoutDetail; error?: string };
      if (!response.ok || !body.detail) { setDetail(null); setMessage(body.error === "not_found" ? "送金の記録はまだありません（決済の確定と体験の終了のあと、自動で作られます）。" : "送金の記録を読み込めませんでした。"); return; }
      setDetail(body.detail); setReadAt(serverNow(response));
    } catch { setMessage("通信状態を確認してください。"); }
    finally { setBusy(false); }
  };
  const act = async (action: AgentPayoutAdminAction, expectedVersion: number, adjustmentId?: string) => {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(endpoint, {
        method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, expectedVersion, ...(adjustmentId ? { adjustmentId } : {}), confirmedNotSent: confirmed, ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      if (response.status === 401 || response.status === 403) { onSessionExpired(); return; }
      const result = await response.json().catch(() => ({})) as { detail?: AgentPayoutDetail; error?: string };
      if (!response.ok || !result.detail) {
        setMessage(result.error === "conflict" ? "状態が更新されています。読み直してから続けてください。" : result.error === "invalid_input" ? "入力（メモ・確認のチェック）を確かめてください。" : "操作を完了できませんでした。");
        return;
      }
      setDetail(result.detail); setReadAt(serverNow(response)); setNote(""); setConfirmed(false); setMessage("記録しました。");
    } catch { setMessage("結果を確認できません。再送前に読み直してください。"); }
    finally { setBusy(false); }
  };

  const payout = detail?.payout;
  // A transfer whose result is unknown is the job's to look up for 23 hours from its command (Stripe's key window); only then may it be made again or closed.
  const unknownOpen = payout?.status === "RESULT_UNKNOWN" && payout.commandCreatedAtUtc !== null && readAt - Date.parse(payout.commandCreatedAtUtc) < 23 * 3_600_000;
  const hasCommand = payout !== undefined && (payout.status === "RESULT_UNKNOWN" || (payout.status === "REVIEW_REQUIRED" && payout.commandCreatedAtUtc !== null));
  return <details className={`group ${HOST_SURFACE}`} onToggle={(event: SyntheticEvent<HTMLDetailsElement>) => { if (event.currentTarget.open && !requested.current) { requested.current = true; void load(); } }}>
    <summary className="cursor-pointer px-4 py-3 font-extrabold">ホストへの送金（サポート 15%）</summary>
    <div className="border-t border-line px-4 py-3 text-[0.84375rem]">
      {paused ? <p role="status" className="mb-2 font-bold text-warn">送金は一時停止中です（job は再計算と照合だけ行い、送金・取り消しを作りません）。</p> : null}
      <button type="button" className={BUTTON} disabled={busy} onClick={() => void load()}>読み直す</button>
      {payout ? <div className="mt-3">
        <p className="font-extrabold">{STATUS[payout.status] ?? payout.status}{payout.holdReason ? `（${HOLD[payout.holdReason] ?? payout.holdReason}）` : ""}{payout.issueCode ? ` · ${payout.issueCode}` : ""}</p>
        {unknownOpen ? <p className="mt-1 text-muted">送金の結果は job が照合中です（command から 23 時間は、作り直しも閉じることもできません）。</p> : null}
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt>決済額</dt><dd>{yen(payout.capturedAmount)}</dd>
          <dt>返金</dt><dd>{yen(payout.refundedAmount)}</dd>
          <dt>異議申立ての負け</dt><dd>{yen(payout.disputedAmount)}</dd>
          <dt>NIHO の取り分</dt><dd>{yen(payout.nihoFeeAmount)}</dd>
          <dt>ホストの取り分</dt><dd className="font-bold">{yen(payout.payoutAmount)}</dd>
          <dt>送金の予定日</dt><dd>{payout.dueAtUtc.slice(0, 10)}</dd>
          {payout.submittedAmount !== null ? <><dt>送金額</dt><dd>{yen(payout.submittedAmount)}（差し引き {yen(payout.offsetAmount)}・取り消し {yen(payout.reversedAmount)}）</dd></> : null}
          {payout.stripeTransferRef ? <><dt>Transfer</dt><dd className="break-all">{payout.stripeTransferRef}</dd></> : null}
        </dl>
        {detail.adjustments.length ? <ul className="mt-3 space-y-2">{detail.adjustments.map((adjustment) => <li key={adjustment.id} className="rounded-lg border border-line p-2">
          <p className="font-bold">{adjustment.reason === "DISPUTE" ? "異議申立て" : "返金"}の取り戻し {yen(adjustment.amount)} · {ADJUSTMENT[adjustment.status] ?? adjustment.status}{adjustment.issueCode ? ` · ${adjustment.issueCode}` : ""}</p>
          <p className="text-muted">残り {yen(adjustment.remainingAmount)}</p>
          {["REVIEW_REQUIRED", "RESULT_UNKNOWN", "OFFSET_PENDING"].includes(adjustment.status) ? <div className="mt-2 flex flex-wrap gap-2">
            {adjustment.status === "REVIEW_REQUIRED" && adjustment.reversalAmount > 0 && adjustment.stripeReversalRef === null ? <button type="button" className={BUTTON} disabled={busy} onClick={() => void act("RESUME_ADJUSTMENT", adjustment.version, adjustment.id)}>取り消しを再開</button> : null}
            {adjustment.status !== "OFFSET_PENDING" ? <button type="button" className={BUTTON} disabled={busy || (adjustment.status === "RESULT_UNKNOWN" && !confirmed)} onClick={() => void act("OFFSET", adjustment.version, adjustment.id)}>次の送金からの差し引きに回す</button> : null}
            <button type="button" className={BUTTON} disabled={busy || !note.trim() || (adjustment.status === "RESULT_UNKNOWN" && !confirmed)} onClick={() => void act("LOSS", adjustment.version, adjustment.id)}>NIHO の損失として記録</button>
          </div> : null}
        </li>)}</ul> : null}
        <div className="mt-3 space-y-2">
          <label className="block"><span className="font-bold">メモ（閉じる・損失の記録には必須）</span><input className={INPUT} value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} /></label>
          {hasCommand || detail.adjustments.some((adjustment) => adjustment.status === "RESULT_UNKNOWN") ? <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>Stripe で、送金（取り消し）が行われていないことを確かめた</span></label> : null}
          <div className="flex flex-wrap gap-2">
            {["SCHEDULED", "AWAITING_ACCOUNT", "REVIEW_REQUIRED"].includes(payout.status) && !hasCommand ? <button type="button" className={BUTTON} disabled={busy} onClick={() => void act("RECALCULATE", payout.version)}>再計算して再開</button> : null}
            {hasCommand && !unknownOpen ? <button type="button" className={BUTTON} disabled={busy || !confirmed} onClick={() => void act("RECREATE", payout.version)}>送られていないことを確かめて作り直す</button> : null}
            {["SCHEDULED", "AWAITING_ACCOUNT", "REVIEW_REQUIRED", "RESULT_UNKNOWN"].includes(payout.status) && !unknownOpen && !payout.stripeTransferRef ? <button type="button" className={BUTTON} disabled={busy || !note.trim() || (hasCommand && !confirmed)} onClick={() => void act("CLOSE", payout.version)}>送らずに閉じる</button> : null}
          </div>
        </div>
        {detail.events.length ? <details className="mt-3"><summary className="cursor-pointer font-bold">履歴</summary><ul className="mt-1 space-y-1">{detail.events.map((event, index) => <li key={index} className="text-muted">{event.occurredAtUtc.slice(0, 16).replace("T", " ")} {event.eventType} {event.fromStatus ?? ""}{event.toStatus ? ` → ${event.toStatus}` : ""} · {event.actor}{event.note ? ` · ${event.note}` : ""}</li>)}</ul></details> : null}
      </div> : null}
      {message ? <p role="status" className="mt-3 text-sm font-bold text-warn">{message}</p> : null}
    </div>
  </details>;
}
