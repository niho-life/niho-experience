"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { cancelConfirmLabel, refundChoicesFor, refundNowYen } from "@/host/bookings";
import { yen } from "@/host/format";
import type { HostCancelReason, HostRefundChoice } from "@/host/types";
import type { AdminBooking, AdminBookingAction } from "@/admin/types";
import type { AdminOperation } from "@/admin/bookings";
import { adminCancellationMessage } from "@/admin/bookings";
import { HOST_DIALOG } from "@/components/host/HostConfirmDialog";
import { consoleButtonClass } from "@/components/host/host-ui";

const LABELS: Record<AdminBookingAction, { title: string; submit: string }> = {
  approve: { title: "予約を承認しますか？", submit: "予約を承認する" },
  decline: { title: "申込を辞退しますか？", submit: "申込を辞退する" },
  contact: { title: "連絡内容を記録しますか？", submit: "対応履歴へ追加する" },
  cancel: { title: "予約を取り消しますか？", submit: "予約を取り消す" },
};

export function AdminActionDialog({ booking, action, busy, onConfirm, onClose }: { booking: AdminBooking; action: AdminBookingAction; busy: boolean; onConfirm: (operation: AdminOperation) => void; onClose: () => void }) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [reason, setReason] = useState("");
  const [refund, setRefund] = useState<HostRefundChoice>(booking.status === "refund_needed" ? "full" : "full");
  const [cancelReason, setCancelReason] = useState<HostCancelReason>(booking.status === "refund_needed" ? "guest" : "host");
  const refundChoices = refundChoicesFor(booking.status);
  const refundYen = refundNowYen(booking, refund);

  useEffect(() => {
    dialog.current?.showModal();
    cancel.current?.focus();
  }, []);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !event.currentTarget.reportValidity()) return;
    const operation: AdminOperation = action === "cancel"
      ? { action, reason, cancellation: { refund, reason: cancelReason, message: adminCancellationMessage(booking, cancelReason) } }
      : { action, reason };
    onConfirm(operation);
  };

  const amount = action === "approve" ? `${yen(booking.amountYen)} を決済` : action === "cancel" ? (refundYen ? `${yen(refundYen)} を返金` : "返金なし") : "金銭の変更なし";
  return (
    <dialog ref={dialog} aria-labelledby={`${id}-title`} onCancel={(event) => { if (busy) event.preventDefault(); }} onClose={onClose} className={HOST_DIALOG}>
      <form onSubmit={submit} className="flex max-h-[calc(100dvh-2rem)] flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-4 md:px-5 md:pt-5">
          <h2 id={`${id}-title`} className="font-sans text-[0.9375rem] font-extrabold tracking-normal">{LABELS[action].title}</h2>
          <dl className="mt-3 grid grid-cols-[72px_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-[0.8125rem]">
            <dt className="font-bold text-muted">相手</dt><dd>{booking.guest}／{booking.hostName}</dd>
            <dt className="font-bold text-muted">予約</dt><dd>{booking.bookingNumber}</dd>
            <dt className="font-bold text-muted">金額</dt><dd>{amount}</dd>
          </dl>
          {action === "cancel" ? (
            <div className="mt-4 space-y-3 rounded-xl bg-sand p-3">
              <fieldset>
                <legend className="text-xs font-extrabold text-ink-soft">返金</legend>
                <div className="mt-1 flex flex-wrap gap-3">
                  {refundChoices.map((choice) => (
                    <label key={choice} className="inline-flex min-h-7 items-center gap-1.5"><input type="radio" name={`${id}-refund`} checked={refund === choice} onChange={() => setRefund(choice)} />{choice === "full" ? "全額" : choice === "half" ? "半額" : "返金なし"}</label>
                  ))}
                </div>
              </fieldset>
              <label className="block text-xs font-extrabold text-ink-soft">取消理由
                <select value={cancelReason} onChange={(event) => setCancelReason(event.currentTarget.value as HostCancelReason)} className="mt-1 block min-h-10 w-full rounded-[10px] border border-line-strong bg-canvas px-3 text-base md:text-sm">
                  <option value="host">運営者の都合</option><option value="guest">旅行者からの依頼</option><option value="other">その他</option>
                </select>
              </label>
            </div>
          ) : null}
          <label htmlFor={`${id}-reason`} className="mt-4 block text-xs font-extrabold text-ink-soft">対応理由
            <textarea id={`${id}-reason`} required maxLength={2000} rows={3} value={reason} onChange={(event) => setReason(event.currentTarget.value)} placeholder={action === "contact" ? "連絡する内容と目的" : "確認した条件や判断理由"} className="mt-1 block min-h-24 w-full resize-y rounded-[10px] border border-line-strong bg-canvas px-3 py-2 text-base font-normal text-ink md:text-sm" />
          </label>
          <p className="mt-2 text-xs text-muted">このプレビューでは外部への連絡・決済・返金は行わず、画面上の状態と対応履歴だけを更新します。</p>
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3 md:px-5">
          <button ref={cancel} type="button" disabled={busy} onClick={() => dialog.current?.close()} className={consoleButtonClass("secondary")}>やめる</button>
          <button type="submit" disabled={busy} className={consoleButtonClass(action === "cancel" || action === "decline" ? "secondary" : "primary")}>{busy ? "処理しています…" : action === "cancel" ? cancelConfirmLabel(refundYen) : LABELS[action].submit}</button>
        </div>
      </form>
    </dialog>
  );
}

