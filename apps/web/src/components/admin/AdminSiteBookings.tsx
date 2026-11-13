"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import { decodeExperienceAdminSupportAdminListResponse, type ExperienceAdminSupportAdminListResponse } from "@niho-experience/api-client/admin-support-case";
import type { ExperienceSettlementSummary, ExperienceSupportCase, ExperienceSupportNotification, SupportEnabledBookingsPage, SupportQueue, SupportQueueBooking } from "@niho-experience/experience-store";
import { DANGER_BUTTON } from "@/components/host/HostBookingDialogs";
import { HostIcon } from "@/components/host/HostIcon";
import { INPUT, TEXTAREA } from "@/components/host/fields";
import { HOST_SURFACE, LIST_ROW, LIST_ROW_DETAIL, LIST_ROW_TITLE, consoleButtonClass } from "@/components/host/host-ui";
import { HostPageBody, PageHead, StatusPill } from "@/components/host/ui";
import { SettlementSummaryList } from "@/components/settlement/SettlementSummaryList";
import type { StatusLabel } from "@/host/status";
import { DIALOG_BODY, DIALOG_FOOT, DIALOG_TITLE, ModalDialog } from "./AdminModalDialog";
import { TodoSlotCountContext } from "./admin-todo-slot";
import { siteBookingCommandRejected, siteBookingOutcome, siteBookingPreview, type SiteBookingPreview } from "./site-booking-outcome";
import {
  beginContactOperation,
  beginFinancialExecution,
  beginFinancialPreview,
  claimFinancialOperation,
  contactCommand,
  finishFinancialPreview,
  markContactUnknown,
  markFinancialUnknown,
  releaseContactOperation,
  releaseFinancialOperation,
  resetFinancialForm,
  type ContactGuestCommand,
  type LockTransition,
  type SiteBookingOperationLock,
} from "./site-booking-operation-lock";
import { contactDeliveryText, unsettledOwnContact, withRefreshedEvents } from "./site-booking-contact-recovery";

/*
 * サイト予約の取消・返金 (#285 slice 7, docs/guest-booking.md「取消と返金（第7段）」): what NIHO support has to look at
 * among the bookings made on this site, and its actions. Each action is confirmed on the row first and sent with a UUID
 * kept until an answer comes back, so a retry after a lost answer is the same action. After every answer the list is
 * read again. Full and partial refunds return NIHO's fee in proportion to the refunded amount.
 */

const API = "/admin/api/site-bookings";
const BUTTON = `${consoleButtonClass("secondary")} disabled:opacity-50`;
const DANGER = `${DANGER_BUTTON} disabled:opacity-50`;
const FIELD = INPUT;
const AREA = TEXTAREA;
const LABEL = "grid gap-1 text-[0.78125rem] font-extrabold text-ink-soft";
const REASONS = [
  { value: "GUEST_REQUEST", label: "予約者からの依頼" },
  { value: "HOST_UNAVAILABLE", label: "ホストの都合" },
  { value: "WEATHER", label: "雨・荒天" },
  { value: "ILLNESS", label: "急病・けが" },
  { value: "OTHER", label: "その他" },
] as const;

const ERROR_TEXT: Record<string, string> = {
  invalid_input: "入力を確かめてください（金額は支払額より小さく、全額なら「全額」を選びます）",
  conflict: "同時に別の操作があったか、返金できる残額がありません。一覧を読み直してください",
  not_found: "予約が見つかりませんでした",
  unauthenticated: "管理者のログインが切れました。ログインし直してください",
};

const REFUND_STATE = {
  REQUESTED: () => "Stripe の受付待ち（10 分以上）",
  PENDING: () => "Stripe の処理中（7 日以上）",
  FAILED: (code: string | null) => `返金に失敗（${code ?? "理由不明"}）`,
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BOOKING_STATUS: Record<string, StatusLabel> = {
  CONFIRMED: { label: "確定", tone: "ok" },
  PAYMENT_REVIEW: { label: "確認待ち", tone: "wait" },
  CANCELLED: { label: "取消済み", tone: "stop" },
};
const bookingStatus = (status: string): StatusLabel => BOOKING_STATUS[status] ?? { label: status, tone: "draft" };

/** Only bookings whose own snapshot records support ON: the server decides, and the screen never shows one it did not. */
const supportRows = (bookings: readonly SupportQueueBooking[]) => bookings.filter((booking) => booking.supportEligible);

const yen = (amount: number) => `¥${amount.toLocaleString("ja-JP")}`;
const japanTime = (utc: string) => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(utc));

const guestLabel = (booking: SupportQueueBooking) => booking.guestName ?? "（保存期間を過ぎた予約者）";

