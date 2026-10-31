"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { yen } from "@/host/format";
import { japanTime, NIHO_CHANNEL_LABELS, NIHO_STATUS_LABELS, nihoLabel } from "@/host/niho-bookings";
import { HostLeaveDialog, useHostLeaveGuard, type HostLeaveMode } from "./HostLeaveGuard";
import { HostNihoBookingDetail, type NihoDetailLock, type NihoReplyDraft } from "./HostNihoBookingDetail";
import { consoleButtonClass, HOST_SURFACE } from "./host-ui";
import { HostPageBody, PageHead } from "./ui";
import { useNihoBookingList } from "./use-niho-bookings";

export interface HostLiveBookingsProps {
  providerId: string;
  initialBookingId?: string | null;
  mode?: "bookings" | "messages";
  /** 通訳を始める (#181) with the day in Japan it counts from; null while the translate BFF is closed. */
  translate?: { today: string } | null;
  /** The way to the bookings made on this site (#285 slice 8) or to their messages (slice 6b), under the title; null when there are none. */
  siteNotice?: ReactNode;
}

/**
 * NIHO's bookings while they are the screen's own (provider operations, #87/#90): 予約 for anyone but the OWNER of
 * bookings made on this site (their 予約 is one list of both, HostBookings, #84), and メッセージ. The list, and one
 * booking (HostNihoBookingDetail) beside it from lg; below lg one of them at a time.
 */
export function HostLiveBookings({ providerId, initialBookingId, mode = "bookings", translate = null, siteNotice = null }: HostLiveBookingsProps) {
  const [selected, setSelected] = useState(initialBookingId ?? null);
  const [drafts, setDrafts] = useState<Readonly<Record<string, NihoReplyDraft>>>({});
  const [lock, setLock] = useState<NihoDetailLock>({ acting: false, uncertain: false });
  // NIHO ended the session or the permission: the booking shown goes with the list.
  const dropSelection = useCallback(() => { setSelected(null); setLock({ acting: false, uncertain: false }); }, []);
  const { items, cursor, state: listState, busy: listBusy, error, load: loadList, revoke } = useNihoBookingList(providerId, { onRevoke: dropSelection });
  const errorRef = useRef<HTMLParagraphElement>(null);
  const locked = lock.acting || lock.uncertain;
  const hasReplyDraft = useMemo(() => Object.values(drafts).some((value) => value.subject.trim() || value.body.trim()), [drafts]);
  const leaveMode: HostLeaveMode = lock.acting ? "saving" : lock.uncertain ? "unknown" : hasReplyDraft ? "dirty" : null;
  const leaveGuard = useHostLeaveGuard(leaveMode);

  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);

  function chooseBooking(bookingId: string | null) {
    if (locked) return;
    setSelected(bookingId);
    const url = new URL(window.location.href);
    if (bookingId) url.searchParams.set("booking", bookingId); else url.searchParams.delete("booking");
    url.searchParams.delete("thread");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  const reloadList = useCallback(() => { void loadList(); }, [loadList]);
  const revoked = listState === "revoked";

  return <HostPageBody><PageHead title={mode === "messages" ? "メッセージ" : "予約"} />
    {siteNotice}
    {mode === "messages" ? <div className="mb-3.5 rounded-xl bg-sand p-3 text-sm text-ink-soft"><p>予約後のWeb返信と、あなたが送ったメールを予約ごとに表示します。</p><p className="mt-1">予約前の質問・予約者からのメール返信の取り込み・自動翻訳は、まだ利用できません。</p></div> : null}
    {error ? <p ref={errorRef} tabIndex={-1} role="alert" className="mb-3 rounded-xl bg-danger-pale p-4 text-danger focus:outline-none">{error}</p> : null}
    {revoked ? <button type="button" onClick={() => window.location.reload()} className={consoleButtonClass("secondary")}>ページを再読み込み</button> : null}
    {!revoked ? <div className="grid min-w-0 gap-3.5 lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start">
      <section className={`${HOST_SURFACE} min-w-0 ${selected ? "max-lg:hidden" : ""}`} aria-label={mode === "messages" ? "予約ごとの会話一覧" : "予約一覧"}>
        {listState === "loading" ? <p role="status" className="p-5 text-ink-soft">読み込み中…</p> : null}
        {listState === "error" ? <div className="p-5"><p className="text-ink-soft">予約一覧を表示できません。</p><button type="button" disabled={listBusy} onClick={() => void loadList()} className={`${consoleButtonClass("secondary", "sm")} mt-2`}>もう一度読み込む</button></div> : null}
        {listState === "empty" ? <p className="p-5 text-ink-soft">{mode === "messages" ? "予約後の会話はありません。" : "予約はありません。"}</p> : null}
        {listState === "ready" ? <ul>{items.map((booking) => <li key={booking.id} className="border-t border-line first:border-t-0"><button type="button" disabled={locked} onClick={() => chooseBooking(booking.id)} className={`w-full px-4 py-3 text-left hover:bg-sand focus-visible:outline-3 focus-visible:outline-offset-[-3px] focus-visible:outline-moss disabled:cursor-not-allowed disabled:opacity-60 ${selected === booking.id ? "bg-sand" : ""}`}><span className="block font-extrabold [overflow-wrap:anywhere]">{booking.pageTitle}</span><span className="block text-sm [overflow-wrap:anywhere]">{booking.occurrenceDate} {japanTime(booking.startAt)}・{booking.guestName}・{booking.headCount}名</span><span className="block text-xs text-muted [overflow-wrap:anywhere]">{booking.offerName}・{yen(booking.totalYen)}</span><span className="block text-xs text-muted">{nihoLabel(NIHO_STATUS_LABELS, booking.status)}・{nihoLabel(NIHO_CHANNEL_LABELS, booking.salesChannel)}</span></button></li>)}</ul> : null}
        {cursor && listState === "ready" ? <div className="border-t border-line p-3"><button type="button" disabled={listBusy || locked} onClick={() => void loadList(cursor)} className={consoleButtonClass("secondary", "sm")}>{listBusy ? "読み込み中…" : "続きを見る"}</button></div> : null}
      </section>
      {selected ? (
        <HostNihoBookingDetail
          // Each booking starts from NIHO's read of it; its draft stays with the page.
          key={selected}
          providerId={providerId}
          bookingId={selected}
          mode={mode}
          translate={translate}
          drafts={drafts}
          onDrafts={setDrafts}
          onLock={setLock}
          onRevoke={revoke}
          onChanged={reloadList}
          back={(busy) => <button type="button" disabled={busy} onClick={() => chooseBooking(null)} className={`${consoleButtonClass("ghost", "sm")} mb-3 lg:hidden`}>‹ {mode === "messages" ? "会話一覧" : "予約一覧"}</button>}
        />
      ) : (
        <section aria-label={mode === "messages" ? "予約者との会話" : "予約の詳細"} className={`${HOST_SURFACE} min-w-0 p-4 max-lg:hidden sm:p-5`}>
          <p className="text-ink-soft">一覧から予約を選んでください。</p>
        </section>
      )}
    </div> : null}
    {leaveGuard.asking && leaveMode ? <HostLeaveDialog mode={leaveMode} requestKey={leaveGuard.requestKey} onStay={leaveGuard.stay} onLeave={leaveGuard.leave} onDiscard={() => setDrafts({})} /> : null}
  </HostPageBody>;
}
