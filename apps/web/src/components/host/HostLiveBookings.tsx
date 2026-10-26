"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BookingDialogSubject } from "@/host/bookings";
import { yen } from "@/host/format";
import type {
  HostLiveBookingDetailResponse,
  HostLiveBookingListItem,
  HostLiveBookingListResponse,
  HostLiveBookingStatusResponse,
  HostLiveMessageReceiptResponse,
} from "@/host/live-bookings";
import { hostFetch } from "@/lib/host/client-session";
import { BookingDecisionDialog } from "./HostBookingDialogs";
import { HostConfirmDialog } from "./HostConfirmDialog";
import { HostLeaveDialog, useHostLeaveGuard, type HostLeaveMode } from "./HostLeaveGuard";
import { canDecideLiveBooking, findUncertainMessage } from "./live-booking-state";
import { consoleButtonClass, HOST_SURFACE } from "./host-ui";
import { HostPageBody, PageHead } from "./ui";

const STATUS: Record<string, string> = {
  PENDING: "支払い確認中", PAYMENT_PENDING: "支払い待ち", PROVISIONAL: "承認待ち", CONFIRMED: "確定",
  DECLINED: "お断り", EXPIRED: "期限切れ", CANCELLED: "取消済み", REFUND_NEEDED: "返金対応が必要", UNKNOWN: "状態を確認中",
};
const CHANNEL: Record<string, string> = { NIHO_PAGE: "NIHO", EMBED: "埋め込み", EXPERIENCE_SITE: "体験サイト" };
const DELIVERY: Record<string, string> = { QUEUED: "配信待ち", SENT: "送信済み", FAILED: "送信失敗", UNKNOWN: "配信状態を確認中" };
const label = (map: Record<string, string>, value: string | null) => value !== null && map[value] ? map[value] : "確認中";

type LoadState = "loading" | "ready" | "empty" | "error" | "missing" | "revoked";
type ReplyDraft = { subject: string; body: string };
type UncertainOperation = {
  bookingId: string;
  operation: "approve" | "decline" | "message";
  baselineMessageIds: string[];
  receiptId: string | null;
  sentDraft: ReplyDraft | null;
  verification: "needed" | "found" | "not-found";
};

class BookingRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

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
function dialogSubject(detail: HostLiveBookingDetailResponse): BookingDialogSubject {
  const booking = detail.booking;
  return { guest: booking.guestName, date: booking.occurrenceDate, start: formatTime(booking.startAt), end: formatTime(booking.endAt), offer: booking.offerName, amountYen: booking.totalYen };
}
function answerText(answer: NonNullable<HostLiveBookingDetailResponse["booking"]["answers"]>[number]): string {
  const values = answer.options.map((option) => option.label);
  if (answer.text) values.unshift(answer.text);
  return values.join("、") || "回答なし";
}

function MessageSendDialog({ guestName, draft, onConfirm, onClose }: { guestName: string; draft: ReplyDraft; onConfirm: () => void; onClose: () => void }) {
  const stay = useRef<HTMLButtonElement>(null);
  return (
    <HostConfirmDialog
      title="送信内容を確認してください"
      description={`自動翻訳はしません。次の件名と本文がそのまま ${guestName} さんへメールで届きます。`}
      focusRef={stay}
      stayRef={stay}
      confirm={<button type="submit" className={consoleButtonClass("primary")}>この内容で送る</button>}
      onConfirm={onConfirm}
      onClose={onClose}
    >
      <dl className="mt-3 space-y-3 rounded-xl bg-sand p-3">
        <div><dt className="text-xs font-extrabold text-muted">件名</dt><dd className="mt-0.5 [overflow-wrap:anywhere]">{draft.subject}</dd></div>
        <div><dt className="text-xs font-extrabold text-muted">本文</dt><dd className="mt-0.5 whitespace-pre-wrap [overflow-wrap:anywhere]">{draft.body}</dd></div>
      </dl>
    </HostConfirmDialog>
  );
}