/** What the opened booking says about itself (the facts of the row, set out as a list of terms). */
function BookingFacts({ booking, extra }: { booking: SupportQueueBooking; extra?: readonly (readonly [string, ReactNode])[] }) {
  const cancellation = booking.freeCancellationUntilUtc ? `${japanTime(booking.freeCancellationUntilUtc)} まで` : booking.cancellationPolicy === "NONE" ? "返金なしの条件" : null;
  const rows: (readonly [string, ReactNode])[] = [
    ["日時", `${booking.localDate} ${booking.localStartTime}`],
    ["予約者", guestLabel(booking)],
    ["金額", yen(booking.totalAmount)],
    ...(cancellation ? [["無料取消", cancellation] as const] : []),
    ["予約番号", booking.publicBookingId],
    ["提供者", booking.providerId],
    ...(extra ?? []),
  ];
  return (
    <div className="min-w-0">
      <dl className="grid gap-x-4 gap-y-2.5 md:grid-cols-2">
        {rows.map(([term, value]) => (
          <div key={term} className="min-w-0">
            <dt className="text-xs text-muted">{term}</dt>
            <dd className="text-[0.84375rem] leading-normal [overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
      {booking.mailUndeliverable ? <p role="note" className="mt-3 text-xs font-bold text-warn">予約者のメールアドレスにメールが届きません。この予約者へのメールは送られていません。連絡は電話など別の方法で行ってください。</p> : null}
    </div>
  );
}

/** A face that folds (案件・報酬の振込・決済費用): 52px summary, the title on the left, the chevron on the right. */
const FOLD = `group ${HOST_SURFACE}`;
function FoldSummary({ children }: { children: ReactNode }) {
  return (
    <summary className="flex h-[52px] cursor-pointer list-none items-center justify-between gap-3 px-4 [&::-webkit-details-marker]:hidden">
      <span className="font-sans text-[0.78125rem] font-bold text-ink-soft">{children}</span>
      <HostIcon name="chevronDown" className="size-4 text-muted transition-transform group-open:rotate-180" />
    </summary>
  );
}

const SUPPORT_ACTION_LABEL: Record<string, string> = {
  SUPPORT_CANCEL: "予約取消・返金",
  SUPPORT_APPROVE: "取消依頼を承認・返金",
  SUPPORT_DECLINE: "取消依頼を辞退",
  SUPPORT_RESOLVE_REVIEW: "支払い確認を解決・返金",
  SUPPORT_RETRY_REFUND: "返金を再試行",
  SUPPORT_CLOSE_REFUND: "返金対応を終了",
};
const SUPPORT_OUTCOME_LABEL: Record<string, string> = {
  CANCELLED: "取消済み", DECLINED: "辞退済み", REFUND_RETRIED: "再試行受付", REFUND_CLOSED: "対応終了", NOT_CANCELLABLE: "操作対象外",
};

function SupportCasePanel({ booking, operationLock, onBeginContact, onContactUnknown, onReleaseContact, onSessionExpired }: {
  booking: SupportQueueBooking;
  operationLock: SiteBookingOperationLock | null;
  onBeginContact: (ownerId: string, existing: ContactGuestCommand | null, input: { readonly publicBookingId: string; readonly message: string }) => ContactGuestCommand | null;
  onContactUnknown: (ownerId: string, commandId: string) => boolean;
  onReleaseContact: (ownerId: string, commandId: string) => boolean;
  onSessionExpired: () => void;
}) {
  const ownerId = useId();
  const [caseData, setCaseData] = useState<ExperienceSupportCase | null>(null);
  const [currentAdmin, setCurrentAdmin] = useState<string | null>(null);
  const [roster, setRoster] = useState<ExperienceAdminSupportAdminListResponse | null>(null);
  const [rosterState, setRosterState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [assignee, setAssignee] = useState("");
  const [memo, setMemo] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [command, setCommand] = useState<Record<string, unknown> | null>(null);
  const [contactText, setContactText] = useState("");
  const [contactCommandState, setContactCommandState] = useState<ContactGuestCommand | null>(null);
  const contactCommandRef = useRef<ContactGuestCommand | null>(null);
  const [message, setMessage] = useState("");
  // When the case was last read: the age of a contact is judged against this, not against a clock read while rendering.
  const [loadedAtMs, setLoadedAtMs] = useState(0);
  const ownsContact = operationLock?.kind === "CONTACT" && operationLock.ownerId === ownerId
    && operationLock.commandId === contactCommandState?.commandId;
  const canSendContact = operationLock === null || (ownsContact && operationLock.phase === "UNKNOWN");
  const operationBlocked = operationLock !== null;
  const fetchCase = useCallback(async () => {
    const response = await fetch(`${API}/case?publicBookingId=${encodeURIComponent(booking.publicBookingId)}`, { cache: "no-store", credentials: "same-origin" });
    if (response.status === 401 || response.status === 403) { onSessionExpired(); throw new Error("session"); }
    if (!response.ok) throw new Error(String(response.status));
    return await response.json() as { case: ExperienceSupportCase | null; currentAdminUserId: string };
  }, [booking.publicBookingId, onSessionExpired]);
  const load = useCallback(async () => {
    const result = await fetchCase();
    setCaseData(result.case ?? { publicBookingId: booking.publicBookingId, assignedAdminUserId: null, internalMemo: null, revision: 0, updatedBy: null, updatedAtUtc: new Date(0).toISOString(), events: [] });
    setCurrentAdmin(result.currentAdminUserId);
    setAssignee(result.case?.assignedAdminUserId ?? "");
    setMemo(result.case?.internalMemo ?? "");
    setLoaded(true);
    setLoadedAtMs(Date.now());
  }, [booking.publicBookingId, fetchCase]);
  // Only the history is read again: the assignee and the memo being typed, and the revision they will be saved against,
  // stay as they are, so checking where an email is neither loses an edit nor hides another Admin's change from the save.
  const refreshHistory = useCallback(async () => {
    const result = await fetchCase();
    setCaseData((current) => current === null ? current : withRefreshedEvents(current, result.case));
    setCurrentAdmin(result.currentAdminUserId);
    setLoadedAtMs(Date.now());
  }, [fetchCase]);
  const loadRoster = useCallback(async () => {
    setRosterState("loading");
    const response = await fetch("/admin/api/support-admins", { cache: "no-store", credentials: "same-origin" });
    if (response.status === 401 || response.status === 403) { onSessionExpired(); throw new Error("session"); }
    const value = await response.json().catch(() => null) as unknown;
    const decoded = decodeExperienceAdminSupportAdminListResponse(value);
    if (!response.ok || !decoded) { setRosterState("error"); throw new Error("roster"); }
    setRoster(decoded);
    setRosterState("ready");
  }, [onSessionExpired]);
  const openPanel = () => {
    if (loaded || busy || operationBlocked) return;
    setBusy(true);
    setMessage("");
    void Promise.all([load(), loadRoster()]).catch(() => setMessage("案件または担当候補を読み込めません。通信状態と権限を確認して再度開いてください。"))
      .finally(() => setBusy(false));
  };
  const save = async () => {
    if (!caseData || busy || operationBlocked) return;
    const next = command ?? { commandId: crypto.randomUUID(), publicBookingId: booking.publicBookingId, expectedRevision: caseData.revision, assignedAdminUserId: assignee.trim() || null, internalMemo: memo.trim() || null };
    setCommand(next);
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`${API}/case`, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
      const payload = await response.json().catch(() => ({})) as { case?: ExperienceSupportCase; error?: string; currentAdminUserId?: string };
      if (response.status === 401 || response.status === 403) { onSessionExpired(); return; }
      if (response.ok && payload.case) {
        setCaseData(payload.case); setCurrentAdmin(payload.currentAdminUserId ?? currentAdmin); setAssignee(payload.case.assignedAdminUserId ?? ""); setMemo(payload.case.internalMemo ?? ""); setCommand(null); setMessage("担当・内部メモを保存しました。");
      } else if (response.status < 500) {
        const retainedAssignee = assignee;
        const retainedMemo = memo;
        await load();
        if (payload.error === "assignee_unavailable") {
          await loadRoster().catch(() => undefined);
        }
        setAssignee(retainedAssignee);
        setMemo(retainedMemo);
        setCommand(null);
        setMessage(payload.error === "assignee_unavailable" ? "担当候補から外れています。候補を読み直して選び直してください。内部メモの入力は保持しています。" : response.status === 409 ? "ほかの管理者が先に更新しました。入力は保持しています。最新の案件を確認して再保存してください。" : "保存できませんでした。入力は保持しています。");
      } else {
        setMessage("保存結果を確認できません。再試行すると同じ命令IDで照合します。");
      }
    } catch {
      setMessage("通信できません。再試行すると同じ命令IDで照合します。");
    } finally { setBusy(false); }
  };
  const sendContact = async () => {
    const existing = contactCommandRef.current;
    const contactMessage = existing?.message ?? contactText.trim();
    if (!contactMessage || busy) return;
    const request = onBeginContact(ownerId, existing, { publicBookingId: booking.publicBookingId, message: contactMessage });
    if (!request) {
      setMessage("進行中の操作結果を先に確認してください。同じ連絡の結果確認だけ再試行できます。");
      return;
    }
    // Fixed synchronously before fetch/await: a second click cannot mint another UUID or payload.
    contactCommandRef.current = request;
    setContactCommandState(request);
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(API, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
      const result = await response.json().catch(() => ({})) as { outcome?: string; error?: string };
      if (response.status === 401 || response.status === 403) { onSessionExpired(); return; }
      if (response.ok && result.outcome === "CONTACT_SENT" && siteBookingOutcome(result)) {
        if (onReleaseContact(ownerId, request.commandId)) {
          contactCommandRef.current = null;
          setContactCommandState(null);
          setContactText("");
        }
        setMessage("予約者への連絡をメール配信キューに登録しました。");
        await load().catch(() => setMessage("予約者への連絡は登録しましたが、操作履歴を再読込できませんでした。"));
      } else if (response.ok) {
        onContactUnknown(ownerId, request.commandId);
        setMessage("送信結果を確認できません。入力を保持しています。同じ命令IDで照合してください。");
      } else {
        if (siteBookingCommandRejected(response.status, result)) {
          if (onReleaseContact(ownerId, request.commandId)) {
            contactCommandRef.current = null;
            setContactCommandState(null);
          }
        } else {
          onContactUnknown(ownerId, request.commandId);
        }
        setMessage(ERROR_TEXT[result.error ?? ""] ?? "送信結果を確認できません。通信後は同じ命令IDで再試行します。");
      }
    } catch {
      onContactUnknown(ownerId, request.commandId);
      setMessage("通信できません。再試行すると同じ命令IDで照合します。");
    }
    finally { setBusy(false); }
  };
  if (!booking.supportEligible) return <p className="mt-3 rounded-lg bg-sand p-2 text-xs text-muted">受付時のサポートON同意を確認できない予約です。サポート操作は行えません。</p>;
  const changed = caseData !== null && (assignee.trim() !== (caseData.assignedAdminUserId ?? "") || memo.trim() !== (caseData.internalMemo ?? ""));
  const admins = roster?.admins ?? [];
  const retainedAssignee = caseData?.assignedAdminUserId;
  const retainedOutsideRoster = retainedAssignee !== null && retainedAssignee !== undefined && !admins.some((admin) => admin.id === retainedAssignee);
  // Only while this screen holds no contact of its own: otherwise it is the screen that sent it, and says so itself.
  // A screen opened anew has lost the command it kept in memory, so the case history is what remembers.
  const unsettledContact = caseData !== null && contactCommandState === null ? unsettledOwnContact(caseData.events, currentAdmin, loadedAtMs) : null;
  const refreshCase = () => {
    if (busy) return;
    setBusy(true);
    setMessage("");
    void refreshHistory().catch(() => setMessage("送信状態を読み込めません。通信状態と権限を確認して、もう一度お試しください。")).finally(() => setBusy(false));
  };
  return <details className={FOLD} onToggle={(event: SyntheticEvent<HTMLDetailsElement>) => { if (event.currentTarget.open) openPanel(); }}>
    <FoldSummary>案件</FoldSummary>
    <div className="border-t border-line px-4 py-3">
    {!loaded ? (message || busy ? <p className="text-sm text-muted">{message || "案件を読み込んでいます…"}</p> : null) : caseData ? <div className="grid gap-2">
      <label className={LABEL}>担当Admin
        <select className={FIELD} value={assignee} disabled={rosterState !== "ready" || busy || command !== null || operationBlocked} onChange={(event) => { setAssignee(event.currentTarget.value); setCommand(null); }}>
          <option value="">未割当</option>
          {retainedOutsideRoster ? <option value={retainedAssignee}>現在の担当を維持（候補外）</option> : null}
          {admins.map((admin) => <option key={admin.id} value={admin.id}>{admin.displayName?.trim() || `管理者 ${admin.id}`}</option>)}
        </select>
      </label>
      {rosterState === "loading" ? <p className="text-xs text-muted">担当候補を確認しています。</p> : rosterState === "error" ? <div><p className="text-xs text-warn">担当候補を確認できません。内部メモは保存できます。</p><button type="button" disabled={busy} className="mt-1 text-sm font-bold underline" onClick={() => { setBusy(true); void loadRoster().catch(() => setMessage("担当候補を読み込めません。通信状態を確認してください。")).finally(() => setBusy(false)); }}>候補を再読込</button></div> : roster?.truncated ? <p className="text-xs text-muted">担当候補は先頭100名です。候補外の現在担当は維持できます。</p> : null}
      {assignee && currentAdmin ? <p className="text-xs text-muted">{assignee === currentAdmin ? "自分が担当です" : "現在の管理者を担当に設定しています"}</p> : null}
      <label className={LABEL}>内部メモ（ホスト・予約者には共有されません）
        <textarea className={AREA} rows={3} maxLength={5000} value={memo} disabled={busy || command !== null || operationBlocked} onChange={(event) => { setMemo(event.currentTarget.value); setCommand(null); }} />
      </label>
      <button type="button" disabled={!changed || busy || operationBlocked} className={`${BUTTON} justify-self-start`} onClick={() => void save()}>{busy ? "保存中…" : command ? "同じ操作を再試行" : "案件情報を保存"}</button>
      <label className={LABEL}>予約者へNIHOサポートから連絡（英語・メール配信）
        <textarea className={AREA} rows={3} maxLength={4000} value={contactText} disabled={busy || operationLock !== null} onChange={(event) => setContactText(event.currentTarget.value)} />
      </label>
      <button type="button" disabled={!(contactCommandState?.message ?? contactText.trim()) || busy || !canSendContact} className={`${BUTTON} justify-self-start`} onClick={() => void sendContact()}>{busy ? "送っています…" : contactCommandState ? "同じ連絡を再試行" : "NIHOサポートとして連絡"}</button>
      {operationLock !== null && !ownsContact ? <p role="status" className="text-sm text-warn">別の操作結果を先に確認してください。</p> : null}
      {unsettledContact ? <div role="status" className="grid gap-1 rounded-lg bg-sand p-2 text-xs text-ink-soft">
        <p className="font-bold">あなたの直前の連絡（{japanTime(unsettledContact.occurredAtUtc)}）は受け付け済みです。{contactDeliveryText(unsettledContact)}。</p>
        <p>連絡文は画面に残していません。同じ内容を重ねて送らず、「状態を更新」で送信状態を確認してください。</p>
        <button type="button" disabled={busy} className={`${BUTTON} justify-self-start`} onClick={refreshCase}>{busy ? "確認しています…" : "状態を更新"}</button>
      </div> : null}
      {caseData.events.length ? <div><p className="text-xs font-bold text-muted">操作履歴（本文は記録しません）</p><ul className="mt-1 grid gap-1 text-xs text-muted">{caseData.events.map((event, index) => {
        const eventLabel = event.type === "ASSIGNEE_CHANGED" ? "担当変更" : event.type === "GUEST_CONTACT_SENT" ? `予約者へ連絡 · ${contactDeliveryText(event)}` : event.type === "SUPPORT_ACTION"
          ? `${SUPPORT_ACTION_LABEL[event.action ?? ""] ?? "支援操作"}${event.outcome ? ` · ${SUPPORT_OUTCOME_LABEL[event.outcome] ?? "結果を記録"}` : ""}`
          : "内部メモ変更";
        return <li key={`${event.revision}-${event.type}-${index}`}>{eventLabel} · {japanTime(event.occurredAtUtc)} · Admin {event.actorAdminUserId}</li>;
      })}</ul></div> : null}
      {message ? <p role="status" className="text-sm font-bold text-ink-soft">{message}</p> : null}
    </div> : <p role="alert" className="text-sm text-warn">{message || "この予約は支援案件として開けません。"}</p>}
    </div>
  </details>;
}

function AdminSupportNotifications({ initial, onSessionExpired, onUnreadChange }: { initial: ExperienceSupportNotification[]; onSessionExpired: () => void; onUnreadChange?: (unread: number) => void }) {
  const [items, setItems] = useState(initial);
  const [message, setMessage] = useState("");
  const unread = items.filter((item) => !item.read).length;
  useEffect(() => { onUnreadChange?.(unread); }, [unread, onUnreadChange]);
  const markRead = async (id: string) => {
    try {
      const response = await fetch(`${API}/notifications`, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ notificationId: id }) });
      if (response.status === 401 || response.status === 403) { onSessionExpired(); return; }
      if (!response.ok) throw new Error("read");
      setItems((current) => current.map((item) => item.id === id ? { ...item, read: true } : item));
      setMessage("");
    } catch { setMessage("既読を保存できませんでした。再読み込みして確認してください。"); }
  };
  return <section aria-label="Admin通知">
    {items.length ? <div className={`${HOST_SURFACE} overflow-hidden`}><ul className="divide-y divide-line">{items.map((item) => <li key={item.id} className={`${LIST_ROW} flex-wrap justify-between`}>
      <div className="min-w-0 flex-1"><p className={LIST_ROW_TITLE}>{({ BOOKING_RECEIVED: "予約を受け付けました", PAYMENT_REVIEW: "支払いの確認が必要です", CANCELLATION_REQUEST: "取消依頼が届きました", BOOKING_CANCELLED: "予約が取り消されました", REFUND_UPDATED: "返金状態が更新されました", GUEST_MESSAGE: "予約者から新しい連絡が届きました" } as Record<string, string>)[item.topic] ?? "予約通知"}</p><p className={`${LIST_ROW_DETAIL} break-all`}>{item.publicBookingId} · {japanTime(item.createdAtUtc)}</p></div>
      {item.read ? <span className="text-xs text-muted">既読</span> : <button type="button" className={consoleButtonClass("ghost", "sm")} onClick={() => void markRead(item.id)}>既読にする</button>}
    </li>)}</ul></div> : <p className="text-muted">通知はありません。</p>}
    {message ? <p role="status" className="mt-2 text-sm text-warn">{message}</p> : null}
  </section>;
}

