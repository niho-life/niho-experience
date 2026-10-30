"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { HOST_DIALOG } from "@/components/host/HostConfirmDialog";
import { consoleButtonClass, HOST_SURFACE } from "@/components/host/host-ui";

const CHANNEL_API = "/admin/api/channels";
const POLL_MS = 30_000;

export type ManualResolution = "CUSTOMER_CONTACTED" | "ACCEPTED_BOTH" | "CANCELLED_AT_SOURCE";

/** What staff record after handling a case outside this system. None of them changes a reservation. */
export const RESOLUTION_LABEL: Record<ManualResolution, string> = {
  CUSTOMER_CONTACTED: "お客様に連絡した",
  ACCEPTED_BOTH: "両方の予約を受け入れる",
  CANCELLED_AT_SOURCE: "予約元で取り消された",
};

export interface ConflictMemberDto {
  readonly kind: "EXTERNAL" | "DIRECT";
  readonly site?: string;
  readonly externalReservationId?: string;
  readonly bookingId?: string;
  readonly seats: number;
  readonly status: string;
}

export interface ConflictCaseDto {
  readonly id: string;
  readonly productTitle: string;
  readonly occurrenceStartAtUtc?: string;
  readonly status: "OPEN" | "RESOLVED";
  readonly openedAtUtc: string;
  readonly acknowledged: boolean;
  readonly assignedToMe: boolean;
  readonly members: readonly ConflictMemberDto[];
}

interface DurationDto { readonly count: number; readonly p50Seconds?: number; readonly p95Seconds?: number }

export interface PropagationMetricsDto {
  readonly providerId: string;
  readonly truncated: boolean;
  readonly counts: Readonly<Record<"OPEN" | "COMPLETED" | "NOT_REQUIRED" | "ABANDONED" | "TIMED_OUT", number>>;
  readonly closeVerified: DurationDto & { readonly maxSeconds?: number; readonly over60Minutes: number };
  readonly detectionLag: DurationDto;
  readonly queueWait: DurationDto;
  readonly open: { readonly count: number; readonly oldestAgeSeconds?: number };
}

type AttentionState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly cases: readonly ConflictCaseDto[]; readonly metrics: PropagationMetricsDto }
  | { readonly kind: "error" }
  | { readonly kind: "disabled" };

interface AttentionMutation {
  readonly body: Readonly<Record<string, unknown>>;
  readonly notice: string;
}

const MEMBER_STATUS: Record<string, string> = {
  CONFIRMED: "確定", PENDING: "仮予約", CANCELLED: "取消済み", MOVED: "別の回へ移動", HOLD: "仮押さえ",
  EXPIRED: "期限切れ", PAYMENT_REVIEW: "決済確認中",
};

export function decodeConflictCases(value: unknown): readonly ConflictCaseDto[] | null {
  if (!value || typeof value !== "object" || !Array.isArray((value as { cases?: unknown }).cases)) return null;
  const cases = (value as { cases: unknown[] }).cases;
  const valid = cases.every((item) => item && typeof item === "object"
    && typeof (item as ConflictCaseDto).id === "string" && typeof (item as ConflictCaseDto).productTitle === "string"
    && ((item as ConflictCaseDto).status === "OPEN" || (item as ConflictCaseDto).status === "RESOLVED")
    && Array.isArray((item as ConflictCaseDto).members));
  return valid ? cases as ConflictCaseDto[] : null;
}

export function decodePropagationMetrics(value: unknown, providerId: string): PropagationMetricsDto | null {
  if (!value || typeof value !== "object") return null;
  const metrics = (value as { metrics?: unknown }).metrics as Partial<PropagationMetricsDto> | undefined;
  if (!metrics || metrics.providerId !== providerId || !metrics.counts || !metrics.closeVerified || !metrics.open
    || typeof metrics.closeVerified.count !== "number" || typeof metrics.open.count !== "number") return null;
  return metrics as PropagationMetricsDto;
}

