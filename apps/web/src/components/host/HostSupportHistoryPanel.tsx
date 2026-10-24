"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { decodeExperienceHostSupportHistoryDetailResponse, decodeExperienceHostSupportHistoryResponse, type ExperienceHostSupportHistoryDetail, type ExperienceHostSupportHistoryItem, type ExperienceHostSupportHistoryResponse } from "@niho-experience/api-client/host-support-history";
import { adminDateTime } from "@/admin/date-time";
import { yen } from "@/host/format";
import { hostFetch } from "@/lib/host/client-session";

const ACTION: Record<ExperienceHostSupportHistoryItem["action"], string> = { APPROVE: "承認", DECLINE: "辞退", CANCEL: "取消・返金", MESSAGE: "予約者への連絡" };
const STATE: Record<ExperienceHostSupportHistoryItem["state"], string> = { ACCEPTED: "受付済み", PROCESSING: "処理中", UNKNOWN: "結果確認中", SUCCEEDED: "完了", REJECTED: "受付不可", FAILED: "失敗" };
const DELIVERY: Record<string, string> = { PENDING: "送信処理中", SENT: "メール送信済み", FAILED: "送信できませんでした", UNKNOWN: "送信結果確認中" };

export function HostSupportHistoryPanel({ bookingId, enabled }: { bookingId: string; enabled: boolean }) {
  const [history, setHistory] = useState<ExperienceHostSupportHistoryResponse | null>(null);
  const [detail, setDetail] = useState<ExperienceHostSupportHistoryDetail | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error" | "missing">("loading");
  const generation = useRef(0);
  const bookingRef = useRef(bookingId);
  const listSequence = useRef(0);
  const detailSequence = useRef(0);
  const detailController = useRef<AbortController | null>(null);
  const invalidate = useCallback((expectedGeneration: number) => {
    if (generation.current === expectedGeneration) ++generation.current;
    ++detailSequence.current; detailController.current?.abort();
  }, []);
  useEffect(() => {
    bookingRef.current = bookingId; const currentGeneration = ++generation.current; ++detailSequence.current; detailController.current?.abort();
    if (!enabled) { ++listSequence.current; return; }
    const current = ++listSequence.current; const controller = new AbortController();
    void Promise.resolve().then(async () => {
      if (currentGeneration !== generation.current || current !== listSequence.current || controller.signal.aborted || bookingRef.current !== bookingId) return;
      setState("loading"); setHistory(null); setDetail(null);
      return hostFetch(`bookings/${encodeURIComponent(bookingId)}/support-history`, { signal: controller.signal });
    }).then(async (response) => {
      if (!response) return;
      if (currentGeneration !== generation.current || current !== listSequence.current || controller.signal.aborted || bookingRef.current !== bookingId) return;
      let value: unknown; try { value = await response.json() as unknown; } catch { if (currentGeneration === generation.current && current === listSequence.current && !controller.signal.aborted) setState("error"); return; }
      if (currentGeneration !== generation.current || current !== listSequence.current || controller.signal.aborted || bookingRef.current !== bookingId) return;
      if (response.status === 404) { setState("missing"); return; }
      const decoded = decodeExperienceHostSupportHistoryResponse(value);
      if (!response.ok || !decoded || decoded.bookingRequestId !== bookingId) { setState("error"); return; }
      setHistory(decoded); setState("ready");
    }).catch(() => { if (currentGeneration === generation.current && current === listSequence.current && !controller.signal.aborted) setState("error"); });
    return () => { controller.abort(); invalidate(currentGeneration); };
  }, [bookingId, enabled, invalidate]);

  const open = async (item: ExperienceHostSupportHistoryItem) => {
    const currentGeneration = generation.current; const expectedBooking = bookingId; const current = ++detailSequence.current;
    setDetail(null); setState("ready");
    detailController.current?.abort(); const controller = new AbortController(); detailController.current = controller;
    try {
      const response = await hostFetch(`bookings/${encodeURIComponent(expectedBooking)}/support-history/${item.operationId}`, { signal: controller.signal });
      if (currentGeneration !== generation.current || current !== detailSequence.current || controller.signal.aborted || bookingRef.current !== expectedBooking) return;
      const value = await response.json() as unknown;
      if (currentGeneration !== generation.current || current !== detailSequence.current || controller.signal.aborted || bookingRef.current !== expectedBooking) return;
      const decoded = decodeExperienceHostSupportHistoryDetailResponse(value);
      if (response.ok && decoded && decoded.operation.bookingRequestId === expectedBooking && decoded.operation.operationId === item.operationId) setDetail(decoded.operation);
      else setState("error");
    } catch { if (currentGeneration === generation.current && current === detailSequence.current && !controller.signal.aborted && bookingRef.current === expectedBooking) setState("error"); }
  };

  if (!enabled || state === "missing") return <section aria-labelledby="booking-support-history-heading" className="mt-3.5 border-t border-line pt-3.5"><h3 id="booking-support-history-heading" className="mb-2 font-sans text-xs font-extrabold tracking-[0.04em] text-ink-soft">NIHO事務局の支援履歴</h3><p className="text-[0.8125rem] text-ink-soft">支援履歴は準備中です。合成履歴を実績として表示しません。</p></section>;
  return <section aria-labelledby="booking-support-history-heading" className="mt-3.5 border-t border-line pt-3.5"><div className="flex items-center justify-between gap-2"><h3 id="booking-support-history-heading" className="font-sans text-xs font-extrabold tracking-[0.04em] text-ink-soft">NIHO事務局の支援履歴</h3>{history?.history.truncated ? <span className="text-xs text-muted">以前の履歴あり</span> : null}</div>
    {state === "loading" ? <p role="status" className="mt-2 text-[0.8125rem] text-muted">履歴を確認しています…</p> : null}
    {state === "error" ? <p role="alert" className="mt-2 text-[0.8125rem] font-bold text-danger">履歴を読み込めませんでした。予約内容はそのまま表示しています。</p> : null}
    {history && history.operations.length === 0 ? <p className="mt-2 text-[0.8125rem] text-muted">NIHO事務局による保存済みの対応履歴はありません。</p> : null}
    {history?.operations.length ? <ol className="mt-2 divide-y divide-line">{history.operations.map((item) => <li key={item.operationId}><button type="button" onClick={() => void open(item)} className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-2 py-2 text-left text-[0.8125rem]"><span><strong>{ACTION[item.action]}</strong><span className="block text-xs text-muted">NIHO事務局 · {adminDateTime(item.createdAt)}</span></span><span className="text-xs font-extrabold">{STATE[item.state]}</span></button></li>)}</ol> : null}
    {detail ? <div className="mt-2 rounded-xl bg-sand/55 p-3 text-[0.8125rem]"><p className="font-extrabold">{ACTION[detail.action]} · {STATE[detail.state]}</p>{detail.resultRefundedYen !== null ? <p className="mt-1">返金後累計 {yen(detail.resultRefundedYen)}</p> : null}{detail.communication === null ? null : !detail.communication.retained ? <p className="mt-2 text-xs text-muted">連絡本文の保持期間は終了しました。</p> : <><p className="mt-2 font-bold">{detail.communication.subject ?? "件名の記録なし"}</p><p className="mt-1 whitespace-pre-wrap">{detail.communication.body ?? "本文の記録なし"}</p><p className="mt-1 text-xs text-muted">{detail.communication.deliveryStatus ? (DELIVERY[detail.communication.deliveryStatus] ?? detail.communication.deliveryStatus) : "配信状態の記録なし"}</p></>}</div> : null}
  </section>;
}