type Form = { action: string; key: string; body: Record<string, unknown> } | null;

function previewBody(form: NonNullable<Form>): Record<string, unknown> {
  const target = typeof form.body.publicBookingId === "string" ? { publicBookingId: form.body.publicBookingId } : { refundId: form.body.refundId };
  return form.action === "CANCEL" || form.action === "APPROVE_REQUEST"
    ? { action: form.action, ...target, refund: form.body.refund }
    : { action: form.action, ...target };
}

type ManagedCompensationView = {
  publicBookingId: string; currency: string; capturedAmount: number; refundedAmount: number; disputedAmount: number;
  nihoFeeAmount: number; providerAmount: number; dueOn: string; recipientVerified: boolean;
  status: "REVIEW_REQUIRED" | "READY" | "PREPARED" | "RESULT_UNKNOWN" | "PAID" | "ADJUSTMENT_REQUIRED";
  version: number; statementReference: string | null; preparedAmount: number | null; paidAmount: number | null; adjustmentAmount: number | null;
};

function ManagedCompensationPanel({ publicBookingId, onSessionExpired }: { publicBookingId: string; onSessionExpired: () => void }) {
  const bookingId = publicBookingId;
  const requested = useRef(false);
  const [statementReference, setStatementReference] = useState("");
  const [paidAmount, setPaidAmount] = useState("");
  const [paidDate, setPaidDate] = useState("");
  const [compensation, setCompensation] = useState<ManagedCompensationView | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const endpoint = bookingId.trim() ? `${API}/managed-compensation/${encodeURIComponent(bookingId.trim().toLowerCase())}` : "";
  const load = async () => {
    if (!UUID.test(bookingId.trim())) { setMessage("予約番号の形式を確認してください。"); return; }
    setBusy(true); setMessage("");
    try {
      const response = await fetch(endpoint, { cache: "no-store", credentials: "same-origin" });
      if (response.status === 401 || response.status === 403) { onSessionExpired(); return; }
      const body = await response.json().catch(() => ({})) as { compensation?: ManagedCompensationView; error?: string };
      if (!response.ok || !body.compensation) { setMessage(body.error === "not_found" ? "報酬記録はまだありません。開催後に計算してください。" : "報酬記録を読み込めませんでした。"); return; }
      setCompensation(body.compensation); setPaidAmount(String(body.compensation.preparedAmount ?? body.compensation.providerAmount));
    } catch { setMessage("通信状態を確認してください。"); }
    finally { setBusy(false); }
  };
  const mutate = async (body: Record<string, unknown>) => {
    if (!UUID.test(bookingId.trim())) { setMessage("予約番号の形式を確認してください。"); return; }
    setBusy(true); setMessage("");
    try {
      const response = await fetch(endpoint, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, commandId: crypto.randomUUID() }) });
      if (response.status === 401 || response.status === 403) { onSessionExpired(); return; }
      const result = await response.json().catch(() => ({})) as { compensation?: ManagedCompensationView; error?: string };
      if (!response.ok || !result.compensation) { setMessage(result.error === "conflict" ? "状態が更新されています。読み直してから続けてください。" : "操作を完了できませんでした。"); return; }
      setCompensation(result.compensation); setPaidAmount(String(result.compensation.preparedAmount ?? result.compensation.providerAmount)); setMessage("記録しました。");
    } catch { setMessage("結果を確認できません。再送前に同じ予約を読み直してください。"); }
    finally { setBusy(false); }
  };
  const status = compensation ? ({ REVIEW_REQUIRED: "要確認・再計算", READY: "準備可能", PREPARED: "振込準備済み", RESULT_UNKNOWN: "銀行明細との照合待ち", PAID: "振込済み", ADJUSTMENT_REQUIRED: "支払後調整が必要" } as const)[compensation.status] : "";
  const paidAt = Date.parse(`${paidDate}T00:00:00+09:00`);
  const canRecordPayment = Number.isFinite(paidAt) && paidAmount.trim() !== ""
    && Number.isSafeInteger(Number(paidAmount)) && Number(paidAmount) > 0;
  return <details className={FOLD} onToggle={(event: SyntheticEvent<HTMLDetailsElement>) => { if (event.currentTarget.open && !requested.current) { requested.current = true; void load(); } }}>
    <FoldSummary>報酬の振込</FoldSummary>
    <div className="border-t border-line px-4 py-3 text-[0.84375rem]">
    <div className="flex flex-wrap gap-2"><button type="button" className={BUTTON} disabled={busy || !bookingId} onClick={() => void load()}>読み直す</button><button type="button" className={BUTTON} disabled={busy || !bookingId} onClick={() => void mutate({ action: "CALCULATE" })}>開催後の報酬を計算</button></div>
    {compensation ? <div className="mt-3"><p className="font-extrabold">{status}</p><dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1"><dt>確定売上</dt><dd>{yen(compensation.capturedAmount)}</dd><dt>返金</dt><dd>{yen(compensation.refundedAmount)}</dd><dt>異議申立て</dt><dd>{yen(compensation.disputedAmount)}</dd><dt>NIHO 20%</dt><dd>{yen(compensation.nihoFeeAmount)}</dd><dt>提供者報酬</dt><dd className="font-bold">{yen(compensation.providerAmount)}</dd><dt>支払期日</dt><dd>{compensation.dueOn}</dd></dl>
      <div className="mt-3 flex flex-wrap gap-2">{compensation.status === "READY" && compensation.providerAmount > 0 ? <button type="button" className={BUTTON} disabled={busy} onClick={() => void mutate({ action: "PREPARE", expectedVersion: compensation.version, recipientVerified: true })}>受取先を照合して振込準備</button> : null}{compensation.status === "PREPARED" ? <button type="button" className={BUTTON} disabled={busy} onClick={() => void mutate({ action: "RESULT_UNKNOWN", expectedVersion: compensation.version })}>結果不明として明細照合へ</button> : null}</div>
      {compensation.preparedAmount !== null ? <p className="mt-2">準備時固定額: {yen(compensation.preparedAmount)}{compensation.paidAmount !== null ? ` · 実振込額: ${yen(compensation.paidAmount)}` : ""}{compensation.adjustmentAmount ? ` · 差額: ${yen(compensation.adjustmentAmount)}` : ""}</p> : null}
      {compensation.status === "PREPARED" || compensation.status === "RESULT_UNKNOWN" ? <div className="mt-3 space-y-2">
        <div className="grid gap-2 sm:grid-cols-3">
          <label className={LABEL}>銀行明細の照合番号<input className={FIELD} value={statementReference} maxLength={160} onChange={(event) => setStatementReference(event.currentTarget.value)} /></label>
          <label className={LABEL}>振込日<input className={FIELD} type="date" value={paidDate} onChange={(event) => setPaidDate(event.currentTarget.value)} /></label>
          <label className={LABEL}>実振込額<input className={FIELD} type="number" min={1} value={paidAmount} onChange={(event) => setPaidAmount(event.currentTarget.value)} /></label>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={BUTTON} disabled={busy || !statementReference.trim() || !canRecordPayment} onClick={() => void mutate({
            action: "RECONCILE_PAID", expectedVersion: compensation.version, statementReference: statementReference.trim(),
            paidAtUtc: new Date(paidAt).toISOString(), paidAmount: Number(paidAmount),
          })}>明細と照合して振込済みにする</button>
          {compensation.status === "RESULT_UNKNOWN" ? <button type="button" className={BUTTON} disabled={busy || !statementReference.trim()} onClick={() => void mutate({
            action: "RECONCILE_NOT_PAID", expectedVersion: compensation.version, statementReference: statementReference.trim(),
          })}>明細で未振込を確認</button> : null}
        </div>
      </div> : null}
    </div> : null}
    {message ? <p role="status" className="mt-3 text-sm font-bold text-warn">{message}</p> : null}
    </div>
  </details>;
}