/** 45秒 / 12分 / 1時間5分. Seconds are rounded; never shows a value the data does not have. */
export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return "—";
  const value = Math.max(0, Math.round(seconds));
  if (value < 60) return `${value}秒`;
  const minutes = Math.round(value / 60);
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours}時間` : `${hours}時間${minutes % 60}分`;
}

function time(value: string | undefined): string {
  if (!value) return "日時不明";
  const date = new Date(value);
  return Number.isFinite(date.valueOf())
    ? date.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "日時不明";
}

async function postJson(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
  return fetch(CHANNEL_API, {
    method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), signal,
  });
}

/** Reads both views while the page is visible. Provider switches abort and discard older responses. */
function useAttention(providerId: string, refreshVersion: number): AttentionState {
  const [state, setState] = useState<AttentionState>({ kind: "loading" });
  const sequence = useRef(0);
  useEffect(() => {
    let active = true;
    let disabled = false;
    let initial = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    const clear = () => { if (timer) clearTimeout(timer); timer = null; controller?.abort(); controller = null; };
    const poll = async () => {
      if (!active || disabled || !providerId || document.visibilityState !== "visible") return;
      const current = ++sequence.current;
      const requestController = new AbortController();
      controller = requestController;
      if (initial) setState({ kind: "loading" });
      try {
        const [casesResponse, metricsResponse] = await Promise.all([
          postJson({ action: "conflictCases", providerId }, requestController.signal),
          postJson({ action: "propagationMetrics", providerId }, requestController.signal),
        ]);
        if (!active || requestController.signal.aborted || current !== sequence.current) return;
        if (casesResponse.status === 404 || metricsResponse.status === 404) {
          disabled = true;
          setState({ kind: "disabled" });
          return;
        }
        if (!casesResponse.ok || !metricsResponse.ok) throw new Error("attention_read_failed");
        const cases = decodeConflictCases(await casesResponse.json());
        const metrics = decodePropagationMetrics(await metricsResponse.json(), providerId);
        if (!cases || !metrics) throw new Error("attention_shape_failed");
        if (active && !requestController.signal.aborted && current === sequence.current) setState({ kind: "ready", cases, metrics });
      } catch {
        if (requestController.signal.aborted || !active || current !== sequence.current) return;
        setState({ kind: "error" });
      } finally {
        if (active && current === sequence.current) {
          initial = false;
          controller = null;
          if (!disabled && document.visibilityState === "visible") timer = setTimeout(() => void poll(), POLL_MS);
        }
      }
    };
    const visibility = () => {
      clear();
      sequence.current += 1;
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", visibility);
    if (document.visibilityState === "visible") void poll();
    return () => { active = false; sequence.current += 1; document.removeEventListener("visibilitychange", visibility); clear(); };
  }, [providerId, refreshVersion]);
  return state;
}

function ResolveDialog({ item, busy, onClose, onConfirm }: {
  item: ConflictCaseDto;
  busy: boolean;
  onClose: () => void;
  onConfirm: (resolution: ManualResolution) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [choice, setChoice] = useState<ManualResolution | null>(null);
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    queueMicrotask(() => { if (element?.isConnected && !element.open) { element.showModal(); cancel.current?.focus(); } });
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} aria-labelledby="conflict-resolve-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }} onClose={onClose} className={HOST_DIALOG}>
    <form className="flex flex-col" onSubmit={(event) => { event.preventDefault(); if (!busy && choice) onConfirm(choice); }}>
      <div className="space-y-3 px-4 pt-4 pb-4 md:px-5 md:pt-5">
        <h2 id="conflict-resolve-title" className="text-[0.9375rem] font-extrabold">対応済みにする</h2>
        <p className="text-sm font-bold [overflow-wrap:anywhere]">{item.productTitle} · {time(item.occurrenceStartAtUtc)}</p>
        <fieldset className="space-y-1">
          <legend className="text-sm text-ink-soft">記録のみ。予約と在庫は変わりません。</legend>
          {(Object.keys(RESOLUTION_LABEL) as ManualResolution[]).map((value) => <label key={value} className="flex min-h-11 items-center gap-2 font-bold">
            <input type="radio" name="conflict-resolution" value={value} checked={choice === value} disabled={busy} onChange={() => setChoice(value)} />
            {RESOLUTION_LABEL[value]}
          </label>)}
        </fieldset>
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3 md:px-5">
        <button ref={cancel} type="button" disabled={busy} onClick={onClose} className={consoleButtonClass("secondary", "md", "min-h-11")}>やめる</button>
        <button type="submit" disabled={busy || !choice} className={consoleButtonClass("primary", "md", "min-h-11 disabled:opacity-50")}>{busy ? "送信中…" : "記録する"}</button>
      </div>
    </form>
  </dialog>;
}

function memberLabel(member: ConflictMemberDto): string {
  const source = member.kind === "EXTERNAL" ? `${member.site ?? "外部"} ${member.externalReservationId ?? ""}`.trim() : `直販 #${member.bookingId ?? ""}`;
  return `${source} · ${member.seats}名 · ${MEMBER_STATUS[member.status] ?? "不明"}`;
}

