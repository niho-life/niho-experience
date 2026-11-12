"use client";

import { useRef, useState } from "react";
import type { ManagedBookingApprovalPage } from "@niho-experience/experience-store";
import { DANGER_BUTTON } from "@/components/host/HostBookingDialogs";
import { HostConfirmDialog } from "@/components/host/HostConfirmDialog";
import { INPUT } from "@/components/host/fields";
import { HOST_SURFACE, LIST_ROW, LIST_ROW_DETAIL, LIST_ROW_TITLE, consoleButtonClass } from "@/components/host/host-ui";
import { StatusPill } from "@/components/host/ui";
import { useTodoSlotCount } from "./admin-todo-slot";

const API = "/admin/api/booking-approvals";
const BUTTON = `${consoleButtonClass("secondary", "sm")} disabled:opacity-50`;
const PRIMARY = `${consoleButtonClass("primary", "sm")} disabled:opacity-50`;
const DANGER = "inline-flex h-[30px] shrink-0 items-center justify-center whitespace-nowrap rounded-full border border-line-strong bg-canvas px-3 text-[0.78125rem] leading-none font-extrabold text-danger hover:bg-danger-pale disabled:opacity-50";
const yen = (amount: number) => `¥${amount.toLocaleString("ja-JP")}`;
const jst = (utc: string) => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "short", timeStyle: "short" }).format(new Date(utc));

