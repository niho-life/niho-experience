"use client";

import { useState } from "react";
import { adminBookingActions, type AdminOperation } from "@/admin/bookings";
import type { AdminBooking, AdminBookingAction } from "@/admin/types";
import { bookingRequestRows, bookingStateRows, bookingStatusLabel, bookingWhen, shortDateTime } from "@/host/bookings";
import { yen } from "@/host/format";
import { consoleButtonClass, HOST_SURFACE } from "@/components/host/host-ui";
import { StatusPill } from "@/components/host/ui";
import { AdminActionDialog } from "./AdminActionDialog";

function Rows({ booking }: { booking: AdminBooking }) {
  const rows = [...bookingRequestRows(booking, booking.experienceTitle), ...bookingStateRows(booking)];
  return <dl>{rows.map((row) => <div key={row.label} className="grid grid-cols-[82px_minmax(0,1fr)] gap-2 border-t border-line py-2 text-[0.8125rem] first:border-t-0"><dt className="font-bold text-muted">{row.label}</dt><dd className="min-w-0 [overflow-wrap:anywhere]">{"answers" in row ? row.answers.map((a) => `${a.question}: ${a.answer}`).join(" / ") : row.value}</dd></div>)}</dl>;
}

function Heading({ children }: { children: string }) {
  return <h3 className="mb-2 font-sans text-xs font-extrabold tracking-[0.04em] text-ink-soft">{children}</h3>;
}

export function AdminBookingDetail({ booking, today, notice, busy, onOperation }: { booking: AdminBooking; today: string; notice: string; busy: boolean; onOperation: (operation: AdminOperation) => Promise<boolean> }) {
  const [asking, setAsking] = useState<AdminBookingAction | null>(null);
  const actions = adminBookingActions(booking);
  const run = async (operation: AdminOperation) => { if (await onOperation(operation)) setAsking(null); };
  return (
    <article aria-labelledby="admin-booking-detail-title" className={`${HOST_SURFACE} min-w-0 p-4 md:px-5 md:py-[18px]`}>
      <div className="flex flex-wrap items-start justify-between gap-2.5">
        <div className="min-w-0"><p className="text-xs font-extrabold text-muted">{booking.bookingNumber}</p><h2 id="admin-booking-detail-title" tabIndex={-1} className="font-sans text-[1.125rem] font-extrabold tracking-normal focus:outline-none">{booking.guest}</h2><p className="mt-0.5 text-[0.78125rem] text-muted">{bookingWhen(booking)}</p></div>
        <StatusPill status={bookingStatusLabel(booking, today)} />
      </div>
      {notice ? <p role={notice.includes("できません") ? "alert" : "status"} className="mt-3 rounded-xl bg-leaf-pale px-3 py-2 text-[0.8125rem] font-bold text-moss">{notice}</p> : null}

      <section className="mt-4 border-t border-line pt-4"><Heading>支援条件</Heading>
        <div className="flex flex-wrap items-center gap-2"><span className={`rounded-full px-2.5 py-1 text-xs font-extrabold ${booking.support.enabled ? "bg-leaf-pale text-moss" : "bg-sand text-ink-soft"}`}>サポート{booking.support.enabled ? "ON" : "OFF"}</span><span className="text-[0.8125rem]">手数料 {booking.support.feePercent}%（受付時）</span><span className="text-xs text-muted">受付 {shortDateTime(booking.support.acceptedAt)}</span></div>
        <p className="mt-2 text-[0.8125rem] text-ink-soft">{booking.support.enabled ? "事務局への共有と通常の支援操作を許可済み。具体的な支援内容はホストと相談して決めます。" : "運営上の全体確認はできますが、日常の代行操作は行いません。"}</p>
        <p className="mt-1 text-xs text-muted">支援担当者の人件費は、ホストから担当者へ別途直接支払います。</p>
      </section>
      <section className="mt-4 border-t border-line pt-4"><Heading>要対応</Heading><p className={booking.needsAttention ? "font-extrabold text-warn" : "text-ink-soft"}>{booking.needsAttention ? booking.attentionReason : "現在、要対応ではありません"}</p></section>
      <section className="mt-4 border-t border-line pt-4"><Heading>相談内容</Heading><p className="whitespace-pre-wrap text-[0.8125rem]">{booking.consultation || "相談はありません。"}</p><dl className="mt-2 grid grid-cols-[82px_minmax(0,1fr)] gap-2 text-[0.8125rem]"><dt className="font-bold text-muted">担当</dt><dd>{booking.assignee ?? "未割当"}</dd><dt className="font-bold text-muted">運営メモ</dt><dd>{booking.adminNotes || "なし"}</dd></dl></section>
      <section className="mt-4 border-t border-line pt-4"><Heading>予約内容・状態</Heading><Rows booking={booking} /></section>
      <section className="mt-4 border-t border-line pt-4"><Heading>連絡</Heading><div className="grid gap-1 text-[0.8125rem]"><p>ホスト: {booking.hostContact}</p><p>予約者: {booking.guestContact}</p></div></section>
      <section className="mt-4 border-t border-line pt-4"><Heading>操作</Heading>
        {booking.support.operationsAllowed ? <div className="flex flex-wrap gap-2">{actions.approve ? <button type="button" onClick={() => setAsking("approve")} className={consoleButtonClass("primary")}>承認する</button> : null}{actions.decline ? <button type="button" onClick={() => setAsking("decline")} className={consoleButtonClass("secondary")}>辞退する</button> : null}{actions.contact ? <button type="button" onClick={() => setAsking("contact")} className={consoleButtonClass("secondary")}>連絡を記録</button> : null}{actions.cancel ? <button type="button" onClick={() => setAsking("cancel")} className="inline-flex h-[38px] items-center rounded-full border border-danger px-4 text-[0.84375rem] font-extrabold text-danger hover:bg-danger-pale">取消・返金</button> : null}</div> : <p className="rounded-xl bg-sand px-3 py-2 text-[0.8125rem] text-ink-soft">サポートOFFで受け付けたため、閲覧だけができます。代行が必要な場合はホストと相談し、予約条件を変えず個別に対応してください。</p>}
      </section>
      <section className="mt-4 border-t border-line pt-4"><Heading>Admin本人の対応履歴</Heading>{booking.adminHistory.length ? <ol>{booking.adminHistory.map((event, index) => <li key={`${event.at}-${index}`} className="grid grid-cols-[78px_minmax(0,1fr)] gap-2 py-1.5 text-[0.78125rem]"><time className="text-muted">{shortDateTime(event.at)}</time><span><strong>{event.actorName}</strong><span className="block text-ink-soft">{event.detail}</span></span></li>)}</ol> : <p className="text-[0.8125rem] text-muted">対応履歴はありません。</p>}</section>
      <p className="mt-4 text-xs text-muted">合計 {yen(booking.amountYen)} · プレビュー（合成データ）</p>
      {asking ? <AdminActionDialog booking={booking} action={asking} busy={busy} onConfirm={run} onClose={() => setAsking(null)} /> : null}
    </article>
  );
}

