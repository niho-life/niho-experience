"use client";

import { useCallback, useState, type ReactNode, type SyntheticEvent } from "react";
import { decodeExperienceAdminSupportAdminListResponse, type ExperienceAdminSupportAdminListResponse } from "@niho-experience/api-client/admin-support-case";
import type { ExperienceSettlementSummary, ExperienceSupportCase, ExperienceSupportNotification, SupportQueue, SupportQueueBooking } from "@niho-experience/experience-store";
import { SettlementSummaryList } from "@/components/settlement/SettlementSummaryList";
import { siteBookingOutcome } from "./site-booking-outcome";

/*
 * サイト予約の取消・返金 (#285 slice 7, docs/guest-booking.md「取消と返金（第7段）」): what NIHO support has to look at
 * among the bookings made on this site, and its actions. Each action is confirmed on the row first and sent with a UUID
 * kept until an answer comes back, so a retry after a lost answer is the same action. After every answer the list is
 * read again. Partial refunds keep NIHO's fee (support enters the amount); full refunds give it back.
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
  REQUESTED: () => "Stripe の受付待ち（10 分以上。自動の再送は 8 回まで）",
  PENDING: () => "Stripe の処理中（7 日以上）",
  FAILED: (code: string | null) => `返金に失敗（${code ?? "理由不明"}）`,
} as const;

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

function SupportCasePanel({ booking, onSessionExpired }: { booking: SupportQueueBooking; onSessionExpired: () => void }) {
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
  const [contactCommand, setContactCommand] = useState<Record<string, unknown> | null>(null);
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    const response = await fetch(`${API}/case?publicBookingId=${encodeURIComponent(booking.publicBookingId)}`, { cache: "no-store", credentials: "same-origin" });
    if (response.status === 401 || response.status === 403) { onSessionExpired(); throw new Error("session"); }
    if (!response.ok) throw new Error(String(response.status));
    const result = await response.json() as { case: ExperienceSupportCase | null; currentAdminUserId: string };
    setCaseData(result.case ?? { publicBookingId: booking.publicBookingId, assignedAdminUserId: null, internalMemo: null, revision: 0, updatedBy: null, updatedAtUtc: new Date(0).toISOString(), events: [] });
    setCurrentAdmin(result.currentAdminUserId);
    setAssignee(result.case?.assignedAdminUserId ?? "");
    setMemo(result.case?.internalMemo ?? "");
    setLoaded(true);
  }, [booking.publicBookingId, onSessionExpired]);
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
    if (loaded || busy) return;
    setBusy(true);
    setMessage("");
    void Promise.all([load(), loadRoster()]).catch(() => setMessage("案件または担当候補を読み込めません。通信状態と権限を確認して再度開いてください。"))
      .finally(() => setBusy(false));
  };
  const save = async () => {
    if (!caseData || busy) return;
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
    if (!contactText.trim() || busy) return;
    const request = contactCommand ?? { action: "CONTACT_GUEST", commandId: crypto.randomUUID(), publicBookingId: booking.publicBookingId, message: contactText.trim() };
    setContactCommand(request);
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(API, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
      const result = await response.json().catch(() => ({})) as { outcome?: string; error?: string };
      if (response.status === 401 || response.status === 403) { onSessionExpired(); return; }
      if (response.ok && result.outcome === "CONTACT_SENT" && siteBookingOutcome(result)) {
        setContactCommand(null); setContactText(""); await load();
        setMessage("予約者への連絡をメール配信キューに登録しました。");
      } else if (response.ok) {
        setMessage("送信結果を確認できません。入力を保持しています。同じ命令IDで照合してください。");
      } else {
        if (response.status < 500) setContactCommand(null);
        setMessage(ERROR_TEXT[result.error ?? ""] ?? "送信結果を確認できません。通信後は同じ命令IDで再試行します。");
      }
    } catch { setMessage("通信できません。再試行すると同じ命令IDで照合します。"); }
    finally { setBusy(false); }
  };
  if (!booking.supportEligible) return <p className="mt-3 rounded-lg bg-sand p-2 text-xs text-muted">受付時のサポートON同意を確認できない予約です。サポート操作は行えません。</p>;
  const changed = caseData !== null && (assignee.trim() !== (caseData.assignedAdminUserId ?? "") || memo.trim() !== (caseData.internalMemo ?? ""));
  const admins = roster?.admins ?? [];
  const retainedAssignee = caseData?.assignedAdminUserId;
  const retainedOutsideRoster = retainedAssignee !== null && retainedAssignee !== undefined && !admins.some((admin) => admin.id === retainedAssignee);
  return <details className="mt-3 rounded-xl border border-line bg-sand/40 p-3" onToggle={(event: SyntheticEvent<HTMLDetailsElement>) => { if (event.currentTarget.open) openPanel(); }}>
    <summary className="cursor-pointer font-bold">Admin案件 · 担当・内部メモ・操作履歴</summary>
    {!loaded ? <p className="mt-2 text-sm text-muted">{message || (busy ? "案件を読み込んでいます…" : "開くと案件情報を読み込みます。")}</p> : caseData ? <div className="mt-3 grid gap-2">
      <label className="grid gap-1 text-sm">担当Admin
        <select className={FIELD} value={assignee} disabled={rosterState !== "ready" || busy || command !== null} onChange={(event) => { setAssignee(event.currentTarget.value); setCommand(null); }}>
          <option value="">未割当</option>
          {retainedOutsideRoster ? <option value={retainedAssignee}>現在の担当を維持（候補外）</option> : null}
          {admins.map((admin) => <option key={admin.id} value={admin.id}>{admin.displayName?.trim() || `管理者 ${admin.id}`}</option>)}
        </select>
      </label>
      {rosterState === "loading" ? <p className="text-xs text-muted">担当候補を確認しています。</p> : rosterState === "error" ? <div><p className="text-xs text-warn">担当候補を確認できません。内部メモは保存できます。</p><button type="button" disabled={busy} className="mt-1 text-sm font-bold underline" onClick={() => { setBusy(true); void loadRoster().catch(() => setMessage("担当候補を読み込めません。通信状態を確認してください。")).finally(() => setBusy(false)); }}>候補を再読込</button></div> : roster?.truncated ? <p className="text-xs text-muted">担当候補は先頭100名です。候補外の現在担当は維持できます。</p> : null}
      {assignee && currentAdmin ? <p className="text-xs text-muted">{assignee === currentAdmin ? "自分が担当です" : "現在の管理者を担当に設定しています"}</p> : null}
      <label className="grid gap-1 text-sm">内部メモ（ホスト・予約者には共有されません）
        <textarea className={`${FIELD} py-2`} rows={3} maxLength={5000} value={memo} disabled={busy || command !== null} onChange={(event) => { setMemo(event.currentTarget.value); setCommand(null); }} />
      </label>
      <button type="button" disabled={!changed || busy} className={`${BUTTON} justify-self-start`} onClick={() => void save()}>{busy ? "保存中…" : command ? "同じ操作を再試行" : "案件情報を保存"}</button>
      <label className="grid gap-1 text-sm">予約者へNIHOサポートから連絡（英語・メール配信）
        <textarea className={`${FIELD} py-2`} rows={3} maxLength={4000} value={contactText} onChange={(event) => { setContactText(event.currentTarget.value); setContactCommand(null); }} />
      </label>
      <button type="button" disabled={!contactText.trim() || busy} className={`${BUTTON} justify-self-start`} onClick={() => void sendContact()}>{busy ? "送っています…" : contactCommand ? "同じ連絡を再試行" : "NIHOサポートとして連絡"}</button>
      {caseData.events.length ? <div><p className="text-xs font-bold text-muted">操作履歴（本文は記録しません）</p><ul className="mt-1 grid gap-1 text-xs text-muted">{caseData.events.map((event, index) => {
        const eventLabel = event.type === "ASSIGNEE_CHANGED" ? "担当変更" : event.type === "GUEST_CONTACT_SENT" ? "予約者へ連絡" : event.type === "SUPPORT_ACTION"
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

export function AdminSiteBookings({ initial, notifications = [], settlements = [] }: { initial: SupportQueue; notifications?: ExperienceSupportNotification[]; settlements?: ExperienceSettlementSummary[] }) {
  const [queue, setQueue] = useState(initial);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [form, setForm] = useState<Form>(null);
  const [pending, setPending] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [cancelId, setCancelId] = useState("");

  const expireSession = useCallback(() => {
    setSessionExpired(true);
    setQueue({ cancellationRequests: [], paymentReviews: [], refunds: [] });
    setForm(null);
    setPending(null);
    setCancelId("");
  }, []);

  const refresh = async () => {
    try {
      const response = await fetch(API, { cache: "no-store", credentials: "same-origin" });
      if (response.ok) setQueue(await response.json() as SupportQueue);
      else if (response.status === 401 || response.status === 403) expireSession();
    } catch {
      // The list stays as it is; the next action reads it again.
    }
  };

  const send = async () => {
    if (!form || busy) return;
    const request = pending ?? { ...form.body, action: form.action, commandId: crypto.randomUUID() };
    setPending(request);
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(API, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
      const result = await response.json().catch(() => ({})) as { outcome?: string; error?: string; refunds?: { status: string }[] };
      if (response.status === 401 || response.status === 403) { expireSession(); return; }
      if (!response.ok) {
        // A refusal is final for this command; a server failure may be retried with the same one.
        if (response.status < 500) setPending(null);
        setMessage({ tone: "error", text: ERROR_TEXT[result.error ?? ""] ?? "送れませんでした。もう一度お試しください（同じ操作として送り直します）" });
        return;
      }
      const outcome = siteBookingOutcome(result);
      if (!outcome || result.outcome === "CONTACT_SENT") {
        setMessage({ tone: "error", text: "操作結果を確認できません。入力を保持しています。同じ操作として照合してください。" });
        return;
      }
      setPending(null);
      setForm(null);
      setMessage(outcome);
      await refresh();
    } catch {
      setMessage({ tone: "error", text: "通信できませんでした。もう一度お試しください（同じ操作として送り直します）" });
    } finally {
      setBusy(false);
    }
  };

  const open = (action: string, key: string, body: Record<string, unknown>) => {
    if (busy || pending) {
      setMessage({ tone: "error", text: "送信済みの操作結果を先に確認してください。確認が終わるまで別の操作は始められません。" });
      return;
    }
    setPending(null);
    setMessage(null);
    setForm({ action, key, body });
  };
  const set = (patch: Record<string, unknown>) => {
    if (busy || pending) return;
    setForm((current) => (current ? { ...current, body: { ...current.body, ...patch } } : current));
  };

  /** The confirmation of the open action, under its row. */
  const confirmPanel = (key: string, title: string, fields: ReactNode, label: string) =>
    form?.key === key ? (
      <div className="mt-3 rounded-xl border border-line bg-sand/50 p-3">
        <p className="font-extrabold">{title}</p>
        <fieldset disabled={busy || pending !== null} className="mt-2 grid gap-2"><legend className="sr-only">{title}</legend>{fields}</fieldset>
        {pending ? <p role="status" className="mt-2 text-sm text-ink-soft">送信済みの操作結果を確認しています。確認が終わるまで内容の変更や中止はできません。</p> : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className={DANGER} disabled={busy} onClick={() => void send()}>{busy ? "確認しています…" : pending ? "同じ操作の結果を確認" : label}</button>
          <button type="button" className={BUTTON} disabled={busy || pending !== null} onClick={() => { setForm(null); setPending(null); }}>やめる</button>
        </div>
      </div>
    ) : null;

  if (sessionExpired) return <main className="mx-auto max-w-4xl px-4 py-8"><h1 className="font-display text-2xl font-medium">Adminの再ログインが必要です</h1><p role="status" className="mt-2 text-ink-soft">権限またはログインの有効期限が切れました。再ログインすると予約・案件・入力を読み直せます。</p></main>;

  const refundFields = (paid: number) => (
    <>
      <fieldset className="flex flex-wrap gap-3">
        <legend className="sr-only">返金</legend>
        <label className="inline-flex items-center gap-1.5"><input type="radio" checked={(form?.body.refund as { kind?: string } | undefined)?.kind !== "PARTIAL"} onChange={() => set({ refund: { kind: "FULL" } })} />全額 {yen(paid)}（NIHO 手数料も返す）</label>
        <label className="inline-flex items-center gap-1.5"><input type="radio" checked={(form?.body.refund as { kind?: string } | undefined)?.kind === "PARTIAL"} onChange={() => set({ refund: { kind: "PARTIAL", amount: 0 } })} />一部（NIHO 手数料も額に比例して返す）</label>
      </fieldset>
      {(form?.body.refund as { kind?: string } | undefined)?.kind === "PARTIAL" ? (
        <label className="grid gap-1">返金額（円、{yen(paid)} 未満）
          <input type="number" min={1} max={paid - 1} inputMode="numeric" className={FIELD} value={String((form?.body.refund as { amount?: number }).amount || "")} onChange={(event) => set({ refund: { kind: "PARTIAL", amount: Number(event.currentTarget.value) } })} />
        </label>
      ) : null}
    </>
  );
  const noteField = (label: string, key: "note" | "message", required = false) => (
    <label className="grid gap-1">{label}
      <textarea rows={3} maxLength={key === "message" ? 2000 : 1000} required={required} className={`${FIELD} py-2`} value={String(form?.body[key] ?? "")} onChange={(event) => set({ [key]: event.currentTarget.value })} />
    </label>
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
              <SupportCasePanel booking={item} onSessionExpired={expireSession} />
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" disabled={!item.supportEligible} className={BUTTON} onClick={() => open("APPROVE_REQUEST", `approve-${item.requestId}`, { publicBookingId: item.publicBookingId, refund: { kind: "FULL" } })}>取り消して返金する</button>
                <button type="button" disabled={!item.supportEligible} className={BUTTON} onClick={() => open("DECLINE_REQUEST", `decline-${item.requestId}`, { publicBookingId: item.publicBookingId, message: "" })}>お断りする</button>
              </div>
              {confirmPanel(`approve-${item.requestId}`, "依頼のとおり取り消します", <>{refundFields(item.totalAmount)}{noteField("メモ（任意・予約者には届きません）", "note")}</>, "取り消して返金する")}
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
              <SupportCasePanel booking={item} onSessionExpired={expireSession} />
              <div className="mt-2"><button type="button" disabled={!item.supportEligible} className={BUTTON} onClick={() => open("RESOLVE_PAYMENT_REVIEW", `review-${item.publicBookingId}`, { publicBookingId: item.publicBookingId })}>全額を返金して取り消す</button></div>
              {confirmPanel(`review-${item.publicBookingId}`, `${yen(item.paidAmount)} を全額返金して取り消します`, null, "返金して取り消す")}
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
              <SupportCasePanel booking={item} onSessionExpired={expireSession} />
              {item.refundStatus === "PENDING" ? (
                <p className="mt-2 text-ink-soft">Stripe の Dashboard で、販売者の口座のこの返金の状態を確かめてください。</p>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" disabled={!item.supportEligible} className={BUTTON} onClick={() => open("RETRY_REFUND", `retry-${item.refundId}`, { refundId: item.refundId })}>{item.refundStatus === "FAILED" ? "もう一度返金する" : "もう一度送る"}</button>
                  {item.refundStatus === "FAILED" ? <button type="button" disabled={!item.supportEligible} className={BUTTON} onClick={() => open("CLOSE_REFUND", `close-${item.refundId}`, { refundId: item.refundId, note: "" })}>手作業で済ませた</button> : null}
                </div>
              )}
              {confirmPanel(`retry-${item.refundId}`, `${yen(item.amount)} の返金を Stripe へ送ります`, null, "送る")}
              {confirmPanel(`close-${item.refundId}`, "この返金を一覧から外します（Stripe では返金しません）", noteField("どう済ませたか（必須）", "note", true), "閉じる")}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="site-cancel" className="mt-8">
        <h2 id="site-cancel" className="text-lg font-extrabold">予約番号で取り消す</h2>
        <p className="text-ink-soft">確定している予約を、全額または一部の返金で取り消します。ホストに通知が届きます。</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <label className="grid min-w-72 flex-1 gap-1">予約番号
            <input className={FIELD} value={cancelId} onChange={(event) => setCancelId(event.currentTarget.value.trim())} />
          </label>
          <button type="button" className={`${BUTTON} self-end`} disabled={!cancelId} onClick={() => open("CANCEL", "cancel-by-id", { publicBookingId: cancelId, refund: { kind: "FULL" }, reason: "", note: "" })}>取り消す</button>
        </div>
        {confirmPanel(
          "cancel-by-id",
          `予約 ${String(form?.body.publicBookingId ?? "")} を取り消します`,
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
          </>,
          "取り消して返金する",
        )}
      </section>
    </main>
  );
}
