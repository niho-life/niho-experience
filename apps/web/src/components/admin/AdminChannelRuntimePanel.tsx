"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  ChannelRuntimeAccountView,
  ChannelRuntimeIncidentKind,
  ChannelRuntimeIncidentView,
  ChannelRuntimeOverview,
  ChannelWorkerHealth,
} from "@niho-experience/experience-store";
import { HOST_DIALOG } from "@/components/host/HostConfirmDialog";
import { consoleButtonClass, HOST_SURFACE } from "@/components/host/host-ui";

const CHANNEL_API = "/admin/api/channels";
const POLL_MS = 30_000;

export type RuntimePanelState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly overview: ChannelRuntimeOverview }
  | { readonly kind: "error" }
  | { readonly kind: "disabled" };

type ConfirmKind = "pause" | "recover" | "reauth";

interface RuntimeMutation {
  readonly body: Readonly<Record<string, unknown>>;
  readonly notice: string;
}

const KIND_LABEL: Record<ChannelRuntimeIncidentKind, string> = {
  WORKER_STALE: "Studio停止",
  SYNC_OVERDUE: "反映の遅れ",
  RESERVATION_READ_OVERDUE: "予約照合の遅れ",
  ACCOUNT_QUARANTINED: "アカウント停止",
  EXTERNAL_RESERVATION_CONFLICT: "予約の重複",
};

const HEALTH_LABEL: Record<ChannelWorkerHealth, string> = { FRESH: "稼働中", STALE: "応答なし", DOWN: "停止", NEVER: "未接続" };

export function decodeRuntimeOverview(value: unknown, providerId: string): ChannelRuntimeOverview | null {
  if (!value || typeof value !== "object" || !("overview" in value)) return null;
  const overview = (value as { overview: unknown }).overview;
  if (!overview || typeof overview !== "object") return null;
  const item = overview as Partial<ChannelRuntimeOverview>;
  if (item.providerId !== providerId || !Array.isArray(item.workers) || !Array.isArray(item.accounts) || !Array.isArray(item.incidents)
    || typeof item.watchdogStale !== "boolean" || typeof item.openHold !== "boolean" || typeof item.unclosedOccurrences !== "number") return null;
  return item as ChannelRuntimeOverview;
}

/** A Studio that is not FRESH writes nothing: externally open occurrences stay open. */
export function studioStopped(overview: ChannelRuntimeOverview): boolean {
  return overview.workers.length === 0 || overview.workers.some((worker) => worker.health !== "FRESH");
}

export function isReauthReason(reason: string | undefined): boolean {
  return reason?.startsWith("AUTH_REQUIRED") === true;
}

function time(value: string | undefined): string {
  if (!value) return "なし";
  const date = new Date(value);
  return Number.isFinite(date.valueOf())
    ? date.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "なし";
}

/** Reads only while the page is visible. Provider switches abort and discard older responses. */
function useRuntimeOverview(providerId: string, refreshVersion: number): RuntimePanelState {
  const [state, setState] = useState<RuntimePanelState>({ kind: "loading" });
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
        const response = await fetch(CHANNEL_API, {
          method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "runtimeOverview", providerId }), signal: requestController.signal,
        });
        if (!active || requestController.signal.aborted || current !== sequence.current) return;
        if (response.status === 404) {
          disabled = true;
          setState({ kind: "disabled" });
          return;
        }
        if (!response.ok) throw new Error("runtime_read_failed");
        const overview = decodeRuntimeOverview(await response.json(), providerId);
        if (!overview) throw new Error("runtime_shape_failed");
        if (active && !requestController.signal.aborted && current === sequence.current) setState({ kind: "ready", overview });
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