type Tab = "todo" | "all" | "news" | "settle";
const TABS: readonly { id: Tab; label: string }[] = [
  { id: "todo", label: "要対応" },
  { id: "all", label: "すべて" },
  { id: "news", label: "通知" },
  { id: "settle", label: "精算" },
];
const NOT_SUPPORT_BOOKING = "サポートONで受け付けた予約に、この予約番号はありません。";

/** One booking the screen can open: a row of a queue, of the support-ON list, or the one opened by number. */
type Item =
  | { key: string; kind: "request"; booking: SupportQueue["cancellationRequests"][number] }
  | { key: string; kind: "review"; booking: SupportQueue["paymentReviews"][number] }
  | { key: string; kind: "refund"; booking: SupportQueue["refunds"][number] }
  | { key: string; kind: "support" | "lookup"; booking: SupportQueueBooking };

const itemPill = (item: Item): StatusLabel =>
  item.kind === "request" ? { label: "取消の依頼", tone: "wait" }
    : item.kind === "review" ? { label: "確認待ち", tone: "wait" }
      : item.kind === "refund" ? { label: "返金", tone: "stop" }
        : bookingStatus(item.booking.status);

/** The dialog around a confirmation: the body, and the two buttons (やめる first, which has the focus). */
function ConfirmDialogFrame({ titleId, locked, onCancel, cancelDisabled, primary, primaryLabel, primaryDisabled, primaryDanger, children }: { titleId: string; locked: boolean; onCancel: () => void; cancelDisabled: boolean; primary: () => void; primaryLabel: string; primaryDisabled: boolean; primaryDanger: boolean; children: ReactNode }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <ModalDialog titleId={titleId} focusRef={cancelRef} locked={locked} onClose={onCancel}>
      <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
        {children}
        <div className={DIALOG_FOOT}>
          <button ref={cancelRef} type="button" className={BUTTON} disabled={cancelDisabled} onClick={onCancel}>やめる</button>
          <button type="button" className={primaryDanger ? DANGER : `${consoleButtonClass("primary")} disabled:opacity-50`} disabled={primaryDisabled} onClick={primary}>{primaryLabel}</button>
        </div>
      </div>
    </ModalDialog>
  );
}

