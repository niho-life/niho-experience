"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import {
  decodeExperienceAdminSupportOperationDetailResponse,
  decodeExperienceAdminSupportOperationSnapshotResponse,
  isExperienceAdminOperationId,
  type ExperienceAdminOperationAction,
  type ExperienceAdminOperationRequest,
  type ExperienceAdminSupportOperation,
  type ExperienceAdminSupportOperationBookingSnapshot,
  type ExperienceAdminSupportOperationSnapshotResponse,
} from "@niho-experience/api-client/admin-operations";
import { adminDateTime } from "@/admin/date-time";
import { yen } from "@/host/format";
import { useAdminLeaveProtection } from "./AdminLeaveGuard";

type Draft = { action: ExperienceAdminOperationAction; reasonCode: string; refund: "" | "FULL" | "HALF" | "NONE"; subject: string; body: string };
type ImmutableCommand = Readonly<{ action: ExperienceAdminOperationAction; body: ExperienceAdminOperationRequest }>;
type PreparedConfirmation = Readonly<{ action: ExperienceAdminOperationAction; reasonCode: string; refund: Draft["refund"]; subject: string; body: string; booking: ExperienceAdminSupportOperationBookingSnapshot }>;
type OperationRead = ExperienceAdminSupportOperation | "expired" | "not-found" | "invalid" | "stale";
const EMPTY: Draft = { action: "APPROVE", reasonCode: "SUPPORT_REVIEWED", refund: "", subject: "", body: "" };
const TERMINAL = new Set<ExperienceAdminSupportOperation["state"]>(["SUCCEEDED", "REJECTED", "FAILED"]);
const ACTION_LABEL: Record<ExperienceAdminOperationAction, string> = { APPROVE: "承認", DECLINE: "辞退", CANCEL: "取消・返金", MESSAGE: "予約者への連絡" };
const STATE_LABEL: Record<ExperienceAdminSupportOperation["state"], string> = { ACCEPTED: "受付済み", PROCESSING: "結果を確認中", UNKNOWN: "結果を確認できていません", SUCCEEDED: "完了", REJECTED: "受理されませんでした", FAILED: "完了できませんでした" };
const DELIVERY_LABEL: Record<string, string> = { PENDING: "送信処理中", SENT: "メール送信済み", FAILED: "送信できませんでした", UNKNOWN: "送信結果不明" };
const REFUND_LABEL: Record<Exclude<Draft["refund"], "">, string> = { FULL: "全額", HALF: "半額まで", NONE: "返金なし" };
const STATUS_LABEL: Record<string, string> = { PROVISIONAL: "仮予約", CONFIRMED: "予約確定", REFUND_NEEDED: "返金確認待ち", CANCELLED: "取消済み", DECLINED: "辞退済み" };
const REASON_LABEL: Record<string, string> = { STATUS: "現在の予約状態では選べません", SUPPORT_OFF: "この予約では利用できません", PII_RETENTION_EXPIRED: "確認できる期間を過ぎています", APPROVAL_EXPIRED: "承認期限を過ぎています", OPERATION_IN_PROGRESS: "ほかの予約対応の結果を確認中です", PROVIDER_REFUND_UNAVAILABLE: "返金状況を確認できません", WRITES_DISABLED: "現在準備中です" };
const KNOWN_CONFLICTS = new Set(["REVISION_CONFLICT", "BOOKING_SNAPSHOT_CHANGED", "ACTION_NOT_ALLOWED", "APPROVAL_EXPIRED", "REFUND_SNAPSHOT_CHANGED"]);

export const normalizeAdminOperationSubject = (value: string) => value.trim().replace(/\s+/gu, " ");
export const normalizeAdminOperationBody = (value: string) => value.replace(/\r\n?/g, "\n").trim();

export function sameAdminOperationConfirmationSnapshot(a: ExperienceAdminSupportOperationBookingSnapshot, b: ExperienceAdminSupportOperationBookingSnapshot) {
  const selected = (value: ExperienceAdminSupportOperationBookingSnapshot) => ({
    bookingRequestId: value.bookingRequestId, revision: value.revision, host: value.host, guest: value.guest,
    status: value.status, totalYen: value.totalYen, refundedYen: value.refundedYen,
    providerRefund: { status: value.providerRefund.status, refundedYen: value.providerRefund.refundedYen }, refundOptions: value.refundOptions, occurrenceDate: value.occurrenceDate,
    startAt: value.startAt, endAt: value.endAt, approvalDeadlineAt: value.approvalDeadlineAt, actions: value.actions,
  });
  return JSON.stringify(selected(a)) === JSON.stringify(selected(b));
}

async function decodeJson(response: Response) { try { return await response.json() as unknown; } catch { return null; } }
const statusLabel = (status: string) => STATUS_LABEL[status] ?? "確認済みの予約状態";
const capabilityReason = (reason: string | null | undefined) => reason ? (REASON_LABEL[reason] ?? "現在の予約情報では選べません") : "現在の予約情報では選べません";

