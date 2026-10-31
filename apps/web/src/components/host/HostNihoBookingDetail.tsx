"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { bookingWhen, type BookingDialogSubject } from "@/host/bookings";
import { yen } from "@/host/format";
import type { HostLiveBookingDetailResponse, HostLiveBookingStatusResponse, HostLiveMessageReceiptResponse } from "@/host/live-bookings";
import { japanDateTime, japanTime, NIHO_DELIVERY_LABELS, NIHO_STATUS_LABELS, nihoChannelLabel, nihoLabel } from "@/host/niho-bookings";
import { BOOKING_STATUS, type StatusLabel } from "@/host/status";
import { translationOffered } from "@/host/translate";
import { hostFetch } from "@/lib/host/client-session";
import { BookingDecisionDialog } from "./HostBookingDialogs";
import { HostConfirmDialog } from "./HostConfirmDialog";
import { HostTranslatePanel } from "./HostTranslatePanel";
import { canDecideLiveBooking, findUncertainMessage } from "./live-booking-state";
import { consoleButtonClass, HOST_SURFACE } from "./host-ui";
import { StatusPill } from "./ui";

/*
 * One of NIHO's bookings (the provider operations BFF, #87/#90): read from NIHO when it is opened, with what NIHO
 * lets the host do with it: 承認する・お断りする (a request), 通訳を始める (#181) and a message by email. Every action
 * re-reads NIHO's booking first and after; a result that cannot be confirmed is never sent again on its own, and
 * keeps the host on this booking until they check it (onLock). Shown by 予約 and メッセージ while NIHO's bookings
 * are the screen (HostLiveBookings), and by 予約's one list beside this site's bookings (HostBookings, #84).
 */

export type NihoReplyDraft = { subject: string; body: string };
export interface NihoDetailLock { acting: boolean; uncertain: boolean }

type DetailState = "loading" | "ready" | "error" | "missing";
type UncertainOperation = {
  bookingId: string;
  operation: "approve" | "decline" | "message";
  baselineMessageIds: string[];
  receiptId: string | null;
  sentDraft: NihoReplyDraft | null;
  verification: "needed" | "found" | "not-found";
};

class BookingRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const EMPTY_DRAFT: NihoReplyDraft = { subject: "", body: "" };

function sameDraft(left: NihoReplyDraft, right: NihoReplyDraft): boolean {
  return left.subject.trim() === right.subject.trim() && left.body.trim() === right.body.trim();
}
function dialogSubject(detail: HostLiveBookingDetailResponse): BookingDialogSubject {
  const booking = detail.booking;
  return { guest: booking.guestName, date: booking.occurrenceDate, start: japanTime(booking.startAt), end: japanTime(booking.endAt), offer: booking.offerName, amountYen: booking.totalYen };
}
function answerText(answer: NonNullable<HostLiveBookingDetailResponse["booking"]["answers"]>[number]): string {
  const values = answer.options.map((option) => option.label);
  if (answer.text) values.unshift(answer.text);
  return values.join("、") || "回答なし";
}
/** NIHO's state as 予約's pill: its own words where 予約 has them (確定・承認待ち…), NIHO's for the rest. */
function statusPill(status: string): StatusLabel {
  const own: Record<string, StatusLabel> = {
    PROVISIONAL: BOOKING_STATUS.pending, CONFIRMED: BOOKING_STATUS.confirmed, DECLINED: BOOKING_STATUS.declined, EXPIRED: BOOKING_STATUS.expired,
    CANCELLED: BOOKING_STATUS.cancelled, REFUND_NEEDED: { label: NIHO_STATUS_LABELS.REFUND_NEEDED!, tone: "wait" },
  };
  return own[status] ?? { label: nihoLabel(NIHO_STATUS_LABELS, status), tone: "wait" };
}
/** "大人 2名・子ども 1名". */
function peopleText(booking: HostLiveBookingDetailResponse["booking"]): string {
  return `${booking.adultCount + booking.childCount}名（大人 ${booking.adultCount}${booking.childCount ? `・子ども ${booking.childCount}` : ""}）`;
}

/** One part of the booking under a hairline, as 予約's own detail (HostBookingDetail) has it. */
function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="mt-3.5 border-t border-line pt-3.5">
      <h3 id={id} className="mb-2 font-sans text-xs leading-normal font-extrabold tracking-[0.04em] text-ink-soft">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Row({ label, children, multiline = false }: { label: string; children: ReactNode; multiline?: boolean }) {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2 py-[5px] text-[0.8125rem] leading-normal">
      <dt className="font-bold text-muted">{label}</dt>
      <dd className={`min-w-0 [overflow-wrap:anywhere] ${multiline ? "whitespace-pre-wrap" : ""}`}>{children}</dd>
    </div>
  );
}

