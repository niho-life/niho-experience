"use client";

import { useState } from "react";
import type { AssignmentHistoryItem, AssignmentOccurrence, HostAssignmentList } from "@niho-experience/experience-store";
import { claimAssignment, declineAssignment, loadAssignmentHistory, releaseAssignment } from "@/host/actions";
import {
  ASSIGNMENT_ACTION_FAILED_TEXT, ASSIGNMENT_ACTION_LABEL, ASSIGNMENT_NOTE, type assignmentFor,
} from "@/host/assignments";
import { monthDayJa, yen } from "@/host/format";
import { consoleButtonClass, HOST_SURFACE } from "./host-ui";

const jst = (utc: string) => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(utc));
const when = (item: AssignmentOccurrence) => `${monthDayJa(item.localDate)} ${item.localStartTime}`;

function historyText(item: AssignmentHistoryItem): string {
  const who = item.subject.kind === "YOU" ? "あなた" : "別のメンバー";
  const how = item.recordedBy === "ADMIN" ? "（事務局が代わりに記録）" : "";
  const fee = item.feeYen !== null ? ` ${yen(item.feeYen)}` : "";
  return `${who}：${ASSIGNMENT_ACTION_LABEL[item.action]}${how}${fee}${item.reason ? ` · ${item.reason}` : ""}`;
}

/** The history of one occurrence, read when it is opened: when / who / what / why. No names, nobody else's reason or fee. */
function History({ providerId, occurrenceId }: { providerId: string; occurrenceId: string }) {
  const [state, setState] = useState<{ status: "closed" } | { status: "busy" } | { status: "open"; items: readonly AssignmentHistoryItem[] } | { status: "failed"; message: string }>({ status: "closed" });
  async function toggle() {
    if (state.status === "open") { setState({ status: "closed" }); return; }
    setState({ status: "busy" });
    const result = await loadAssignmentHistory({ providerId, occurrenceId }).catch(() => null);
    setState(result?.ok ? { status: "open", items: result.history } : { status: "failed", message: result?.message ?? ASSIGNMENT_ACTION_FAILED_TEXT });
  }
  return (
    <div className="mt-2">
      <button type="button" onClick={() => void toggle()} disabled={state.status === "busy"} aria-expanded={state.status === "open"} className="text-[0.78125rem] font-extrabold text-ink-soft underline underline-offset-2 hover:text-ink">
        {state.status === "open" ? "履歴を閉じる" : "履歴を見る"}
      </button>
      {state.status === "failed" ? <p role="alert" className="mt-1 text-[0.78125rem] text-danger">{state.message}</p> : null}
      {state.status === "open" ? (
        state.items.length === 0 ? <p className="mt-1 text-[0.78125rem] text-muted">まだありません。</p> : (
          <ol aria-label="担当の履歴" className="mt-1">
            {state.items.map((item) => (
              <li key={item.id} className="flex gap-2.5 py-0.5 text-[0.78125rem] leading-normal">
                <time dateTime={item.atUtc} className="w-[84px] shrink-0 text-muted tabular-nums">{jst(item.atUtc)}</time>
                <span className="min-w-0 [overflow-wrap:anywhere]">{historyText(item)}</span>
              </li>
            ))}
          </ol>
        )
      ) : null}
    </div>
  );
}

/** One occurrence's controls: 対応する / 行けません while open, 担当を外れる for the assignee. */
function Controls({ providerId, item, onList }: { providerId: string; item: AssignmentOccurrence; onList: (list: HostAssignmentList) => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "alert"; text: string } | null>(null);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");

  async function send(run: () => ReturnType<typeof claimAssignment>) {
    if (busy) return;
    setBusy(true); setMessage(null);
    try {
      const result = await run();
      if (result.list) onList(result.list);
      // A late 対応する (someone else already took it) is an answer, not a failure: the list now says 担当済み.
      setMessage({ tone: result.ok ? "ok" : "alert", text: result.message || ASSIGNMENT_ACTION_FAILED_TEXT });
      if (result.ok || result.list) { setDeclining(false); setReason(""); }
    } catch { setMessage({ tone: "alert", text: ASSIGNMENT_ACTION_FAILED_TEXT }); }
    finally { setBusy(false); }
  }
  // One command ID per press: a repeated request for the same press is the same command.
  const commandId = () => crypto.randomUUID();

  return (
    <div className="mt-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {item.status === "OPEN" ? (
          <>
            <button type="button" disabled={busy} onClick={() => void send(() => claimAssignment({ providerId, occurrenceId: item.occurrenceId, commandId: commandId() }))} className={consoleButtonClass("primary", "md")}>
              {busy ? "送っています…" : "対応する"}
            </button>
            {item.declinedByMe ? <span className="text-[0.78125rem] text-muted">行けないと伝えています</span> : (
              <button type="button" disabled={busy} onClick={() => setDeclining((value) => !value)} aria-expanded={declining} className={consoleButtonClass("ghost", "md")}>行けません</button>
            )}
          </>
        ) : item.assignedToMe ? (
          <button type="button" disabled={busy} onClick={() => { if (window.confirm("担当を外れて、募集中に戻しますか？予約者の予約は変わりません。")) void send(() => releaseAssignment({ providerId, occurrenceId: item.occurrenceId, commandId: commandId() })); }} className={consoleButtonClass("secondary", "md")}>
            担当を外れる
          </button>
        ) : null}
      </div>
      {declining ? (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 text-[0.78125rem] font-extrabold text-ink-soft">理由（任意・事務局だけが見ます）
            <input value={reason} maxLength={300} onChange={(event) => setReason(event.target.value)} className="mt-1 block min-h-10 w-full rounded-[10px] border border-line-strong bg-canvas px-3 text-[1rem] font-normal text-ink md:text-[0.875rem]" />
          </label>
          <button type="button" disabled={busy} onClick={() => void send(() => declineAssignment({ providerId, occurrenceId: item.occurrenceId, commandId: commandId(), reason }))} className={consoleButtonClass("secondary", "md")}>行けないと伝える</button>
        </div>
      ) : null}
      {message ? <p role={message.tone === "alert" ? "alert" : "status"} className={`mt-1.5 text-[0.8125rem] leading-normal font-bold ${message.tone === "alert" ? "text-danger" : "text-moss"}`}>{message.text}</p> : null}
    </div>
  );
}

