"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ExperienceAdminSupportAdminListResponse,
  ExperienceAdminSupportCase,
  ExperienceAdminSupportCaseConflictReason,
  ExperienceAdminSupportCaseReadResponse,
} from "@niho-experience/api-client/admin-support-case";
import {
  decodeExperienceAdminSupportAdminListResponse,
  decodeExperienceAdminSupportCasePatchResponse,
  decodeExperienceAdminSupportCaseReadResponse,
  EXPERIENCE_ADMIN_SUPPORT_CASE_CONFLICT_REASONS,
  EXPERIENCE_ADMIN_SUPPORT_CASE_MEMO_MAX_CODE_POINTS,
} from "@niho-experience/api-client/admin-support-case-schema";
import {
  buildSupportCasePatch,
  draftAfterConflictChoice,
  draftAfterConfirmedPatch,
  normalizeSupportCaseMemo,
  reconcileLatestSupportCase,
  sameDraftAssignment,
  supportCaseDraft,
  supportCaseWriteReasonLabel,
  type AdminSupportCaseDraft,
  type AdminSupportCaseDraftAssignment,
} from "@/admin/support-case";
import { useAdminLeaveProtection } from "./AdminLeaveGuard";

type RequestFailure = "session" | "not-found" | "unavailable" | "invalid";
type RequestResult<T> = { ok: true; data: T } | { ok: false; failure: RequestFailure; conflictReason?: ExperienceAdminSupportCaseConflictReason };
type RosterState = { kind: "idle" | "loading" | "error" } | { kind: "ready"; data: ExperienceAdminSupportAdminListResponse };
type ConflictState = { latest: ExperienceAdminSupportCaseReadResponse | null; loading: boolean; error: boolean } | null;
type RevisionState = "confirmed" | "checking" | "unknown";
type WriteBlockReason = Exclude<ExperienceAdminSupportCaseConflictReason, "REVISION_CONFLICT" | "ASSIGNED_ADMIN_UNAVAILABLE">;

const BUTTON = "inline-flex min-h-10 items-center justify-center rounded-full border border-line-strong px-4 font-extrabold hover:bg-sand disabled:cursor-not-allowed disabled:opacity-45";
const PRIMARY = "inline-flex min-h-10 items-center justify-center rounded-full bg-leaf px-5 font-extrabold hover:bg-leaf-hover disabled:cursor-not-allowed disabled:opacity-45";

function codePointLength(value: string) {
  return Array.from(value).length;
}

function isConflictReason(value: unknown): value is ExperienceAdminSupportCaseConflictReason {
  return typeof value === "string" && (EXPERIENCE_ADMIN_SUPPORT_CASE_CONFLICT_REASONS as readonly string[]).includes(value);
}

async function readCaseResponse(response: Response): Promise<RequestResult<ExperienceAdminSupportCaseReadResponse>> {
  if (response.status === 401) return { ok: false, failure: "session" };
  if (response.status === 404) return { ok: false, failure: "not-found" };
  let body: unknown;
  try { body = await response.json() as unknown; } catch { return { ok: false, failure: "unavailable" }; }
  const decoded = decodeExperienceAdminSupportCaseReadResponse(body);
  return response.ok && decoded ? { ok: true, data: decoded } : { ok: false, failure: "unavailable" };
}

async function requestCase(bookingId: string, signal?: AbortSignal): Promise<RequestResult<ExperienceAdminSupportCaseReadResponse>> {
  let segment: string;
  try { segment = encodeURIComponent(bookingId); } catch { return { ok: false, failure: "invalid" }; }
  try {
    return await readCaseResponse(await fetch(`/admin/api/bookings/${segment}/support-case`, { cache: "no-store", signal }));
  } catch {
    return { ok: false, failure: "unavailable" };
  }
}

async function requestRoster(signal?: AbortSignal): Promise<RequestResult<ExperienceAdminSupportAdminListResponse>> {
  try {
    const response = await fetch("/admin/api/support-admins", { cache: "no-store", signal });
    if (response.status === 401) return { ok: false, failure: "session" };
    let body: unknown;
    try { body = await response.json() as unknown; } catch { return { ok: false, failure: "unavailable" }; }
    const decoded = decodeExperienceAdminSupportAdminListResponse(body);
    return response.ok && decoded ? { ok: true, data: decoded } : { ok: false, failure: "unavailable" };
  } catch {
    return { ok: false, failure: "unavailable" };
  }
}