/** Exported for static-render tests. */
export function ConflictCaseList({ cases, locked, onAcknowledge, onResolve }: {
  cases: readonly ConflictCaseDto[];
  locked: boolean;
  onAcknowledge: (item: ConflictCaseDto) => void;
  onResolve: (item: ConflictCaseDto) => void;
}) {
  const open = cases.filter((item) => item.status === "OPEN");
  if (open.length === 0) return <p className="border-t border-line px-4 py-3 text-sm text-ink-soft">要対応はありません</p>;
  return <ul className="divide-y divide-line border-t border-line">{open.map((item) => {
    const owner = item.assignedToMe ? "担当: 自分" : item.acknowledged ? "担当: 他のスタッフ" : "担当なし";
    return <li key={item.id} className="space-y-2 px-4 py-3">
      <div className="min-w-0">
        <p className="font-extrabold [overflow-wrap:anywhere]">{item.productTitle} · {time(item.occurrenceStartAtUtc)}</p>
        <p className="text-xs text-ink-soft">{time(item.openedAtUtc)}に検知 · {owner}</p>
      </div>
      <ul aria-label="重なった予約" className="space-y-0.5 text-sm">{item.members.map((member, index) => <li key={`${member.kind}-${member.externalReservationId ?? member.bookingId ?? index}`} className="[overflow-wrap:anywhere]">{memberLabel(member)}</li>)}</ul>
      <div className="flex flex-wrap gap-2">
        {item.assignedToMe ? null : <button type="button" disabled={locked} onClick={() => onAcknowledge(item)} className={consoleButtonClass("secondary", "md", "min-h-11")}>担当する</button>}
        <button type="button" disabled={locked} onClick={() => onResolve(item)} className={consoleButtonClass("secondary", "md", "min-h-11")}>対応済みにする</button>
      </div>
    </li>;
  })}</ul>;
}

/** One to three lines. Exported for static-render tests. */
export function PropagationSummary({ metrics }: { metrics: PropagationMetricsDto }) {
  const close = metrics.closeVerified;
  const unfinished = metrics.counts.TIMED_OUT;
  return <div className="space-y-1 border-t border-line px-4 py-3 text-sm">
    {close.count > 0
      ? <p>他の販路で閉鎖を確認するまで 中央値 {formatDuration(close.p50Seconds)} · 95% {formatDuration(close.p95Seconds)} · 最大 {formatDuration(close.maxSeconds)}（{close.count}件{close.over60Minutes ? `、60分超 ${close.over60Minutes}件` : ""}）</p>
      : <p className="text-ink-soft">閉鎖を確認した例はまだありません</p>}
    {metrics.detectionLag.count > 0 || metrics.queueWait.count > 0
      ? <p className="text-ink-soft">検知の遅れ 中央値 {formatDuration(metrics.detectionLag.p50Seconds)} · 実行待ち 中央値 {formatDuration(metrics.queueWait.p50Seconds)}</p>
      : null}
    {metrics.open.count > 0 || unfinished > 0
      ? <p className={unfinished > 0 ? "font-bold text-warn" : "text-ink-soft"}>
        {metrics.open.count > 0 ? `確認待ち ${metrics.open.count}件（最長 ${formatDuration(metrics.open.oldestAgeSeconds)}）` : ""}
        {metrics.open.count > 0 && unfinished > 0 ? " · " : ""}
        {unfinished > 0 ? `24時間以内に確認できず ${unfinished}件` : ""}
      </p>
      : null}
  </div>;
}