function OperationMessage({ operation }: { operation: ExperienceAdminSupportOperation }) {
  if (!operation.message) return null;
  if (!operation.message.retained) return <p className="mt-2 rounded-xl bg-sand px-3 py-2 text-xs text-muted">連絡本文の保持期間は終了しました。</p>;
  return <div className="mt-2 rounded-xl bg-sand/60 p-3 text-[0.8125rem]"><p className="font-extrabold">{operation.message.subject ?? "件名の記録なし"}</p><p className="mt-1 whitespace-pre-wrap">{operation.message.body ?? "本文の記録なし"}</p><p className="mt-1 text-xs text-muted">{operation.message.deliveryStatus ? (DELIVERY_LABEL[operation.message.deliveryStatus] ?? "配信状態を確認できません") : "配信状態の記録なし"}</p></div>;
}

function ConfirmationDialog({ prepared, busy, opener, onConfirm, onDismiss }: { prepared: PreparedConfirmation; busy: boolean; opener: RefObject<HTMLButtonElement | null>; onConfirm: () => void; onDismiss: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const selectedRefund = prepared.booking.refundOptions.find((option) => option.choice === prepared.refund) ?? null;
  useEffect(() => {
    const current = dialog.current;
    const focusTarget = opener.current;
    if (current && !current.open) current.showModal();
    back.current?.focus();
    return () => { if (current?.open) current.close(); focusTarget?.focus(); };
  }, [opener]);
  return <dialog ref={dialog} aria-labelledby="admin-operation-confirm-title" aria-describedby="admin-operation-confirm-description" onCancel={(event) => { if (busy) event.preventDefault(); }} onClose={() => { if (!dialog.current?.open) onDismiss(); }} className="m-auto w-[calc(100%-2rem)] max-w-[520px] rounded-2xl border-0 bg-canvas p-0 text-ink shadow-[0_20px_60px_rgb(0_0_0/0.2)] backdrop:bg-ink/40">
    <div className="max-h-[75vh] overflow-y-auto p-5"><h2 id="admin-operation-confirm-title" className="font-sans text-lg font-extrabold">{ACTION_LABEL[prepared.action]}の最終確認</h2><p id="admin-operation-confirm-description" className="mt-2 text-[0.8125rem] text-ink-soft">確定直前に最新の予約情報を読み直します。以下と異なる場合は送信せず、確認画面へ戻ります。</p>
      <dl className="mt-3 grid grid-cols-[96px_minmax(0,1fr)] gap-2 text-[0.8125rem]"><dt className="font-bold text-muted">対象予約</dt><dd className="break-all">{prepared.booking.bookingRequestId}</dd><dt className="font-bold text-muted">ホスト</dt><dd>{prepared.booking.host.displayName}</dd><dt className="font-bold text-muted">予約者</dt><dd>{prepared.booking.guest.displayName || "保持期間終了"}</dd><dt className="font-bold text-muted">開催日時</dt><dd>{adminDateTime(prepared.booking.startAt)}〜{adminDateTime(prepared.booking.endAt)}</dd><dt className="font-bold text-muted">現在状態</dt><dd>{statusLabel(prepared.booking.status)}</dd><dt className="font-bold text-muted">合計</dt><dd>{yen(prepared.booking.totalYen)}</dd><dt className="font-bold text-muted">返金済み</dt><dd>{yen(prepared.booking.refundedYen)}</dd><dt className="font-bold text-muted">承認期限</dt><dd>{prepared.booking.approvalDeadlineAt ? adminDateTime(prepared.booking.approvalDeadlineAt) : "設定なし"}</dd>{selectedRefund ? <><dt className="font-bold text-muted">返金方法</dt><dd>{REFUND_LABEL[selectedRefund.choice]}</dd><dt className="font-bold text-muted">今回の返金</dt><dd>{yen(selectedRefund.refundAmountYen)}</dd><dt className="font-bold text-muted">返金後累計</dt><dd>{yen(selectedRefund.resultRefundedYen)}</dd></> : null}{prepared.action === "MESSAGE" ? <><dt className="font-bold text-muted">件名</dt><dd className="break-words">{prepared.subject}</dd></> : null}</dl>
      {prepared.body ? <div className="mt-3"><p className="text-xs font-extrabold text-muted">実際に送る本文</p><p className="mt-1 whitespace-pre-wrap break-words rounded-xl bg-sand p-3 text-[0.8125rem]">{prepared.body}</p></div> : null}
    </div><div className="flex justify-end gap-2 border-t border-line p-3"><button ref={back} type="button" disabled={busy} onClick={() => dialog.current?.close()} className="min-h-10 rounded-full border border-line-strong px-4 font-extrabold">戻る</button><button type="button" disabled={busy} onClick={onConfirm} className="min-h-10 rounded-full bg-leaf px-4 font-extrabold disabled:opacity-45">この内容で{ACTION_LABEL[prepared.action]}</button></div>
  </dialog>;
}

export function AdminBookingOperations({ bookingId, enabled, recoveredOperationId, onSessionExpired }: { bookingId: string; enabled: boolean; recoveredOperationId: string | null; onSessionExpired: () => void }) {
  const [snapshot, setSnapshot] = useState<ExperienceAdminSupportOperationSnapshotResponse | null>(null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "error" | "not-found" | "invalid">("idle");
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [prepared, setPrepared] = useState<PreparedConfirmation | null>(null);
  const [command, setCommand] = useState<ImmutableCommand | null>(null);
  const commandRef = useRef<ImmutableCommand | null>(null);
  const reusedOperationId = useRef<string | null>(null);
  const [operation, setOperation] = useState<ExperienceAdminSupportOperation | null>(null);
  const [trackedOperationId, setTrackedOperationId] = useState<string | null>(null);
  const [lookupMissing, setLookupMissing] = useState(false);
  const [detail, setDetail] = useState<ExperienceAdminSupportOperation | null>(null);
  const [notice, setNotice] = useState("");
  const [networkCount, setNetworkCount] = useState(0);
  const networkRequests = useRef(new Set<number>());
  const nextNetworkRequest = useRef(0);
  const generation = useRef(0);
  const expired = useRef(false);
  const bookingRef = useRef(bookingId);
  const authoredQuery = useRef<{ value: string | null } | null>(null);
  const snapshotSequence = useRef(0);
  const operationSequence = useRef(0);
  const detailSequence = useRef(0);
  const snapshotController = useRef<AbortController | null>(null);
  const operationController = useRef<AbortController | null>(null);
  const detailController = useRef<AbortController | null>(null);
  const sendLock = useRef(false);
  const confirmLock = useRef(false);
  const opener = useRef<HTMLButtonElement>(null);
  const messageHelpId = useId();

  const beginNetwork = useCallback(() => { const id = ++nextNetworkRequest.current; networkRequests.current.add(id); setNetworkCount(networkRequests.current.size); return id; }, []);
  const endNetwork = useCallback((id: number) => { networkRequests.current.delete(id); setNetworkCount(networkRequests.current.size); }, []);
  const active = useCallback((atGeneration: number, expectedBooking: string, signal?: AbortSignal) => !signal?.aborted && !expired.current && generation.current === atGeneration && bookingRef.current === expectedBooking, []);
  const invalidateRequests = useCallback((expectedGeneration?: number) => {
    if (expectedGeneration !== undefined && generation.current !== expectedGeneration) return;
    ++generation.current; ++snapshotSequence.current; ++operationSequence.current; ++detailSequence.current;
    snapshotController.current?.abort(); operationController.current?.abort(); detailController.current?.abort();
  }, []);
  const draftDirty = draft.reasonCode !== EMPTY.reasonCode || draft.refund !== "" || draft.subject !== "" || draft.body !== "" || draft.action !== "APPROVE";
  const trackedUnresolved = trackedOperationId !== null && (!operation || !TERMINAL.has(operation.state));
  useAdminLeaveProtection(draftDirty || command !== null || trackedUnresolved, networkCount > 0);

  const expire = useCallback(() => {
    expired.current = true; invalidateRequests();
    networkRequests.current.clear(); setNetworkCount(0); sendLock.current = false; confirmLock.current = false; commandRef.current = null;
    reusedOperationId.current = null;
    setCommand(null); setOperation(null); setTrackedOperationId(null); setLookupMissing(false); setDetail(null); setSnapshot(null); setDraft(EMPTY); setNotice(""); setPrepared(null); onSessionExpired();
  }, [invalidateRequests, onSessionExpired]);

  const setOperationQuery = useCallback((operationId: string | null) => {
    authoredQuery.current = { value: operationId };
    const url = new URL(window.location.href);
    if (operationId) url.searchParams.set("operation", operationId); else url.searchParams.delete("operation");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const loadSnapshot = useCallback(async (showLoading = false) => {
    const atGeneration = generation.current; const expectedBooking = bookingId; const sequence = ++snapshotSequence.current;
    snapshotController.current?.abort(); const controller = new AbortController(); snapshotController.current = controller;
    const networkId = beginNetwork(); if (showLoading) setLoadState("loading");
    try {
      let response: Response;
      try { response = await fetch(`/admin/api/bookings/${encodeURIComponent(expectedBooking)}/operations`, { cache: "no-store", signal: controller.signal }); }
      catch { if (active(atGeneration, expectedBooking, controller.signal) && sequence === snapshotSequence.current) setLoadState("error"); return null; }
      if (!active(atGeneration, expectedBooking, controller.signal) || sequence !== snapshotSequence.current) return null;
      if (response.status === 401) { expire(); return null; }
      const value = await decodeJson(response);
      if (!active(atGeneration, expectedBooking, controller.signal) || sequence !== snapshotSequence.current) return null;
      if (response.status === 404) { setLoadState("not-found"); return null; }
      const decoded = decodeExperienceAdminSupportOperationSnapshotResponse(value);
      if (!response.ok || !decoded || decoded.booking.bookingRequestId !== expectedBooking || decoded.operations.some((item) => item.bookingRequestId !== expectedBooking)) { setLoadState(decoded ? "error" : "invalid"); return null; }
      setSnapshot(decoded); setLoadState("idle"); return decoded;
    } finally { endNetwork(networkId); }
  }, [active, beginNetwork, bookingId, endNetwork, expire]);

  const readOperation = useCallback(async (operationId: string, lane: "main" | "detail"): Promise<OperationRead> => {
    const atGeneration = generation.current; const expectedBooking = bookingId;
    const sequenceRef = lane === "main" ? operationSequence : detailSequence;
    const controllerRef = lane === "main" ? operationController : detailController;
    const sequence = ++sequenceRef.current; controllerRef.current?.abort(); const controller = new AbortController(); controllerRef.current = controller;
    const networkId = beginNetwork();
    try {
      let response: Response;
      try { response = await fetch(`/admin/api/bookings/${encodeURIComponent(expectedBooking)}/operations/${encodeURIComponent(operationId)}`, { cache: "no-store", signal: controller.signal }); }
      catch { return active(atGeneration, expectedBooking, controller.signal) && sequence === sequenceRef.current ? "invalid" : "stale"; }
      if (!active(atGeneration, expectedBooking, controller.signal) || sequence !== sequenceRef.current) return "stale";
      if (response.status === 401) { expire(); return "expired"; }
      const value = await decodeJson(response);
      if (!active(atGeneration, expectedBooking, controller.signal) || sequence !== sequenceRef.current) return "stale";
      if (response.status === 404) return "not-found";
      const decoded = decodeExperienceAdminSupportOperationDetailResponse(value);
      if (!response.ok || !decoded || decoded.operation.bookingRequestId !== expectedBooking || decoded.operation.operationId.toLowerCase() !== operationId.toLowerCase()) return "invalid";
      return decoded.operation;
    } finally { endNetwork(networkId); }
  }, [active, beginNetwork, bookingId, endNetwork, expire]);

  const applyOperation = useCallback(async (found: ExperienceAdminSupportOperation, fixed?: ImmutableCommand) => {
    if (reusedOperationId.current === found.operationId.toLowerCase()) {
      setDetail(found); setLoadState("idle");
      setNotice("この受付番号は別の内容で使用済みです。表示する既存の対応は今回の依頼の結果ではありません。入力は保持しています。新しい番号での再送は行いません。");
      return;
    }
    setOperation(found); setDetail(found); setTrackedOperationId(found.operationId); setLookupMissing(false); setOperationQuery(found.operationId); setLoadState("idle"); setNotice(STATE_LABEL[found.state]);
    if (!TERMINAL.has(found.state)) return;
    if (commandRef.current?.body.operationId.toLowerCase() === found.operationId.toLowerCase()) { commandRef.current = null; setCommand(null); }
    if (found.state === "SUCCEEDED" && fixed) setDraft(EMPTY);
    await loadSnapshot(false);
  }, [loadSnapshot, setOperationQuery]);

  const recheck = useCallback(async (operationId: string, fixed?: ImmutableCommand) => {
    setNotice("同じ受付番号で結果を確認しています…");
    const found = await readOperation(operationId, "main");
    if (found === "stale" || found === "expired") return;
    if (found === "not-found") { setLookupMissing(true); setTrackedOperationId(operationId); setNotice("同じ受付番号はまだ確認できません。未実行とは断定せず、同じ番号のまま後で再確認できます。"); return; }
    if (found === "invalid") { setLookupMissing(false); setNotice("確認結果を安全に読み取れませんでした。同じ受付番号の結果は不明です。"); return; }
    await applyOperation(found, fixed);
  }, [applyOperation, readOperation]);

  // A local tracking-URL update must not abort the command that just created it.
  // Booking changes/unmount still invalidate every outstanding response.
  useEffect(() => {
    bookingRef.current = bookingId; expired.current = false; authoredQuery.current = null;
    invalidateRequests();
    return () => invalidateRequests();
  }, [bookingId, enabled, invalidateRequests]);

  useEffect(() => {
    if (authoredQuery.current?.value === recoveredOperationId) {
      authoredQuery.current = null;
      return;
    }
    authoredQuery.current = null;
    invalidateRequests();
    const current = generation.current;
    void Promise.resolve().then(async () => {
      if (current !== generation.current || expired.current) return;
      commandRef.current = null; reusedOperationId.current = null; setCommand(null); setSnapshot(null); setOperation(null); setTrackedOperationId(null); setLookupMissing(false); setDetail(null); setDraft(EMPTY); setPrepared(null); setNotice("");
      if (!enabled) { setLoadState("idle"); return; }
      if (recoveredOperationId !== null) {
        if (!isExperienceAdminOperationId(recoveredOperationId)) { setLoadState("invalid"); return; }
        setLoadState("loading"); setTrackedOperationId(recoveredOperationId); await recheck(recoveredOperationId);
        if (current === generation.current && !expired.current) setLoadState((state) => state === "loading" ? "idle" : state);
      } else await loadSnapshot(true);
    });
  }, [bookingId, enabled, invalidateRequests, loadSnapshot, recoveredOperationId, recheck]);

  const capability = snapshot?.booking.actions[draft.action.toLowerCase() as "approve" | "decline" | "cancel" | "message"];
  const selectedRefund = snapshot?.booking.refundOptions.find((option) => option.choice === draft.refund) ?? null;
  const unresolved = operation !== null && !TERMINAL.has(operation.state);
  const ready = useMemo(() => {
    if (!snapshot || !capability?.allowed || command || trackedUnresolved || unresolved) return false;
    if (draft.action === "APPROVE") return true;
    if (draft.action === "DECLINE") return draft.reasonCode === "HOST_CANNOT_HOST" || draft.reasonCode === "OTHER";
    if (draft.action === "CANCEL") return Boolean(selectedRefund && draft.reasonCode && normalizeAdminOperationBody(draft.body));
    return Boolean(draft.reasonCode && normalizeAdminOperationSubject(draft.subject) && normalizeAdminOperationBody(draft.body));
  }, [capability?.allowed, command, draft, selectedRefund, snapshot, trackedUnresolved, unresolved]);

  function makeCommand(reviewed: PreparedConfirmation): ImmutableCommand | null {
    const source = reviewed.booking; const operationId = crypto.randomUUID();
    const common = { operationId, expectedRevision: source.revision, expectedStatus: source.status, expectedTotalYen: source.totalYen, expectedRefundedYen: source.refundedYen };
    let body: ExperienceAdminOperationRequest;
    if (reviewed.action === "APPROVE" && source.status === "PROVISIONAL") body = { ...common, expectedStatus: "PROVISIONAL", reasonCode: "SUPPORT_REVIEWED" };
    else if (reviewed.action === "DECLINE" && source.status === "PROVISIONAL" && (reviewed.reasonCode === "HOST_CANNOT_HOST" || reviewed.reasonCode === "OTHER")) body = { ...common, expectedStatus: "PROVISIONAL", reasonCode: reviewed.reasonCode };
    else if (reviewed.action === "CANCEL" && (source.status === "CONFIRMED" || source.status === "REFUND_NEEDED") && source.providerRefund.refundedYen !== null) {
      const option = source.refundOptions.find((item) => item.choice === reviewed.refund); if (!option || !(reviewed.reasonCode === "HOST_CANNOT_HOST" || reviewed.reasonCode === "GUEST_REQUEST" || reviewed.reasonCode === "OTHER")) return null;
      body = { ...common, expectedStatus: source.status, expectedProviderRefundedYen: source.providerRefund.refundedYen, expectedRefundAmountYen: option.refundAmountYen, refund: option.choice, reasonCode: reviewed.reasonCode, message: reviewed.body };
    } else if (reviewed.action === "MESSAGE" && (source.status === "PROVISIONAL" || source.status === "CONFIRMED" || source.status === "REFUND_NEEDED" || source.status === "CANCELLED") && (reviewed.reasonCode === "BOOKING_DETAILS" || reviewed.reasonCode === "SCHEDULE_COORDINATION" || reviewed.reasonCode === "OTHER")) body = { ...common, expectedStatus: source.status, reasonCode: reviewed.reasonCode, subject: reviewed.subject, body: reviewed.body };
    else return null;
    return Object.freeze({ action: reviewed.action, body: Object.freeze(body) });
  }

  const send = useCallback(async (fixed: ImmutableCommand) => {
    if (sendLock.current || reusedOperationId.current === fixed.body.operationId.toLowerCase()) return; sendLock.current = true;
    const atGeneration = generation.current; const expectedBooking = bookingId; const sequence = ++operationSequence.current;
    operationController.current?.abort(); const controller = new AbortController(); operationController.current = controller; const networkId = beginNetwork();
    setNotice("同じ受付番号で結果を確認しています…");
    try {
      let response: Response;
      try { response = await fetch(`/admin/api/bookings/${encodeURIComponent(expectedBooking)}/operations`, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: fixed.action, command: fixed.body }), signal: controller.signal }); }
      catch { if (active(atGeneration, expectedBooking, controller.signal) && sequence === operationSequence.current) await recheck(fixed.body.operationId, fixed); return; }
      if (!active(atGeneration, expectedBooking, controller.signal) || sequence !== operationSequence.current) return;
      if (response.status === 401) { expire(); return; }
      const value = await decodeJson(response);
      if (!active(atGeneration, expectedBooking, controller.signal) || sequence !== operationSequence.current) return;
      if (response.status === 409 && value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 2 && (value as { error?: unknown }).error === "conflict" && typeof (value as { reason?: unknown }).reason === "string" && KNOWN_CONFLICTS.has((value as { reason: string }).reason)) {
        commandRef.current = null; setCommand(null); setOperation(null); setTrackedOperationId(null); setLookupMissing(false); setOperationQuery(null);
        setNotice("予約情報が更新されたため、この内容は受理されませんでした。入力は保持しています。最新の内容を確認し、もう一度最終確認してください。");
        await loadSnapshot(false); return;
      }
      if (response.status === 409 && value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && (value as { error?: unknown }).error === "operation_id_reused") {
        reusedOperationId.current = fixed.body.operationId.toLowerCase();
        setOperation(null); setDetail(null); setTrackedOperationId(fixed.body.operationId); setLookupMissing(true); setNotice("この受付番号は別の内容ですでに使われています。今回の依頼の完了とは扱いません。入力は保持しています。同じ番号の既存の対応を確認できます。"); return;
      }
      const decoded = decodeExperienceAdminSupportOperationDetailResponse(value);
      if (!response.ok || !decoded || decoded.operation.bookingRequestId !== expectedBooking || decoded.operation.operationId.toLowerCase() !== fixed.body.operationId.toLowerCase() || decoded.operation.action !== fixed.action) { await recheck(fixed.body.operationId, fixed); return; }
      await applyOperation(decoded.operation, fixed);
    } finally { sendLock.current = false; endNetwork(networkId); }
  }, [active, applyOperation, beginNetwork, bookingId, endNetwork, expire, loadSnapshot, recheck, setOperationQuery]);

  const confirm = useCallback(async () => {
    if (confirmLock.current || sendLock.current || !prepared) return; confirmLock.current = true;
    try {
      const latest = await loadSnapshot(false); if (!latest) return;
      if (!sameAdminOperationConfirmationSnapshot(prepared.booking, latest.booking)) { setPrepared(null); setNotice("予約内容または利用できる対応が変わりました。入力は保持しています。最新の内容を確認してから、もう一度最終確認してください。"); return; }
      const fixed = makeCommand(prepared); if (!fixed) { setPrepared(null); setNotice("最新の予約情報ではこの対応を作成できません。入力を確認してください。"); return; }
      commandRef.current = fixed; setCommand(fixed); setTrackedOperationId(fixed.body.operationId); setLookupMissing(false); setOperationQuery(fixed.body.operationId); setPrepared(null);
      confirmLock.current = false; await send(fixed);
    } finally { confirmLock.current = false; }
  }, [loadSnapshot, prepared, send, setOperationQuery]);

  const openConfirmation = () => {
    if (!snapshot || !ready) return;
    setPrepared(Object.freeze({ action: draft.action, reasonCode: draft.reasonCode, refund: draft.refund, subject: normalizeAdminOperationSubject(draft.subject), body: normalizeAdminOperationBody(draft.body), booking: snapshot.booking }));
  };
  const retry = () => { const fixed = commandRef.current; if (!reusedOperationId.current && fixed && operation?.operationId === fixed.body.operationId && operation.retryAllowed) void send(fixed); };
  const openDetail = async (item: ExperienceAdminSupportOperation) => {
    setDetail(item); if (!item.message && item.action !== "MESSAGE" && item.action !== "CANCEL") return;
    const loaded = await readOperation(item.operationId, "detail"); if (typeof loaded === "object") setDetail(loaded);
  };

  if (!enabled) return <section className="mt-4 border-t border-line pt-4"><h3 className="mb-2 font-sans text-xs font-extrabold tracking-[0.04em] text-ink-soft">予約対応</h3><p className="rounded-xl bg-sand px-3 py-2 text-[0.8125rem] text-ink-soft">予約対応は準備中です。承認・辞退・取消／返金・連絡の送信は行いません。</p></section>;

  return <section className="mt-4 border-t border-line pt-4" aria-busy={networkCount > 0}>
    <h3 className="mb-2 font-sans text-xs font-extrabold tracking-[0.04em] text-ink-soft">予約対応</h3>
    {notice ? <p role={notice.includes("できません") || notice.includes("不明") || notice.includes("受理されません") ? "alert" : "status"} className="mb-3 rounded-xl bg-sand px-3 py-2 text-[0.8125rem] font-bold text-ink-soft">{notice}</p> : null}
    {trackedUnresolved ? <p className="mb-3 rounded-xl border border-warn/30 bg-warn-pale px-3 py-2 text-xs text-ink-soft">この画面を明示的に離れても処理は取り消されません。受付番号を含むURLまたは対応履歴から、後で同じ処理を確認できます。入力中の本文はこの端末から失われます。</p> : null}
    {loadState === "loading" ? <p role="status" className="text-[0.8125rem] text-muted">最新の予約情報を確認しています…</p> : null}
    {loadState === "error" || loadState === "invalid" ? <div role="alert" className="rounded-xl bg-danger-pale p-3 text-[0.8125rem] text-danger"><p>{loadState === "invalid" ? "確認結果を安全に読み取れませんでした。" : "予約対応の状態を読み込めませんでした。"}</p>{trackedOperationId ? <button type="button" onClick={() => void recheck(trackedOperationId, commandRef.current ?? undefined)} className="mt-2 min-h-9 rounded-full border border-danger/40 px-3 font-extrabold">同じ受付番号を再確認</button> : <button type="button" onClick={() => void loadSnapshot(true)} className="mt-2 min-h-9 rounded-full border border-danger/40 px-3 font-extrabold">もう一度確認</button>}</div> : null}
    {loadState === "not-found" && !trackedOperationId ? <p className="rounded-xl bg-sand p-3 text-[0.8125rem] text-ink-soft">予約対応を確認できません。新しい対応は作成しません。</p> : null}
    {trackedOperationId && (!operation || !TERMINAL.has(operation.state) || lookupMissing) ? <button type="button" disabled={networkCount > 0} onClick={() => void recheck(trackedOperationId, commandRef.current ?? undefined)} className="mb-3 min-h-9 rounded-full border border-line-strong px-3 text-[0.8125rem] font-extrabold disabled:opacity-45">同じ受付番号を再確認</button> : null}
    {!snapshot && operation && TERMINAL.has(operation.state) ? <button type="button" disabled={networkCount > 0} onClick={() => void loadSnapshot(true)} className="mb-3 min-h-9 rounded-full border border-line-strong px-3 text-[0.8125rem] font-extrabold disabled:opacity-45">最新の予約情報を確認</button> : null}
    {snapshot ? <>
      <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-2 gap-y-1.5 rounded-xl bg-sand/55 p-3 text-[0.8125rem]"><dt className="font-bold text-muted">ホスト</dt><dd>{snapshot.booking.host.displayName}（{snapshot.booking.host.kind === "SPOT" ? "通常拠点" : "外部提供者"}）</dd><dt className="font-bold text-muted">予約者</dt><dd>{snapshot.booking.guest.displayName || "保持期間終了"}</dd><dt className="font-bold text-muted">開催</dt><dd>{adminDateTime(snapshot.booking.startAt)}〜{adminDateTime(snapshot.booking.endAt)}</dd><dt className="font-bold text-muted">現在状態</dt><dd>{statusLabel(snapshot.booking.status)}</dd><dt className="font-bold text-muted">合計</dt><dd>{yen(snapshot.booking.totalYen)}</dd><dt className="font-bold text-muted">返金済み</dt><dd>{yen(snapshot.booking.refundedYen)}</dd><dt className="font-bold text-muted">決済側返金</dt><dd>{snapshot.booking.providerRefund.status === "UNAVAILABLE" ? "確認できません" : snapshot.booking.providerRefund.refundedYen === null ? "対象外" : yen(snapshot.booking.providerRefund.refundedYen)}</dd>{snapshot.booking.approvalDeadlineAt ? <><dt className="font-bold text-muted">承認期限</dt><dd>{adminDateTime(snapshot.booking.approvalDeadlineAt)}</dd></> : null}</dl>
      <div className="mt-3 grid gap-2"><label className="text-xs font-extrabold text-ink-soft">対応<select aria-label="予約対応" value={draft.action} disabled={Boolean(command) || trackedUnresolved} onChange={(event) => setDraft({ ...EMPTY, action: event.currentTarget.value as ExperienceAdminOperationAction, reasonCode: event.currentTarget.value === "APPROVE" ? "SUPPORT_REVIEWED" : "" })} className="mt-1 block min-h-10 w-full rounded-[10px] border border-line-strong bg-canvas px-3 text-base font-normal md:text-sm">{(["APPROVE", "DECLINE", "CANCEL", "MESSAGE"] as const).map((action) => <option key={action} value={action}>{ACTION_LABEL[action]}</option>)}</select></label>
        {!capability?.allowed ? <p className="text-xs font-extrabold text-warn">この対応は選べません: {capabilityReason(capability?.reason)}</p> : null}
        {draft.action === "DECLINE" || draft.action === "CANCEL" || draft.action === "MESSAGE" ? <label className="text-xs font-extrabold text-ink-soft">定型理由<select value={draft.reasonCode} onChange={(event) => { const value = event.currentTarget.value; setDraft((current) => ({ ...current, reasonCode: value })); }} className="mt-1 block min-h-10 w-full rounded-[10px] border border-line-strong bg-canvas px-3 text-base font-normal md:text-sm"><option value="">選択してください</option>{draft.action === "DECLINE" ? <><option value="HOST_CANNOT_HOST">ホストが開催できない</option><option value="OTHER">その他</option></> : draft.action === "CANCEL" ? <><option value="HOST_CANNOT_HOST">ホストが開催できない</option><option value="GUEST_REQUEST">旅行者の希望</option><option value="OTHER">その他</option></> : <><option value="BOOKING_DETAILS">予約内容</option><option value="SCHEDULE_COORDINATION">日程調整</option><option value="OTHER">その他</option></>}</select></label> : null}
        {draft.action === "CANCEL" ? <fieldset><legend className="text-xs font-extrabold text-ink-soft">返金</legend><div className="mt-1 grid gap-1">{snapshot.booking.refundOptions.map((option) => <label key={option.choice} className="flex min-h-10 items-center gap-2 rounded-xl border border-line px-3 text-[0.8125rem]"><input type="radio" name={`refund-${bookingId}`} checked={draft.refund === option.choice} onChange={() => setDraft((current) => ({ ...current, refund: option.choice }))}/>{REFUND_LABEL[option.choice]} · 今回 {yen(option.refundAmountYen)} · 累計 {yen(option.resultRefundedYen)}</label>)}</div></fieldset> : null}
        {draft.action === "MESSAGE" ? <label className="text-xs font-extrabold text-ink-soft">件名<input value={draft.subject} maxLength={200} onChange={(event) => { const value = event.currentTarget.value; setDraft((current) => ({ ...current, subject: value })); }} className="mt-1 block min-h-10 w-full rounded-[10px] border border-line-strong px-3 text-base font-normal md:text-sm"/></label> : null}
        {draft.action === "MESSAGE" || draft.action === "CANCEL" ? <label className="text-xs font-extrabold text-ink-soft">旅行者に届く本文<textarea aria-label="旅行者に届く本文" aria-describedby={messageHelpId} value={draft.body} maxLength={draft.action === "MESSAGE" ? 4000 : 2000} rows={4} onChange={(event) => { const value = event.currentTarget.value; setDraft((current) => ({ ...current, body: value })); }} className="mt-1 block w-full rounded-[10px] border border-line-strong p-3 text-base font-normal md:text-sm"/><span id={messageHelpId} className="mt-1 block font-normal text-muted">内部メモから自動転記しません。返信先は、送信メールに記載される案内を確認してください。</span></label> : null}
        <button ref={opener} type="button" disabled={!ready || networkCount > 0} onClick={openConfirmation} className="mt-1 min-h-10 rounded-full bg-leaf px-4 font-extrabold enabled:hover:bg-leaf-hover disabled:cursor-not-allowed disabled:opacity-45">最新の予約情報を確認して{ACTION_LABEL[draft.action]}へ</button>
      </div>
    </> : null}

    {operation ? <div className="mt-3 rounded-xl border border-line p-3 text-[0.8125rem]"><p className="font-extrabold">{ACTION_LABEL[operation.action]} · {STATE_LABEL[operation.state]}</p><p className="mt-1 break-all text-xs text-muted">受付番号 {operation.operationId}</p>{operation.resultStatus ? <p className="mt-1">結果: {statusLabel(operation.resultStatus)}</p> : null}{operation.resultRefundedYen !== null ? <p className="mt-1">返金後累計: {yen(operation.resultRefundedYen)}</p> : null}<OperationMessage operation={operation}/>{command && operation.retryAllowed ? <button type="button" disabled={networkCount > 0} onClick={retry} className="mt-2 min-h-9 rounded-full border border-line-strong px-3 font-extrabold">同じ受付番号・内容で再送</button> : null}{command && !operation.retryAllowed ? <p className="mt-2 text-xs font-extrabold text-warn">同じ内容の再送はできません。同じ受付番号で結果だけを再確認できます。</p> : null}</div> : null}

    {snapshot ? <div className="mt-4 border-t border-line pt-3"><div className="flex items-center justify-between"><h4 className="font-sans text-xs font-extrabold tracking-[0.04em] text-ink-soft">NIHO事務局の対応履歴</h4><span className="text-xs text-muted">最大{snapshot.history.limit}件{snapshot.history.truncated ? " · 以前の履歴あり" : ""}</span></div>{snapshot.operations.length ? <ol className="mt-2 divide-y divide-line">{snapshot.operations.map((item) => <li key={item.operationId}><button type="button" onClick={() => void openDetail(item)} className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-2 py-2 text-left text-[0.8125rem]"><span><strong>{ACTION_LABEL[item.action]}</strong><span className="block text-xs text-muted">実行者 NIHO事務局 · {adminDateTime(item.createdAt)}</span></span><span className="text-xs font-extrabold">{STATE_LABEL[item.state]}</span></button></li>)}</ol> : <p className="mt-2 text-[0.8125rem] text-muted">保存済みの対応履歴はありません。</p>}{detail ? <div className="mt-2 rounded-xl bg-sand/45 p-3 text-[0.8125rem]"><p className="font-extrabold">履歴詳細 · {ACTION_LABEL[detail.action]}</p><p className="mt-1">{STATE_LABEL[detail.state]}{detail.resultStatus ? ` · ${statusLabel(detail.resultStatus)}` : ""}</p><OperationMessage operation={detail}/></div> : null}</div> : null}

    {prepared ? <ConfirmationDialog prepared={prepared} busy={networkCount > 0} opener={opener} onConfirm={() => void confirm()} onDismiss={() => setPrepared((current) => current === prepared ? null : current)}/> : null}
  </section>;
}
