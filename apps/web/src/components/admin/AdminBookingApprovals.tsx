"use client";

import { useState } from "react";
import type { ManagedBookingApprovalRequest } from "@niho-experience/experience-store";

const API = "/admin/api/booking-approvals";
const BUTTON = "min-h-10 rounded-full border border-line-strong px-4 font-extrabold hover:bg-sand disabled:opacity-50";
const DANGER = "min-h-10 rounded-full border border-danger/40 px-4 font-extrabold text-danger hover:bg-danger-pale disabled:opacity-50";
const yen = (amount: number) => `¥${amount.toLocaleString("ja-JP")}`;
const jst = (utc: string) => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "short", timeStyle: "short" }).format(new Date(utc));

export function AdminBookingApprovals({ initial }: { initial: readonly ManagedBookingApprovalRequest[] }) {
  const [requests, setRequests] = useState([...initial]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [paymentUrls, setPaymentUrls] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");

  async function refresh() {
    const response = await fetch(API, { cache: "no-store", credentials: "same-origin" });
    const body = await response.json().catch(() => null) as { requests?: ManagedBookingApprovalRequest[] } | null;
    if (!response.ok || !Array.isArray(body?.requests)) throw new Error("refresh");
    setRequests(body.requests);
  }

  async function decide(publicBookingId: string, action: "APPROVE" | "DECLINE") {
    if (busy || (action === "DECLINE" && !window.confirm("この申込を辞退し、確保中の在庫をすぐ戻しますか？"))) return;
    setBusy(publicBookingId); setError(""); setNotice("");
    try {
      const response = await fetch(API, {
        method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, publicBookingId }),
      });
      const body = await response.json().catch(() => null) as { paymentUrl?: string | null; checkoutCompleted?: boolean; error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? String(response.status));
      if (action === "APPROVE") {
        if (typeof body?.paymentUrl === "string") {
          setPaymentUrls((current) => ({ ...current, [publicBookingId]: body.paymentUrl! }));
          setNotice("承認しました。下の支払URLを予約者への返信にコピーしてください。自動送信はしていません。");
        } else if (body?.checkoutCompleted) setNotice("予約者はStripeの手続きを完了しました。支払結果はStripeからの通知で確認します。");
        else throw new Error("missing_url");
      } else {
        setPaymentUrls((current) => { const next = { ...current }; delete next[publicBookingId]; return next; });
        setNotice("辞退を記録し、在庫を戻しました。予約者への連絡は手動で行ってください。");
      }
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error && reason.message === "conflict"
        ? "他の担当者が対応済みか、決済に必要な時間が残っていないか、販売条件が変わりました。一覧を読み直してください。"
        : "操作を完了できませんでした。状態を読み直して、同じ承認操作を再試行できます。");
      try { await refresh(); } catch { /* Keep the last private snapshot visible. */ }
    } finally { setBusy(null); }
  }

  async function copy(url: string) {
    try { await navigator.clipboard.writeText(url); setNotice("支払URLをコピーしました。有効期限とともに予約者へ手動で案内してください。"); }
    catch { setError("自動コピーに失敗しました。URL欄を選択してコピーしてください。"); }
  }

  return <section className="mt-8 rounded-2xl border border-line bg-white p-4 md:p-5" aria-labelledby="booking-approvals-heading">
    <h2 id="booking-approvals-heading" className="font-display text-xl font-medium">承認後に決済する申込</h2>
    <p className="mt-1 text-sm text-ink-soft">申込時点ではカード情報も決済もありません。承認すると、この画面だけに有効期限付きStripe支払URLを表示します。予約者への送付は事務局が手動で行います。</p>
    {error ? <p role="alert" className="mt-3 rounded-xl bg-danger-pale p-3 text-sm text-danger">{error}</p> : null}
    {notice ? <p role="status" className="mt-3 rounded-xl bg-leaf-pale p-3 text-sm text-moss">{notice}</p> : null}
    {requests.length === 0 ? <p className="mt-4 text-sm text-muted">対応中の申込はありません。</p> : <ul className="mt-4 space-y-3">
      {requests.map((request) => {
        const url = paymentUrls[request.publicBookingId];
        return <li key={request.publicBookingId} className="rounded-xl border border-line bg-canvas p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-extrabold">{request.experienceTitle}</p>
              <p className="text-sm text-ink-soft">{request.localDate} {request.localStartTime} · 大人{request.adultCount}人{request.childCount ? `・子ども${request.childCount}人` : ""} · {yen(request.totalAmount)}</p>
              <p className="mt-1 text-sm">{request.guestName ?? "（連絡先消去済み）"} · <span className="break-all">{request.guestEmail ?? "メールなし"}</span>{request.guestPhone ? ` · ${request.guestPhone}` : ""}</p>
              <p className="mt-1 text-xs text-muted">申込 {jst(request.createdAtUtc)} · 支払期限上限 {jst(request.holdExpiresAtUtc)} · 予約番号 {request.publicBookingId}</p>
              {!request.holdActive ? <p className="mt-1 text-sm font-bold text-danger">在庫確保の期限が切れています。承認できません。</p> : null}
            </div>
            <span className="rounded-full bg-sand px-2.5 py-1 text-xs font-extrabold">{request.status === "PENDING" ? "判断待ち" : "承認済み・支払待ち"}</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={BUTTON} disabled={!request.holdActive || busy !== null} onClick={() => void decide(request.publicBookingId, "APPROVE")}>{busy === request.publicBookingId ? "処理中…" : request.status === "APPROVED" ? "支払URLを再表示" : "承認して支払URLを作る"}</button>
            {request.status === "PENDING" ? <button type="button" className={DANGER} disabled={busy !== null} onClick={() => void decide(request.publicBookingId, "DECLINE")}>辞退して在庫を戻す</button> : null}
          </div>
          {url ? <div className="mt-3 rounded-xl border border-line bg-white p-3"><label className="text-xs font-extrabold text-ink-soft">予約者へ手動送付するStripe支払URL<input readOnly value={url} onFocus={(event) => event.currentTarget.select()} className="mt-1 block w-full rounded-lg border border-line-strong px-3 py-2 font-mono text-xs" /></label><button type="button" className={`${BUTTON} mt-2`} onClick={() => void copy(url)}>URLをコピー</button></div> : null}
        </li>;
      })}
    </ul>}
  </section>;
}
