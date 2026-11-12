"use client";

import { useState } from "react";
import type { AdminAssignmentRow, AssignmentCandidate, AssignmentHistoryItem } from "@niho-experience/experience-store";

const API = "/admin/api/occurrence-assignments";
const BUTTON = "min-h-10 rounded-full border border-line-strong px-4 font-extrabold hover:bg-sand disabled:opacity-50";
const jst = (utc: string) => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "short", timeStyle: "short" }).format(new Date(utc));
const ACTION_LABEL = { CLAIM: "対応する", DECLINE: "行けません", RELEASE: "担当を外れた", SET_FEE: "合意した額を記録" } as const;
const key = (row: Pick<AdminAssignmentRow, "providerId" | "occurrenceId">) => `${row.providerId}\u0000${row.occurrenceId}`;

interface Detail { readonly candidates: readonly AssignmentCandidate[]; readonly history: readonly AssignmentHistoryItem[] }

/**
 * 開催回の担当 (#535 v0): the occurrences with no assignee first, who said 行けません, and recording for someone by hand
 * (the office hears it on LINE or the phone). It never approves, charges or confirms a booking; the 承認後に決済する申込
 * above stays as it is.
 */
export function AdminOccurrenceAssignments({ initial }: { initial: readonly AdminAssignmentRow[] }) {
  const [rows, setRows] = useState(initial);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [subject, setSubject] = useState("");
  const [reason, setReason] = useState("");
  const [fee, setFee] = useState("");

  async function refresh() {
    const response = await fetch(API, { cache: "no-store", credentials: "same-origin" });
    const body = await response.json().catch(() => null) as { rows?: AdminAssignmentRow[] } | null;
    if (!response.ok || !Array.isArray(body?.rows)) throw new Error("refresh");
    setRows(body.rows);
  }

  async function show(row: AdminAssignmentRow) {
    if (busy) return;
    if (open === key(row)) { setOpen(null); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`${API}?providerId=${encodeURIComponent(row.providerId)}&occurrenceId=${encodeURIComponent(row.occurrenceId)}`, { cache: "no-store", credentials: "same-origin" });
      const body = await response.json().catch(() => null) as Detail | null;
      if (!response.ok || !Array.isArray(body?.candidates) || !Array.isArray(body?.history)) throw new Error("detail");
      setDetail(body); setOpen(key(row)); setSubject(body.candidates[0]?.nihoUserId ?? ""); setReason(""); setFee(row.assignee?.agreedFeeYen?.toString() ?? "");
    } catch { setError("履歴と候補を読み込めませんでした。もう一度お試しください。"); }
    finally { setBusy(false); }
  }

  async function send(row: AdminAssignmentRow, payload: Record<string, unknown>, done: string) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(API, {
        method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: row.providerId, occurrenceId: row.occurrenceId, commandId: crypto.randomUUID(), ...payload }),
      });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? String(response.status));
      setNotice(done);
      await refresh();
      setOpen(null);
    } catch (failure) {
      setError(failure instanceof Error && failure.message === "already_assigned"
        ? "すでに別の人が担当です。一覧を読み直しました。外れてもらってから記録し直してください。"
        : failure instanceof Error && failure.message === "conflict"
          ? "この回は受け付けていないか、状態が変わりました。一覧を読み直しました。"
          : "記録できませんでした。状態を読み直して、もう一度お試しください。");
      try { await refresh(); } catch { /* Keep the last snapshot. */ }
    } finally { setBusy(false); }
  }

  const unassigned = rows.filter((row) => row.status === "OPEN").length;
  return <section className="mt-8 rounded-2xl border border-line bg-white p-4 md:p-5" aria-labelledby="occurrence-assignments-heading">
    <h2 id="occurrence-assignments-heading" className="font-display text-xl font-medium">開催回の担当</h2>
    <p className="mt-1 text-sm text-ink-soft">担当できる人が「対応する」を押すと、その人が担当になります（開催回に1人）。LINEなどで返事をもらったときは、ここで代わりに記録できます。担当が決まっても、予約者への承認・支払い・予約の確定は済みになりません。予約者には担当を知らせません。</p>
    <p className="mt-2 text-sm font-bold">{unassigned === 0 ? "担当が決まっていない回はありません。" : `担当が決まっていない回：${unassigned}件`}</p>
    {error ? <p role="alert" className="mt-3 rounded-xl bg-danger-pale p-3 text-sm text-danger">{error}</p> : null}
    {notice ? <p role="status" className="mt-3 rounded-xl bg-leaf-pale p-3 text-sm text-moss">{notice}</p> : null}
    {rows.length === 0 ? null : <ul className="mt-4 space-y-3">
      {rows.map((row) => {
        const expanded = open === key(row) && detail !== null;
        return <li key={key(row)} className="rounded-xl border border-line bg-canvas p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-extrabold">{row.experienceTitle}</p>
              <p className="text-sm text-ink-soft">{row.localDate} {row.localStartTime} · 申込・予約 {row.bookingCount}件 · {row.participants}名</p>
              <p className="mt-1 text-xs text-muted">最初の申込 {jst(row.firstRequestedAtUtc)}</p>
              {row.assignee ? <p className="mt-1 text-sm">担当：<span className="font-bold">{row.assignee.label}</span>（{jst(row.assignee.claimedAtUtc)}{row.assignee.recordedByAdmin ? "・事務局が記録" : ""}）{row.assignee.agreedFeeYen === null ? " · 合意した額：未設定" : ` · 合意した額：¥${row.assignee.agreedFeeYen.toLocaleString("ja-JP")}`}</p> : null}
              {row.declined.length ? <p className="mt-1 text-sm text-ink-soft">行けません：{row.declined.map((item) => `${item.label}${item.reason ? `（${item.reason}）` : ""}`).join("、")}</p> : null}
            </div>
            <span className={`rounded-full px-2.5 py-1 text-xs font-extrabold ${row.status === "OPEN" ? "bg-warn-pale text-warn" : "bg-sand"}`}>{row.status === "OPEN" ? "募集中" : "担当あり"}</span>
          </div>
          <div className="mt-3"><button type="button" className={BUTTON} disabled={busy} onClick={() => void show(row)}>{expanded ? "閉じる" : "記録・履歴"}</button></div>
          {expanded ? <div className="mt-3 space-y-3 rounded-xl border border-line bg-white p-3">
            {row.status === "OPEN" ? <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-xs font-extrabold text-ink-soft">だれについて記録するか
                <select value={subject} onChange={(event) => setSubject(event.target.value)} className="mt-1 block w-full rounded-lg border border-line-strong px-3 py-2 text-sm font-normal">
                  {detail.candidates.map((person) => <option key={person.nihoUserId} value={person.nihoUserId}>{person.label}{person.kind === "OPERATOR" ? "（商品の運営者）" : ""}</option>)}
                </select>
              </label>
              <label className="text-xs font-extrabold text-ink-soft">連絡の方法やひとこと（任意）
                <input value={reason} maxLength={300} onChange={(event) => setReason(event.target.value)} className="mt-1 block w-full rounded-lg border border-line-strong px-3 py-2 text-sm font-normal" />
              </label>
              <div className="flex flex-wrap gap-2 sm:col-span-2">
                <button type="button" className={BUTTON} disabled={busy || !subject} onClick={() => void send(row, { action: "CLAIM", subjectNihoUserId: subject, reason }, "担当として記録しました。")}>この人が対応すると記録</button>
                <button type="button" className={BUTTON} disabled={busy || !subject} onClick={() => void send(row, { action: "DECLINE", subjectNihoUserId: subject, reason }, "行けないと記録しました。")}>この人は行けないと記録</button>
              </div>
            </div> : <div className="space-y-2">
              <label className="block text-xs font-extrabold text-ink-soft">合意した額（円・空欄は未設定）。計算・送金はしません。
                <input inputMode="numeric" value={fee} onChange={(event) => setFee(event.target.value.replace(/[^0-9]/g, ""))} className="mt-1 block w-40 rounded-lg border border-line-strong px-3 py-2 text-sm font-normal" />
              </label>
              <label className="block text-xs font-extrabold text-ink-soft">理由・ひとこと（任意。担当を外すときの記録に使います）
                <input value={reason} maxLength={300} onChange={(event) => setReason(event.target.value)} className="mt-1 block w-full rounded-lg border border-line-strong px-3 py-2 text-sm font-normal" />
              </label>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={BUTTON} disabled={busy} onClick={() => void send(row, { action: "SET_FEE", assignmentId: row.assignee?.assignmentId, agreedFeeYen: fee === "" ? null : Number(fee) }, "合意した額を記録しました。")}>額を記録</button>
                <button type="button" className={BUTTON} disabled={busy} onClick={() => { if (window.confirm("この人の担当を外し、募集中に戻しますか？予約者の予約は変わりません。")) void send(row, { action: "RELEASE", reason }, "担当を外して募集中に戻しました。"); }}>担当を外して募集中に戻す</button>
              </div>
            </div>}
            <div>
              <p className="text-xs font-extrabold text-ink-soft">履歴（追記のみ）</p>
              {detail.history.length === 0 ? <p className="mt-1 text-sm text-muted">まだありません。</p> : <ol className="mt-1 space-y-1 text-sm">
                {detail.history.map((item) => <li key={item.id}>{jst(item.atUtc)} · {item.subject.label} · {ACTION_LABEL[item.action]}{item.recordedBy === "ADMIN" ? "（事務局が代わりに記録）" : ""}{item.feeYen !== null ? ` ¥${item.feeYen.toLocaleString("ja-JP")}` : ""}{item.reason ? ` · ${item.reason}` : ""}</li>)}
              </ol>}
            </div>
          </div> : null}
        </li>;
      })}
    </ul>}
  </section>;
}
