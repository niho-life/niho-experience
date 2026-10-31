"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { withProvider } from "@/lib/host/routes";
import { consoleButtonClass } from "./host-ui";
import { StatusPill } from "./ui";
import { HostIcon } from "./HostIcon";

const OPTIONS_PATH = "/host/calendar/google-output/options";
const SETUP_PATH = "/host/calendar/google-output";
const ANCHOR_PATH = "/host/calendar/google-output/anchors";
const ACTIVATION_PATH = "/host/calendar/google-output/activation";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 45_000;

type SetupState = "PREPARING" | "CREATING" | "READY_FOR_CONNECTION" | "FAILED_BEFORE_CREATE" | "UNCERTAIN";
type AnchorState = "PREPARING" | "INITIALIZING" | "GOOGLE_VERIFIED" | "UNCERTAIN" | "FAILED_BEFORE_INITIALIZE";
type ActivationState = "READY" | "ACTIVE" | "NEEDS_REVIEW";
type PendingSetup = { commandId: string; expectedMappingVersion: number };
type PendingAnchor = PendingSetup & { expectedDesiredVersion: number };
type Candidate = {
  listingId: string; accountDisplayName: string; mappingVersion: number; desiredVersion?: number;
  localDate: string;
  pendingSetup?: PendingSetup; pendingAnchor?: PendingAnchor;
};
type Options = { connected: boolean; candidates: Candidate[] };
type SetupDto = { commandId: string; listingId: string; state: SetupState; calendarName: string };
type AnchorDto = { commandId: string; listingId: string; occurrenceId: string; state: AnchorState };
type ActivationDto = {
  listingId: string; occurrenceId: string; state: ActivationState;
  expectedMappingVersion: number; expectedBindingVersion: number; expectedDesiredVersion: number;
};
type UiError = "reauth" | "forbidden" | "unavailable" | "conflict";

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const uuid = (value: unknown): value is string => typeof value === "string" && UUID_V4.test(value);
const text = (value: unknown, max = 256): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const exactKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) =>
  required.every((key) => key in value) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));

function pendingSetup(value: unknown): value is PendingSetup {
  return object(value) && exactKeys(value, ["commandId", "expectedMappingVersion"])
    && uuid(value.commandId) && positive(value.expectedMappingVersion);
}
function pendingAnchor(value: unknown): value is PendingAnchor {
  return object(value) && exactKeys(value, ["commandId", "expectedMappingVersion", "expectedDesiredVersion"])
    && uuid(value.commandId) && positive(value.expectedMappingVersion) && positive(value.expectedDesiredVersion);
}
function optionsDto(value: unknown): value is Options {
  if (!object(value) || !exactKeys(value, ["connected", "candidates"]) || typeof value.connected !== "boolean" || !Array.isArray(value.candidates)) return false;
  return value.candidates.every((item) => object(item)
    && exactKeys(item, ["listingId", "accountDisplayName", "mappingVersion", "localDate"], ["desiredVersion", "pendingSetup", "pendingAnchor"])
    && text(item.listingId) && text(item.accountDisplayName, 300) && positive(item.mappingVersion)
    && /^\d{4}-\d{2}-\d{2}$/.test(String(item.localDate))
    && (item.desiredVersion === undefined || positive(item.desiredVersion))
    && (item.pendingSetup === undefined || pendingSetup(item.pendingSetup))
    && (item.pendingAnchor === undefined || pendingAnchor(item.pendingAnchor)));
}
function setupDto(value: unknown): value is SetupDto {
  return object(value) && exactKeys(value, ["commandId", "listingId", "state", "calendarName"], ["reason"])
    && uuid(value.commandId) && text(value.listingId) && text(value.calendarName, 200)
    && ["PREPARING", "CREATING", "READY_FOR_CONNECTION", "FAILED_BEFORE_CREATE", "UNCERTAIN"].includes(String(value.state))
    && (value.reason === undefined || typeof value.reason === "string");
}
function anchorDto(value: unknown): value is AnchorDto {
  return object(value) && exactKeys(value, ["commandId", "listingId", "occurrenceId", "state"], ["reason"])
    && uuid(value.commandId) && text(value.listingId) && text(value.occurrenceId)
    && ["PREPARING", "INITIALIZING", "GOOGLE_VERIFIED", "UNCERTAIN", "FAILED_BEFORE_INITIALIZE"].includes(String(value.state))
    && (value.reason === undefined || typeof value.reason === "string");
}
function activationDto(value: unknown): value is ActivationDto {
  return object(value) && exactKeys(value, ["listingId", "occurrenceId", "state", "expectedMappingVersion", "expectedBindingVersion", "expectedDesiredVersion"])
    && text(value.listingId) && text(value.occurrenceId) && ["READY", "ACTIVE", "NEEDS_REVIEW"].includes(String(value.state))
    && positive(value.expectedMappingVersion) && positive(value.expectedBindingVersion) && positive(value.expectedDesiredVersion);
}
function setupAck(value: unknown): boolean { return setupDto(value); }
function anchorAck(value: unknown): boolean { return anchorDto(value); }
function activationAck(value: unknown, commandId: string, listingId: string, occurrenceId: string): boolean {
  return object(value) && exactKeys(value, ["commandId", "listingId", "occurrenceId", "state"])
    && value.commandId === commandId && value.listingId === listingId && value.occurrenceId === occurrenceId && value.state === "APPLIED";
}