function MessageSendDialog({ guestName, draft, onConfirm, onClose }: { guestName: string; draft: NihoReplyDraft; onConfirm: () => void; onClose: () => void }) {
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

export interface HostNihoBookingDetailProps {
  providerId: string;
  bookingId: string;
  mode?: "bookings" | "messages";
  /** 通訳を始める (#181) with the day in Japan it counts from; null while the translate BFF is closed. */
  translate?: { today: string } | null;
  /** Each booking's unsent message, kept by the page: a draft stays with its booking. */
  drafts: Readonly<Record<string, NihoReplyDraft>>;
  onDrafts: (update: (current: Readonly<Record<string, NihoReplyDraft>>) => Readonly<Record<string, NihoReplyDraft>>) => void;
  /** An action is with NIHO, or its result is not confirmed: the page keeps the host on this booking. */
  onLock: (lock: NihoDetailLock) => void;
  /** NIHO said 401, 403 or 404 where the booking must exist: the session or the permission ended. */
  onRevoke: (status: number) => void;
  /** NIHO changed the booking (承認・お断り): the page reads NIHO's list again. */
  onChanged: (bookingId: string) => void;
  /** Above the booking, below lg: the way back to the list. */
  back?: (locked: boolean) => ReactNode;
  className?: string;
}

/**
 * The page keys it by booking: another booking starts from NIHO's read of it. The page keeps the drafts, and moves
 * to another booking only while nothing is locked.
 */
export function HostNihoBookingDetail({ providerId, bookingId, mode = "bookings", translate = null, drafts, onDrafts, onLock, onRevoke, onChanged, back, className = "" }: HostNihoBookingDetailProps) {
  const [detail, setDetail] = useState<HostLiveBookingDetailResponse | null>(null);
  const [detailState, setDetailState] = useState<DetailState>("loading");
  const [acting, setActing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [messageReview, setMessageReview] = useState<{ bookingId: string; draft: NihoReplyDraft } | null>(null);
  const [uncertain, setUncertain] = useState<UncertainOperation | null>(null);
  const [decision, setDecision] = useState<"approve" | "decline" | null>(null);
  const detailVersion = useRef(0);
  const detailAbort = useRef<AbortController | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const root = `provider-operations/${encodeURIComponent(providerId)}/bookings`;
  const draft = drafts[bookingId] ?? EMPTY_DRAFT;
  const locked = acting || Boolean(uncertain);

  useEffect(() => { onLock({ acting, uncertain: Boolean(uncertain) }); }, [acting, uncertain, onLock]);
  useEffect(() => () => onLock({ acting: false, uncertain: false }), [onLock]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);

  const readDetail = useCallback(async (signal?: AbortSignal): Promise<HostLiveBookingDetailResponse> => {
    const response = await hostFetch(`${root}/${encodeURIComponent(bookingId)}`, { signal });
    if (!response.ok) throw new BookingRequestError(response.status === 404 ? "予約が見つかりません。" : "予約の状態を読み込めませんでした。", response.status);
    const value = await response.json() as HostLiveBookingDetailResponse;
    if (value.booking.id !== bookingId) throw new BookingRequestError("選んだ予約と異なる内容が返されました。", 502);
    return value;
  }, [bookingId, root]);

  const loadDetail = useCallback(async () => {
    detailAbort.current?.abort();
    const controller = new AbortController(); detailAbort.current = controller;
    const version = ++detailVersion.current;
    setDetail(null); setDetailState("loading"); setError(""); setNotice("");
    try {
      const value = await readDetail(controller.signal);
      if (version !== detailVersion.current) return;
      setDetail(value); setDetailState("ready");
      if (window.matchMedia("(max-width: 1023px)").matches) requestAnimationFrame(() => headingRef.current?.focus());
    } catch (reason) {
      if (controller.signal.aborted || version !== detailVersion.current) return;
      if (reason instanceof BookingRequestError && (reason.status === 401 || reason.status === 403)) { onRevoke(reason.status); return; }
      if (reason instanceof BookingRequestError && reason.status === 404) {
        setDetailState("missing"); setError("この予約は見つかりません。別の提供者の予約、または削除された予約は表示できません。");
        return;
      }
      setDetailState("error"); setError(reason instanceof Error ? reason.message : "予約を読み込めませんでした。");
    }
  }, [readDetail, onRevoke]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) void loadDetail(); });
    return () => { active = false; detailAbort.current?.abort(); };
  }, [loadDetail]);

  function updateDraft(patch: Partial<NihoReplyDraft>) {
    if (locked) return;
    onDrafts((current) => ({ ...current, [bookingId]: { ...(current[bookingId] ?? EMPTY_DRAFT), ...patch } }));
  }
  /** The draft that was sent leaves its booking, unless the host has changed it since. */
  function clearSentDraft(sent: NihoReplyDraft) {
    onDrafts((current) => sameDraft(current[bookingId] ?? EMPTY_DRAFT, sent) ? { ...current, [bookingId]: EMPTY_DRAFT } : current);
  }
  const ended = (reason: unknown) => reason instanceof BookingRequestError && (reason.status === 401 || reason.status === 403 || reason.status === 404);

  async function beginDecision(kind: "approve" | "decline") {
    if (!detail || locked || !canDecideLiveBooking(detail.booking.status)) return;
    setActing(true); setError(""); setNotice("");
    try {
      const latest = await readDetail();
      setDetail(latest); setDetailState("ready");
      if (!canDecideLiveBooking(latest.booking.status)) { setNotice("予約の状態が変わりました。最新の内容を表示しています。"); return; }
      setDecision(kind);
    } catch (reason) {
      if (ended(reason)) { onRevoke((reason as BookingRequestError).status); return; }
      setError("確認のための最新状態を読み込めませんでした。操作はしていません。");
    } finally { setActing(false); }
  }

  async function action(kind: "approve" | "decline") {
    if (!detail || locked || !canDecideLiveBooking(detail.booking.status)) return;
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
        if (response.status === 401 || response.status === 403 || response.status === 404) { onRevoke(response.status); return; }
        if (response.status >= 500 || response.status === 409) { setUncertain(pending); setError("操作結果を確認できません。二重処理を避けるため、同じ操作は再送していません。"); return; }
        setError("予約を更新できませんでした。"); return;
      }
      let accepted: HostLiveBookingStatusResponse;
      try { accepted = await response.json() as HostLiveBookingStatusResponse; }
      catch { setUncertain(pending); setError("操作は受け付けられた可能性があります。現在の予約状態を確認してください。"); return; }
      try {
        const current = await readDetail();
        setDetail(current); setDetailState("ready");
        if (current.booking.status !== accepted.status) {
          setUncertain(pending); setError("操作後の予約状態をまだ確認できません。自動再送はしていません。"); return;
        }
        setNotice(kind === "approve" ? "予約を承認しました。最新の状態を表示しています。" : "予約をお断りしました。最新の状態を表示しています。");
        headingRef.current?.focus(); onChanged(bookingId);
      } catch (reason) {
        if (ended(reason)) { onRevoke((reason as BookingRequestError).status); return; }
        setUncertain(pending); setError("操作は受け付けられた可能性があります。現在の予約状態を確認するまで次の操作はできません。");
      }
    } finally { setActing(false); }
  }

  async function sendMessage(review: { bookingId: string; draft: NihoReplyDraft }) {
    if (!detail || detail.booking.id !== review.bookingId || locked) return;
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
        if (response.status === 401 || response.status === 403 || response.status === 404) { onRevoke(response.status); return; }
        if (response.status >= 500) { setUncertain(pending); setError("返信結果を確認できません。二重送信を避けるため、自動再送はしていません。"); return; }
        setError(response.status === 409 ? "この予約者へ返信を送れませんでした。入力は保持しています。" : "返信を送信できませんでした。入力は保持しています。"); return;
      }
      let receipt: HostLiveMessageReceiptResponse;
      try { receipt = await response.json() as HostLiveMessageReceiptResponse; }
      catch { setUncertain(pending); setError("返信は受け付けられた可能性があります。履歴を確認してください。"); return; }
      const accepted = { ...pending, receiptId: receipt.message.id };
      try {
        const current = await readDetail();
        const found = current.booking.hostMessages.find((item) => item.id === receipt.message.id) ?? null;
        setDetail(current); setDetailState("ready");
        if (!found) {
          setUncertain({ ...accepted, verification: "not-found" });
          setError("返信は受け付けられましたが、履歴への反映をまだ確認できません。自動再送はしていません。"); return;
        }
        clearSentDraft(sentDraft);
        setNotice(`返信を受け付けました（${nihoLabel(NIHO_DELIVERY_LABELS, found.deliveryStatus)}）。最新の履歴を表示しています。`);
        headingRef.current?.focus();
      } catch (reason) {
        if (ended(reason)) { onRevoke((reason as BookingRequestError).status); return; }
        setUncertain(accepted); setError("返信は受け付けられた可能性があります。履歴を確認するまで次の送信はできません。");
      }
    } finally { setActing(false); }
  }

  async function verifyUncertain() {
    if (!uncertain || acting) return;
    const pending = uncertain;
    setActing(true); setError(""); setNotice("");
    try {
      const current = await readDetail();
      setDetail(current); setDetailState("ready");
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
      if (ended(reason)) { onRevoke((reason as BookingRequestError).status); return; }
      setError("現在の状態を確認できません。操作は再送していません。");
    } finally { setActing(false); }
  }

  function acknowledgeUncertain() {
    if (!uncertain || uncertain.verification === "needed") return;
    if (uncertain.operation === "message" && uncertain.verification === "found" && uncertain.sentDraft) clearSentDraft(uncertain.sentDraft);
    if (uncertain.operation !== "message" && uncertain.verification === "found") onChanged(bookingId);
    setUncertain(null); setError(""); setNotice("確認結果を了承しました。次の操作を行えます。");
  }

  const conversation = useMemo(() => {
    if (!detail) return [];
    const host = detail.booking.hostMessages.map((message) => ({ kind: "host" as const, id: message.id, at: message.createdAt, subject: message.subject, body: message.body, deliveryStatus: message.deliveryStatus }));
    const guest = detail.booking.guestMessages.map((message) => ({ kind: "guest" as const, id: message.id, at: message.createdAt, body: message.body }));
    return [...host, ...guest].sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
  }, [detail]);
  const guestLanguage = detail?.booking.languageSnapshot.toLowerCase().startsWith("en") ? "en" : undefined;
  const canReviewDraft = draft.subject.trim() !== "" && draft.body.trim() !== "";
  const booking = detail?.booking;

  return (
    <section aria-label={mode === "messages" ? "予約者との会話" : "予約の詳細"} className={`${HOST_SURFACE} min-w-0 p-4 md:px-5 md:py-[18px] ${className}`}>
      {back?.(locked)}
      {error ? <p ref={errorRef} tabIndex={-1} role="alert" className="mb-3 rounded-xl bg-danger-pale p-3 text-[0.8125rem] font-bold text-danger focus:outline-none">{error}</p> : null}
      {notice ? <p role="status" className="mb-3 rounded-xl bg-leaf-pale px-3 py-2 text-[0.8125rem] leading-normal font-bold text-moss">{notice}</p> : null}
      {detailState === "loading" ? <p role="status" className="text-ink-soft">予約を読み込み中…</p> : null}
      {detailState === "error" ? <div><p className="text-ink-soft">予約の詳細を表示できません。</p><button type="button" onClick={() => void loadDetail()} className={`${consoleButtonClass("secondary", "sm")} mt-2`}>もう一度読み込む</button></div> : null}
      {detailState === "missing" ? <p className="text-ink-soft">この予約は表示できません。</p> : null}
      {detailState === "ready" && booking ? <>
        <div className="flex items-start justify-between gap-2.5">
          <div className="min-w-0">
            <h2 ref={headingRef} tabIndex={-1} className="font-sans text-[1.125rem] leading-[1.3] font-extrabold tracking-normal [overflow-wrap:anywhere] focus:outline-none">{booking.guestName}</h2>
            <p className="mt-0.5 text-[0.78125rem] leading-normal text-muted">{bookingWhen({ date: booking.occurrenceDate, start: japanTime(booking.startAt), end: japanTime(booking.endAt), offer: booking.offerName })}（日本時間）</p>
          </div>
          <StatusPill status={statusPill(booking.status)} />
        </div>
        <DetailSection title="申込内容">
          <dl>
            <Row label="体験">{booking.pageTitle}</Row>
            <Row label="商品">{booking.offerName}</Row>
            <Row label="人数">{peopleText(booking)}</Row>
            <Row label="金額">{yen(booking.totalYen)}</Row>
            <Row label="申込経路">{nihoChannelLabel(booking.salesChannel)}</Row>
            <Row label="予約時のメモ" multiline>{booking.note || "なし"}</Row>
            {booking.answers?.length ? (
              <Row label="回答">
                <ul className="flex flex-col gap-1.5">
                  {booking.answers.map((answer) => <li key={answer.questionId}><span className="block text-xs text-muted">{answer.prompt}</span><span className="block whitespace-pre-wrap">{answerText(answer)}</span></li>)}
                </ul>
              </Row>
            ) : null}
          </dl>
          <p className="mt-1 text-xs text-muted">NIHO で受けた予約です。承認・お断り・予約者への連絡は NIHO を通じて行います。</p>
        </DetailSection>
        {uncertain?.bookingId === booking.id ? <div className="mt-3.5 rounded-xl border border-warn bg-warn-pale p-3"><p className="font-extrabold">直前の操作結果を確認してください</p><p className="mt-1 text-sm">同じ内容は自動で再送しません。現在の予約状態と返信履歴を確認してください。</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" disabled={acting} onClick={() => void verifyUncertain()} className={consoleButtonClass("secondary", "sm")}>最新状態を確認</button>{uncertain.verification !== "needed" ? <button type="button" disabled={acting} onClick={acknowledgeUncertain} className={consoleButtonClass("primary", "sm")}>確認結果を了承する</button> : null}</div></div> : null}
        {mode === "bookings" && canDecideLiveBooking(booking.status) ? <div className="mt-3.5 flex flex-wrap gap-2 border-t border-line pt-3.5"><button type="button" disabled={locked} onClick={() => void beginDecision("approve")} className={consoleButtonClass("primary")}>{acting ? "最新状態を確認中…" : "承認する"}</button><button type="button" disabled={locked} onClick={() => void beginDecision("decline")} className={consoleButtonClass("secondary")}>お断りする</button></div> : null}
        {mode === "bookings" && translate && translationOffered({ confirmed: booking.status === "CONFIRMED", language: booking.languageSnapshot, date: booking.occurrenceDate }, translate.today) ? <HostTranslatePanel key={booking.id} providerId={providerId} bookingId={booking.id} disabled={locked} onAuthorizationEnded={onRevoke} className="mt-3.5" /> : null}
        <DetailSection title="予約者とのやりとり">
          <p className="text-xs text-muted">予約者のWeb返信は原文です。メールでの返信はここには取り込まれません。</p>
          {conversation.length ? <ol className="mt-3 space-y-3">{conversation.map((item) => item.kind === "guest" ? <li key={`guest-${item.id}`} className="mr-5 rounded-2xl rounded-tl-sm bg-sand p-3 sm:mr-12"><p className="text-xs font-extrabold text-muted">予約者（Web）・原文</p><p lang={guestLanguage} className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{item.body}</p><p className="mt-1 text-xs text-muted">{japanDateTime(item.at)}</p></li> : <li key={`host-${item.id}`} className="ml-5 rounded-2xl rounded-tr-sm bg-leaf-pale p-3 sm:ml-12"><p className="text-xs font-extrabold text-moss">あなたから送信</p><p className="mt-1 font-extrabold [overflow-wrap:anywhere]">{item.subject}</p><p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{item.body ?? "本文は過去の履歴から確認できません。"}</p><p className="mt-1 text-xs text-muted">{japanDateTime(item.at)}・{nihoLabel(NIHO_DELIVERY_LABELS, item.deliveryStatus)}</p></li>)}</ol> : <p className="mt-2 text-[0.8125rem] text-muted">まだやりとりはありません。</p>}
        </DetailSection>
        <form onSubmit={(event) => { event.preventDefault(); if (!canReviewDraft) return; setMessageReview({ bookingId, draft: { subject: draft.subject.trim(), body: draft.body.trim() } }); }} className="mt-3.5 space-y-3 border-t border-line pt-3.5"><h3 className="font-sans text-xs leading-normal font-extrabold tracking-[0.04em] text-ink-soft">予約者へ個別メッセージ</h3><p className="text-xs text-muted">入力した件名と本文を確認してから、そのままメールで1人に送ります。自動翻訳はしません。</p><label className="block font-extrabold">件名<input required maxLength={200} disabled={locked} value={draft.subject} onChange={(event) => updateDraft({ subject: event.target.value })} className="mt-1 min-h-10 w-full rounded-xl border border-line-strong px-3 text-base md:text-sm" /></label><label className="block font-extrabold">本文<textarea required maxLength={4000} rows={6} disabled={locked} value={draft.body} onChange={(event) => updateDraft({ body: event.target.value })} className="mt-1 w-full rounded-xl border border-line-strong px-3 py-2 text-base md:text-sm" /></label><button disabled={locked || !canReviewDraft} className={consoleButtonClass("primary", "lg")}>{acting ? "確認中…" : "送信内容を確認"}</button></form>
      </> : null}
      {decision && detail ? <BookingDecisionDialog kind={decision} booking={dialogSubject(detail)} onClose={() => setDecision(null)} onConfirm={() => void action(decision)} /> : null}
      {messageReview && detail?.booking.id === messageReview.bookingId ? <MessageSendDialog guestName={detail.booking.guestName} draft={messageReview.draft} onClose={() => setMessageReview(null)} onConfirm={() => void sendMessage(messageReview)} /> : null}
    </section>
  );
}