async function patchCase(bookingId: string, body: NonNullable<ReturnType<typeof buildSupportCasePatch>>): Promise<RequestResult<ExperienceAdminSupportCase>> {
  let segment: string;
  try { segment = encodeURIComponent(bookingId); } catch { return { ok: false, failure: "invalid" }; }
  try {
    const response = await fetch(`/admin/api/bookings/${segment}/support-case`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (response.status === 401) return { ok: false, failure: "session" };
    let value: unknown;
    try { value = await response.json() as unknown; } catch { return { ok: false, failure: "unavailable" }; }
    if (response.status === 409 && typeof value === "object" && value !== null && "reason" in value && isConflictReason((value as { reason: unknown }).reason)) {
      return { ok: false, failure: "unavailable", conflictReason: (value as { reason: ExperienceAdminSupportCaseConflictReason }).reason };
    }
    const decoded = decodeExperienceAdminSupportCasePatchResponse(value);
    return response.ok && decoded ? { ok: true, data: decoded.supportCase } : { ok: false, failure: "unavailable" };
  } catch {
    return { ok: false, failure: "unavailable" };
  }
}

function assignmentText(value: ExperienceAdminSupportCase["assignedAdmin"]) {
  if (value.status === "ACTIVE") return value.displayName?.trim() || `管理者 ${value.id}`;
  return value.status === "UNAVAILABLE" ? "以前の担当は失効しています" : "未担当";
}

function draftAssignmentText(value: AdminSupportCaseDraftAssignment, roster: RosterState) {
  if (value.kind === "unassigned") return "未担当";
  if (value.kind === "unavailable") return "以前の担当は失効しています";
  if (roster.kind === "ready") {
    const admin = roster.data.admins.find((item) => item.id === value.id);
    if (admin) return admin.displayName?.trim() || `管理者 ${admin.id}`;
  }
  return `現在の担当 (${value.id})`;
}

function AssignmentSelect({ draft, baseline, roster, onChange, requiredChange }: { draft: AdminSupportCaseDraftAssignment; baseline: ExperienceAdminSupportCase; roster: RosterState; onChange: (value: AdminSupportCaseDraftAssignment) => void; requiredChange: AdminSupportCaseDraftAssignment | null }) {
  const currentActive = baseline.assignedAdmin.status === "ACTIVE" ? baseline.assignedAdmin : null;
  const options = roster.kind === "ready" ? roster.data.admins : [];
  const draftIndex = draft.kind === "active" ? options.findIndex((admin) => admin.id === draft.id) : -1;
  const isOutside = draft.kind === "active" && draftIndex < 0;
  const outsideOptions: { value: string; id: string; label: string }[] = [];
  if (currentActive && !options.some((admin) => admin.id === currentActive.id)) outsideOptions.push({ value: "current", id: currentActive.id, label: `${currentActive.displayName?.trim() || `管理者 ${currentActive.id}`}（候補外・維持）` });
  if (draft.kind === "active" && isOutside && draft.id !== currentActive?.id) outsideOptions.push({ value: "retained", id: draft.id, label: `入力中の担当（ID: ${draft.id}・候補外）` });
  const value = draft.kind === "unassigned" ? "unassigned" : draft.kind === "unavailable" ? "unavailable" : draftIndex >= 0 ? `roster:${draftIndex}` : outsideOptions.find((option) => option.id === draft.id)?.value ?? "unassigned";
  const mustChange = requiredChange !== null && sameDraftAssignment(requiredChange, draft);
  if (roster.kind !== "ready") return <div><p className="rounded-xl bg-sand/55 px-3 py-2">{draftAssignmentText(draft, roster)}</p><p className="mt-1 text-xs text-muted">{roster.kind === "loading" ? "担当候補を読み込んでいます。" : "担当候補を確認できないため、担当は変更できません。メモは保存できます。"}</p></div>;
  return <div>
    <select aria-label="NIHO事務局の担当" value={value} onChange={(event) => {
      const selected = event.currentTarget.value;
      if (selected === "unassigned") onChange({ kind: "unassigned" });
      else if (selected.startsWith("roster:")) {
        const admin = options[Number(selected.slice(7))];
        if (admin) onChange({ kind: "active", id: admin.id });
      } else {
        const outside = outsideOptions.find((option) => option.value === selected);
        if (outside) onChange({ kind: "active", id: outside.id });
      }
    }} className="block min-h-11 w-full rounded-[10px] border border-line-strong bg-canvas px-3 text-base md:text-sm">
      {draft.kind === "unavailable" ? <option value="unavailable" disabled>以前の担当は失効しています</option> : null}
      <option value="unassigned">担当を解除する（未担当）</option>
      {outsideOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      {options.map((admin, index) => <option key={admin.id} value={`roster:${index}`}>{admin.displayName?.trim() || `管理者 ${admin.id}`}</option>)}
    </select>
    {mustChange ? <p role="alert" className="mt-1 text-xs font-extrabold text-danger">この担当は現在選べません。新しい担当を選ぶか、明示的に解除してください。</p> : null}
    {isOutside ? <p className="mt-1 text-xs text-warn">現在の担当は候補一覧にありません。選び直さない限り担当を変更しません。</p> : null}
    {roster.data.truncated ? <p className="mt-1 text-xs text-warn">候補は先頭100件までです。現在の担当は候補外でも維持されます。</p> : null}
  </div>;
}

export function AdminSupportCaseEditor({ bookingId, enabled, onSessionExpired }: { bookingId: string; enabled: boolean; onSessionExpired: () => void }) {
  const [baseline, setBaseline] = useState<ExperienceAdminSupportCaseReadResponse | null>(null);
  const [draft, setDraft] = useState<AdminSupportCaseDraft | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error" | "not-found">("loading");
  const [retry, setRetry] = useState(0);
  const [roster, setRoster] = useState<RosterState>({ kind: "idle" });
  const [rosterRetry, setRosterRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<"" | "saved" | "saved-unconfirmed">("");
  const [saveError, setSaveError] = useState("");
  const [conflict, setConflict] = useState<ConflictState>(null);
  const [revisionState, setRevisionState] = useState<RevisionState>("unknown");
  const [writeBlockedReason, setWriteBlockedReason] = useState<WriteBlockReason | null>(null);
  const [heldDraft, setHeldDraft] = useState<AdminSupportCaseDraft | null>(null);
  const [requiredAssignmentChange, setRequiredAssignmentChange] = useState<AdminSupportCaseDraftAssignment | null>(null);
  const sequence = useRef(0);
  const saveSequence = useRef(0);
  const bookingRef = useRef(bookingId);
  const mounted = useRef(true);
  const baselineRef = useRef<ExperienceAdminSupportCaseReadResponse | null>(null);
  const draftRef = useRef<AdminSupportCaseDraft | null>(null);

  const patch = useMemo(() => baseline && draft ? buildSupportCasePatch(baseline.supportCase, draft) : null, [baseline, draft]);
  const dirty = patch !== null || heldDraft !== null;
  useAdminLeaveProtection(dirty, saving);
  const memoLength = draft ? codePointLength(draft.memo) : 0;
  const memoInvalid = draft ? memoLength > EXPERIENCE_ADMIN_SUPPORT_CASE_MEMO_MAX_CODE_POINTS || draft.memo.includes("\0") : false;
  const assignmentStillInvalid = requiredAssignmentChange !== null && draft !== null && sameDraftAssignment(requiredAssignmentChange, draft.assignment);

  const replaceBaseline = useCallback((value: ExperienceAdminSupportCaseReadResponse | null) => {
    baselineRef.current = value;
    setBaseline(value);
  }, []);
  const replaceDraft = useCallback((value: AdminSupportCaseDraft | null) => {
    draftRef.current = value;
    setDraft(value);
  }, []);
  const changeDraft = useCallback((change: (current: AdminSupportCaseDraft) => AdminSupportCaseDraft) => {
    const current = draftRef.current;
    if (!current) return;
    const next = change(current);
    draftRef.current = next;
    setDraft(next);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const expire = useCallback(() => {
    if (!mounted.current) return;
    ++sequence.current;
    ++saveSequence.current;
    replaceBaseline(null);
    replaceDraft(null);
    setRoster({ kind: "idle" });
    setSaving(false);
    onSessionExpired();
  }, [onSessionExpired, replaceBaseline, replaceDraft]);

  useEffect(() => {
    bookingRef.current = bookingId;
    const operation = ++sequence.current;
    ++saveSequence.current;
    const controller = new AbortController();
    if (!enabled) return () => controller.abort();
    void requestCase(bookingId, controller.signal).then((result) => {
      if (operation !== sequence.current || controller.signal.aborted) return;
      if (!result.ok) {
        if (result.failure === "session") expire();
        else setLoadState(result.failure === "not-found" ? "not-found" : "error");
        return;
      }
      if (result.data.writeCapability.writable) setRoster({ kind: "loading" });
      replaceBaseline(result.data);
      replaceDraft(supportCaseDraft(result.data.supportCase));
      setRevisionState("confirmed");
      setLoadState("ready");
    });
    return () => controller.abort();
  }, [bookingId, enabled, expire, replaceBaseline, replaceDraft, retry]);

  useEffect(() => {
    if (!baseline?.writeCapability.writable || loadState !== "ready") return;
    const operation = sequence.current;
    const controller = new AbortController();
    void requestRoster(controller.signal).then((result) => {
      if (operation !== sequence.current || controller.signal.aborted) return;
      if (!result.ok) {
        if (result.failure === "session") expire();
        else setRoster({ kind: "error" });
      } else setRoster({ kind: "ready", data: result.data });
    });
    return () => controller.abort();
  }, [baseline?.writeCapability.writable, expire, loadState, rosterRetry]);

  const retryRoster = () => {
    setRoster({ kind: "loading" });
    setRosterRetry((value) => value + 1);
  };

  const confirmLatest = useCallback(async (afterSave: boolean) => {
    const operation = saveSequence.current;
    const id = bookingRef.current;
    setRevisionState("checking");
    const latest = await requestCase(id);
    if (!mounted.current || operation !== saveSequence.current || id !== bookingRef.current) return;
    if (!latest.ok) {
      if (latest.failure === "session") expire();
      else {
        setRevisionState("unknown");
        if (afterSave) setNotice("saved-unconfirmed");
        else setSaveError("最新の保存内容を確認できませんでした。入力は保持しています。");
      }
      return;
    }
    const currentBaseline = baselineRef.current;
    const currentDraft = draftRef.current;
    if (!currentBaseline || !currentDraft) return;
    const reconciliation = reconcileLatestSupportCase(currentBaseline, currentDraft, latest.data);
    if (reconciliation.kind === "confirmed" || reconciliation.kind === "adopt") {
      replaceBaseline(reconciliation.baseline);
      replaceDraft(reconciliation.draft);
      if (!reconciliation.baseline.writeCapability.writable && buildSupportCasePatch(currentBaseline.supportCase, currentDraft)) {
        setWriteBlockedReason(reconciliation.baseline.writeCapability.reason);
        setHeldDraft(currentDraft);
      }
      setRevisionState("confirmed");
      setSaveError("");
      setNotice((current) => afterSave || current === "saved-unconfirmed" ? "saved" : current);
    } else if (reconciliation.kind === "conflict") {
      setRevisionState("unknown");
      setConflict({ latest: reconciliation.latest, loading: false, error: false });
      setSaveError("別の管理者が更新した最新内容との照合が必要です。自分の入力は保持しています。");
      if (afterSave) setNotice("saved");
    } else {
      setRevisionState("unknown");
      setSaveError("同じ改訂番号で内容が一致しません。入力を保持したまま再確認してください。");
      if (afterSave) setNotice("saved-unconfirmed");
    }
  }, [expire, replaceBaseline, replaceDraft]);

  const refreshBlockedLatest = useCallback(async () => {
    const operation = saveSequence.current;
    const id = bookingRef.current;
    setRevisionState("checking");
    const latest = await requestCase(id);
    if (!mounted.current || operation !== saveSequence.current || id !== bookingRef.current) return;
    if (!latest.ok) {
      if (latest.failure === "session") expire();
      else setRevisionState("unknown");
      return;
    }
    const currentBaseline = baselineRef.current;
    if (currentBaseline && latest.data.supportCase.revision < currentBaseline.supportCase.revision) {
      setRevisionState("unknown");
      return;
    }
    replaceBaseline(latest.data);
    setRevisionState("confirmed");
  }, [expire, replaceBaseline]);

  const save = async () => {
    if (!baseline || !draft || !patch || memoInvalid || assignmentStillInvalid || saving || revisionState !== "confirmed" || writeBlockedReason) return;
    const operation = ++saveSequence.current;
    const id = bookingId;
    const submitted = draft;
    setSaving(true); setNotice(""); setSaveError(""); setConflict(null);
    const result = await patchCase(id, patch);
    if (!mounted.current || operation !== saveSequence.current || id !== bookingRef.current) return;
    if (!result.ok) {
      setSaving(false);
      if (result.failure === "session") { expire(); return; }
      if (result.conflictReason === "REVISION_CONFLICT") {
        setRevisionState("unknown");
        setConflict({ latest: null, loading: false, error: false });
        setSaveError("別の管理者が先に更新しました。自分の入力は保持しています。");
      } else if (result.conflictReason === "ASSIGNED_ADMIN_UNAVAILABLE") {
        setRequiredAssignmentChange(submitted.assignment);
        setSaveError("選んだ担当が現在は利用できません。新しい担当を選ぶか、担当を解除してください。");
        retryRoster();
      } else if (result.conflictReason) {
        const reason = result.conflictReason as WriteBlockReason;
        setWriteBlockedReason(reason);
        setHeldDraft(draftRef.current ?? submitted);
        setRevisionState("unknown");
        setSaveError(supportCaseWriteReasonLabel(reason));
        void refreshBlockedLatest();
      } else {
        setRevisionState("unknown");
        setSaveError("保存結果を確認できませんでした。入力は保持しています。最新状態を再確認してください。");
      }
      return;
    }
    const currentBaseline = baselineRef.current;
    const currentDraft = draftRef.current;
    if (!currentBaseline || !currentDraft) return;
    replaceBaseline({ ...currentBaseline, supportCase: result.data });
    replaceDraft(draftAfterConfirmedPatch(currentDraft, submitted, result.data));
    setRequiredAssignmentChange(null);
    setNotice("saved");
    setSaving(false);
    await confirmLatest(true);
  };

  const loadConflictLatest = async () => {
    if (!conflict || conflict.loading || !draft) return;
    const operation = saveSequence.current;
    const id = bookingId;
    setConflict({ ...conflict, loading: true, error: false });
    const result = await requestCase(id);
    if (!mounted.current || operation !== saveSequence.current || id !== bookingRef.current) return;
    if (!result.ok) {
      if (result.failure === "session") expire();
      else setConflict({ latest: null, loading: false, error: true });
      return;
    }
    setConflict({ latest: result.data, loading: false, error: false });
  };

  const resolveConflict = (keepDraft: boolean) => {
    if (!conflict?.latest) return;
    const latest = conflict.latest;
    const currentDraft = draftRef.current;
    const previous = baselineRef.current;
    const nextDraft = keepDraft && currentDraft && previous
      ? draftAfterConflictChoice(previous.supportCase, currentDraft, latest.supportCase)
      : supportCaseDraft(latest.supportCase);
    replaceBaseline(latest);
    replaceDraft(nextDraft);
    if (keepDraft) {
      if (currentDraft && !latest.writeCapability.writable) {
        setWriteBlockedReason(latest.writeCapability.reason);
        setHeldDraft(nextDraft);
      }
    } else {
      setRequiredAssignmentChange(null);
    }
    setConflict(null);
    setRevisionState("confirmed");
    setSaveError("");
  };

  if (!enabled) return <section aria-label="NIHO事務局の内部メモ" className="mt-4 border-t border-line pt-4"><h3 className="font-sans text-xs font-extrabold tracking-[0.04em] text-ink-soft">NIHO事務局の内部メモ</h3><p className="mt-2 rounded-xl bg-sand px-3 py-2 text-[0.8125rem] text-ink-soft">担当・内部メモの編集は準備中です。入力欄はまだ利用できません。</p></section>;
  if (loadState === "loading") return <section aria-label="NIHO事務局の内部メモ" aria-busy="true" className="mt-4 border-t border-line pt-4"><h3 className="font-sans text-xs font-extrabold tracking-[0.04em] text-ink-soft">NIHO事務局の内部メモ</h3><p className="mt-2 text-[0.8125rem] text-muted">担当と内部メモを読み込んでいます…</p></section>;
  if (loadState !== "ready" || !baseline || !draft) return <section aria-label="NIHO事務局の内部メモ" className="mt-4 border-t border-line pt-4"><h3 className="font-sans text-xs font-extrabold tracking-[0.04em] text-ink-soft">NIHO事務局の内部メモ</h3><div role="alert" className="mt-2 rounded-xl bg-danger-pale p-3"><p>{loadState === "not-found" ? "この予約の支援ケースを確認できません。" : "担当と内部メモを読み込めませんでした。空の入力欄は表示していません。"}</p><button type="button" onClick={() => { setLoadState("loading"); replaceBaseline(null); replaceDraft(null); setRevisionState("unknown"); setRetry((value) => value + 1); }} className={`${BUTTON} mt-2 bg-canvas`}>もう一度試す</button></div></section>;

  const writable = baseline.writeCapability.writable && writeBlockedReason === null;
  const readOnlyReason = writeBlockedReason ?? baseline.writeCapability.reason;
  const created = baseline.supportCase.createdAt !== null;
  return <section aria-label="NIHO事務局の内部メモ" className="mt-4 border-t border-line pt-4">
    <div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="font-sans text-xs font-extrabold tracking-[0.04em] text-ink-soft">NIHO事務局の内部メモ</h3><p className="mt-1 text-[0.8125rem] text-muted">Adminだけが確認できます。担当は支援の引継ぎ先で、権限を付与するものではありません。</p></div><span className="rounded-full bg-sand px-2.5 py-1 text-xs font-extrabold">{created ? `改訂 ${baseline.supportCase.revision}` : "未作成"}</span></div>
    {!writable ? <div className="mt-3 grid gap-3"><div className="rounded-xl bg-sand/70 p-3"><p className="font-extrabold">閲覧専用</p><p className="mt-1 text-[0.8125rem] text-ink-soft">{supportCaseWriteReasonLabel(readOnlyReason ?? "")}</p><dl className="mt-3 grid grid-cols-[72px_minmax(0,1fr)] gap-2 text-[0.8125rem]"><dt className="font-bold text-muted">現在の担当</dt><dd className="[overflow-wrap:anywhere]">{assignmentText(baseline.supportCase.assignedAdmin)}</dd><dt className="font-bold text-muted">現在のメモ</dt><dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">{baseline.supportCase.internalMemo || "未記入"}</dd></dl></div>{heldDraft ? <div className="rounded-xl border border-warn bg-warn-pale p-3"><p className="font-extrabold">保存されなかった入力（コピーできます）</p><p className="mt-1 text-[0.8125rem]">担当: {draftAssignmentText(heldDraft.assignment, roster)}</p><label className="mt-2 grid gap-1 text-xs font-extrabold text-ink-soft">内部メモ<textarea readOnly value={heldDraft.memo} rows={5} className="min-h-28 w-full resize-y rounded-[10px] border border-line-strong bg-canvas px-3 py-2 text-base font-normal text-ink md:text-sm" /></label>{revisionState !== "confirmed" ? <button type="button" onClick={() => void refreshBlockedLatest()} disabled={revisionState === "checking"} className={`${BUTTON} mt-2 bg-canvas`}>{revisionState === "checking" ? "確認中…" : "現在の保存内容を再確認"}</button> : null}</div> : null}</div> : <div className="mt-3 grid gap-3">
      <div className="grid gap-1"><p className="text-xs font-extrabold text-ink-soft">担当</p><AssignmentSelect draft={draft.assignment} baseline={baseline.supportCase} roster={roster} requiredChange={requiredAssignmentChange} onChange={(assignment) => { changeDraft((current) => ({ ...current, assignment })); setNotice(""); setSaveError(""); }} /></div>
      {roster.kind === "error" ? <button type="button" onClick={retryRoster} className={`${BUTTON} justify-self-start`}>担当候補を再読み込み</button> : null}
      <label className="grid gap-1 text-xs font-extrabold text-ink-soft">内部メモ<textarea aria-describedby="admin-support-case-memo-help" value={draft.memo} onChange={(event) => { changeDraft((current) => ({ ...current, memo: event.currentTarget.value })); setNotice(""); setSaveError(""); }} rows={6} className="min-h-32 w-full resize-y rounded-[10px] border border-line-strong bg-canvas px-3 py-2 text-base font-normal text-ink md:text-sm" /></label>
      <p id="admin-support-case-memo-help" className={`text-xs ${memoInvalid ? "font-extrabold text-danger" : "text-muted"}`}>保存ボタンで確定します。ホストや予約者には共有されません。{memoLength}/{EXPERIENCE_ADMIN_SUPPORT_CASE_MEMO_MAX_CODE_POINTS}文字{draft.memo.includes("\0") ? "。保存できない文字が含まれています。" : ""}</p>
      {saveError ? <p role="alert" className="rounded-xl bg-danger-pale px-3 py-2 text-[0.8125rem] font-bold text-danger">{saveError}</p> : null}
      {notice ? <p role="status" className="rounded-xl bg-leaf-pale px-3 py-2 text-[0.8125rem] font-bold text-moss">{notice === "saved" ? "保存しました。" : "保存しました。最新の編集可否だけ再確認できませんでした。保存内容は取り消していません。"}</p> : null}
      {revisionState === "unknown" && !conflict ? <button type="button" onClick={() => void confirmLatest(false)} className={`${BUTTON} justify-self-start`}>最新状態を再確認</button> : null}
      <div><button type="button" onClick={() => void save()} disabled={!patch || memoInvalid || assignmentStillInvalid || saving || revisionState !== "confirmed"} className={PRIMARY}>{saving ? "保存中…" : "担当・内部メモを保存"}</button></div>
    </div>}
    {conflict ? <div className="mt-3 rounded-xl border border-warn bg-warn-pale p-3" role="alert"><p className="font-extrabold">最新の内容との照合が必要です</p>{!conflict.latest ? <><p className="mt-1 text-[0.8125rem]">自分の入力はそのまま保持しています。最新の保存内容を確認してから選んでください。</p><button type="button" onClick={() => void loadConflictLatest()} disabled={conflict.loading} className={`${BUTTON} mt-2 bg-canvas`}>{conflict.loading ? "確認中…" : "最新を確認"}</button>{conflict.error ? <p className="mt-2 text-xs font-bold text-danger">最新内容を読み込めませんでした。入力は保持しています。</p> : null}</> : <div className="mt-3 grid gap-3 text-[0.8125rem]"><div className="grid gap-2 sm:grid-cols-2"><div className="rounded-xl bg-canvas p-3"><p className="font-extrabold">最新の保存内容</p><p className="mt-1">担当: {assignmentText(conflict.latest.supportCase.assignedAdmin)}</p><p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">メモ: {conflict.latest.supportCase.internalMemo || "未記入"}</p></div><div className="rounded-xl bg-canvas p-3"><p className="font-extrabold">自分の入力</p><p className="mt-1">担当: {draftAssignmentText(draft.assignment, roster)}</p><p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">メモ: {normalizeSupportCaseMemo(draft.memo) || "未記入"}</p></div></div><div className="flex flex-wrap gap-2"><button type="button" className={PRIMARY} onClick={() => resolveConflict(true)}>最新を基に入力を引き継ぐ</button><button type="button" className={BUTTON} onClick={() => resolveConflict(false)}>自分の変更を破棄</button></div></div>}</div> : null}
  </section>;
}