/** Mount with `key={providerId}` so a provider switch also drops any pending command of the previous provider. */
export function AdminReservationAttentionPanel({ providerId }: { providerId: string }) {
  const [refresh, setRefresh] = useState(0);
  const state = useAttention(providerId, refresh);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<AttentionMutation | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [resolving, setResolving] = useState<ConflictCaseDto | null>(null);
  const busyRef = useRef(false);

  const mutate = useCallback(async (next: AttentionMutation) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setMessage(null); setPending(next);
    try {
      const response = await fetch(CHANNEL_API, {
        method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(next.body),
      });
      if (response.status >= 400 && response.status < 500) {
        setPending(null);
        setMessage(response.status === 409 ? "状態が変わりました。最新の表示を確認してください。" : "実行できません。ログインと権限を確認してください。");
        setRefresh((value) => value + 1);
        return;
      }
      if (!response.ok) throw new Error("unknown_ack");
      setPending(null); setMessage(next.notice);
      setRefresh((value) => value + 1);
    } catch {
      setMessage("結果を確認できません。");
    } finally {
      busyRef.current = false; setBusy(false);
    }
  }, []);

  const send = (body: Record<string, unknown>, notice: string) => void mutate({ body: { ...body, commandId: crypto.randomUUID() }, notice });
  const locked = busy || pending !== null;

  if (state.kind === "disabled" || !providerId) return null;
  return <>
    <section className={`${HOST_SURFACE} overflow-hidden`} aria-labelledby="reservation-conflicts-title">
      <div className="p-4"><h2 id="reservation-conflicts-title" className="font-extrabold">外部予約の要対応</h2></div>
      {message ? <div role="status" className="mx-4 mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-sand px-3 py-2 text-sm font-bold"><span className="min-w-0 flex-1">{message}</span>{pending && !busy ? <button type="button" onClick={() => void mutate(pending)} className={consoleButtonClass("secondary", "md", "min-h-11")}>結果を確認</button> : null}</div> : null}
      {state.kind === "loading" ? <p role="status" className="px-4 pb-4 text-sm text-ink-soft">確認中…</p> : null}
      {state.kind === "error" ? <p role="alert" className="px-4 pb-4 text-sm font-bold text-warn">要対応を確認できません。</p> : null}
      {state.kind === "ready" ? <ConflictCaseList cases={state.cases} locked={locked}
        onAcknowledge={(item) => send({ action: "acknowledgeConflictCase", caseId: item.id }, "担当にしました。")}
        onResolve={(item) => setResolving(item)} /> : null}
      {resolving ? <ResolveDialog item={resolving} busy={locked} onClose={() => { if (!locked) setResolving(null); }} onConfirm={(resolution) => {
        // The result (and a same-command retry) is shown in the section, so the modal never traps a pending command.
        const item = resolving;
        setResolving(null);
        send({ action: "resolveConflictCase", caseId: item.id, resolution }, "対応済みとして記録しました。");
      }} /> : null}
    </section>
    {state.kind === "ready" ? <section className={`${HOST_SURFACE} overflow-hidden`} aria-labelledby="propagation-title">
      <div className="p-4"><h2 id="propagation-title" className="font-extrabold">反映時間（30日）</h2></div>
      <PropagationSummary metrics={state.metrics} />
    </section> : null}
  </>;
}