export function AdminSiteBookings({ initial, supportBookings, notifications = [], settlements = [], managedCompensationAvailable = false, todoSlot, todoSlotCount = 0 }: {
  initial: SupportQueue;
  supportBookings?: SupportEnabledBookingsPage;
  notifications?: ExperienceSupportNotification[];
  settlements?: ExperienceSettlementSummary[];
  managedCompensationAvailable?: boolean;
  /** What waits for a decision before the queues (承認待ちの申込), and how many of them there are. */
  todoSlot?: ReactNode;
  todoSlotCount?: number;
}) {
  const financialOwnerId = useId();
  const [queue, setQueue] = useState(initial);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [form, setForm] = useState<Form>(null);
  const [preview, setPreview] = useState<SiteBookingPreview | null>(null);
  const [prepared, setPrepared] = useState<Record<string, unknown> | null>(null);
  const [pending, setPending] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [tab, setTab] = useState<Tab>("todo");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // What waits in the blocks of the 要対応 slot (承認待ち …): each reports its own count; until one does, the page's count stands.
  const [slotCounts, setSlotCounts] = useState<Record<string, number>>({});
  const reportSlotCount = useCallback((source: string, count: number) => setSlotCounts((current) => current[source] === count ? current : { ...current, [source]: count }), []);
  const slotCount = Object.keys(slotCounts).length ? Object.values(slotCounts).reduce((sum, count) => sum + count, 0) : todoSlotCount;
  const [idOnly, setIdOnly] = useState<string | null>(null);
  const [unread, setUnread] = useState(() => notifications.filter((item) => !item.read).length);
  const dialogTitleId = useId();
  const [supportList, setSupportList] = useState<readonly SupportQueueBooking[]>(() => supportRows(supportBookings?.bookings ?? []));
  const [supportCursor, setSupportCursor] = useState<string | null>(supportBookings?.nextCursor ?? null);
  const [supportListBusy, setSupportListBusy] = useState(false);
  const [supportListMessage, setSupportListMessage] = useState("");
  const [lookupId, setLookupId] = useState("");
  const [lookup, setLookup] = useState<SupportQueueBooking | null>(null);
  const [lookupMessage, setLookupMessage] = useState("");
  const operationLockRef = useRef<SiteBookingOperationLock | null>(null);
  const [operationLock, setOperationLock] = useState<SiteBookingOperationLock | null>(null);

  const applyLockTransition = useCallback((transition: LockTransition): boolean => {
    if (!transition.accepted) return false;
    operationLockRef.current = transition.lock;
    setOperationLock(transition.lock);
    return true;
  }, []);
  const beginContact = useCallback((ownerId: string, existing: ContactGuestCommand | null, input: { readonly publicBookingId: string; readonly message: string }): ContactGuestCommand | null => {
    // Do not mint a UUID while another panel or a financial form owns the synchronous gate.
    if (existing === null && operationLockRef.current !== null) return null;
    const candidate = contactCommand(existing, input, () => crypto.randomUUID());
    return applyLockTransition(beginContactOperation(operationLockRef.current, ownerId, candidate.commandId)) ? candidate : null;
  }, [applyLockTransition]);
  const contactUnknown = useCallback((ownerId: string, commandId: string): boolean =>
    applyLockTransition(markContactUnknown(operationLockRef.current, ownerId, commandId)), [applyLockTransition]);
  const releaseContact = useCallback((ownerId: string, commandId: string): boolean =>
    applyLockTransition(releaseContactOperation(operationLockRef.current, ownerId, commandId)), [applyLockTransition]);

  const expireSession = useCallback(() => {
    operationLockRef.current = null;
    setOperationLock(null);
    setSessionExpired(true);
    setQueue({ cancellationRequests: [], paymentReviews: [], refunds: [] });
    setForm(null);
    setPreview(null);
    setPrepared(null);
    setPending(null);
    setSelectedKey(null);
    setIdOnly(null);
    setSupportList([]);
    setSupportCursor(null);
    setLookup(null);
    setLookupId("");
    setLookupMessage("");
    setSupportListMessage("");
  }, []);

  /** One page of support-ON bookings, or null after a failure (the session is ended on 401/403). */
  const fetchSupportBookings = useCallback(async (query: string): Promise<SupportEnabledBookingsPage | null> => {
    const response = await fetch(`${API}/bookings${query}`, { cache: "no-store", credentials: "same-origin" });
    if (response.status === 401 || response.status === 403) { expireSession(); return null; }
    if (!response.ok) return null;
    const page = await response.json().catch(() => null) as SupportEnabledBookingsPage | null;
    return page && Array.isArray(page.bookings) ? { bookings: supportRows(page.bookings), nextCursor: typeof page.nextCursor === "string" ? page.nextCursor : null } : null;
  }, [expireSession]);

  const loadMoreSupport = async () => {
    if (!supportCursor || supportListBusy) return;
    setSupportListBusy(true);
    setSupportListMessage("");
    try {
      const page = await fetchSupportBookings(`?cursor=${encodeURIComponent(supportCursor)}`);
      if (!page) { setSupportListMessage("続きを読み込めませんでした。もう一度お試しください。"); return; }
      setSupportList((current) => [...current, ...page.bookings.filter((booking) => !current.some((item) => item.publicBookingId === booking.publicBookingId))]);
      setSupportCursor(page.nextCursor);
    } catch {
      setSupportListMessage("続きを読み込めませんでした。通信状態を確かめてください。");
    } finally {
      setSupportListBusy(false);
    }
  };

  const openByBookingId = async () => {
    // Opening another booking replaces the panel that is open, and with it the command a contact or an action is still
    // waiting on (its UUID, and the owner of the screen's operation lock): the search waits until that is settled.
    if (operationLockRef.current !== null) return;
    const id = lookupId.trim().toLowerCase();
    setLookup(null);
    if (!UUID.test(id)) { setLookupMessage("予約番号の形式が違います（36文字のUUID）。"); return; }
    setSupportListBusy(true);
    setLookupMessage("");
    try {
      const page = await fetchSupportBookings(`?publicBookingId=${encodeURIComponent(id)}`);
      if (!page) { setLookupMessage("予約を読み込めませんでした。もう一度お試しください。"); return; }
      const found = page.bookings[0] ?? null;
      setLookup(found);
      if (found) setSelectedKey(`lookup:${found.publicBookingId}`);
      if (!found) setLookupMessage(NOT_SUPPORT_BOOKING);
      if (!found) { setIdOnly(id); setSelectedKey(`id:${id}`); }
    } catch {
      setLookupMessage("予約を読み込めませんでした。通信状態を確かめてください。");
    } finally {
      setSupportListBusy(false);
    }
  };

  /** After an action on one booking, its row in the support-ON list (and the one opened by number) is read again. */
  const refreshSupportBooking = async (publicBookingId: string) => {
    try {
      const page = await fetchSupportBookings(`?publicBookingId=${encodeURIComponent(publicBookingId)}`);
      const fresh = page?.bookings[0];
      if (!fresh) return;
      setSupportList((current) => current.map((booking) => booking.publicBookingId === publicBookingId ? fresh : booking));
      setLookup((current) => current?.publicBookingId === publicBookingId ? fresh : current);
    } catch {
      // The row stays as it is; reopening the page reads it again.
    }
  };

  const refresh = async () => {
    try {
      const response = await fetch(API, { cache: "no-store", credentials: "same-origin" });
      if (response.ok) setQueue(await response.json() as SupportQueue);
      else if (response.status === 401 || response.status === 403) expireSession();
    } catch {
      // The list stays as it is; the next action reads it again.
    }
  };

  const loadPreview = async () => {
    if (!form || pending || !applyLockTransition(beginFinancialPreview(operationLockRef.current, financialOwnerId))) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`${API}/preview`, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(previewBody(form)) });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (response.status === 401 || response.status === 403) { expireSession(); return; }
      if (!response.ok) {
        setPreview(null); setPrepared(null);
        setMessage({ tone: "error", text: ERROR_TEXT[result.error ?? ""] ?? "最新の状態を確認できませんでした。入力を確かめて再度お試しください。" });
        return;
      }
      const checked = siteBookingPreview(result);
      const expectedTarget = String(form.body.publicBookingId ?? "");
      if (!checked || checked.action !== form.action || (expectedTarget && checked.publicBookingId !== expectedTarget)) {
        setPreview(null); setPrepared(null);
        setMessage({ tone: "error", text: "確認結果を検証できません。操作は実行していません。" });
        return;
      }
      setPreview(checked);
      setPrepared({ ...form.body, action: form.action, commandId: crypto.randomUUID(), expectedSnapshot: checked.expectedSnapshot });
    } catch {
      setPreview(null); setPrepared(null);
      setMessage({ tone: "error", text: "最新の状態を確認できませんでした。通信状態を確かめてください。" });
    } finally {
      applyLockTransition(finishFinancialPreview(operationLockRef.current, financialOwnerId));
      setBusy(false);
    }
  };

  const send = async () => {
    if (!form || !prepared || !applyLockTransition(beginFinancialExecution(operationLockRef.current, financialOwnerId))) return;
    const request = pending ?? prepared;
    setPending(request);
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(API, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
      const result = await response.json().catch(() => ({})) as { outcome?: string; error?: string; refunds?: { status: string }[] };
      if (response.status === 401 || response.status === 403) { expireSession(); return; }
      if (!response.ok) {
        // Only a typed business rejection permits a new confirmation; route/proxy failures retain this command.
        if (siteBookingCommandRejected(response.status, result)) {
          applyLockTransition(resetFinancialForm(operationLockRef.current, financialOwnerId));
          setPending(null); setPreview(null); setPrepared(null);
        } else {
          applyLockTransition(markFinancialUnknown(operationLockRef.current, financialOwnerId));
        }
        setMessage({ tone: "error", text: response.status === 409 ? "状態または返金額が確認後に変わりました。最新の状態と金額をもう一度確認してください。" : ERROR_TEXT[result.error ?? ""] ?? "送れませんでした。もう一度お試しください（同じ操作として送り直します）" });
        return;
      }
      const outcome = siteBookingOutcome(result);
      if (!outcome || result.outcome === "CONTACT_SENT") {
        applyLockTransition(markFinancialUnknown(operationLockRef.current, financialOwnerId));
        setMessage({ tone: "error", text: "操作結果を確認できません。入力を保持しています。同じ操作として照合してください。" });
        return;
      }
      applyLockTransition(releaseFinancialOperation(operationLockRef.current, financialOwnerId));
      setPending(null);
      setPreview(null);
      setPrepared(null);
      setForm(null);
      setMessage(outcome);
      await refresh();
      if (typeof request.publicBookingId === "string") await refreshSupportBooking(request.publicBookingId);
    } catch {
      applyLockTransition(markFinancialUnknown(operationLockRef.current, financialOwnerId));
      setMessage({ tone: "error", text: "通信できませんでした。もう一度お試しください（同じ操作として送り直します）" });
    } finally {
      setBusy(false);
    }
  };

  const open = (action: string, key: string, body: Record<string, unknown>) => {
    if (busy || pending || !applyLockTransition(claimFinancialOperation(operationLockRef.current, financialOwnerId))) {
      setMessage({ tone: "error", text: "送信済みの操作結果を先に確認してください。確認が終わるまで別の操作は始められません。" });
      return;
    }
    setPreview(null);
    setPrepared(null);
    setPending(null);
    setMessage(null);
    setForm({ action, key, body });
  };
  const set = (patch: Record<string, unknown>) => {
    if (busy || pending || operationLockRef.current?.kind !== "FINANCIAL" || operationLockRef.current.ownerId !== financialOwnerId || operationLockRef.current.phase !== "FORM") return;
    setPreview(null);
    setPrepared(null);
    setForm((current) => (current ? { ...current, body: { ...current.body, ...patch } } : current));
  };

  const ownsFinancialLock = operationLock?.kind === "FINANCIAL" && operationLock.ownerId === financialOwnerId;
  const canContinueFinancial = ownsFinancialLock && (operationLock.phase === "FORM" || operationLock.phase === "EXECUTION_UNKNOWN");
  const cancelFinancialForm = () => {
    if (operationLockRef.current?.phase !== "FORM") return;
    if (!applyLockTransition(releaseFinancialOperation(operationLockRef.current, financialOwnerId))) return;
    setForm(null); setPreview(null); setPrepared(null); setPending(null);
  };

  if (sessionExpired) return <HostPageBody><h1 className="font-display text-2xl font-medium">Adminの再ログインが必要です</h1><p role="status" className="mt-2 text-ink-soft">権限またはログインの有効期限が切れました。再ログインすると予約・案件・入力を読み直せます。</p></HostPageBody>;

  const refundFields = () => (
    <>
      <fieldset className="flex flex-wrap gap-3">
        <legend className="sr-only">返金</legend>
        <label className="inline-flex items-center gap-1.5 text-[0.875rem]"><input type="radio" checked={(form?.body.refund as { kind?: string } | undefined)?.kind !== "PARTIAL"} onChange={() => set({ refund: { kind: "FULL" } })} />全額（最新の支払額は次に確認）</label>
        <label className="inline-flex items-center gap-1.5 text-[0.875rem]"><input type="radio" checked={(form?.body.refund as { kind?: string } | undefined)?.kind === "PARTIAL"} onChange={() => set({ refund: { kind: "PARTIAL", amount: 0 } })} />一部（NIHO 手数料も額に比例して返す）</label>
      </fieldset>
      {(form?.body.refund as { kind?: string } | undefined)?.kind === "PARTIAL" ? (
        <label className={LABEL}>返金額（円、最新の返金可能残額以下）
          <input type="number" min={1} inputMode="numeric" className={FIELD} value={String((form?.body.refund as { amount?: number }).amount || "")} onChange={(event) => set({ refund: { kind: "PARTIAL", amount: Number(event.currentTarget.value) } })} />
        </label>
      ) : null}
    </>
  );
  const noteField = (label: string, key: "note" | "message", required = false) => (
    <label className={LABEL}>{label}
      <textarea rows={3} maxLength={key === "message" ? 2000 : 1000} required={required} className={AREA} value={String(form?.body[key] ?? "")} onChange={(event) => set({ [key]: event.currentTarget.value })} />
    </label>
  );

  /** Support's own cancellation of a confirmed booking: reason, full or partial refund, note (the same for every entry). */
  const cancelFields = () => (
    <>
      <label className={LABEL}>取消理由
        <select className={FIELD} value={String(form?.body.reason ?? "")} onChange={(event) => set({ reason: event.currentTarget.value })}>
          <option value="">選んでください</option>
          {REASONS.map((reason) => <option key={reason.value} value={reason.value}>{reason.label}</option>)}
        </select>
      </label>
      <fieldset className="flex flex-wrap gap-3">
        <legend className="sr-only">返金</legend>
        <label className="inline-flex items-center gap-1.5 text-[0.875rem]"><input type="radio" checked={(form?.body.refund as { kind?: string } | undefined)?.kind !== "PARTIAL"} onChange={() => set({ refund: { kind: "FULL" } })} />全額（NIHO 手数料も返す）</label>
        <label className="inline-flex items-center gap-1.5 text-[0.875rem]"><input type="radio" checked={(form?.body.refund as { kind?: string } | undefined)?.kind === "PARTIAL"} onChange={() => set({ refund: { kind: "PARTIAL", amount: 0 } })} />一部（NIHO 手数料も額に比例して返す）</label>
      </fieldset>
      {(form?.body.refund as { kind?: string } | undefined)?.kind === "PARTIAL" ? (
        <label className={LABEL}>返金額（円、支払額未満）
          <input type="number" min={1} inputMode="numeric" className={FIELD} value={String((form?.body.refund as { amount?: number }).amount || "")} onChange={(event) => set({ refund: { kind: "PARTIAL", amount: Number(event.currentTarget.value) } })} />
        </label>
      ) : null}
      {noteField("メモ（任意・予約者には届きません）", "note")}
    </>
  );
  const openCancel = (key: string, publicBookingId: string) => open("CANCEL", key, { publicBookingId, refund: { kind: "FULL" }, reason: "", note: "" });

  /* The bookings the screen can open, and which one is open. */
  const todoItems: Item[] = [
    ...queue.cancellationRequests.map((booking): Item => ({ key: `request:${booking.requestId}`, kind: "request", booking })),
    ...queue.paymentReviews.map((booking): Item => ({ key: `review:${booking.publicBookingId}`, kind: "review", booking })),
    ...queue.refunds.map((booking): Item => ({ key: `refund:${booking.refundId}`, kind: "refund", booking })),
  ];
  const supportItems: Item[] = supportList.map((booking): Item => ({ key: `support:${booking.publicBookingId}`, kind: "support", booking }));
  const lookupItem: Item | null = lookup ? { key: `lookup:${lookup.publicBookingId}`, kind: "lookup", booking: lookup } : null;
  const allItems: Item[] = [...todoItems, ...(lookupItem ? [lookupItem] : []), ...supportItems];
  const idOnlyKey = idOnly !== null ? `id:${idOnly}` : null;
  // A choice whose row is gone after a read is no choice.
  const activeKey = selectedKey !== null && (selectedKey === idOnlyKey || allItems.some((item) => item.key === selectedKey)) ? selectedKey : null;
  const defaultItem = tab === "all" ? supportItems[0] ?? todoItems[0] : todoItems[0] ?? supportItems[0];
  const shownKey = activeKey ?? defaultItem?.key ?? null;
  const todoCount = todoItems.length + slotCount;
  const locked = operationLock !== null;
  const dialogOpen = form !== null;

  const rowDetail = (item: Item): string => {
    const { booking } = item;
    if (item.kind === "refund") return `${REFUND_STATE[item.booking.refundStatus](item.booking.failureCode)} · ${item.booking.kind === "FULL" ? "全額" : "一部"} ${yen(item.booking.amount)}`;
    return `${booking.localDate} ${booking.localStartTime} · ${guestLabel(booking)} · ${yen(booking.totalAmount)}`;
  };
  const rowButton = (item: Item, children: ReactNode) => (
    <button
      type="button"
      disabled={locked}
      aria-current={item.key === shownKey ? "true" : undefined}
      onClick={() => setSelectedKey(item.key)}
      className={`${LIST_ROW} w-full text-left hover:bg-sand/60 disabled:opacity-60 ${item.key === shownKey ? "bg-sand" : ""}`}
    >{children}</button>
  );
  const todoRow = (item: Item) => (
    <li key={item.key}>
      {rowButton(item, <>
        <span className="w-24 shrink-0"><StatusPill status={itemPill(item)} /></span>
        <span className="min-w-0 flex-1"><span className={`block ${LIST_ROW_TITLE}`}>{item.booking.experienceTitle}</span><span className={`block ${LIST_ROW_DETAIL}`}>{rowDetail(item)}</span></span>
      </>)}
    </li>
  );
  const allRow = (item: Item) => (
    <li key={item.key}>
      {rowButton(item, <>
        <span className="min-w-0 flex-1"><span className={`block ${LIST_ROW_TITLE}`}>{item.booking.experienceTitle}</span><span className={`block ${LIST_ROW_DETAIL}`}>{rowDetail(item)}</span></span>
        <StatusPill status={itemPill(item)} />
      </>)}
    </li>
  );

  const backToList = (
    <button type="button" disabled={locked} onClick={() => setSelectedKey(null)} className={`${consoleButtonClass("ghost", "sm")} -ml-3 justify-self-start disabled:opacity-50 xl:hidden`}>
      <HostIcon name="chevronLeft" className="size-3.5" />
      一覧
    </button>
  );
  const compensationFace = (publicBookingId: string) => managedCompensationAvailable ? <ManagedCompensationPanel publicBookingId={publicBookingId} onSessionExpired={expireSession} /> : null;

  /** The opened booking: its state and what can be done to it first, then the folds. Every item keeps its face on the page (its case keeps what is typed); one is shown. */
  const face = (item: Item) => {
    const { booking } = item;
    const settlement = settlements.find((entry) => entry.publicBookingId === booking.publicBookingId);
    const extra: (readonly [string, ReactNode])[] = item.kind === "request"
      ? [["依頼", japanTime(item.booking.requestedAtUtc)]]
      : item.kind === "review"
        ? [["受領", `${yen(item.booking.paidAmount)}${item.booking.paidAtUtc ? ` · ${japanTime(item.booking.paidAtUtc)}` : ""}`]]
        : item.kind === "refund"
          ? [["状態", <span key="refund" className="font-bold text-danger">{REFUND_STATE[item.booking.refundStatus](item.booking.failureCode)} · {item.booking.kind === "FULL" ? "全額" : "一部"} {yen(item.booking.amount)} · {japanTime(item.booking.createdAtUtc)}</span>]]
          : [];
    const disabled = !booking.supportEligible || locked;
    const actions = item.kind === "request" ? (
      <>
        <button type="button" disabled={disabled} className={DANGER} onClick={() => open("APPROVE_REQUEST", `approve-${item.booking.requestId}`, { publicBookingId: booking.publicBookingId, refund: { kind: "FULL" } })}>取り消して返金する</button>
        <button type="button" disabled={disabled} className={BUTTON} onClick={() => open("DECLINE_REQUEST", `decline-${item.booking.requestId}`, { publicBookingId: booking.publicBookingId, message: "" })}>お断りする</button>
      </>
    ) : item.kind === "review" ? (
      <button type="button" disabled={disabled} className={DANGER} onClick={() => open("RESOLVE_PAYMENT_REVIEW", `review-${booking.publicBookingId}`, { publicBookingId: booking.publicBookingId })}>全額を返金して取り消す</button>
    ) : item.kind === "refund" ? (
      item.booking.refundStatus === "PENDING" ? (
        <p className="min-w-0 flex-1 text-left text-ink-soft">Stripe の Dashboard で、販売者の口座のこの返金の状態を確かめてください。</p>
      ) : (
        <>
          <button type="button" disabled={disabled} className={BUTTON} onClick={() => open("RETRY_REFUND", `retry-${item.booking.refundId}`, { refundId: item.booking.refundId })}>{item.booking.refundStatus === "FAILED" ? "もう一度返金する" : "もう一度送る"}</button>
          {item.booking.refundStatus === "FAILED" ? <button type="button" disabled={disabled} className={BUTTON} onClick={() => open("CLOSE_REFUND", `close-${item.booking.refundId}`, { refundId: item.booking.refundId, note: "" })}>手作業で済ませた</button> : null}
        </>
      )
    ) : booking.status === "CONFIRMED" ? (
      <button type="button" disabled={locked} className={DANGER} onClick={() => openCancel(`${item.kind}-cancel-${booking.publicBookingId}`, booking.publicBookingId)}>この予約を取り消す</button>
    ) : null;
    return (
      <article key={item.key} hidden={item.key !== shownKey} aria-label={booking.experienceTitle} className="grid gap-3">
        {backToList}
        <section className={HOST_SURFACE}>
          <div className="flex items-start justify-between gap-3 px-4 pt-4">
            <h2 className="min-w-0 font-sans text-[0.9375rem] font-extrabold [overflow-wrap:anywhere]">{booking.experienceTitle}</h2>
            <StatusPill status={itemPill(item)} />
          </div>
          <div className="px-4 py-3"><BookingFacts booking={booking} extra={extra} /></div>
          {actions ? <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3">{actions}</div> : null}
        </section>
        <SupportCasePanel booking={booking} operationLock={operationLock} onBeginContact={beginContact} onContactUnknown={contactUnknown} onReleaseContact={releaseContact} onSessionExpired={expireSession} />
        {compensationFace(booking.publicBookingId)}
        {settlement ? <details className={FOLD}>
          <FoldSummary>決済費用</FoldSummary>
          <div className="border-t border-line px-4 pb-4 [&>section]:mt-3 [&>section]:rounded-none [&>section]:border-0 [&>section]:p-0">
            <SettlementSummaryList items={[settlement]} provider admin heading="決済費用" />
          </div>
        </details> : null}
      </article>
    );
  };
  /** A number that is not a support-ON booking: all that can still be done is to cancel it, and to look at its compensation. */
  const idOnlyFace = (publicBookingId: string) => (
    <article key={`id:${publicBookingId}`} hidden={`id:${publicBookingId}` !== shownKey} aria-label={`予約 ${publicBookingId}`} className="grid gap-3">
      {backToList}
      <section className={HOST_SURFACE}>
        <div className="px-4 pt-4"><h2 className="font-sans text-[0.9375rem] font-extrabold [overflow-wrap:anywhere]">予約 {publicBookingId}</h2></div>
        <p className="px-4 py-3 text-[0.84375rem] text-ink-soft">{NOT_SUPPORT_BOOKING}</p>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3">
          <button type="button" disabled={locked} className={DANGER} onClick={() => open("CANCEL", "cancel-by-id", { publicBookingId, refund: { kind: "FULL" }, reason: "", note: "" })}>この予約を取り消す</button>
        </div>
      </section>
      {compensationFace(publicBookingId)}
    </article>
  );

  /** The confirmation of the open action, in a dialog: what is typed, the latest state and amount, and the two steps. */
  const dialogSpec = (current: NonNullable<Form>): { title: string; fields: ReactNode; label: string } => {
    switch (current.action) {
      case "APPROVE_REQUEST": return { title: "依頼のとおり取り消します", fields: <>{refundFields()}{noteField("メモ（任意・予約者には届きません）", "note")}</>, label: "取り消して返金する" };
      case "DECLINE_REQUEST": return { title: "依頼をお断りします（予約は確定のまま）", fields: noteField("予約者へのメッセージ（英語・メールで届きます）", "message", true), label: "お断りを送る" };
      case "RESOLVE_PAYMENT_REVIEW": return { title: "最新の受領額を全額返金して取り消します", fields: null, label: "返金して取り消す" };
      case "RETRY_REFUND": return { title: "対象の返金を Stripe へ送ります", fields: null, label: "送る" };
      case "CLOSE_REFUND": return { title: "この返金を一覧から外します（Stripe では返金しません）", fields: noteField("どう済ませたか（必須）", "note", true), label: "閉じる" };
      default: return { title: `予約 ${String(current.body.publicBookingId ?? "")} を取り消します`, fields: cancelFields(), label: "取り消して返金する" };
    }
  };
  const dialogLocked = busy || pending !== null || operationLock?.phase !== "FORM";
  const messageClass = (tone: "ok" | "error") => `text-[0.78125rem] leading-normal font-extrabold ${tone === "ok" ? "text-moss" : "text-danger"}`;
  const advance = () => void (pending || preview ? send() : loadPreview());
  const confirmDialog = () => {
    if (!form) return null;
    const { title, fields, label } = dialogSpec(form);
    return (
      <ConfirmDialogFrame
        titleId={dialogTitleId}
        locked={dialogLocked}
        onCancel={cancelFinancialForm}
        cancelDisabled={busy || pending !== null || operationLock?.phase !== "FORM"}
        primary={advance}
        primaryLabel={busy ? "確認しています…" : pending ? "同じ操作の結果を確認" : preview ? label : "最新の状態と金額を確認"}
        primaryDisabled={busy || !canContinueFinancial}
        primaryDanger={preview !== null}
      >
        <div className={`${DIALOG_BODY} grid gap-3`}>
          <h2 id={dialogTitleId} className={DIALOG_TITLE}>{title}</h2>
          <fieldset disabled={dialogLocked} className="grid gap-2"><legend className="sr-only">{title}</legend>{fields}</fieldset>
          {preview ? <div>
            <p className="text-[0.78125rem] font-extrabold text-ink-soft">最新の状態と金額</p>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[0.84375rem]">
              <dt className="text-muted">体験</dt><dd className="[overflow-wrap:anywhere]">{preview.experienceTitle} · {japanTime(preview.startUtc)}</dd>
              <dt className="text-muted">予約</dt><dd className="[overflow-wrap:anywhere]">予約番号 {preview.publicBookingId} · 提供者 {preview.providerId}</dd>
              <dt className="text-muted">結果</dt><dd>状態 {preview.bookingStatus} → {preview.bookingStatusAfter} · 今回の返金 {yen(preview.refundAmount)}</dd>
            </dl>
          </div> : null}
          <p role="status" className={message ? messageClass(message.tone) : "sr-only"}>{message?.text ?? ""}</p>
          {pending ? <p role="status" className="text-sm text-ink-soft">送信済みの操作結果を確認しています。確認が終わるまで内容の変更や中止はできません。</p> : null}
        </div>
      </ConfirmDialogFrame>
    );
  };

  return (
    <HostPageBody>
      <PageHead title="予約">
        <form role="search" className="relative w-44 sm:w-64" onSubmit={(event) => { event.preventDefault(); if (lookupId) void openByBookingId(); }}>
          <HostIcon name="search" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
          <input
            aria-label="予約番号"
            placeholder="予約番号"
            value={lookupId}
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            disabled={supportListBusy || operationLock !== null}
            aria-describedby={operationLock !== null ? "site-lookup-locked" : undefined}
            onChange={(event) => { setLookupId(event.currentTarget.value.trim()); setLookupMessage(""); }}
            className="block h-[38px] w-full rounded-full border border-line-strong bg-canvas pr-3 pl-9 text-[1rem] text-ink disabled:cursor-not-allowed disabled:bg-sand md:text-[0.875rem]"
          />
        </form>
      </PageHead>
      <p role="status" className={!dialogOpen && message ? `mb-3 ${messageClass(message.tone)}` : "sr-only"}>{!dialogOpen ? message?.text ?? "" : ""}</p>
      {operationLock !== null ? <p id="site-lookup-locked" className="mb-3 text-xs text-muted">いまの操作（結果の確認を含む）を終えるまで、別の予約は開けません。</p> : null}
      {lookupMessage && !(lookupMessage === NOT_SUPPORT_BOOKING && activeKey !== null && activeKey === idOnlyKey) ? <p role="status" className="mb-3 text-sm font-bold text-warn">{lookupMessage}</p> : null}

      <div className="xl:grid xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] xl:items-start xl:gap-4">
        <div className={`min-w-0 ${activeKey !== null ? "max-xl:hidden" : ""}`.trim()}>
          <div role="tablist" aria-label="予約の一覧" className="mb-3 flex flex-wrap gap-2">
            {TABS.map((entry) => {
              const count = entry.id === "todo" ? todoCount : entry.id === "news" ? unread : 0;
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  id={`site-tab-${entry.id}`}
                  aria-selected={tab === entry.id}
                  aria-controls={`site-panel-${entry.id}`}
                  disabled={locked}
                  onClick={() => { setTab(entry.id); setSelectedKey(null); }}
                  className={`inline-flex h-8 items-center rounded-full border px-3 text-[0.8125rem] font-bold disabled:opacity-60 ${tab === entry.id ? "border-leaf bg-leaf-pale text-moss" : "border-line-strong bg-canvas text-ink-soft hover:bg-sand"}`}
                >
                  {entry.label}
                  {count > 0 ? <span className="ml-1.5 text-xs">{count}</span> : null}
                </button>
              );
            })}
          </div>

          <div role="tabpanel" id="site-panel-todo" aria-labelledby="site-tab-todo" hidden={tab !== "todo"} className="grid gap-3">
            <div hidden={tab !== "todo"}><TodoSlotCountContext.Provider value={reportSlotCount}>{todoSlot}</TodoSlotCountContext.Provider></div>
            {todoItems.length ? <div className={`${HOST_SURFACE} overflow-hidden`}><ul aria-label="要対応の予約" className="divide-y divide-line">{todoItems.map(todoRow)}</ul></div> : slotCount === 0 ? <p className="text-muted">いま対応が必要なことはありません。</p> : null}
          </div>

          <div role="tabpanel" id="site-panel-all" aria-labelledby="site-tab-all" hidden={tab !== "all"}>
            {supportItems.length ? <div className={`${HOST_SURFACE} overflow-hidden`}><ul aria-label="サポートONの予約一覧" className="divide-y divide-line">{supportItems.map(allRow)}</ul></div> : <p className="text-muted">サポートONで受け付けた予約はまだありません。</p>}
            {supportCursor ? <button type="button" className={`${BUTTON} mt-3`} disabled={supportListBusy} onClick={() => void loadMoreSupport()}>{supportListBusy ? "読み込んでいます…" : "もっと見る"}</button> : null}
            {supportListMessage ? <p role="status" className="mt-2 text-sm font-bold text-warn">{supportListMessage}</p> : null}
          </div>

          <div role="tabpanel" id="site-panel-news" aria-labelledby="site-tab-news" hidden={tab !== "news"}>
            <AdminSupportNotifications initial={notifications} onSessionExpired={expireSession} onUnreadChange={setUnread} />
          </div>

          <div role="tabpanel" id="site-panel-settle" aria-labelledby="site-tab-settle" hidden={tab !== "settle"} className="[&>section]:mt-0">
            <SettlementSummaryList items={settlements} provider admin heading="決済費用" />
          </div>
        </div>

        <div className={`min-w-0 ${activeKey === null ? "max-xl:hidden" : ""}`.trim()}>
          {allItems.map(face)}
          {idOnly !== null ? idOnlyFace(idOnly) : null}
        </div>
      </div>
      {dialogOpen ? confirmDialog() : null}
    </HostPageBody>
  );
}
