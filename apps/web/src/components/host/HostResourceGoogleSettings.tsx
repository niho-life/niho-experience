"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { consoleButtonClass } from "./host-ui";

interface Snapshot {
  resources: readonly { resourceId: string; resourceName: string; resourceKind: "VENUE" | "INSTRUCTOR" | "EQUIPMENT"; enabled: boolean; opaqueCalendarId?: string; version: number | null; syncStatus: "FRESH" | "STALE" | "FAILED" }[];
  calendars: readonly { id: string; name: string; primary: boolean }[];
}
interface Draft { calendarId: string; enabled: boolean }
interface Pending { providerId: string; resourceId: string; calendarId: string; enabled: boolean; expectedVersion: number | null; commandId: string }
interface Feedback { message: string; action?: "retry" | "reload"; login?: boolean }

const PATH = "/host/calendar/resource-google";
const kindLabel = { VENUE: "会場", INSTRUCTOR: "講師", EQUIPMENT: "備品" } as const;

export function HostResourceGoogleSettings({ providerId, connected }: { providerId: string; connected: boolean }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [reloadRequired, setReloadRequired] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const mounted = useRef(true);
  const requestGeneration = useRef(0);
  const sendingRef = useRef(false);
  const pendingRef = useRef<Pending | null>(null);

  const load = useCallback(async (clearFeedback = true): Promise<boolean> => {
    void connected;
    const generation = ++requestGeneration.current;
    setLoading(true);
    if (clearFeedback) setFeedback(null);
    try {
      const url = new URL(PATH, location.origin);
      url.searchParams.set("providerId", providerId);
      const response = await fetch(url, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw Object.assign(new Error(response.status === 409 ? "Google カレンダーを再接続してください。" : "設定を読み込めませんでした。"), { status: response.status });
      const next = await response.json() as Snapshot;
      if (!mounted.current || generation !== requestGeneration.current) return false;
      setSnapshot(next);
      if (pendingRef.current === null) {
        setDrafts(Object.fromEntries(next.resources.map((resource) => [resource.resourceId, {
          calendarId: resource.opaqueCalendarId ?? next.calendars[0]?.id ?? "", enabled: resource.enabled,
        }])));
      }
      setReloadRequired(false);
      return true;
    } catch (error) {
      if (!mounted.current || generation !== requestGeneration.current) return false;
      const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
      setFeedback({ message: error instanceof Error ? error.message : "設定を読み込めませんでした。", action: "reload", login: status === 401 });
      return false;
    } finally {
      if (mounted.current && generation === requestGeneration.current) setLoading(false);
    }
  }, [connected, providerId]);

  useEffect(() => {
    mounted.current = true;
    const timer = window.setTimeout(() => void load(), 0);
    return () => { window.clearTimeout(timer); mounted.current = false; requestGeneration.current += 1; };
  }, [load]);

  const send = async (command: Pending) => {
    const response = await fetch(PATH, {
      method: "PUT", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(command),
    });
    if (!response.ok) throw Object.assign(new Error("save"), { status: response.status });
  };
  const saveSucceeded = async () => {
    pendingRef.current = null;
    setPending(null);
    const refreshed = await load(false);
    if (refreshed && mounted.current) setFeedback({ message: "保存しました。反映を確認中です。" });
    else if (mounted.current) setFeedback({ message: "保存済み・表示を更新できません。", action: "reload" });
  };
  const saveConflict = () => {
    pendingRef.current = null;
    setPending(null);
    setReloadRequired(true);
    setFeedback({ message: "別の変更があります。再読込してください。", action: "reload" });
  };
  const save = async (resourceId: string) => {
    const resource = snapshot?.resources.find((item) => item.resourceId === resourceId);
    const draft = drafts[resourceId];
    if (!resource || !draft || !draft.calendarId || pendingRef.current || sendingRef.current || reloadRequired) return;
    const command: Pending = Object.freeze({ providerId, resourceId, calendarId: draft.calendarId, enabled: draft.enabled, expectedVersion: resource.version, commandId: crypto.randomUUID() });
    pendingRef.current = command;
    sendingRef.current = true;
    setPending(command);
    setSending(true);
    setFeedback(null);
    try {
      await send(command);
      await saveSucceeded();
    } catch (error) {
      const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
      if (status === 409) saveConflict();
      else setFeedback({
        message: status === 401 ? "保存結果を確認できません。ログイン後に同じ内容を再送できます。"
          : status === 403 ? "保存結果を確認できません。同じ内容を再送できます。" : "保存結果が不明です。同じ内容を再送できます。",
        action: "retry", login: status === 401,
      });
    } finally {
      sendingRef.current = false;
      if (mounted.current) setSending(false);
    }
  };
  const retry = async () => {
    const command = pendingRef.current;
    if (!command || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setFeedback(null);
    try {
      await send(command);
      await saveSucceeded();
    } catch (error) {
      const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
      if (status === 409) saveConflict();
      else setFeedback({ message: status === 401 ? "ログイン後に同じ内容を再送できます。" : "保存結果を確認できません。同じ内容を再送できます。", action: "retry", login: status === 401 });
    } finally {
      sendingRef.current = false;
      if (mounted.current) setSending(false);
    }
  };

  if (loading && !snapshot) return <p className="mt-3 text-sm text-ink-soft">資源設定を読込中…</p>;
  const fixed = pending !== null || sending || reloadRequired || loading;
  return <div className="mt-3 grid gap-3 border-t border-line pt-3">
    {feedback ? <p role="status" className="text-sm font-bold text-warn">{feedback.message}
      {feedback.login ? <Link href="/host" target="_blank" rel="noreferrer" className="ml-2 inline-flex min-h-11 items-center underline underline-offset-4">ログイン</Link> : null}
      {feedback.action === "retry" ? <button type="button" disabled={sending} onClick={() => void retry()} className="ml-2 min-h-11 underline underline-offset-4 disabled:opacity-50">同じ内容で再送</button> : null}
      {feedback.action === "reload" ? <button type="button" disabled={loading || sending} onClick={() => void load()} className="ml-2 min-h-11 underline underline-offset-4 disabled:opacity-50">再読込</button> : null}
    </p> : null}
    {snapshot?.resources.map((resource) => {
      const draft = drafts[resource.resourceId] ?? { calendarId: "", enabled: false };
      return <fieldset key={resource.resourceId} disabled={fixed} className="grid gap-2 rounded-xl bg-sand p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] sm:items-end">
        <legend className="sr-only">{resource.resourceName}</legend>
        <div className="grid gap-1 text-sm font-extrabold"><span>会場・講師</span><span className="min-h-11 content-center font-normal">{kindLabel[resource.resourceKind]}・{resource.resourceName}</span></div>
        <label className="grid gap-1 text-sm font-extrabold">カレンダー<select aria-label={`${resource.resourceName}のカレンダー`} value={draft.calendarId} onChange={(event) => { const calendarId = event.currentTarget.value; setDrafts((current) => ({ ...current, [resource.resourceId]: { ...draft, calendarId } })); }} className="min-h-11 min-w-0 rounded-[10px] border border-line-strong bg-canvas px-3 text-base">{snapshot.calendars.map((calendar) => <option key={calendar.id} value={calendar.id}>{calendar.name}{calendar.primary ? "（メイン）" : ""}</option>)}</select></label>
        <div className="flex flex-wrap items-center gap-2"><label className="flex min-h-11 items-center gap-2 font-extrabold"><input type="checkbox" checked={draft.enabled} onChange={(event) => { const enabled = event.currentTarget.checked; setDrafts((current) => ({ ...current, [resource.resourceId]: { ...draft, enabled } })); }} className="size-5 accent-moss" />{draft.enabled ? "使う" : "使わない"}</label><button type="button" disabled={fixed || !draft.calendarId} onClick={() => void save(resource.resourceId)} className={consoleButtonClass("secondary", "sm", "disabled:opacity-50")}>保存</button></div>
        <p className="text-xs text-ink-soft sm:col-span-3">{resource.enabled ? resource.syncStatus === "FRESH" ? "確認済み" : "確認待ち" : "使わない"}</p>
      </fieldset>;
    })}
  </div>;
}
