"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ExperienceProviderBookingDetailResponse,
  ExperienceProviderBookingListItem,
  ExperienceProviderBookingListResponse,
  ExperienceProviderBookingStatusResponse,
  ExperienceProviderMessageResponse,
} from "@niho-experience/api-client/experience-provider-operations";
import type { BookingDialogSubject } from "@/host/bookings";
import { yen } from "@/host/format";
import { BookingDecisionDialog } from "./HostBookingDialogs";
import { HostLeaveDialog, useHostLeaveGuard, type HostLeaveMode } from "./HostLeaveGuard";
import { canDecideLiveBooking, findUncertainMessage } from "./live-booking-state";
import { consoleButtonClass, HOST_SURFACE } from "./host-ui";
import { HostPageBody, PageHead } from "./ui";

const STATUS: Record<string, string> = {
  PENDING: "支払い確認中",
  PAYMENT_PENDING: "支払い待ち",
  PROVISIONAL: "承認待ち",
  CONFIRMED: "確定",
  DECLINED: "お断り",
  EXPIRED: "期限切れ",
  CANCELLED: "取消済み",
  REFUND_NEEDED: "返金対応が必要",
  UNKNOWN: "状態を確認中",
};
const CHANNEL: Record<string, string> = { NIHO_PAGE: "NIHO", EMBED: "埋め込み", EXPERIENCE_SITE: "体験サイト" };
const DELIVERY: Record<string, string> = { QUEUED: "配信待ち", SENT: "送信済み", FAILED: "送信失敗", UNKNOWN: "配信状態を確認中" };
const label = (map: Record<string, string>, value: string | null) => value !== null && map[value] ? map[value] : "確認中";

type LoadState = "loading" | "ready" | "empty" | "error" | "revoked";
type ReplyDraft = { subject: string; body: string };
type UncertainOperation = {
  bookingId: string;
  operation: "approve" | "decline" | "message";
  baselineMessageIds: string[];
  receiptId: string | null;
  sentDraft: ReplyDraft | null;
  verification: "needed" | "found" | "not-found";
};

function isRevoked(status: number): boolean { return status === 403 || status === 404; }
function sameDraft(left: ReplyDraft, right: ReplyDraft): boolean { return left.subject === right.subject && left.body === right.body; }
function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date)
    : "--:--";
}
function messageDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date)
    : "日時未確認";
}
function dialogSubject(detail: ExperienceProviderBookingDetailResponse): BookingDialogSubject {
  const booking = detail.booking;
  return {
    guest: booking.guestName,
    date: booking.occurrenceDate,
    start: formatTime(booking.startAt),
    end: formatTime(booking.endAt),
    offer: booking.offerName,
    amountYen: booking.totalYen,
  };
}