function Pill({ tone, children }: { tone: "ok" | "warn" | "danger" | "muted"; children: ReactNode }) {
  const tones = { ok: "bg-leaf-pale text-moss", warn: "bg-warn-pale text-warn", danger: "bg-danger-pale text-danger", muted: "bg-sand text-ink-soft" };
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-extrabold ${tones[tone]}`}><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />{children}</span>;
}

function ConfirmDialog({ kind, account, busy, onClose, onConfirm }: {
  kind: ConfirmKind;
  account: ChannelRuntimeAccountView;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [stopped, setStopped] = useState(false);
  const [relogged, setRelogged] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    queueMicrotask(() => { if (element?.isConnected && !element.open) { element.showModal(); cancel.current?.focus(); } });
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  const title = kind === "pause" ? "停止して手動対応" : kind === "recover" ? "停止を確認して照合" : "再認証を確認して照合";
  const ready = kind === "pause" || (stopped && (kind === "recover" || relogged));
  return <dialog ref={dialog} aria-labelledby="channel-runtime-dialog-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }} onClose={onClose} className={HOST_DIALOG}>
    <form className="flex flex-col" onSubmit={(event) => { event.preventDefault(); if (!busy && ready) onConfirm(); }}>
      <div className="space-y-3 px-4 pt-4 pb-4 md:px-5 md:pt-5">
        <h2 id="channel-runtime-dialog-title" className="text-[0.9375rem] font-extrabold">{title}</h2>
        <p className="text-sm font-bold [overflow-wrap:anywhere]">{account.site} · {account.displayName}</p>
        {kind === "pause" ? <p className="text-sm text-ink-soft">自動反映を止めます。外部で受付中の回は各サイトで閉じてください。</p> : null}
        {kind !== "pause" ? <label className="flex min-h-11 items-center gap-2 font-bold"><input type="checkbox" checked={stopped} disabled={busy} onChange={(event) => setStopped(event.currentTarget.checked)} />Studioの操作が止まっている</label> : null}
        {kind === "reauth" ? <label className="flex min-h-11 items-center gap-2 font-bold"><input type="checkbox" checked={relogged} disabled={busy} onChange={(event) => setRelogged(event.currentTarget.checked)} />掲載先に再ログインした</label> : null}
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3 md:px-5">
        <button ref={cancel} type="button" disabled={busy} onClick={onClose} className={consoleButtonClass("secondary", "md", "min-h-11")}>やめる</button>
        <button type="submit" disabled={busy || !ready} className={consoleButtonClass("primary", "md", "min-h-11 disabled:opacity-50")}>{busy ? "送信中…" : kind === "pause" ? "停止する" : "照合する"}</button>
      </div>
    </form>
  </dialog>;
}

function IncidentRow({ incident, label, locked, onAcknowledge }: { incident: ChannelRuntimeIncidentView; label: string; locked: boolean; onAcknowledge: () => void }) {
  const owner = incident.assignedToMe ? "担当: 自分" : incident.acknowledged ? "担当: 他のスタッフ" : "担当なし";
  return <li className="flex min-w-0 flex-wrap items-center gap-3 px-4 py-3">
    <div className="min-w-0 flex-1">
      <p className="flex flex-wrap items-center gap-2 font-extrabold">{KIND_LABEL[incident.kind] ?? incident.kind}{incident.escalated ? <Pill tone="danger">要対応</Pill> : null}</p>
      <p className="text-xs text-ink-soft [overflow-wrap:anywhere]">{label} · {time(incident.openedAtUtc)}から · {owner}</p>
    </div>
    {incident.assignedToMe ? null : <button type="button" disabled={locked} onClick={onAcknowledge} className={consoleButtonClass("secondary", "md", "min-h-11")}>担当する</button>}
  </li>;
}

/** Mount with `key={providerId}` so a provider switch also drops any pending command of the previous provider. */
export function AdminChannelRuntimePanel({ providerId, onChanged }: { providerId: string; onChanged?: () => void }) {
  const [refresh, setRefresh] = useState(0);
  const state = useRuntimeOverview(providerId, refresh);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<RuntimeMutation | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: ConfirmKind; account: ChannelRuntimeAccountView } | null>(null);
  const busyRef = useRef(false);

  const mutate = useCallback(async (next: RuntimeMutation) => {
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
      onChanged?.();
    } catch {
      setMessage("結果を確認できません。");
    } finally {
      busyRef.current = false; setBusy(false);
    }
  }, [onChanged]);

  const send = (body: Record<string, unknown>, notice: string) => void mutate({ body: { ...body, commandId: crypto.randomUUID() }, notice });
  const locked = busy || pending !== null;

  if (state.kind === "disabled" || !providerId) return null;
  return <section className={`${HOST_SURFACE} overflow-hidden`} aria-labelledby="channel-runtime-title">
    <div className="flex flex-wrap items-center justify-between gap-3 p-4">
      <h2 id="channel-runtime-title" className="font-extrabold">稼働状況</h2>
      {state.kind === "ready" ? <span className="text-xs text-ink-soft">{time(state.overview.generatedAtUtc)} 時点</span> : null}
    </div>
    {message ? <div role="status" className="mx-4 mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-sand px-3 py-2 text-sm font-bold"><span className="min-w-0 flex-1">{message}</span>{pending && !busy ? <button type="button" onClick={() => void mutate(pending)} className={consoleButtonClass("secondary", "md", "min-h-11")}>結果を確認</button> : null}</div> : null}
    {state.kind === "loading" ? <p role="status" className="px-4 pb-4 text-sm text-ink-soft">確認中…</p> : null}
    {state.kind === "error" ? <p role="alert" className="px-4 pb-4 text-sm font-bold text-warn">稼働状況を確認できません。</p> : null}
    {state.kind === "ready" ? <RuntimeOverviewBody overview={state.overview} locked={locked} onConfirm={(kind, account) => setConfirm({ kind, account })} send={send} /> : null}
    {confirm ? <ConfirmDialog kind={confirm.kind} account={confirm.account} busy={locked} onClose={() => { if (!locked) setConfirm(null); }} onConfirm={() => {
      // The result (and a same-command retry) is shown in the section, so the modal never traps a pending command.
      const { kind, account } = confirm;
      setConfirm(null);
      if (kind === "pause") send({ action: "pauseAccount", accountId: account.id, expectedVersion: account.version }, "手動対応に切り替えました。");
      else if (kind === "recover") send({ action: "recover", accountId: account.id, stopConfirmed: true }, "照合を受け付けました。確認できるまで停止したままです。");
      else send({ action: "confirmReauth", accountId: account.id, stopConfirmed: true, reauthConfirmed: true }, "照合を受け付けました。確認できるまで停止したままです。");
    }} /> : null}
  </section>;
}

/** Exported for static-render tests. */
export function RuntimeOverviewBody({ overview, locked, onConfirm, send }: {
  overview: ChannelRuntimeOverview;
  locked: boolean;
  onConfirm: (kind: ConfirmKind, account: ChannelRuntimeAccountView) => void;
  send: (body: Record<string, unknown>, notice: string) => void;
}) {
  const stopped = studioStopped(overview);
  const subject = (incident: ChannelRuntimeIncidentView) => incident.subjectType === "worker"
    ? overview.workers.find((worker) => worker.id === incident.subjectId)?.displayName ?? "Studio"
    : incident.subjectType === "conflict_case" ? "外部予約の要対応"
    : (() => { const account = overview.accounts.find((item) => item.id === incident.subjectId); return account ? `${account.site} · ${account.displayName}` : "外部アカウント"; })();
  return <div className="space-y-0">
    {stopped ? <div role="alert" className="mx-4 mb-3 rounded-xl bg-danger-pale px-3 py-2 text-sm">
      <p className="font-extrabold">Studio 停止中。外部で受付中の回は自動では閉じません</p>
      <p>閉じられていない回: {overview.unclosedOccurrences}件</p>
    </div> : null}
    {!stopped && overview.openHold ? <p role="status" className="mx-4 mb-3 rounded-xl bg-warn-pale px-3 py-2 text-sm font-bold">予約を読み直すまで、新しく開く操作は保留中です</p> : null}
    {overview.watchdogStale ? <p role="status" className="mx-4 mb-3 rounded-xl bg-warn-pale px-3 py-2 text-sm font-bold">監視が止まっています{overview.watchdogLastRunAtUtc ? `（最終 ${time(overview.watchdogLastRunAtUtc)}）` : ""}</p> : null}

    <ul aria-label="Studio" className="divide-y divide-line border-t border-line">{overview.workers.map((worker) => <li key={worker.id} className="flex min-w-0 flex-wrap items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1"><p className="font-extrabold [overflow-wrap:anywhere]">{worker.displayName}</p><p className="text-xs text-ink-soft">最終応答 {time(worker.lastHeartbeatAtUtc)} · {worker.assignedAccounts}アカウント{worker.openHold ? ` · 開く操作を保留（${time(worker.openHoldSinceUtc)}から）` : ""}</p></div>
      <Pill tone={worker.health === "FRESH" ? "ok" : worker.health === "STALE" ? "warn" : "danger"}>{HEALTH_LABEL[worker.health] ?? worker.health}</Pill>
    </li>)}{overview.workers.length === 0 ? <li className="px-4 py-3 text-sm text-ink-soft">割り当てられたStudioはありません</li> : null}</ul>

    {overview.incidents.length ? <div className="border-t border-line">
      <h3 className="px-4 pt-3 text-sm font-extrabold">未解決</h3>
      <ul className="divide-y divide-line">{overview.incidents.map((incident) => <IncidentRow key={incident.id} incident={incident} label={subject(incident)} locked={locked}
        onAcknowledge={() => send({ action: "acknowledgeIncident", incidentId: incident.id }, "担当にしました。")} />)}</ul>
    </div> : null}

    <ul aria-label="外部アカウントの稼働" className="divide-y divide-line border-t border-line">{overview.accounts.map((account) => {
      const quarantined = account.quarantineReason !== undefined;
      return <li key={account.id} className="space-y-2 px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="font-extrabold [overflow-wrap:anywhere]">{account.site} · {account.displayName}</p>
            <p className="text-xs text-ink-soft">未反映 閉じる{account.sync.closePending}件 · 開く{account.sync.openPending}件{account.sync.overdue ? ` · 60分超 ${account.sync.overdue}件` : ""}{account.sync.heldOpen ? ` · 保留中の開く ${account.sync.heldOpen}件` : ""}</p>
            {account.reservationReads.listings ? <p className="text-xs text-ink-soft">予約照合 {account.reservationReads.listings}件 · 最終成功 {time(account.reservationReads.lastSuccessAtUtc)} · 次回 {time(account.reservationReads.nextDueAtUtc)}{account.reservationReads.halted ? ` · 停止 ${account.reservationReads.halted}件` : ""}</p> : null}
          </div>
          {quarantined ? <Pill tone="warn">停止中 {account.quarantineReason}</Pill> : account.active ? <Pill tone="ok">自動</Pill> : <Pill tone="muted">無効</Pill>}
        </div>
        <div className="flex flex-wrap gap-2">
          {account.quarantineReason !== "MANUAL_HANDLING" ? <button type="button" disabled={locked} onClick={() => onConfirm("pause", account)} className={consoleButtonClass("secondary", "md", "min-h-11")}>停止して手動対応</button> : null}
          {quarantined ? <button type="button" disabled={locked} onClick={() => onConfirm("recover", account)} className={consoleButtonClass("secondary", "md", "min-h-11")}>停止を確認して照合</button> : null}
          {isReauthReason(account.quarantineReason) ? <button type="button" disabled={locked} onClick={() => onConfirm("reauth", account)} className={consoleButtonClass("secondary", "md", "min-h-11")}>再認証を確認して照合</button> : null}
        </div>
        {account.listings.length ? <ul className="divide-y divide-line rounded-xl border border-line">{account.listings.map((listing) => <li key={listing.listingId} className="flex min-w-0 flex-wrap items-center gap-2 px-3 py-2">
          <div className="min-w-0 flex-1"><p className="text-sm font-bold [overflow-wrap:anywhere]">{listing.productTitle}</p><p className="text-xs text-ink-soft">未反映 {listing.closePending + listing.openPending}件{listing.readHalted ? ` · 予約照合停止${listing.readLastError ? `（${listing.readLastError}）` : ""}` : ""}</p></div>
          {listing.readHalted ? <button type="button" disabled={locked} onClick={() => send({ action: "retryReservationReads", listingId: listing.listingId }, "予約照合を再開しました。")} className={consoleButtonClass("secondary", "sm", "min-h-11")}>予約照合を再開</button> : null}
          <button type="button" disabled={locked} onClick={() => send({ action: "reconcile", listingId: listing.listingId }, "再照合を受け付けました。")} className={consoleButtonClass("secondary", "sm", "min-h-11")}>再照合</button>
        </li>)}</ul> : null}
      </li>;
    })}{overview.accounts.length === 0 ? <li className="px-4 py-3 text-sm text-ink-soft">外部アカウントはありません</li> : null}</ul>
  </div>;
}