export function HostLiveBookings({ providerId, initialBookingId, mode = "bookings" }: { providerId: string; initialBookingId?: string | null; mode?: "bookings" | "messages" }) {
  const [items, setItems] = useState<HostLiveBookingListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [listState, setListState] = useState<LoadState>("loading");
  const [listBusy, setListBusy] = useState(false);
  const [selected, setSelected] = useState(initialBookingId ?? null);
  const [detail, setDetail] = useState<HostLiveBookingDetailResponse | null>(null);
  const [detailState, setDetailState] = useState<LoadState>(initialBookingId ? "loading" : "empty");
  const [acting, setActing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [drafts, setDrafts] = useState<Record<string, ReplyDraft>>({});
  const [messageReview, setMessageReview] = useState<{ bookingId: string; draft: ReplyDraft } | null>(null);
  const [uncertain, setUncertain] = useState<UncertainOperation | null>(null);
  const [decision, setDecision] = useState<"approve" | "decline" | null>(null);
  const listVersion = useRef(0);
  const listBusyRef = useRef(false);
  const detailVersion = useRef(0);
  const detailAbort = useRef<AbortController | null>(null);
  const selectedRef = useRef(selected);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const root = `provider-operations/${encodeURIComponent(providerId)}/bookings`;
  const draft = selected ? drafts[selected] ?? { subject: "", body: "" } : { subject: "", body: "" };
  const hasReplyDraft = useMemo(() => Object.values(drafts).some((value) => value.subject.trim() || value.body.trim()), [drafts]);
  const leaveMode: HostLeaveMode = acting ? "saving" : uncertain ? "unknown" : hasReplyDraft ? "dirty" : null;
  const leaveGuard = useHostLeaveGuard(leaveMode);

  const revoke = useCallback((status: number) => {
    detailAbort.current?.abort();
    listBusyRef.current = false; setListBusy(false);
    setItems([]); setCursor(null); setSelected(null); setDetail(null);
    setListState("revoked"); setDetailState("revoked"); setDecision(null); setMessageReview(null); setUncertain(null);
    setError(status === 401
      ? "ログイン状態を確認できません。ページを再読み込みして、必要ならNIHOでログインし直してください。"
      : "この提供者の予約を見る権限がありません。提供者を切り替えるか、権限を確認してください。");
  }, []);

  const loadList = useCallback(async (next?: string | null) => {
    if (listBusyRef.current) return null;
    listBusyRef.current = true; setListBusy(true);
    const version = ++listVersion.current;
    if (!next) setListState("loading");
    setError("");
    try {
      const response = await hostFetch(`${root}${next ? `?cursor=${encodeURIComponent(next)}` : ""}`);
      if (response.status === 401 || response.status === 403 || response.status === 404) { if (version === listVersion.current) revoke(response.status); return null; }
      if (!response.ok) throw new BookingRequestError("予約を読み込めませんでした。", response.status);
      const value = await response.json() as HostLiveBookingListResponse;
      if (version !== listVersion.current) return null;
      setItems((current) => next ? [...new Map([...current, ...value.bookings].map((item) => [item.id, item])).values()] : value.bookings);
      setCursor(value.nextCursor);
      setListState(value.bookings.length === 0 && !next ? "empty" : "ready");
      return value;
    } catch (reason) {
      if (version !== listVersion.current) return null;
      setListState("error"); setError(reason instanceof Error ? reason.message : "予約を読み込めませんでした。");
      return null;
    } finally {
      if (version === listVersion.current) { listBusyRef.current = false; setListBusy(false); }
    }
  }, [revoke, root]);

  const readDetail = useCallback(async (bookingId: string, signal?: AbortSignal): Promise<HostLiveBookingDetailResponse> => {
    const response = await hostFetch(`${root}/${encodeURIComponent(bookingId)}`, { signal });
    if (!response.ok) throw new BookingRequestError(response.status === 404 ? "予約が見つかりません。" : "予約の状態を読み込めませんでした。", response.status);
    const value = await response.json() as HostLiveBookingDetailResponse;
    if (value.booking.id !== bookingId) throw new BookingRequestError("選んだ予約と異なる内容が返されました。", 502);
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
      if (window.matchMedia("(max-width: 1023px)").matches) requestAnimationFrame(() => detailHeadingRef.current?.focus());
      return value;
    } catch (reason) {
      if (controller.signal.aborted || version !== detailVersion.current || selectedRef.current !== bookingId) return null;
      if (reason instanceof BookingRequestError && (reason.status === 401 || reason.status === 403)) { revoke(reason.status); return null; }
      if (reason instanceof BookingRequestError && reason.status === 404) {
        setDetailState("missing"); setError("この予約は見つかりません。別の提供者の予約、または削除された予約は表示できません。");
        return null;
      }
      setDetailState("error"); setError(reason instanceof Error ? reason.message : "予約を読み込めませんでした。");
      return null;
    }
  }, [readDetail, revoke]);

  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
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

  function chooseBooking(bookingId: string | null) {
    setSelected(bookingId); setError(""); setNotice("");
    if (!bookingId) { detailAbort.current?.abort(); setDetail(null); setDetailState("empty"); }
    const url = new URL(window.location.href);
    if (bookingId) url.searchParams.set("booking", bookingId); else url.searchParams.delete("booking");
    url.searchParams.delete("thread");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }
  function updateDraft(patch: Partial<ReplyDraft>) {
    if (!selected || acting || uncertain) return;
    setDrafts((current) => ({ ...current, [selected]: { ...(current[selected] ?? { subject: "", body: "" }), ...patch } }));
  }

  async function beginDecision(kind: "approve" | "decline") {
    if (!detail || acting || uncertain || !canDecideLiveBooking(detail.booking.status)) return;
    setActing(true); setError(""); setNotice("");
    try {
      const latest = await readDetail(detail.booking.id);
      if (selectedRef.current !== detail.booking.id) return;
      setDetail(latest); setDetailState("ready");
      if (!canDecideLiveBooking(latest.booking.status)) { setNotice("予約の状態が変わりました。最新の内容を表示しています。"); return; }
      setDecision(kind);
    } catch (reason) {
      if (reason instanceof BookingRequestError && (reason.status === 401 || reason.status === 403 || reason.status === 404)) { revoke(reason.status); return; }
      setError("確認のための最新状態を読み込めませんでした。操作はしていません。");
    } finally { setActing(false); }
  }

  async function action(kind: "approve" | "decline") {
    if (!detail || acting || uncertain || !canDecideLiveBooking(detail.booking.status)) return;
    const booking = detail.booking;
    setDecision(null); setActing(true); setError(""); setNotice("");
    const pending: UncertainOperation = { bookingId: booking.id, operation: kind, baselineMessageIds: booking.hostMessages.map((item) => item.id), receiptId: null, sentDraft: null, verification: "needed" };
    try {
      let response: Response;
      try {
        response = await hostFetch(`${root}/${encodeURIComponent(booking.id)}/${kind}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageId: booking.pageId }) });
      } catch {
        setUncertain(pending); setError("操作結果を確認できません。二重処理を避けるため、同じ操作は再送していません。"); return;
      }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403 || response.status === 404) { revoke(response.status); return; }
        if (response.status >= 500 || response.status === 409) { setUncertain(pending); setError("操作結果を確認できません。二重処理を避けるため、同じ操作は再送していません。"); return; }
        setError("予約を更新できませんでした。"); return;
      }
      let accepted: HostLiveBookingStatusResponse;
      try { accepted = await response.json() as HostLiveBookingStatusResponse; }
      catch { setUncertain(pending); setError("操作は受け付けられた可能性があります。現在の予約状態を確認してください。"); return; }
      try {
        const current = await readDetail(booking.id);
        if (current.booking.status !== accepted.status) {
          if (selectedRef.current === booking.id) { setDetail(current); setDetailState("ready"); }
          setUncertain(pending); setError("操作後の予約状態をまだ確認できません。自動再送はしていません。"); return;
        }
        if (selectedRef.current === booking.id) { setDetail(current); setDetailState("ready"); }
        setNotice(kind === "approve" ? "予約を承認しました。最新の状態を表示しています。" : "予約をお断りしました。最新の状態を表示しています。");
        detailHeadingRef.current?.focus(); void loadList();
      } catch (reason) {
        if (reason instanceof BookingRequestError && (reason.status === 401 || reason.status === 403 || reason.status === 404)) { revoke(reason.status); return; }
        setUncertain(pending); setError("操作は受け付けられた可能性があります。現在の予約状態を確認するまで次の操作はできません。");
      }
    } finally { setActing(false); }
  }

  async function sendMessage(review: { bookingId: string; draft: ReplyDraft }) {
    if (!detail || detail.booking.id !== review.bookingId || acting || uncertain) return;
    const booking = detail.booking;
    const sentDraft = review.draft;
    const pending: UncertainOperation = { bookingId: booking.id, operation: "message", baselineMessageIds: booking.hostMessages.map((item) => item.id), receiptId: null, sentDraft, verification: "needed" };
    setMessageReview(null); setActing(true); setError(""); setNotice("");
    try {
      let response: Response;
      try {
        response = await hostFetch(`${root}/${encodeURIComponent(booking.id)}/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageId: booking.pageId, subject: sentDraft.subject, body: sentDraft.body }) });
      } catch {
        setUncertain(pending); setError("返信結果を確認できません。二重送信を避けるため、自動再送はしていません。"); return;
      }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403 || response.status === 404) { revoke(response.status); return; }
        if (response.status >= 500) { setUncertain(pending); setError("返信結果を確認できません。二重送信を避けるため、自動再送はしていません。"); return; }
        setError(response.status === 409 ? "この予約者へ返信を送れませんでした。入力は保持しています。" : "返信を送信できませんでした。入力は保持しています。"); return;
      }
      let receipt: HostLiveMessageReceiptResponse;
      try { receipt = await response.json() as HostLiveMessageReceiptResponse; }
      catch { setUncertain(pending); setError("返信は受け付けられた可能性があります。履歴を確認してください。"); return; }
      const accepted = { ...pending, receiptId: receipt.message.id };
      try {
        const current = await readDetail(booking.id);
        const found = current.booking.hostMessages.find((item) => item.id === receipt.message.id) ?? null;
        if (selectedRef.current === booking.id) { setDetail(current); setDetailState("ready"); }
        if (!found) {
          setUncertain({ ...accepted, verification: "not-found" });
          setError("返信は受け付けられましたが、履歴への反映をまだ確認できません。自動再送はしていません。"); return;
        }
        setDrafts((currentDrafts) => sameDraft(currentDrafts[booking.id] ?? { subject: "", body: "" }, sentDraft) ? { ...currentDrafts, [booking.id]: { subject: "", body: "" } } : currentDrafts);
        setNotice(`返信を受け付けました（${label(DELIVERY, found.deliveryStatus)}）。最新の履歴を表示しています。`);
        detailHeadingRef.current?.focus();
      } catch (reason) {
        if (reason instanceof BookingRequestError && (reason.status === 401 || reason.status === 403 || reason.status === 404)) { revoke(reason.status); return; }
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
      if (reason instanceof BookingRequestError && (reason.status === 401 || reason.status === 403 || reason.status === 404)) { revoke(reason.status); return; }
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

  const conversation = useMemo(() => {
    if (!detail) return [];
    const host = detail.booking.hostMessages.map((message) => ({ kind: "host" as const, id: message.id, at: message.createdAt, subject: message.subject, body: message.body, deliveryStatus: message.deliveryStatus }));
    const guest = detail.booking.guestMessages.map((message) => ({ kind: "guest" as const, id: message.id, at: message.createdAt, body: message.body }));
    return [...host, ...guest].sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
  }, [detail]);
  const guestLanguage = detail?.booking.languageSnapshot.toLowerCase().startsWith("en") ? "en" : undefined;
  const revoked = listState === "revoked" || detailState === "revoked";
  const canReviewDraft = draft.subject.trim() !== "" && draft.body.trim() !== "";

  return <HostPageBody><PageHead title={mode === "messages" ? "メッセージ" : "予約"} />
    {mode === "messages" ? <div className="mb-3.5 rounded-xl bg-sand p-3 text-sm text-ink-soft"><p>予約後のWeb返信と、あなたが送ったメールを予約ごとに表示します。</p><p className="mt-1">予約前の質問・予約者からのメール返信の取り込み・自動翻訳は、まだ利用できません。</p></div> : null}
    {error ? <p ref={errorRef} tabIndex={-1} role="alert" className="mb-3 rounded-xl bg-danger-pale p-4 text-danger focus:outline-none">{error}</p> : null}
    {notice ? <p role="status" className="mb-3 rounded-xl bg-leaf-pale p-4 text-moss">{notice}</p> : null}
    {revoked ? <button type="button" onClick={() => window.location.reload()} className={consoleButtonClass("secondary")}>ページを再読み込み</button> : null}
    {!revoked ? <div className="grid min-w-0 gap-3.5 lg:grid-cols-[minmax(0,1fr)_400px]">
      <section className={`${HOST_SURFACE} min-w-0 ${selected ? "max-lg:hidden" : ""}`} aria-label={mode === "messages" ? "予約ごとの会話一覧" : "予約一覧"}>
        {listState === "loading" ? <p role="status" className="p-5 text-ink-soft">読み込み中…</p> : null}
        {listState === "error" ? <div className="p-5"><p className="text-ink-soft">予約一覧を表示できません。</p><button type="button" disabled={listBusy} onClick={() => void loadList()} className={`${consoleButtonClass("secondary", "sm")} mt-2`}>もう一度読み込む</button></div> : null}
        {listState === "empty" ? <p className="p-5 text-ink-soft">{mode === "messages" ? "予約後の会話はありません。" : "予約はありません。"}</p> : null}
        {listState === "ready" ? <ul>{items.map((booking) => <li key={booking.id} className="border-t border-line first:border-t-0"><button type="button" disabled={acting || Boolean(uncertain)} onClick={() => chooseBooking(booking.id)} className={`w-full px-4 py-3 text-left hover:bg-sand focus-visible:outline-3 focus-visible:outline-offset-[-3px] focus-visible:outline-moss disabled:cursor-not-allowed disabled:opacity-60 ${selected === booking.id ? "bg-sand" : ""}`}><span className="block font-extrabold [overflow-wrap:anywhere]">{booking.pageTitle}</span><span className="block text-sm [overflow-wrap:anywhere]">{booking.occurrenceDate} {formatTime(booking.startAt)}・{booking.guestName}・{booking.headCount}名</span><span className="block text-xs text-muted [overflow-wrap:anywhere]">{booking.offerName}・{yen(booking.totalYen)}</span><span className="block text-xs text-muted">{label(STATUS, booking.status)}・{label(CHANNEL, booking.salesChannel)}</span></button></li>)}</ul> : null}
        {cursor && listState === "ready" ? <div className="border-t border-line p-3"><button type="button" disabled={listBusy || acting || Boolean(uncertain)} onClick={() => void loadList(cursor)} className={consoleButtonClass("secondary", "sm")}>{listBusy ? "読み込み中…" : "続きを見る"}</button></div> : null}
      </section>
      <section aria-label={mode === "messages" ? "予約者との会話" : "予約の詳細"} className={`${HOST_SURFACE} min-w-0 p-4 sm:p-5 ${selected ? "" : "max-lg:hidden"}`}>
        {selected ? <button type="button" onClick={() => chooseBooking(null)} className={`${consoleButtonClass("ghost", "sm")} mb-3 lg:hidden`}>‹ {mode === "messages" ? "会話一覧" : "予約一覧"}</button> : null}
        {detailState === "loading" ? <p role="status" className="text-ink-soft">予約を読み込み中…</p> : null}
        {detailState === "error" ? <div><p className="text-ink-soft">予約の詳細を表示できません。</p>{selected ? <button type="button" onClick={() => void loadDetail(selected)} className={`${consoleButtonClass("secondary", "sm")} mt-2`}>もう一度読み込む</button> : null}</div> : null}
        {detailState === "missing" ? <div><p className="text-ink-soft">この予約は表示できません。</p><button type="button" onClick={() => chooseBooking(null)} className={`${consoleButtonClass("secondary", "sm")} mt-2`}>一覧に戻る</button></div> : null}
        {detailState === "empty" ? <p className="text-ink-soft">一覧から予約を選んでください。</p> : null}
        {detailState === "ready" && detail ? <div className="space-y-5"><div><p className="text-xs font-extrabold text-muted">{label(STATUS, detail.booking.status)}</p><h2 ref={detailHeadingRef} tabIndex={-1} className="font-display text-2xl font-medium focus:outline-none [overflow-wrap:anywhere]">{detail.booking.pageTitle}</h2><p>{detail.booking.occurrenceDate}・{formatTime(detail.booking.startAt)}〜{formatTime(detail.booking.endAt)}（日本時間）</p></div>
          <dl className="grid gap-3 sm:grid-cols-2"><div><dt className="text-xs font-bold text-muted">予約者</dt><dd className="[overflow-wrap:anywhere]">{detail.booking.guestName}</dd></div><div><dt className="text-xs font-bold text-muted">人数</dt><dd>大人{detail.booking.adultCount}名・子ども{detail.booking.childCount}名</dd></div><div><dt className="text-xs font-bold text-muted">金額</dt><dd>{yen(detail.booking.totalYen)}</dd></div><div><dt className="text-xs font-bold text-muted">経路</dt><dd>{label(CHANNEL, detail.booking.salesChannel)}</dd></div><div className="sm:col-span-2"><dt className="text-xs font-bold text-muted">予約時のメモ</dt><dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">{detail.booking.note || "なし"}</dd></div></dl>
          {detail.booking.answers?.length ? <section><h3 className="font-extrabold">申込時の回答</h3><dl className="mt-2 space-y-2">{detail.booking.answers.map((answer) => <div key={answer.questionId} className="rounded-xl bg-sand p-3"><dt className="text-xs font-bold text-muted">{answer.prompt}</dt><dd className="mt-0.5 whitespace-pre-wrap [overflow-wrap:anywhere]">{answerText(answer)}</dd></div>)}</dl></section> : null}
          {uncertain?.bookingId === detail.booking.id ? <div className="rounded-xl border border-warn bg-warn-pale p-3"><p className="font-extrabold">直前の操作結果を確認してください</p><p className="mt-1 text-sm">同じ内容は自動で再送しません。現在の予約状態と返信履歴を確認してください。</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" disabled={acting} onClick={() => void verifyUncertain()} className={consoleButtonClass("secondary", "sm")}>最新状態を確認</button>{uncertain.verification !== "needed" ? <button type="button" disabled={acting} onClick={acknowledgeUncertain} className={consoleButtonClass("primary", "sm")}>確認結果を了承する</button> : null}</div></div> : null}
          {mode === "bookings" && canDecideLiveBooking(detail.booking.status) ? <div className="flex flex-wrap gap-2"><button type="button" disabled={acting || Boolean(uncertain)} onClick={() => void beginDecision("approve")} className={consoleButtonClass("primary")}>{acting ? "最新状態を確認中…" : "承認する"}</button><button type="button" disabled={acting || Boolean(uncertain)} onClick={() => void beginDecision("decline")} className={consoleButtonClass("secondary")}>お断りする</button></div> : null}
          <section className="border-t border-line pt-4"><h3 className="font-extrabold">予約者とのやりとり</h3><p className="mt-1 text-xs text-muted">予約者のWeb返信は原文です。メールでの返信はここには取り込まれません。</p>{conversation.length ? <ol className="mt-3 space-y-3">{conversation.map((item) => item.kind === "guest" ? <li key={`guest-${item.id}`} className="mr-5 rounded-2xl rounded-tl-sm bg-sand p-3 sm:mr-12"><p className="text-xs font-extrabold text-muted">予約者（Web）・原文</p><p lang={guestLanguage} className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{item.body}</p><p className="mt-1 text-xs text-muted">{messageDate(item.at)}</p></li> : <li key={`host-${item.id}`} className="ml-5 rounded-2xl rounded-tr-sm bg-leaf-pale p-3 sm:ml-12"><p className="text-xs font-extrabold text-moss">あなたから送信</p><p className="mt-1 font-extrabold [overflow-wrap:anywhere]">{item.subject}</p><p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{item.body ?? "本文は過去の履歴から確認できません。"}</p><p className="mt-1 text-xs text-muted">{messageDate(item.at)}・{label(DELIVERY, item.deliveryStatus)}</p></li>)}</ol> : <p className="mt-2 text-sm text-muted">まだやりとりはありません。</p>}</section>
          <form onSubmit={(event) => { event.preventDefault(); if (!selected || !canReviewDraft) return; setMessageReview({ bookingId: selected, draft: { subject: draft.subject.trim(), body: draft.body.trim() } }); }} className="space-y-3 border-t border-line pt-4"><h3 className="font-extrabold">予約者へ個別メッセージ</h3><p className="text-xs text-muted">入力した件名と本文を確認してから、そのままメールで1人に送ります。自動翻訳はしません。</p><label className="block font-extrabold">件名<input required maxLength={200} disabled={acting || Boolean(uncertain)} value={draft.subject} onChange={(event) => updateDraft({ subject: event.target.value })} className="mt-1 min-h-10 w-full rounded-xl border border-line-strong px-3 text-base md:text-sm" /></label><label className="block font-extrabold">本文<textarea required maxLength={4000} rows={6} disabled={acting || Boolean(uncertain)} value={draft.body} onChange={(event) => updateDraft({ body: event.target.value })} className="mt-1 w-full rounded-xl border border-line-strong px-3 py-2 text-base md:text-sm" /></label><button disabled={acting || Boolean(uncertain) || !canReviewDraft} className={consoleButtonClass("primary", "lg")}>{acting ? "確認中…" : "送信内容を確認"}</button></form>
        </div> : null}
      </section>
    </div> : null}
    {decision && detail ? <BookingDecisionDialog kind={decision} booking={dialogSubject(detail)} onClose={() => setDecision(null)} onConfirm={() => void action(decision)} /> : null}
    {messageReview && detail?.booking.id === messageReview.bookingId ? <MessageSendDialog guestName={detail.booking.guestName} draft={messageReview.draft} onClose={() => setMessageReview(null)} onConfirm={() => void sendMessage(messageReview)} /> : null}
    {leaveGuard.asking && leaveMode ? <HostLeaveDialog mode={leaveMode} requestKey={leaveGuard.requestKey} onStay={leaveGuard.stay} onLeave={leaveGuard.leave} onDiscard={() => { setDrafts({}); setUncertain(null); }} /> : null}
  </HostPageBody>;
}