export function HostLiveBookings({ providerId, initialBookingId, mode = "bookings" }: { providerId: string; initialBookingId?: string | null; mode?: "bookings" | "messages" }) {
  const [items, setItems] = useState<ExperienceProviderBookingListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [listState, setListState] = useState<LoadState>("loading");
  const [listBusy, setListBusy] = useState(false);
  const [selected, setSelected] = useState(initialBookingId ?? null);
  const [detail, setDetail] = useState<ExperienceProviderBookingDetailResponse | null>(null);
  const [detailState, setDetailState] = useState<LoadState>(initialBookingId ? "loading" : "empty");
  const [acting, setActing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [drafts, setDrafts] = useState<Record<string, ReplyDraft>>({});
  const [uncertain, setUncertain] = useState<UncertainOperation | null>(null);
  const [decision, setDecision] = useState<"approve" | "decline" | null>(null);
  const listVersion = useRef(0);
  const listBusyRef = useRef(false);
  const detailVersion = useRef(0);
  const detailAbort = useRef<AbortController | null>(null);
  const selectedRef = useRef(selected);
  const root = `/host/api/provider-operations/${encodeURIComponent(providerId)}/bookings`;
  const draft = selected ? drafts[selected] ?? { subject: "", body: "" } : { subject: "", body: "" };
  const hasReplyDraft = useMemo(() => Object.values(drafts).some((value) => value.subject.trim() || value.body.trim()), [drafts]);
  const leaveMode: HostLeaveMode = acting ? "saving" : uncertain ? "unknown" : hasReplyDraft ? "dirty" : null;
  const leaveGuard = useHostLeaveGuard(leaveMode);

  const revoke = useCallback((text: string) => {
    detailAbort.current?.abort();
    listBusyRef.current = false; setListBusy(false);
    setItems([]); setCursor(null); setSelected(null); setDetail(null);
    setListState("revoked"); setDetailState("revoked"); setDecision(null); setUncertain(null);
    setError(text);
  }, []);

  const loadList = useCallback(async (next?: string | null) => {
    if (listBusyRef.current) return null;
    listBusyRef.current = true; setListBusy(true);
    const version = ++listVersion.current;
    if (!next) setListState("loading");
    setError("");
    try {
      const response = await fetch(`${root}${next ? `?cursor=${encodeURIComponent(next)}` : ""}`, { cache: "no-store" });
      if (isRevoked(response.status)) { if (version === listVersion.current) revoke("この提供者の予約を見る権限が終了しています。"); return null; }
      if (!response.ok) throw new Error("予約を読み込めませんでした。");
      const value = await response.json() as ExperienceProviderBookingListResponse;
      if (version !== listVersion.current) return null;
      setItems((current) => next ? [...new Map([...current, ...value.bookings].map((item) => [item.id, item])).values()] : value.bookings);
      setCursor(value.nextCursor);
      setListState(value.bookings.length === 0 && !next ? "empty" : "ready");
      return value;
    } catch (reason) {
      if (version !== listVersion.current) return null;
      setListState("error");
      setError(reason instanceof Error ? reason.message : "予約を読み込めませんでした。");
      return null;
    } finally {
      if (version === listVersion.current) { listBusyRef.current = false; setListBusy(false); }
    }
  }, [revoke, root]);

  const readDetail = useCallback(async (bookingId: string, signal?: AbortSignal): Promise<ExperienceProviderBookingDetailResponse> => {
    const response = await fetch(`${root}/${encodeURIComponent(bookingId)}`, { cache: "no-store", signal });
    if (isRevoked(response.status)) throw Object.assign(new Error("予約を確認する権限が終了しています。"), { revoked: true });
    if (!response.ok) throw new Error("予約の状態を読み込めませんでした。");
    const value = await response.json() as ExperienceProviderBookingDetailResponse;
    if (value.booking.id !== bookingId) throw new Error("選んだ予約と異なる内容が返されました。");
    return value;
  }, [root]);

  const loadDetail = useCallback(async (bookingId: string) => {
    detailAbort.current?.abort();
    const controller = new AbortController(); detailAbort.current = controller;
    const version = ++detailVersion.current;
    setDetail(null); setDetailState("loading"); setError(""); setNotice("");
    try {
      const value = await readDetail(bookingId, controller.signal);
      if (version !== detailVersion.current || selectedRef.current !== bookingId) return null;
      setDetail(value); setDetailState("ready");
      return value;
    } catch (reason) {
      if (controller.signal.aborted || version !== detailVersion.current || selectedRef.current !== bookingId) return null;
      if (reason instanceof Error && "revoked" in reason) { revoke(reason.message); return null; }
      setDetailState("error"); setError(reason instanceof Error ? reason.message : "予約を読み込めませんでした。");
      return null;
    }
  }, [readDetail, revoke]);

  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) void loadList(); });
    return () => { active = false; };
  }, [loadList]);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    queueMicrotask(() => { if (active) void loadDetail(selected); });
    return () => { active = false; detailAbort.current?.abort(); };
  }, [selected, loadDetail]);

  function updateDraft(patch: Partial<ReplyDraft>) {
    if (!selected || acting || uncertain) return;
    setDrafts((current) => ({ ...current, [selected]: { ...(current[selected] ?? { subject: "", body: "" }), ...patch } }));
  }

  function beginDecision(kind: "approve" | "decline") {
    if (!detail || acting || uncertain || !canDecideLiveBooking(detail.booking.status)) return;
    setDecision(kind);
  }

  async function action(kind: "approve" | "decline") {
    if (!detail || acting || uncertain || !canDecideLiveBooking(detail.booking.status)) return;
    const booking = detail.booking;
    setDecision(null); setActing(true); setError(""); setNotice("");
    const pending: UncertainOperation = { bookingId: booking.id, operation: kind, baselineMessageIds: booking.hostMessages.map((item) => item.id), receiptId: null, sentDraft: null, verification: "needed" };
    try {
      let response: Response;
      try {
        response = await fetch(`${root}/${encodeURIComponent(booking.id)}/${kind}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageId: booking.pageId }) });
      } catch {
        setUncertain(pending); setError("操作結果を確認できません。二重処理を避けるため、同じ操作は再送していません。"); return;
      }
      if (!response.ok) {
        if (isRevoked(response.status)) { revoke("予約を操作する権限が終了しています。"); return; }
        if (response.status >= 500 || response.status === 409) { setUncertain(pending); setError("操作結果を確認できません。二重処理を避けるため、同じ操作は再送していません。"); return; }
        setError("予約を更新できませんでした。"); return;
      }
      let accepted: ExperienceProviderBookingStatusResponse;
      try { accepted = await response.json() as ExperienceProviderBookingStatusResponse; }
      catch { setUncertain(pending); setError("操作は受け付けられた可能性があります。現在の予約状態を確認してください。"); return; }
      try {
        const current = await readDetail(booking.id);
        if (current.booking.status !== accepted.status) {
          if (selectedRef.current === booking.id) { setDetail(current); setDetailState("ready"); }
          setUncertain(pending); setError("操作後の予約状態をまだ確認できません。自動再送はしていません。"); return;
        }
        if (selectedRef.current === booking.id) { setDetail(current); setDetailState("ready"); }
        setNotice(kind === "approve" ? "予約を承認しました。" : "予約をお断りしました。");
        void loadList();
      } catch (reason) {
        if (reason instanceof Error && "revoked" in reason) { revoke(reason.message); return; }
        setUncertain(pending); setError("操作は受け付けられた可能性があります。現在の予約状態を確認するまで次の操作はできません。");
      }
    } finally { setActing(false); }
  }

  async function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    if (!detail || acting || uncertain) return;
    const booking = detail.booking;
    const sentDraft = { ...draft };
    const pending: UncertainOperation = { bookingId: booking.id, operation: "message", baselineMessageIds: booking.hostMessages.map((item) => item.id), receiptId: null, sentDraft, verification: "needed" };
    setActing(true); setError(""); setNotice("");
    try {
      let response: Response;
      try {
        response = await fetch(`${root}/${encodeURIComponent(booking.id)}/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageId: booking.pageId, subject: sentDraft.subject, body: sentDraft.body }) });
      } catch {
        setUncertain(pending); setError("返信結果を確認できません。二重送信を避けるため、自動再送はしていません。"); return;
      }
      if (!response.ok) {
        if (isRevoked(response.status)) { revoke("予約者へ連絡する権限が終了しています。"); return; }
        if (response.status >= 500 || response.status === 409) { setUncertain(pending); setError("返信結果を確認できません。二重送信を避けるため、自動再送はしていません。"); return; }
        setError("返信を送信できませんでした。入力は保持しています。"); return;
      }
      let receipt: ExperienceProviderMessageResponse;
      try { receipt = await response.json() as ExperienceProviderMessageResponse; }
      catch { setUncertain(pending); setError("返信は受け付けられた可能性があります。履歴を確認してください。"); return; }
      const accepted = { ...pending, receiptId: receipt.message.id };
      try {
        const current = await readDetail(booking.id);
        const found = current.booking.hostMessages.some((item) => item.id === receipt.message.id);
        if (selectedRef.current === booking.id) { setDetail(current); setDetailState("ready"); }
        if (!found) {
          setUncertain({ ...accepted, verification: "not-found" });
          setError("返信は受け付けられましたが、履歴への反映をまだ確認できません。自動再送はしていません。");
          return;
        }
        setDrafts((currentDrafts) => sameDraft(currentDrafts[booking.id] ?? { subject: "", body: "" }, sentDraft) ? { ...currentDrafts, [booking.id]: { subject: "", body: "" } } : currentDrafts);
        setNotice(`返信を受け付けました（${label(DELIVERY, receipt.message.deliveryStatus)}）。`);
      } catch (reason) {
        if (reason instanceof Error && "revoked" in reason) { revoke(reason.message); return; }
        setUncertain(accepted); setError("返信は受け付けられた可能性があります。履歴を確認するまで次の送信はできません。");
      }
    } finally { setActing(false); }
  }

  async function verifyUncertain() {
    if (!uncertain || acting) return;
    const pending = uncertain;
    setActing(true); setError(""); setNotice("");
    try {
      const current = await readDetail(pending.bookingId);
      if (selectedRef.current === pending.bookingId) { setDetail(current); setDetailState("ready"); }
      let found = false;
      if (pending.operation === "message") {
        found = findUncertainMessage(current.booking.hostMessages, pending.baselineMessageIds, pending.receiptId, pending.sentDraft?.subject ?? null) !== null;
        setNotice(found ? "返信の受付と現在の配信状態を確認しました。" : "同じ返信の受付は確認できませんでした。内容を確認してから次の操作を選んでください。");
      } else {
        found = current.booking.status !== "PROVISIONAL";
        setNotice(found ? "予約の現在の状態を確認しました。" : "予約はまだ承認待ちです。次の操作は確認後に選んでください。");
      }
      setUncertain({ ...pending, verification: found ? "found" : "not-found" });
    } catch (reason) {
      if (reason instanceof Error && "revoked" in reason) { revoke(reason.message); return; }
      setError("現在の状態を確認できません。操作は再送していません。");
    } finally { setActing(false); }
  }

  function acknowledgeUncertain() {
    if (!uncertain || uncertain.verification === "needed") return;
    if (uncertain.operation === "message" && uncertain.verification === "found" && uncertain.sentDraft) {
      const bookingId = uncertain.bookingId; const sentDraft = uncertain.sentDraft;
      setDrafts((current) => sameDraft(current[bookingId] ?? { subject: "", body: "" }, sentDraft) ? { ...current, [bookingId]: { subject: "", body: "" } } : current);
    }
    setUncertain(null); setError(""); setNotice("確認結果を了承しました。次の操作を行えます。");
  }

  const revoked = listState === "revoked" || detailState === "revoked";
  return <HostPageBody><PageHead title={mode === "messages" ? "メッセージ" : "予約"} />
    {error ? <p role="alert" className="mb-3 rounded-xl bg-danger-pale p-4 text-danger">{error}</p> : null}
    {notice ? <p role="status" className="mb-3 rounded-xl bg-leaf-pale p-4 text-moss">{notice}</p> : null}
    {!revoked ? <div className="grid gap-3.5 lg:grid-cols-[minmax(17rem,0.8fr)_minmax(0,1.4fr)]">
      <section className={HOST_SURFACE} aria-label="予約一覧">
        {listState === "loading" ? <p className="p-5 text-ink-soft">読み込み中…</p> : null}
        {listState === "error" ? <div className="p-5"><p className="text-ink-soft">予約一覧を表示できません。</p><button type="button" disabled={listBusy} onClick={() => void loadList()} className={`${consoleButtonClass("secondary", "sm")} mt-2`}>もう一度読み込む</button></div> : null}
        {listState === "empty" ? <p className="p-5 text-ink-soft">予約はありません。</p> : null}
        {listState === "ready" ? <ul>{items.map((booking) => <li key={booking.id} className="border-t border-line first:border-t-0"><button type="button" disabled={acting || Boolean(uncertain)} onClick={() => setSelected(booking.id)} className={`w-full px-4 py-3 text-left hover:bg-sand disabled:cursor-not-allowed disabled:opacity-60 ${selected === booking.id ? "bg-sand" : ""}`}><span className="block font-extrabold">{booking.page.title}</span><span className="block text-sm">{booking.occurrenceDate} {booking.guestName}・{booking.headCount}名</span><span className="block text-xs text-muted">{label(STATUS, booking.status)}・{label(CHANNEL, booking.salesChannel)}</span></button></li>)}</ul> : null}
        {cursor && listState === "ready" ? <div className="border-t border-line p-3"><button type="button" disabled={listBusy || acting || Boolean(uncertain)} onClick={() => void loadList(cursor)} className={consoleButtonClass("secondary", "sm")}>{listBusy ? "読み込み中…" : "続きを見る"}</button></div> : null}
      </section>
      <section aria-label="予約の詳細" className={`${HOST_SURFACE} min-w-0 p-5`}>
        {detailState === "loading" ? <p className="text-ink-soft">予約を読み込み中…</p> : null}
        {detailState === "error" ? <div><p className="text-ink-soft">予約の詳細を表示できません。</p>{selected ? <button type="button" onClick={() => void loadDetail(selected)} className={`${consoleButtonClass("secondary", "sm")} mt-2`}>もう一度読み込む</button> : null}</div> : null}
        {detailState === "empty" ? <p className="text-ink-soft">一覧から予約を選んでください。</p> : null}
        {detailState === "ready" && detail ? <div className="space-y-5"><div><p className="text-xs font-extrabold text-muted">{label(STATUS, detail.booking.status)}</p><h2 className="font-display text-2xl font-medium">{detail.booking.page.title}</h2><p>{detail.booking.occurrenceDate}・{formatTime(detail.booking.startAt)}〜{formatTime(detail.booking.endAt)}（日本時間）</p></div>
          <dl className="grid gap-3 sm:grid-cols-2"><div><dt className="text-xs font-bold text-muted">予約者</dt><dd className="[overflow-wrap:anywhere]">{detail.booking.guestName}（{detail.booking.guestEmail}）</dd></div><div><dt className="text-xs font-bold text-muted">人数</dt><dd>大人{detail.booking.adultCount}名・子ども{detail.booking.childCount}名</dd></div><div><dt className="text-xs font-bold text-muted">金額</dt><dd>{yen(detail.booking.totalYen)}</dd></div><div className="sm:col-span-2"><dt className="text-xs font-bold text-muted">予約時のメモ</dt><dd className="whitespace-pre-wrap">{detail.booking.note || "なし"}</dd></div></dl>
          {uncertain?.bookingId === detail.booking.id ? <div className="rounded-xl border border-warn bg-warn-pale p-3"><p className="font-extrabold">直前の操作結果を確認してください</p><p className="mt-1 text-sm">同じ内容は自動で再送しません。現在の予約状態と返信履歴を確認してください。</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" disabled={acting} onClick={() => void verifyUncertain()} className={consoleButtonClass("secondary", "sm")}>最新状態を確認</button>{uncertain.verification !== "needed" ? <button type="button" disabled={acting} onClick={acknowledgeUncertain} className={consoleButtonClass("primary", "sm")}>確認結果を了承する</button> : null}</div></div> : null}
          {mode === "bookings" && canDecideLiveBooking(detail.booking.status) ? <div className="flex flex-wrap gap-2"><button type="button" disabled={acting || Boolean(uncertain)} onClick={() => beginDecision("approve")} className={consoleButtonClass("primary")}>承認する</button><button type="button" disabled={acting || Boolean(uncertain)} onClick={() => beginDecision("decline")} className={consoleButtonClass("secondary")}>お断りする</button></div> : null}
          <section className="border-t border-line pt-4"><h3 className="font-extrabold">返信履歴</h3>{detail.booking.hostMessages.length ? <ol className="mt-2 space-y-2">{detail.booking.hostMessages.map((item) => <li key={item.id} className="rounded-xl bg-sand p-3"><p className="font-extrabold">{item.subject}</p><p className="text-xs text-muted">{messageDate(item.createdAt)}・{label(DELIVERY, item.deliveryStatus)}</p></li>)}</ol> : <p className="mt-1 text-sm text-muted">送信した返信はありません。</p>}</section>
          <form onSubmit={sendMessage} className="space-y-3 border-t border-line pt-4"><h3 className="font-extrabold">予約者へ返信</h3><label className="block font-extrabold">件名<input required maxLength={200} disabled={acting || Boolean(uncertain)} value={draft.subject} onChange={(event) => updateDraft({ subject: event.target.value })} className="mt-1 min-h-10 w-full rounded-xl border border-line-strong px-3" /></label><label className="block font-extrabold">本文<textarea required maxLength={4000} rows={5} disabled={acting || Boolean(uncertain)} value={draft.body} onChange={(event) => updateDraft({ body: event.target.value })} className="mt-1 w-full rounded-xl border border-line-strong px-3 py-2" /></label><button disabled={acting || Boolean(uncertain)} className={consoleButtonClass("primary")}>{acting ? "確認中…" : "返信を送る"}</button></form>
        </div> : null}
      </section>
    </div> : null}
    {decision && detail ? <BookingDecisionDialog kind={decision} booking={dialogSubject(detail)} onClose={() => setDecision(null)} onConfirm={() => void action(decision)} /> : null}
    {leaveGuard.asking && leaveMode ? <HostLeaveDialog mode={leaveMode} requestKey={leaveGuard.requestKey} onStay={leaveGuard.stay} onLeave={leaveGuard.leave} onDiscard={() => { setDrafts({}); setUncertain(null); }} /> : null}
  </HostPageBody>;
}