function Fee({ item }: { item: AssignmentOccurrence }) {
  return <p className="mt-1 text-[0.8125rem] leading-normal text-ink-soft">あなたの報酬（合意した額）：{item.agreedFeeYen === null ? "未設定" : yen(item.agreedFeeYen)}</p>;
}

/**
 * 担当 (#535 v0): the occurrences of NIHO-managed requests that need someone, and the ones you are on. The first to press
 * 対応する becomes the assignee (one per occurrence); 行けません is optional input. It is an internal record: the guest sees
 * nothing of it, and it does not approve, charge or confirm a booking.
 */
export function HostAssignments({ providerId, list, onList }: { providerId: string; list: HostAssignmentList; onList: (list: HostAssignmentList) => void }) {
  if (list.open.length === 0 && list.mine.length === 0) return null;
  return (
    <section aria-labelledby="host-assignments-heading" className={`${HOST_SURFACE} mb-3.5 overflow-hidden`}>
      <div className="px-3.5 pt-3 md:px-4">
        <h2 id="host-assignments-heading" className="font-sans text-[0.9375rem] leading-normal font-extrabold tracking-normal">担当</h2>
        <p className="mt-0.5 text-[0.78125rem] leading-normal text-ink-soft">{ASSIGNMENT_NOTE}</p>
      </div>
      {list.open.length ? (
        <div className="mt-2 border-t border-line">
          <h3 className="bg-sand/60 px-3.5 py-2 font-sans text-xs leading-normal font-extrabold text-ink-soft md:px-4">募集中（{list.open.length}）</h3>
          <ul>
            {list.open.map((item) => (
              <li key={`${item.providerId}-${item.occurrenceId}`} className="border-t border-line px-3.5 py-3 first:border-t-0 md:px-4">
                <p className="text-[0.875rem] leading-[1.4] font-extrabold [overflow-wrap:anywhere]">{when(item)} · {item.experienceTitle}</p>
                <p className="text-[0.8125rem] leading-normal text-ink-soft">申込・予約 {item.bookingCount}件 · {item.participants}名 · 最初の申込 {jst(item.firstRequestedAtUtc)}</p>
                <Controls providerId={providerId} item={item} onList={onList} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {list.mine.length ? (
        <div className="mt-2 border-t border-line">
          <h3 className="bg-sand/60 px-3.5 py-2 font-sans text-xs leading-normal font-extrabold text-ink-soft md:px-4">あなたが担当（{list.mine.length}）</h3>
          <ul>
            {list.mine.map((item) => (
              <li key={`${item.providerId}-${item.occurrenceId}`} className="border-t border-line px-3.5 py-3 first:border-t-0 md:px-4">
                <p className="text-[0.875rem] leading-[1.4] font-extrabold [overflow-wrap:anywhere]">{when(item)} · {item.experienceTitle}</p>
                <p className="text-[0.8125rem] leading-normal text-ink-soft">申込・予約 {item.bookingCount}件 · {item.participants}名</p>
                <Fee item={item} />
                <Controls providerId={providerId} item={item} onList={onList} />
                <History providerId={providerId} occurrenceId={item.occurrenceId} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/** 予約の詳細 › 担当: who is on this booking's occurrence (you, someone else, or nobody yet) and its history. */
export function HostAssignmentDetail({ providerId, found, onList }: { providerId: string; found: NonNullable<ReturnType<typeof assignmentFor>>; onList: (list: HostAssignmentList) => void }) {
  const { kind, occurrence } = found;
  return (
    <div>
      <p className="text-[0.8125rem] leading-normal">
        {kind === "MINE" ? <span className="font-extrabold text-moss">あなたが担当です</span> : kind === "TAKEN" ? <span className="font-extrabold">担当が決まっています（別のメンバー）</span> : <span className="font-extrabold text-warn">担当を募集中です</span>}
      </p>
      {kind === "MINE" ? <Fee item={occurrence} /> : null}
      {kind !== "TAKEN" ? <Controls providerId={providerId} item={occurrence} onList={onList} /> : null}
      <History providerId={providerId} occurrenceId={occurrence.occurrenceId} />
    </div>
  );
}