async function json(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { throw new Error("malformed"); }
}

function errorFor(status: number): UiError {
  if (status === 401) return "reauth";
  if (status === 403) return "forbidden";
  if (status === 409) return "conflict";
  return "unavailable";
}

export function HostAirbnbGoogleSetup({
  providerId, productId, occurrenceId, canManage, onBusyChange,
}: {
  providerId: string; productId: string; occurrenceId: string; canManage: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [options, setOptions] = useState<Options | null>(null);
  const [optionsKey, setOptionsKey] = useState("");
  const [hidden, setHidden] = useState(true);
  const [selectedId, setSelectedId] = useState("");
  const [setup, setSetup] = useState<SetupDto | null>(null);
  const [anchor, setAnchor] = useState<AnchorDto | null>(null);
  const [activation, setActivation] = useState<ActivationDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [optionsRefresh, setOptionsRefresh] = useState(0);
  const [metadata, setMetadata] = useState<{ setup?: PendingSetup; anchor?: PendingAnchor }>({});
  const mutation = useRef<{ controller: AbortController; key: string } | null>(null);
  const singleflight = useRef(false);
  const scopeKey = `${providerId}:${productId}:${occurrenceId}`;
  const currentOptions = optionsKey === scopeKey ? options : null;
  const candidate = useMemo(() => currentOptions?.candidates.find((item) => item.listingId === selectedId) ?? null, [currentOptions, selectedId]);
  const selectionKey = `${providerId}:${productId}:${occurrenceId}:${selectedId}`;
  const selectionRef = useRef({ key: selectionKey, scopeKey, listingId: selectedId });

  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => () => { mutation.current?.controller.abort(); }, []);
  useEffect(() => {
    selectionRef.current = { key: canManage ? selectionKey : "", scopeKey, listingId: selectedId };
    if (mutation.current && mutation.current.key !== selectionRef.current.key) mutation.current.controller.abort();
  }, [canManage, scopeKey, selectedId, selectionKey]);

  useEffect(() => {
    if (!canManage) return;
    const controller = new AbortController();
    let disposed = false;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, READ_TIMEOUT_MS);
    const url = new URL(OPTIONS_PATH, location.origin);
    url.search = new URLSearchParams({ providerId, productId, occurrenceId }).toString();
    fetch(url, { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (response.status === 404) throw Object.assign(new Error("disabled"), { status: 404 });
        if (!response.ok) throw Object.assign(new Error("options"), { status: response.status });
        const value = await json(response);
        if (!optionsDto(value)) throw new Error("malformed");
        return value;
      })
      .then((value) => {
        if (disposed || controller.signal.aborted) return;
        if (value.candidates.length === 0) { setOptions(value); setOptionsKey(scopeKey); setHidden(true); return; }
        const selected = value.candidates.find((item) => selectionRef.current.scopeKey === scopeKey && item.listingId === selectionRef.current.listingId) ?? value.candidates[0]!;
        setOptions(value); setOptionsKey(scopeKey); setSelectedId(selected.listingId); setHidden(false);
        setMetadata({ setup: selected.pendingSetup, anchor: selected.pendingAnchor });
        setSetup(null); setAnchor(null); setActivation(null); setConfirmed(false); setUnknown(false); setError(null); setLoading(value.connected);
      })
      .catch((reason: unknown) => {
        if (disposed || (controller.signal.aborted && !timedOut)) return;
        const status = object(reason) && typeof reason.status === "number" ? reason.status : 503;
        setOptions(null); setOptionsKey(scopeKey);
        if (status === 404) setHidden(true);
        else { setError(errorFor(status)); setHidden(false); }
        setLoading(false);
      }).finally(() => {
        clearTimeout(timeout);
        if (!disposed) setOptionsLoading(false);
      });
    return () => { disposed = true; clearTimeout(timeout); controller.abort(); };
  }, [canManage, occurrenceId, optionsRefresh, productId, providerId, scopeKey]);

  const reload = useCallback(() => { setConfirmed(false); setLoading(true); setOptionsLoading(true); setOptionsRefresh((value) => value + 1); }, []);
  const selectCandidate = (listingId: string) => {
    const selected = currentOptions?.candidates.find((item) => item.listingId === listingId);
    if (!selected) return;
    setSelectedId(listingId); setMetadata({ setup: selected.pendingSetup, anchor: selected.pendingAnchor });
    setSetup(null); setAnchor(null); setActivation(null); setConfirmed(false); setUnknown(false); setError(null); setLoading(true);
  };

  useEffect(() => {
    if (!canManage || !candidate || optionsLoading || !currentOptions?.connected) return;
    const controller = new AbortController();
    let disposed = false;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, READ_TIMEOUT_MS);
    const read = async <T,>(path: string, validator: (value: unknown) => value is T, allowedMissing: readonly number[]): Promise<T | null> => {
      const query = new URLSearchParams({ providerId, listingId: candidate.listingId });
      if (path !== SETUP_PATH) query.set("occurrenceId", occurrenceId);
      const response = await fetch(`${path}?${query}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
      if (allowedMissing.includes(response.status)) return null;
      if (!response.ok) throw Object.assign(new Error("read"), { status: response.status });
      const value = await json(response);
      if (!validator(value)) throw new Error("malformed");
      return value;
    };
    Promise.all([
      read(SETUP_PATH, setupDto, [404]),
      read(ANCHOR_PATH, anchorDto, [404, 409]),
      read(ACTIVATION_PATH, activationDto, [404, 409]),
    ]).then(([nextSetup, nextAnchor, nextActivation]) => {
      if (disposed || controller.signal.aborted) return;
      if (nextSetup && nextSetup.listingId !== candidate.listingId) throw new Error("malformed");
      if (nextAnchor && (nextAnchor.listingId !== candidate.listingId || nextAnchor.occurrenceId !== occurrenceId)) throw new Error("malformed");
      if (nextActivation && (nextActivation.listingId !== candidate.listingId || nextActivation.occurrenceId !== occurrenceId)) throw new Error("malformed");
      setSetup(nextSetup); setAnchor(nextAnchor); setActivation(nextActivation); setError(null); setUnknown(false);
    }).catch((reason: unknown) => {
      if (disposed || (controller.signal.aborted && !timedOut)) return;
      const status = object(reason) && typeof reason.status === "number" ? reason.status : 503;
      if (status === 404) setHidden(true);
      else setError(errorFor(status));
    }).finally(() => {
      clearTimeout(timeout);
      if (!disposed) setLoading(false);
    });
    return () => { disposed = true; clearTimeout(timeout); controller.abort(); };
  }, [canManage, candidate, currentOptions?.connected, occurrenceId, optionsLoading, providerId, refresh]);

  const post = async (
    path: string,
    body: Record<string, unknown>,
    validator: (value: unknown) => boolean,
    commandMetadata?: { setup?: PendingSetup; anchor?: PendingAnchor },
  ) => {
    if (singleflight.current || !candidate) return;
    const capturedKey = selectionKey;
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, WRITE_TIMEOUT_MS);
    singleflight.current = true; mutation.current = { controller, key: capturedKey };
    setBusy(true); setError(null); setUnknown(false);
    if (commandMetadata) setMetadata((current) => ({ ...current, ...commandMetadata }));
    try {
      const response = await fetch(path, {
        method: "POST", credentials: "same-origin", cache: "no-store", signal: controller.signal,
        headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      if (controller.signal.aborted || capturedKey !== selectionRef.current.key) return;
      if (response.status === 404) { setHidden(true); return; }
      if (response.status === 409) { setConfirmed(false); setError("conflict"); reload(); return; }
      if (!response.ok) {
        const nextError = errorFor(response.status);
        setError(nextError);
        if (response.status >= 500) setUnknown(true);
        return;
      }
      const value = await json(response);
      if (controller.signal.aborted || capturedKey !== selectionRef.current.key) return;
      if (!validator(value)) { setUnknown(true); setError("unavailable"); return; }
      setLoading(true); setRefresh((current) => current + 1);
    } catch {
      if ((!controller.signal.aborted || timedOut) && capturedKey === selectionRef.current.key) { setConfirmed(false); setUnknown(true); setError("unavailable"); }
    } finally {
      clearTimeout(timeout);
      if (mutation.current?.controller === controller) {
        mutation.current = null;
        singleflight.current = false;
        setBusy(false);
      }
    }
  };

  if (!canManage || hidden || optionsKey !== scopeKey) return null;
  const reading = optionsLoading || loading;
  const active = activation?.state === "ACTIVE" && !reading && !unknown && !error;
  const ready = setup?.state === "READY_FOR_CONNECTION" && anchor?.state === "GOOGLE_VERIFIED"
    && activation?.state === "READY" && !reading && !unknown && !error;
  let label = "未接続";
  let tone: "draft" | "wait" | "ok" | "stop" = "draft";
  if (reading || busy || setup?.state === "PREPARING" || setup?.state === "CREATING" || anchor?.state === "PREPARING" || anchor?.state === "INITIALIZING") { label = "準備中"; tone = "wait"; }
  if (setup?.state === "READY_FOR_CONNECTION" || ready) { label = "確認待ち"; tone = "wait"; }
  if (unknown || error || setup?.state === "UNCERTAIN" || setup?.state === "FAILED_BEFORE_CREATE" || anchor?.state === "UNCERTAIN" || anchor?.state === "FAILED_BEFORE_INITIALIZE" || activation?.state === "NEEDS_REVIEW") { label = "要確認"; tone = "stop"; }
  if (active) { label = "連携中"; tone = "ok"; }

  const statusAction = !active && (unknown || error === "unavailable" || error === "conflict"
    || setup?.state === "CREATING" || setup?.state === "UNCERTAIN" || activation?.state === "NEEDS_REVIEW");
  const prepareCalendar = () => {
    if (!candidate) return;
    const commandId = crypto.randomUUID();
    const original = { commandId, expectedMappingVersion: candidate.mappingVersion };
    void post(SETUP_PATH, { providerId, listingId: candidate.listingId, ...original },
      (value) => setupAck(value) && (value as SetupDto).commandId === commandId && (value as SetupDto).listingId === candidate.listingId,
      { setup: original });
  };
  const cancelSetup = () => {
    if (!candidate || !setup || setup.commandId !== metadata.setup?.commandId) { reload(); return; }
    const commandId = metadata.setup.commandId;
    void post(SETUP_PATH, { providerId, listingId: candidate.listingId, ...metadata.setup, operation: "cancel_preparing" },
      (value) => setupAck(value) && (value as SetupDto).commandId === commandId && (value as SetupDto).listingId === candidate.listingId);
  };
  const prepareAnchor = () => {
    if (!candidate?.desiredVersion) return;
    const commandId = crypto.randomUUID();
    const original = { commandId, expectedMappingVersion: candidate.mappingVersion, expectedDesiredVersion: candidate.desiredVersion };
    void post(ANCHOR_PATH, { providerId, listingId: candidate.listingId, occurrenceId, ...original, operation: "initialize" },
      (value) => anchorAck(value) && (value as AnchorDto).commandId === commandId
        && (value as AnchorDto).listingId === candidate.listingId && (value as AnchorDto).occurrenceId === occurrenceId,
      { anchor: original });
  };
  const inspectAnchor = () => {
    if (!candidate || !anchor || anchor.commandId !== metadata.anchor?.commandId) { reload(); return; }
    const commandId = metadata.anchor.commandId;
    void post(ANCHOR_PATH, { providerId, listingId: candidate.listingId, occurrenceId, ...metadata.anchor, operation: "inspect" },
      (value) => anchorAck(value) && (value as AnchorDto).commandId === commandId
        && (value as AnchorDto).listingId === candidate.listingId && (value as AnchorDto).occurrenceId === occurrenceId);
  };
  const activate = () => {
    if (!candidate || !activation || !confirmed) return;
    const commandId = crypto.randomUUID();
    void post(ACTIVATION_PATH, {
      providerId, listingId: candidate.listingId, occurrenceId,
      expectedMappingVersion: activation.expectedMappingVersion,
      expectedBindingVersion: activation.expectedBindingVersion,
      expectedDesiredVersion: activation.expectedDesiredVersion,
      commandId, connectionConfirmed: true,
    }, (value) => activationAck(value, commandId, candidate.listingId, occurrenceId));
  };
  const airbnbUrl = candidate ? `https://www.airbnb.jp/multicalendar/experiences-and-services/${candidate.localDate}/week` : "";

  return <details className="group border-t border-line pt-1">
    <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2 text-sm font-bold"><span>Airbnb連携</span><span className="flex items-center gap-2"><StatusPill status={{ label, tone }} /><HostIcon name="chevronDown" className="size-4 text-muted group-open:rotate-180" /></span></summary>
    <div className="grid min-w-0 gap-3 pb-2 pt-2 text-sm">
      {currentOptions && currentOptions.candidates.length > 1 ? <label className="grid gap-1 font-bold">アカウント<select aria-label="アカウント" disabled={busy || reading} value={selectedId} onChange={(event) => selectCandidate(event.currentTarget.value)} className="min-h-11 min-w-0 rounded-[10px] border border-line-strong bg-canvas px-3">{currentOptions.candidates.map((item) => <option key={item.listingId} value={item.listingId}>{item.accountDisplayName}</option>)}</select></label> : candidate ? <strong>{candidate.accountDisplayName}</strong> : null}
      {setup?.calendarName && setup.state === "READY_FOR_CONNECTION" ? <span className="font-bold [overflow-wrap:anywhere]">{setup.calendarName}</span> : null}
      {error === "reauth" ? <p role="alert" className="font-bold text-danger">再ログインしてください。 <a href="/host" target="_blank" rel="noreferrer" className="underline underline-offset-4">ログイン</a></p> : null}
      {error === "forbidden" ? <p role="alert" className="font-bold text-danger">操作権限を確認してください。</p> : null}
      {(error === "unavailable" || error === "conflict") ? <p role="alert" className="font-bold text-danger">状態を確認してください。</p> : null}
      <div className="flex min-w-0 flex-wrap gap-2">
        {currentOptions && !currentOptions.connected && !error ? <a href={withProvider("/host/calendar/google/connect", providerId)} className={consoleButtonClass("secondary", "lg")}>Google カレンダーをつなぐ</a> : null}
        {currentOptions?.connected && !active && !reading && !setup && !unknown && !error ? <button type="button" disabled={busy} onClick={prepareCalendar} className={consoleButtonClass("secondary", "lg", "disabled:opacity-50")}>カレンダーを準備</button> : null}
        {!active && !reading && setup?.state === "PREPARING" && setup.commandId === metadata.setup?.commandId && !unknown && !error ? <button type="button" disabled={busy} onClick={cancelSetup} className={consoleButtonClass("secondary", "lg", "disabled:opacity-50")}>準備を中止</button> : null}
        {!active && !reading && setup?.state === "FAILED_BEFORE_CREATE" && !unknown && !error ? <button type="button" disabled={busy} onClick={prepareCalendar} className={consoleButtonClass("secondary", "lg", "disabled:opacity-50")}>カレンダーを準備</button> : null}
        {setup?.state === "READY_FOR_CONNECTION" && !candidate?.desiredVersion && !unknown && !error ? <button type="button" disabled={busy || reading} onClick={reload} className={consoleButtonClass("secondary", "lg", "disabled:opacity-50")}>再読込</button> : null}
        {!active && !reading && setup?.state === "READY_FOR_CONNECTION" && candidate?.desiredVersion && (!anchor || anchor.state === "FAILED_BEFORE_INITIALIZE") && !unknown && !error ? <button type="button" disabled={busy} onClick={prepareAnchor} className={consoleButtonClass("secondary", "lg", "disabled:opacity-50")}>予約枠を準備</button> : null}
        {!active && !reading && anchor && ["PREPARING", "INITIALIZING", "UNCERTAIN"].includes(anchor.state) && anchor.commandId === metadata.anchor?.commandId && !unknown && !error ? <button type="button" disabled={busy} onClick={inspectAnchor} className={consoleButtonClass("secondary", "lg", "disabled:opacity-50")}>状態を確認</button> : null}
        {statusAction ? <button type="button" disabled={busy || reading} onClick={reload} className={consoleButtonClass("secondary", "lg", "disabled:opacity-50")}>{candidate ? "状態を確認" : "再読込"}</button> : null}
      </div>
      {ready && setup ? <div className="grid gap-3">
        <a href={airbnbUrl} target="_blank" rel="noreferrer" className={consoleButtonClass("secondary", "lg", "w-fit")}>Airbnbを開く</a>
        <label className="flex min-h-11 items-start gap-2 font-bold"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.currentTarget.checked)} className="mt-1 size-5" /><span>Airbnbで「{setup.calendarName}」を接続しました</span></label>
        <button type="button" disabled={busy || !confirmed} onClick={activate} className={consoleButtonClass("primary", "lg", "w-full disabled:opacity-50")}>連携を開始</button>
      </div> : null}
    </div>
  </details>;
}