export function AdminBookingApprovals({ initial }: { initial: ManagedBookingApprovalPage }) {
  const [{ requests, page, hasNext }, setPage] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [paymentUrls, setPaymentUrls] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [declining, setDeclining] = useState<(typeof initial.requests)[number] | null>(null);
  // The 予約 page counts these in 要対応 (admin-todo-slot.tsx).
  useTodoSlotCount("approvals", requests.length);
  const stayRef = useRef<HTMLButtonElement>(null);

  async function refresh(target: number) {
    const response = await fetch(`${API}?page=${target}`, { cache: "no-store", credentials: "same-origin" });
    const body = await response.json().catch(() => null) as ManagedBookingApprovalPage | null;
    if (!response.ok || !Array.isArray(body?.requests) || body.page !== target || typeof body.hasNext !== "boolean") throw new Error("refresh");
    setPage(body);
  }

  async function navigate(target: number) {
    if (loading || busy) return;
    setLoading(true); setError(""); setNotice("");
    try { await refresh(target); }
    catch { setError("申込一覧のページを読み込めませんでした。もう一度お試しください。"); }
    finally { setLoading(false); }
  }

  async function decide(publicBookingId: string, action: "APPROVE" | "DECLINE") {
    if (busy || loading) return;
    setBusy(publicBookingId); setError(""); setNotice("");
    try {
      const response = await fetch(API, {
        method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, publicBookingId }),
      });
      const body = await response.json().catch(() => null) as { paymentUrl?: string | null; checkoutCompleted?: boolean; paymentEmailQueued?: boolean; guestEmailQueued?: boolean; error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? String(response.status));
      if (action === "APPROVE") {
        if (typeof body?.paymentUrl === "string") {
          setPaymentUrls((current) => ({ ...current, [publicBookingId]: body.paymentUrl! }));
          setNotice(body.paymentEmailQueued ? "承認しました。予約者への支払メールを送信待ちに登録しました。下のURLは問い合わせ時の確認・コピー用です。" : "承認しました。下の支払URLを確認してください。");
        } else if (body?.checkoutCompleted) setNotice("予約者はStripeの手続きを完了しました。支払結果はStripeからの通知で確認します。");
        else throw new Error("missing_url");
      } else {
        setPaymentUrls((current) => { const next = { ...current }; delete next[publicBookingId]; return next; });
        setNotice(body?.guestEmailQueued ? "辞退を記録して在庫を戻し、予約者への辞退メールを送信待ちに登録しました。" : "辞退を記録し、在庫を戻しました。");
      }
      await refresh(page);
    } catch (reason) {
      setError(reason instanceof Error && reason.message === "conflict"
        ? "他の担当者が対応済みか、決済に必要な時間が残っていないか、販売条件が変わりました。一覧を読み直してください。"
        : "操作を完了できませんでした。状態を読み直して、同じ承認操作を再試行できます。");
      try { await refresh(page); } catch { /* Keep the last private snapshot visible. */ }
    } finally { setBusy(null); }
  }

  async function copy(url: string) {
    try { await navigator.clipboard.writeText(url); setNotice("問い合わせ対応用の支払URLをコピーしました。"); }
    catch { setError("自動コピーに失敗しました。URL欄を選択してコピーしてください。"); }
  }

  if (requests.length === 0 && !error && !notice && page === 1 && !hasNext) return null;
  return <section className={HOST_SURFACE} aria-label="承認後に決済する申込">
    {error ? <p role="alert" className="border-b border-line bg-danger-pale px-4 py-3 text-sm text-danger">{error}</p> : null}
    {notice ? <p role="status" className="border-b border-line bg-leaf-pale px-4 py-3 text-sm text-moss">{notice}</p> : null}
    {requests.length === 0 ? <p className="px-4 py-3 text-sm text-muted">対応中の申込はありません。</p> : <ul className="divide-y divide-line">
      {requests.map((request) => {
        const url = paymentUrls[request.publicBookingId];
        return <li key={request.publicBookingId} className={`${LIST_ROW} flex-wrap items-start`}>
          <span className="w-24 shrink-0"><StatusPill status={request.status === "PENDING" ? { label: "承認待ち", tone: "wait" } : { label: "支払待ち", tone: "wait" }} /></span>
          <div className="min-w-0 flex-1 basis-56">
            <p className={LIST_ROW_TITLE}>{request.experienceTitle}</p>
            <p className={LIST_ROW_DETAIL}>{request.localDate} {request.localStartTime} · 大人{request.adultCount}人{request.childCount ? `・子ども${request.childCount}人` : ""} · {yen(request.totalAmount)}</p>
            <p className={LIST_ROW_DETAIL}>{request.guestName ?? "（連絡先消去済み）"} · <span className="break-all">{request.guestEmail ?? "メールなし"}</span>{request.guestPhone ? ` · ${request.guestPhone}` : ""}</p>
            <p className={LIST_ROW_DETAIL}>申込 {jst(request.createdAtUtc)} · 支払期限上限 {jst(request.holdExpiresAtUtc)} · 予約番号 {request.publicBookingId}</p>
            {!request.holdActive ? <p className="text-[0.78125rem] font-bold text-danger">在庫確保の期限が切れています。承認できません。</p> : null}
            {url ? <div className="mt-2"><label className="text-xs font-extrabold text-ink-soft">問い合わせ対応用のStripe支払URL（予約者へは自動メール）<input readOnly value={url} onFocus={(event) => event.currentTarget.select()} className={`${INPUT} mt-1 font-mono`} /></label><button type="button" className={`${BUTTON} mt-2`} onClick={() => void copy(url)}>予備URLをコピー</button></div> : null}
          </div>
          <div className="ml-auto flex shrink-0 flex-wrap justify-end gap-2">
            {request.status === "PENDING" ? <button type="button" className={DANGER} disabled={busy !== null || loading} onClick={() => setDeclining(request)}>辞退</button> : null}
            <button type="button" className={PRIMARY} disabled={!request.holdActive || busy !== null || loading} onClick={() => void decide(request.publicBookingId, "APPROVE")}>{busy === request.publicBookingId ? "処理中…" : request.status === "APPROVED" ? "支払メールを再確認" : "承認"}</button>
          </div>
        </li>;
      })}
    </ul>}
    {page > 1 || hasNext ? <nav aria-label="予約リクエスト一覧のページ" className="flex items-center gap-3 border-t border-line px-4 py-3 text-sm">
      <button type="button" className={BUTTON} disabled={page === 1 || loading || busy !== null} onClick={() => void navigate(page - 1)}>前へ</button>
      <span>{page}ページ</span>
      <button type="button" className={BUTTON} disabled={!hasNext || loading || busy !== null} onClick={() => void navigate(page + 1)}>次へ</button>
    </nav> : null}
    {declining ? <HostConfirmDialog
      title="申込を辞退しますか？"
      description={`${declining.experienceTitle} · ${declining.guestName ?? "（連絡先消去済み）"}`}
      focusRef={stayRef}
      stayRef={stayRef}
      confirm={<button type="submit" className={DANGER_BUTTON}>辞退する</button>}
      onConfirm={() => void decide(declining.publicBookingId, "DECLINE")}
      onClose={() => setDeclining(null)}
    >
      <p className="mt-2 text-ink-soft">確保中の在庫をすぐ戻します。</p>
    </HostConfirmDialog> : null}
  </section>;
}
