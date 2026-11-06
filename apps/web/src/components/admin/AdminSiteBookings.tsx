"use client";

import { useCallback, useId, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import { decodeExperienceAdminSupportAdminListResponse, type ExperienceAdminSupportAdminListResponse } from "@niho-experience/api-client/admin-support-case";
import type { ExperienceSettlementSummary, ExperienceSupportCase, ExperienceSupportNotification, SupportEnabledBookingsPage, SupportQueue, SupportQueueBooking } from "@niho-experience/experience-store";
import { SettlementSummaryList } from "@/components/settlement/SettlementSummaryList";
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
const BUTTON = "min-h-10 rounded-full border border-line-strong px-4 font-extrabold hover:bg-sand disabled:opacity-50";
const DANGER = "min-h-10 rounded-full border border-danger/40 px-4 font-extrabold text-danger hover:bg-danger-pale disabled:opacity-50";
const FIELD = "min-h-10 w-full rounded-xl border border-line-strong bg-canvas px-3";
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
const BOOKING_STATUS: Record<string, { label: string; className: string }> = {
  CONFIRMED: { label: "確定", className: "bg-leaf-pale text-moss" },
  PAYMENT_REVIEW: { label: "確認待ち", className: "bg-sand text-warn" },
  CANCELLED: { label: "取消済み", className: "bg-sand text-muted" },
};

function StatusBadge({ status }: { status: string }) {
  const known = BOOKING_STATUS[status] ?? { label: status, className: "bg-sand text-muted" };
  return <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-extrabold ${known.className}`}>{known.label}</span>;
}

/** Only bookings whose own snapshot records support ON: the server decides, and the screen never shows one it did not. */
const supportRows = (bookings: readonly SupportQueueBooking[]) => bookings.filter((booking) => booking.supportEligible);

const yen = (amount: number) => `¥${amount.toLocaleString("ja-JP")}`;
const japanTime = (utc: string) => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(utc));

function BookingFacts({ booking, extra }: { booking: SupportQueueBooking; extra?: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="font-extrabold [overflow-wrap:anywhere]">{booking.experienceTitle}</p>
      <p className="text-ink-soft">
        {booking.localDate} {booking.localStartTime} · {booking.guestName ?? "（保存期間を過ぎた予約者）"} · {yen(booking.totalAmount)}
        {booking.freeCancellationUntilUtc ? ` · 無料取消 ${japanTime(booking.freeCancellationUntilUtc)} まで` : booking.cancellationPolicy === "NONE" ? " · 返金なしの条件" : ""}
      </p>
      <p className="text-xs text-muted">予約番号 {booking.publicBookingId} · 提供者 {booking.providerId}</p>
      {booking.mailUndeliverable ? <p role="note" className="text-xs font-bold text-warn">予約者のメールアドレスにメールが届きません。この予約者へのメールは送られていません。連絡は電話など別の方法で行ってください。</p> : null}
      {extra}
    </div>
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
  return <details className="mt-3 rounded-xl border border-line bg-sand/40 p-3" onToggle={(event: SyntheticEvent<HTMLDetailsElement>) => { if (event.currentTarget.open) openPanel(); }}>
    <summary className="cursor-pointer font-bold">Admin案件 · 担当・内部メモ・操作履歴</summary>
    {!loaded ? <p className="mt-2 text-sm text-muted">{message || (busy ? "案件を読み込んでいます…" : "開くと案件情報を読み込みます。")}</p> : caseData ? <div className="mt-3 grid gap-2">
      <label className="grid gap-1 text-sm">担当Admin
        <select className={FIELD} value={assignee} disabled={rosterState !== "ready" || busy || command !== null || operationBlocked} onChange={(event) => { setAssignee(event.currentTarget.value); setCommand(null); }}>
          <option value="">未割当</option>
          {retainedOutsideRoster ? <option value={retainedAssignee}>現在の担当を維持（候補外）</option> : null}
          {admins.map((admin) => <option key={admin.id} value={admin.id}>{admin.displayName?.trim() || `管理者 ${admin.id}`}</option>)}
        </select>
      </label>
      {rosterState === "loading" ? <p className="text-xs text-muted">担当候補を確認しています。</p> : rosterState === "error" ? <div><p className="text-xs text-warn">担当候補を確認できません。内部メモは保存できます。</p><button type="button" disabled={busy} className="mt-1 text-sm font-bold underline" onClick={() => { setBusy(true); void loadRoster().catch(() => setMessage("担当候補を読み込めません。通信状態を確認してください。")).finally(() => setBusy(false)); }}>候補を再読込</button></div> : roster?.truncated ? <p className="text-xs text-muted">担当候補は先頭100名です。候補外の現在担当は維持できます。</p> : null}
      {assignee && currentAdmin ? <p className="text-xs text-muted">{assignee === currentAdmin ? "自分が担当です" : "現在の管理者を担当に設定しています"}</p> : null}
      <label className="grid gap-1 text-sm">内部メモ（ホスト・予約者には共有されません）
        <textarea className={`${FIELD} py-2`} rows={3} maxLength={5000} value={memo} disabled={busy || command !== null || operationBlocked} onChange={(event) => { setMemo(event.currentTarget.value); setCommand(null); }} />
      </label>
      <button type="button" disabled={!changed || busy || operationBlocked} className={`${BUTTON} justify-self-start`} onClick={() => void save()}>{busy ? "保存中…" : command ? "同じ操作を再試行" : "案件情報を保存"}</button>
      <label className="grid gap-1 text-sm">予約者へNIHOサポートから連絡（英語・メール配信）
        <textarea className={`${FIELD} py-2`} rows={3} maxLength={4000} value={contactText} disabled={busy || operationLock !== null} onChange={(event) => setContactText(event.currentTarget.value)} />
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
    </div> : <p role="alert" className="mt-2 text-sm text-warn">{message || "この予約は支援案件として開けません。"}</p>}
  </details>;
}

function AdminSupportNotifications({ initial, onSessionExpired }: { initial: ExperienceSupportNotification[]; onSessionExpired: () => void }) {
  const [items, setItems] = useState(initial);
  const [message, setMessage] = useState("");
  const markRead = async (id: string) => {
    try {
      const response = await fetch(`${API}/notifications`, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ notificationId: id }) });
      if (response.status === 401 || response.status === 403) { onSessionExpired(); return; }
      if (!response.ok) throw new Error("read");
      setItems((current) => current.map((item) => item.id === id ? { ...item, read: true } : item));
      setMessage("");
    } catch { setMessage("既読を保存できませんでした。再読み込みして確認してください。"); }
  };
  return <section aria-labelledby="site-booking-notifications" className="mt-6">
    <h2 id="site-booking-notifications" className="text-lg font-extrabold">Admin通知（{items.filter((item) => !item.read).length}件未読）</h2>
    {items.length ? <ul className="mt-2 grid gap-2">{items.map((item) => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line p-3">
      <div className="min-w-0"><p className="font-bold">{({ BOOKING_RECEIVED: "予約を受け付けました", PAYMENT_REVIEW: "支払いの確認が必要です", CANCELLATION_REQUEST: "取消依頼が届きました", BOOKING_CANCELLED: "予約が取り消されました", REFUND_UPDATED: "返金状態が更新されました", GUEST_MESSAGE: "予約者から新しい連絡が届きました" } as Record<string, string>)[item.topic] ?? "予約通知"}</p><p className="break-all text-xs text-muted">{item.publicBookingId} · {japanTime(item.createdAtUtc)}</p></div>
      {item.read ? <span className="text-xs text-muted">既読</span> : <button type="button" className={BUTTON} onClick={() => void markRead(item.id)}>既読にする</button>}
    </li>)}</ul> : <p className="mt-2 text-sm text-muted">通知はありません。</p>}
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

export function AdminSiteBookings({ initial, supportBookings, notifications = [], settlements = [] }: { initial: SupportQueue; supportBookings?: SupportEnabledBookingsPage; notifications?: ExperienceSupportNotification[]; settlements?: ExperienceSettlementSummary[] }) {
  const financialOwnerId = useId();
  const [queue, setQueue] = useState(initial);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [form, setForm] = useState<Form>(null);
  const [preview, setPreview] = useState<SiteBookingPreview | null>(null);
  const [prepared, setPrepared] = useState<Record<string, unknown> | null>(null);
  const [pending, setPending] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [cancelId, setCancelId] = useState("");
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
    setCancelId("");
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
      if (!found) setLookupMessage("サポートONで受け付けた予約に、この予約番号はありません。");
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

  /** The confirmation of the open action, under its row. */
  const confirmPanel = (key: string, title: string, fields: ReactNode, label: string) =>
    form?.key === key ? (
      <div className="mt-3 rounded-xl border border-line bg-sand/50 p-3">
        <p className="font-extrabold">{title}</p>
        <fieldset disabled={busy || pending !== null || operationLock?.phase !== "FORM"} className="mt-2 grid gap-2"><legend className="sr-only">{title}</legend>{fields}</fieldset>
        {preview ? <div className="mt-3 rounded-lg border border-line bg-canvas p-3 text-sm">
          <p className="font-extrabold">最新の状態と金額</p>
          <p>{preview.experienceTitle} · {japanTime(preview.startUtc)}</p>
          <p>予約番号 {preview.publicBookingId} · 提供者 {preview.providerId}</p>
          <p>状態 {preview.bookingStatus} → {preview.bookingStatusAfter} · 今回の返金 {yen(preview.refundAmount)}</p>
        </div> : null}
        {pending ? <p role="status" className="mt-2 text-sm text-ink-soft">送信済みの操作結果を確認しています。確認が終わるまで内容の変更や中止はできません。</p> : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className={preview ? DANGER : BUTTON} disabled={busy || !canContinueFinancial} onClick={() => void (pending || preview ? send() : loadPreview())}>{busy ? "確認しています…" : pending ? "同じ操作の結果を確認" : preview ? label : "最新の状態と金額を確認"}</button>
          <button type="button" className={BUTTON} disabled={busy || pending !== null || operationLock?.phase !== "FORM"} onClick={cancelFinancialForm}>やめる</button>
        </div>
      </div>
    ) : null;

  if (sessionExpired) return <main className="mx-auto max-w-4xl px-4 py-8"><h1 className="font-display text-2xl font-medium">Adminの再ログインが必要です</h1><p role="status" className="mt-2 text-ink-soft">権限またはログインの有効期限が切れました。再ログインすると予約・案件・入力を読み直せます。</p></main>;

  const refundFields = () => (
    <>
      <fieldset className="flex flex-wrap gap-3">
        <legend className="sr-only">返金</legend>
        <label className="inline-flex items-center gap-1.5"><input type="radio" checked={(form?.body.refund as { kind?: string } | undefined)?.kind !== "PARTIAL"} onChange={() => set({ refund: { kind: "FULL" } })} />全額（最新の支払額は次に確認）</label>
        <label className="inline-flex items-center gap-1.5"><input type="radio" checked={(form?.body.refund as { kind?: string } | undefined)?.kind === "PARTIAL"} onChange={() => set({ refund: { kind: "PARTIAL", amount: 0 } })} />一部（NIHO 手数料も額に比例して返す）</label>
      </fieldset>
      {(form?.body.refund as { kind?: string } | undefined)?.kind === "PARTIAL" ? (
        <label className="grid gap-1">返金額（円、最新の返金可能残額以下）
          <input type="number" min={1} inputMode="numeric" className={FIELD} value={String((form?.body.refund as { amount?: number }).amount || "")} onChange={(event) => set({ refund: { kind: "PARTIAL", amount: Number(event.currentTarget.value) } })} />
        </label>
      ) : null}
    </>
  );
  const noteField = (label: string, key: "note" | "message", required = false) => (
    <label className="grid gap-1">{label}
      <textarea rows={3} maxLength={key === "message" ? 2000 : 1000} required={required} className={`${FIELD} py-2`} value={String(form?.body[key] ?? "")} onChange={(event) => set({ [key]: event.currentTarget.value })} />
    </label>
  );

  /** Support's own cancellation of a confirmed booking: reason, full or partial refund, note (the same for every entry). */
  const cancelFields = () => (
    <>
      <label className="grid gap-1">取消理由
        <select className={FIELD} value={String(form?.body.reason ?? "")} onChange={(event) => set({ reason: event.currentTarget.value })}>
          <option value="">選んでください</option>
          {REASONS.map((reason) => <option key={reason.value} value={reason.value}>{reason.label}</option>)}
        </select>
      </label>
      <fieldset className="flex flex-wrap gap-3">
        <legend className="sr-only">返金</legend>
        <label className="inline-flex items-center gap-1.5"><input type="radio" checked={(form?.body.refund as { kind?: string } | undefined)?.kind !== "PARTIAL"} onChange={() => set({ refund: { kind: "FULL" } })} />全額（NIHO 手数料も返す）</label>
        <label className="inline-flex items-center gap-1.5"><input type="radio" checked={(form?.body.refund as { kind?: string } | undefined)?.kind === "PARTIAL"} onChange={() => set({ refund: { kind: "PARTIAL", amount: 0 } })} />一部（NIHO 手数料も額に比例して返す）</label>
      </fieldset>
      {(form?.body.refund as { kind?: string } | undefined)?.kind === "PARTIAL" ? (
        <label className="grid gap-1">返金額（円、支払額未満）
          <input type="number" min={1} inputMode="numeric" className={FIELD} value={String((form?.body.refund as { amount?: number }).amount || "")} onChange={(event) => set({ refund: { kind: "PARTIAL", amount: Number(event.currentTarget.value) } })} />
        </label>
      ) : null}
      {noteField("メモ（任意・予約者には届きません）", "note")}
    </>
  );
  const openCancel = (key: string, publicBookingId: string) => open("CANCEL", key, { publicBookingId, refund: { kind: "FULL" }, reason: "", note: "" });
  /** A support-ON booking: its facts and status, its case, and for a confirmed one support's cancellation. */
  const supportBookingRow = (booking: SupportQueueBooking, keyPrefix: string) => (
    <li key={`${keyPrefix}-${booking.publicBookingId}`} className="min-w-0 rounded-2xl border border-line bg-canvas p-4">
      <StatusBadge status={booking.status} />
      <div className="mt-1"><BookingFacts booking={booking} /></div>
      <SupportCasePanel booking={booking} operationLock={operationLock} onBeginContact={beginContact} onContactUnknown={contactUnknown} onReleaseContact={releaseContact} onSessionExpired={expireSession} />
      {booking.status === "CONFIRMED" ? <div className="mt-2"><button type="button" disabled={operationLock !== null} className={BUTTON} onClick={() => openCancel(`${keyPrefix}-cancel-${booking.publicBookingId}`, booking.publicBookingId)}>この予約を取り消す</button></div> : null}
      {confirmPanel(`${keyPrefix}-cancel-${booking.publicBookingId}`, `予約 ${booking.publicBookingId} を取り消します`, cancelFields(), "取り消して返金する")}
    </li>
  );

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="font-display text-2xl font-medium">サイト予約の取消・返金</h1>
      <p className="mt-1 text-ink-soft">このサイトで受けた予約のうち、NIHO サポートの対応が要るもの。全額返金・一部返金とも、NIHO 手数料も返金額に比例して返します（一部返金の額は入力します）。</p>
      <AdminSupportNotifications initial={notifications} onSessionExpired={expireSession} />
      <SettlementSummaryList items={settlements} provider admin heading="Experience予約の決済費用精算" />
      <p role="status" className={message ? `mt-4 rounded-xl px-3 py-2 font-bold ${message.tone === "ok" ? "bg-leaf-pale text-moss" : "bg-danger-pale text-danger"}` : "sr-only"}>{message?.text ?? ""}</p>

      <section aria-labelledby="site-requests" className="mt-8">
        <h2 id="site-requests" className="text-lg font-extrabold">取消の依頼（{queue.cancellationRequests.length}）</h2>
        <p className="text-ink-soft">無料取消の期限後に予約者が依頼したもの。予約はまだ確定のままです。</p>
        <ul className="mt-2 grid gap-2">
          {queue.cancellationRequests.map((item) => (
            <li key={item.requestId} className="rounded-2xl border border-line bg-canvas p-4">
              <BookingFacts booking={item} extra={<p className="text-xs text-muted">依頼 {japanTime(item.requestedAtUtc)}</p>} />
              <SupportCasePanel booking={item} operationLock={operationLock} onBeginContact={beginContact} onContactUnknown={contactUnknown} onReleaseContact={releaseContact} onSessionExpired={expireSession} />
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" disabled={!item.supportEligible || operationLock !== null} className={BUTTON} onClick={() => open("APPROVE_REQUEST", `approve-${item.requestId}`, { publicBookingId: item.publicBookingId, refund: { kind: "FULL" } })}>取り消して返金する</button>
                <button type="button" disabled={!item.supportEligible || operationLock !== null} className={BUTTON} onClick={() => open("DECLINE_REQUEST", `decline-${item.requestId}`, { publicBookingId: item.publicBookingId, message: "" })}>お断りする</button>
              </div>
              {confirmPanel(`approve-${item.requestId}`, "依頼のとおり取り消します", <>{refundFields()}{noteField("メモ（任意・予約者には届きません）", "note")}</>, "取り消して返金する")}
              {confirmPanel(`decline-${item.requestId}`, "依頼をお断りします（予約は確定のまま）", noteField("予約者へのメッセージ（英語・メールで届きます）", "message", true), "お断りを送る")}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="site-reviews" className="mt-8">
        <h2 id="site-reviews" className="text-lg font-extrabold">確認待ちの支払い（{queue.paymentReviews.length}）</h2>
        <p className="text-ink-soft">仮押さえの期限のあとに届いた支払い。席は確保されていません。受け取った額を全額返金して取り消します。</p>
        <ul className="mt-2 grid gap-2">
          {queue.paymentReviews.map((item) => (
            <li key={item.publicBookingId} className="rounded-2xl border border-line bg-canvas p-4">
              <BookingFacts booking={item} extra={<p className="text-xs text-muted">受領 {yen(item.paidAmount)}{item.paidAtUtc ? ` · ${japanTime(item.paidAtUtc)}` : ""}</p>} />
              <SupportCasePanel booking={item} operationLock={operationLock} onBeginContact={beginContact} onContactUnknown={contactUnknown} onReleaseContact={releaseContact} onSessionExpired={expireSession} />
              <div className="mt-2"><button type="button" disabled={!item.supportEligible || operationLock !== null} className={BUTTON} onClick={() => open("RESOLVE_PAYMENT_REVIEW", `review-${item.publicBookingId}`, { publicBookingId: item.publicBookingId })}>全額を返金して取り消す</button></div>
              {confirmPanel(`review-${item.publicBookingId}`, "最新の受領額を全額返金して取り消します", null, "返金して取り消す")}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="site-refunds" className="mt-8">
        <h2 id="site-refunds" className="text-lg font-extrabold">返金の要対応（{queue.refunds.length}）</h2>
        <p className="text-ink-soft">Stripe が 10 分以上受け付けていない返金、7 日以上終わっていない返金と、失敗した返金。</p>
        <ul className="mt-2 grid gap-2">
          {queue.refunds.map((item) => (
            <li key={item.refundId} className="rounded-2xl border border-line bg-canvas p-4">
              <BookingFacts
                booking={item}
                extra={<p className="text-xs font-bold text-danger">{REFUND_STATE[item.refundStatus](item.failureCode)} · {item.kind === "FULL" ? "全額" : "一部"} {yen(item.amount)} · {japanTime(item.createdAtUtc)}</p>}
              />
              <SupportCasePanel booking={item} operationLock={operationLock} onBeginContact={beginContact} onContactUnknown={contactUnknown} onReleaseContact={releaseContact} onSessionExpired={expireSession} />
              {item.refundStatus === "PENDING" ? (
                <p className="mt-2 text-ink-soft">Stripe の Dashboard で、販売者の口座のこの返金の状態を確かめてください。</p>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" disabled={!item.supportEligible || operationLock !== null} className={BUTTON} onClick={() => open("RETRY_REFUND", `retry-${item.refundId}`, { refundId: item.refundId })}>{item.refundStatus === "FAILED" ? "もう一度返金する" : "もう一度送る"}</button>
                  {item.refundStatus === "FAILED" ? <button type="button" disabled={!item.supportEligible || operationLock !== null} className={BUTTON} onClick={() => open("CLOSE_REFUND", `close-${item.refundId}`, { refundId: item.refundId, note: "" })}>手作業で済ませた</button> : null}
                </div>
              )}
              {confirmPanel(`retry-${item.refundId}`, "対象の返金を Stripe へ送ります", null, "送る")}
              {confirmPanel(`close-${item.refundId}`, "この返金を一覧から外します（Stripe では返金しません）", noteField("どう済ませたか（必須）", "note", true), "閉じる")}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="site-support-bookings" className="mt-8">
        <h2 id="site-support-bookings" className="text-lg font-extrabold">サポートONの予約（{supportList.length}{supportCursor ? "+" : ""}）</h2>
        <form className="mt-2 flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); void openByBookingId(); }}>
          <label className="grid min-w-0 flex-1 basis-60 gap-1">予約番号で開く
            <input className={FIELD} value={lookupId} inputMode="text" autoComplete="off" spellCheck={false} disabled={supportListBusy || operationLock !== null} aria-describedby={operationLock !== null ? "site-lookup-locked" : undefined} onChange={(event) => { setLookupId(event.currentTarget.value.trim()); setLookupMessage(""); }} />
          </label>
          <button type="submit" className={`${BUTTON} self-end`} disabled={!lookupId || supportListBusy || operationLock !== null}>開く</button>
        </form>
        {operationLock !== null ? <p id="site-lookup-locked" className="mt-2 text-xs text-muted">いまの操作（結果の確認を含む）を終えるまで、別の予約は開けません。</p> : null}
        {lookupMessage ? <p role="status" className="mt-2 text-sm font-bold text-warn">{lookupMessage}</p> : null}
        {lookup ? <ul aria-label="予約番号で開いた予約" className="mt-2 grid gap-2">{supportBookingRow(lookup, "lookup")}</ul> : null}
        {supportList.length ? <ul aria-label="サポートONの予約一覧" className="mt-3 grid gap-2">{supportList.map((booking) => supportBookingRow(booking, "support"))}</ul> : <p className="mt-3 text-sm text-muted">サポートONで受け付けた予約はまだありません。</p>}
        {supportCursor ? <button type="button" className={`${BUTTON} mt-3`} disabled={supportListBusy} onClick={() => void loadMoreSupport()}>{supportListBusy ? "読み込んでいます…" : "もっと見る"}</button> : null}
        {supportListMessage ? <p role="status" className="mt-2 text-sm font-bold text-warn">{supportListMessage}</p> : null}
      </section>

      <section aria-labelledby="site-cancel" className="mt-8">
        <h2 id="site-cancel" className="text-lg font-extrabold">予約番号で取り消す</h2>
        <p className="text-ink-soft">確定している予約を、全額または一部の返金で取り消します。ホストに通知が届きます。</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <label className="grid min-w-72 flex-1 gap-1">予約番号
            <input className={FIELD} value={cancelId} disabled={operationLock !== null} onChange={(event) => setCancelId(event.currentTarget.value.trim())} />
          </label>
          <button type="button" className={`${BUTTON} self-end`} disabled={!cancelId || operationLock !== null} onClick={() => open("CANCEL", "cancel-by-id", { publicBookingId: cancelId, refund: { kind: "FULL" }, reason: "", note: "" })}>取り消す</button>
        </div>
        {confirmPanel(
          "cancel-by-id",
          `予約 ${String(form?.body.publicBookingId ?? "")} を取り消します`,
          cancelFields(),
          "取り消して返金する",
        )}
      </section>
    </main>
  );
}
