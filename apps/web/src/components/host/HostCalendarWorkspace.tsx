"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { HostCalendarData } from "@/experience/calendar-contract";
import { withProvider } from "@/lib/host/routes";
import { addDays, availabilityLabel, dateLabel, timeLabel, todayInTokyo, weekDays, weekLabel, weekStart } from "./calendar-ui";
import { consoleButtonClass, HOST_SURFACE } from "./host-ui";
import { HostCalendarAgenda } from "./HostCalendarAgenda";
import { channelSummary, HostCalendarChannelDetails, useHostChannelStatuses } from "./HostCalendarChannels";
import { HOST_DIALOG } from "./HostConfirmDialog";
import { HostWeekCalendar, productTone } from "./HostWeekCalendar";
import { PageHead, StatusPill } from "./ui";

const API_PATH = "/host/calendar/data";
const WEEKDAYS = [
  { id: "MONDAY", label: "月" }, { id: "TUESDAY", label: "火" }, { id: "WEDNESDAY", label: "水" },
  { id: "THURSDAY", label: "木" }, { id: "FRIDAY", label: "金" }, { id: "SATURDAY", label: "土" }, { id: "SUNDAY", label: "日" },
] as const;
const FIELD = "min-h-11 min-w-0 w-full rounded-[10px] border border-line-strong bg-canvas px-3 text-[1rem] md:text-[0.875rem]";
type OccurrenceItem = HostCalendarData["occurrences"][number];
type DialogState = { kind: "add" } | { kind: "occurrence"; item: OccurrenceItem } | { kind: "disconnect" };
type PendingCalendarCommand = { readonly request: Record<string, unknown>; readonly focusDate?: string };
type MutationError = { readonly message: string; readonly retryCommand?: boolean; readonly reread?: boolean; reauth?: boolean };

function WorkspaceDialog({ title, children, onClose, closeDisabled = false }: { title: string; children: ReactNode; onClose: () => void; closeDisabled?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = ref.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    queueMicrotask(() => element?.isConnected && !element.open && element.showModal());
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={ref} aria-labelledby="calendar-dialog-title" onCancel={(event) => { event.preventDefault(); if (!closeDisabled) onClose(); }} onClose={onClose} className={HOST_DIALOG}>
    <div className="max-h-[calc(100dvh-2rem)] overflow-y-auto p-4 md:p-5">
      <div className="mb-4 flex items-start justify-between gap-3"><h2 id="calendar-dialog-title" className="min-w-0 font-sans text-lg font-extrabold tracking-normal [overflow-wrap:anywhere]">{title}</h2><button type="button" disabled={closeDisabled} onClick={onClose} aria-label="閉じる" className="grid size-11 shrink-0 place-items-center rounded-full hover:bg-sand disabled:opacity-40">×</button></div>
      {children}
    </div>
  </dialog>;
}

function statePill(item: OccurrenceItem) {
  const label = availabilityLabel(item.availabilityReason);
  const tone = item.availabilityReason === "AVAILABLE" ? "ok" : item.availabilityReason === "MANUALLY_CLOSED" ? "stop" : item.availabilityReason === "GOOGLE_SYNC_UNAVAILABLE" ? "wait" : "draft";
  return <StatusPill status={{ label, tone }} />;
}

function ErrorMessage({ error, onRetry, onReread }: { error: MutationError; onRetry: () => void; onReread: () => void }) {
  return <div role="alert" className="flex flex-wrap items-center gap-2 rounded-xl bg-danger-pale px-3.5 py-2.5 font-bold text-danger"><span>{error.message}</span>{error.reauth ? <a href="/host" target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center underline underline-offset-4">ログイン</a> : null}{error.retryCommand ? <button type="button" onClick={onRetry} className="min-h-11 underline underline-offset-4">同じ内容で再送</button> : null}{error.reread ? <button type="button" onClick={onReread} className="min-h-11 underline underline-offset-4">再読込</button> : null}</div>;
}

/** Experience-owned host calendar. Browser state never decides inventory or authorization. */
export function HostCalendarWorkspace({ providerId, legacyManagementUrl }: { providerId: string; legacyManagementUrl: string | null }) {
  const [today] = useState(todayInTokyo);
  const [activeWeek, setActiveWeek] = useState(() => weekStart(today));
  const [selectedDate, setSelectedDate] = useState(today);
  const [view, setView] = useState<"week" | "day">("week");
  const [experienceId, setExperienceId] = useState("");
  const [data, setData] = useState<HostCalendarData | null>(null);
  const [dataFresh, setDataFresh] = useState(false);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<MutationError | null>(null);
  const [saving, setSaving] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [pendingCommand, setPendingCommand] = useState<PendingCalendarCommand | null>(null);
  const [repeats, setRepeats] = useState(false);
  const [ruleStartsOn, setRuleStartsOn] = useState(today);
  const [recurrence, setRecurrence] = useState("WEEKLY");
  const [weekdays, setWeekdays] = useState<string[]>([]);
  const requestSequence = useRef(0);
  const refreshWasSave = useRef(false);
  const savingRef = useRef(false);
  const days = useMemo(() => weekDays(activeWeek), [activeWeek]);
  const fromDate = days[0]!;
  const toDate = days[6]!;
  const channelSnapshot = useHostChannelStatuses(providerId, `${activeWeek}:${nonce}`);
  const channels = channelSnapshot.kind === "disabled" ? channelSnapshot : !dataFresh || saving || pendingCommand ? { kind: "loading" as const } : channelSnapshot;
  const allChannelSummary = channelSummary(channels);
  const invalidateData = () => { requestSequence.current += 1; setDataFresh(false); };

  const load = useCallback((controller: AbortController, sequence: number) => {
    setLoading(true); setDataFresh(false); setReadError(null);
    const url = new URL(API_PATH, location.origin);
    url.search = new URLSearchParams({ providerId, fromDate, toDate }).toString();
    fetch(url, { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error(response.status === 503 ? "カレンダーを準備しています。" : "カレンダーを読み込めませんでした。"); return response.json() as Promise<HostCalendarData>; })
      .then((result) => {
        if (controller.signal.aborted || sequence !== requestSequence.current) return;
        setData(result);
        setDataFresh(true);
        setExperienceId((current) => result.experiences.some((item) => item.id === current) ? current : "");
        setDialog((current) => {
          if (current?.kind !== "occurrence") return current;
          const item = result.occurrences.find((candidate) => candidate.id === current.item.id);
          return item ? { ...current, item } : current;
        });
        setNotice(refreshWasSave.current ? "保存しました" : null);
        refreshWasSave.current = false;
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || sequence !== requestSequence.current) return;
        if (refreshWasSave.current) { setNotice("保存済み・表示を更新できません"); refreshWasSave.current = false; }
        else setReadError(error instanceof Error ? error.message : "読み込みに失敗しました。");
      })
      .finally(() => { if (!controller.signal.aborted && sequence === requestSequence.current) setLoading(false); });
  }, [fromDate, providerId, toDate]);

  useEffect(() => { const controller = new AbortController(); const sequence = ++requestSequence.current; load(controller, sequence); return () => controller.abort(); }, [load, nonce]);
  const refreshAfterSave = (focusDate?: string) => {
    refreshWasSave.current = true;
    if (focusDate) {
      const nextWeek = weekStart(focusDate);
      setSelectedDate(focusDate);
      if (nextWeek !== activeWeek) { invalidateData(); setActiveWeek(nextWeek); return; }
    }
    invalidateData(); setNonce((value) => value + 1);
  };
  const reread = () => { setMutationError(null); invalidateData(); setNonce((value) => value + 1); };

  const mutate = async (body?: Record<string, unknown>, focusDate?: string): Promise<boolean> => {
    if (savingRef.current) return false;
    const retrying = pendingCommand !== null;
    const command = pendingCommand ?? { request: { providerId, ...body, commandId: crypto.randomUUID() }, ...(focusDate ? { focusDate } : {}) };
    setPendingCommand(command);
    savingRef.current = true;
    setSaving(true); setMutationError(null); setNotice(null);
    try {
      const response = await fetch(API_PATH, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(command.request) });
      if (!response.ok) {
        if (retrying && response.status >= 400 && response.status < 500) {
          setMutationError({ message: "保存結果を確認できません。ログインと権限を確認してください。", retryCommand: true, reauth: response.status === 401 || response.status === 403 });
          return false;
        }
        if (response.status === 409) {
          setPendingCommand(null);
          invalidateData();
          setMutationError({ message: "別の変更が保存されました。入力は残っています。", reread: true });
          return false;
        }
        if (response.status >= 400 && response.status < 500) {
          setPendingCommand(null);
          setMutationError({ message: response.status === 403 ? "このカレンダーは変更できません。" : "入力を確認してください。" });
          return false;
        }
        setMutationError({ message: "保存結果を確認できません。", retryCommand: true });
        return false;
      }
      setPendingCommand(null);
      setDialog(null); refreshAfterSave(command.focusDate); return true;
    } catch { setMutationError({ message: "保存結果を確認できません。", retryCommand: true }); return false; }
    finally { savingRef.current = false; setSaving(false); }
  };

  const mutateGoogle = async (action: "sync" | "disconnect") => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true); setMutationError(null);
    try {
      const response = await fetch("/host/calendar/google", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId, action }) });
      if (!response.ok) throw new Error("Google カレンダーを更新できませんでした。");
      setDialog(null); refreshAfterSave();
    } catch (error) { setMutationError({ message: error instanceof Error ? error.message : "更新に失敗しました。" }); }
    finally { savingRef.current = false; setSaving(false); }
  };

  const submitRule = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (repeats && recurrence === "SELECTED_WEEKDAYS" && weekdays.length === 0) { setMutationError({ message: "曜日を選んでください。" }); return; }
    const startsOn = String(form.get("startsOn"));
    void mutate({ action: "createRule", experienceId: String(form.get("experienceId")), rule: {
      timeZone: "Asia/Tokyo", startsOn, endsOn: repeats ? String(form.get("endsOn")) : startsOn,
      localStartTime: String(form.get("localStartTime")), durationMinutes: Number(form.get("durationMinutes")), capacity: Number(form.get("capacity")),
      bookingCutoffMinutes: 120, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0,
      recurrence: repeats ? (recurrence === "SELECTED_WEEKDAYS" ? { kind: recurrence, weekdays } : { kind: recurrence }) : { kind: "WEEKLY" },
    } }, startsOn);
  };

  const visibleOccurrences = useMemo(() => dataFresh ? data?.occurrences.filter((item) => !experienceId || item.experienceId === experienceId) ?? [] : [], [data, dataFresh, experienceId]);
  const productIndexes = useMemo(() => new Map((data?.experiences ?? []).map((item, index) => [item.id, index])), [data]);
  const selectedOccurrences = visibleOccurrences.filter((item) => item.localDate === selectedDate);
  const selectWeek = (next: string) => { invalidateData(); setActiveWeek(weekStart(next)); setSelectedDate(next); };
  const closeDialog = () => {
    if (saving || pendingCommand !== null) return;
    setMutationError(null); setDialog(null);
    if (!dataFresh) { invalidateData(); setNonce((value) => value + 1); }
  };
  const openAdd = () => { setMutationError(null); setRepeats(false); setRuleStartsOn(selectedDate); setRecurrence("WEEKLY"); setWeekdays([]); setDialog({ kind: "add" }); };
  const openOccurrence = (item: OccurrenceItem) => { setMutationError(null); setDialog({ kind: "occurrence", item }); };
  const dialogFeedback = mutationError ? <ErrorMessage error={mutationError} onRetry={() => void mutate()} onReread={reread} /> : readError ? <ErrorMessage error={{ message: readError, reread: true }} onRetry={() => undefined} onReread={reread} /> : null;

  return <div className="space-y-3.5">
    <PageHead title="カレンダー"><span className="hidden lg:inline-flex">{allChannelSummary ? <StatusPill status={{ ...allChannelSummary, label: `掲載先 ${allChannelSummary.label}` }} /> : null}</span><button type="button" disabled={!dataFresh || !data?.canEdit || data.preview || data.experiences.length === 0} onClick={openAdd} className={consoleButtonClass("primary", "lg", "disabled:cursor-not-allowed disabled:opacity-50")}>枠を追加</button></PageHead>
    {data?.scope !== "OPERATOR" ? <details className="rounded-xl bg-warn-pale px-3.5 py-1.5 text-sm text-warn"><summary className="flex min-h-11 cursor-pointer items-center font-extrabold">現行NIHOの受付には未反映です</summary><p className="pb-2">販売中の枠は現行画面でも管理してください。{legacyManagementUrl ? <> <a href={legacyManagementUrl} className="inline-flex min-h-11 items-center font-extrabold underline underline-offset-4">現行画面を開く</a></> : null}</p></details> : null}
    {notice ? <div role="status" className="flex flex-wrap items-center gap-2 rounded-xl bg-leaf-pale px-3.5 py-2.5 font-bold text-moss"><span>{notice}</span>{notice.includes("更新できません") ? <button type="button" onClick={() => setNonce((value) => value + 1)} className="min-h-11 underline underline-offset-4">再読込</button> : null}</div> : null}
    {mutationError && dialog === null ? <ErrorMessage error={mutationError} onRetry={() => void mutate()} onReread={reread} /> : null}
    {readError && dialog === null ? <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl bg-warn-pale px-3.5 py-2.5 text-warn"><span>{readError}</span><button type="button" onClick={reread} className="min-h-11 font-extrabold underline underline-offset-4">再読込</button></div> : null}

    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5"><strong className="mr-1 whitespace-nowrap font-sans text-sm">{weekLabel(activeWeek)}</strong><button type="button" aria-label="前の週" onClick={() => selectWeek(addDays(activeWeek, -7))} className="grid size-11 place-items-center rounded-full border border-line-strong">‹</button><button type="button" aria-label="次の週" onClick={() => selectWeek(addDays(activeWeek, 7))} className="grid size-11 place-items-center rounded-full border border-line-strong">›</button><button type="button" onClick={() => { const nextWeek = weekStart(today); if (nextWeek !== activeWeek) invalidateData(); setActiveWeek(nextWeek); setSelectedDate(today); }} className="min-h-11 rounded-full px-3 text-sm font-extrabold hover:bg-sand">今日</button></div>
      <div role="group" aria-label="カレンダーの表示" className="hidden rounded-xl bg-sand p-1 lg:flex"><button type="button" aria-pressed={view === "week"} onClick={() => setView("week")} className={`min-h-9 min-w-12 rounded-lg px-3 text-sm font-bold ${view === "week" ? "bg-canvas shadow-sm" : "text-muted"}`}>週</button><button type="button" aria-pressed={view === "day"} onClick={() => setView("day")} className={`min-h-9 min-w-12 rounded-lg px-3 text-sm font-bold ${view === "day" ? "bg-canvas shadow-sm" : "text-muted"}`}>日</button></div>
    </div>

    {dataFresh && data ? <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0" role="group" aria-label="体験で絞り込む">
      {data.experiences.length > 1 ? <><button type="button" aria-pressed={experienceId === ""} onClick={() => setExperienceId("")} className={`min-h-10 shrink-0 rounded-full border px-3 text-xs font-extrabold ${experienceId === "" ? "border-ink bg-sand" : "border-line-strong bg-canvas"}`}>すべて</button>{data.experiences.map((item, index) => <button key={item.id} type="button" aria-pressed={experienceId === item.id} onClick={() => setExperienceId(item.id)} className={`flex min-h-10 max-w-64 shrink-0 items-center gap-2 rounded-full border px-3 text-xs font-extrabold ${experienceId === item.id ? "border-ink bg-sand" : "border-line-strong bg-canvas"}`}><span aria-hidden="true" className={`size-2 rounded-full border ${productTone(index)}`} /><span className="truncate">{item.title}</span></button>)}</> : data.experiences[0] ? <span className="flex min-h-10 items-center gap-2 rounded-full border border-line-strong px-3 text-xs font-extrabold"><span aria-hidden="true" className={`size-2 rounded-full border ${productTone(0)}`} />{data.experiences[0].title}</span> : null}
    </div> : null}

    {loading && !dataFresh ? <p role="status" className="py-10 text-center text-ink-soft">読み込んでいます…</p> : null}
    {dataFresh && data ? <>
      <div className={`grid grid-cols-7 gap-1 ${view === "week" ? "lg:hidden" : ""}`} role="group" aria-label="日を選ぶ">{days.map((day, index) => { const selected = day === selectedDate; const count = visibleOccurrences.filter((item) => item.localDate === day).length; return <button key={day} type="button" data-calendar-day={day} aria-pressed={selected} aria-current={day === today ? "date" : undefined} aria-label={`${WEEKDAYS[index]?.label} ${Number(day.slice(8))}、${dateLabel(day)}${count ? `、枠${count}件` : "、枠なし"}`} onClick={() => setSelectedDate(day)} className={`flex min-h-[4.5rem] min-w-0 flex-col items-center justify-center gap-1 rounded-full text-xs ${selected ? "bg-ink text-canvas" : "text-muted"}`}><span aria-hidden="true">{WEEKDAYS[index]?.label}</span><strong className={`text-base ${selected ? "text-canvas" : "text-ink"}`}>{Number(day.slice(8))}</strong><span aria-hidden="true" className={`size-1 rounded-full ${count ? "bg-leaf" : "bg-transparent"}`} /></button>; })}</div>
      {view === "week" ? <HostWeekCalendar days={days} today={today} occurrences={visibleOccurrences} busyIntervals={data.busyIntervals} productIndexes={productIndexes} onOpen={openOccurrence} onSelectDay={(day) => { setSelectedDate(day); setView("day"); }} /> : null}
      <div className={view === "week" ? "lg:hidden" : ""}><HostCalendarAgenda day={selectedDate} occurrences={selectedOccurrences} busyIntervals={data.busyIntervals} productIndexes={productIndexes} onOpen={openOccurrence} /></div>
    </> : null}

    {dataFresh && data?.scope === "MEMBER" ? <details className={`${HOST_SURFACE} px-4 py-3`}><summary className="flex min-h-11 cursor-pointer items-center font-extrabold">Google カレンダー</summary><div className="border-t border-line pt-3 text-sm"><div className="flex flex-wrap items-center gap-2">{data.google.connected ? <><StatusPill status={{ label: data.google.syncStatus === "FRESH" ? "接続中" : "確認待ち", tone: data.google.syncStatus === "FRESH" ? "ok" : "wait" }} />{data.google.canManage ? <><button type="button" disabled={saving} onClick={() => void mutateGoogle("sync")} className="min-h-11 px-2 font-extrabold underline underline-offset-4">再確認</button><button type="button" disabled={saving} onClick={() => setDialog({ kind: "disconnect" })} className="min-h-11 px-2 font-extrabold underline underline-offset-4">接続を切る</button></> : null}</> : data.google.canManage ? <a href={withProvider("/host/calendar/google/connect", providerId)} className="inline-flex min-h-11 items-center font-extrabold underline underline-offset-4">Google カレンダーをつなぐ</a> : <span className="text-ink-soft">未接続</span>}</div></div></details> : null}

    {dialog?.kind === "add" && data ? <WorkspaceDialog title="枠を追加" closeDisabled={saving || pendingCommand !== null} onClose={closeDialog}><form onSubmit={submitRule} className="grid gap-3">
      {dialogFeedback}<fieldset disabled={saving || pendingCommand !== null} className="contents">
      {data.experiences.length > 1 ? <label className="grid gap-1 text-sm font-extrabold">体験<select name="experienceId" defaultValue={experienceId || data.experiences[0]?.id} required className={FIELD}>{data.experiences.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label> : <input type="hidden" name="experienceId" value={data.experiences[0]?.id ?? ""} />}
      <label className="grid gap-1 text-sm font-extrabold">日付<input name="startsOn" type="date" value={ruleStartsOn} onChange={(event) => setRuleStartsOn(event.currentTarget.value)} required className={FIELD} /></label>
      <label className="grid gap-1 text-sm font-extrabold">開始<input name="localStartTime" type="time" defaultValue="10:00" required className={FIELD} /></label>
      <div className="grid grid-cols-2 gap-3"><label className="grid gap-1 text-sm font-extrabold">所要時間（分）<input name="durationMinutes" type="number" min="1" max="1440" defaultValue="90" required inputMode="numeric" className={FIELD} /></label><label className="grid gap-1 text-sm font-extrabold">定員（人）<input name="capacity" type="number" min="1" max="1000" defaultValue="4" required inputMode="numeric" className={FIELD} /></label></div>
      <label className="flex min-h-11 items-center gap-2 font-extrabold"><input type="checkbox" checked={repeats} onChange={(event) => setRepeats(event.currentTarget.checked)} className="size-5 accent-moss" />繰り返す</label>
      {repeats ? <div className="grid gap-3 rounded-xl bg-sand p-3"><label className="grid gap-1 text-sm font-extrabold">繰り返し<select value={recurrence} onChange={(event) => setRecurrence(event.currentTarget.value)} className={FIELD}><option value="WEEKLY">毎週</option><option value="DAILY">毎日</option><option value="WEEKENDS">土日</option><option value="SELECTED_WEEKDAYS">曜日を選ぶ</option></select></label><label className="grid gap-1 text-sm font-extrabold">終了日<input name="endsOn" type="date" min={ruleStartsOn} required className={FIELD} /></label>{recurrence === "SELECTED_WEEKDAYS" ? <fieldset><legend className="text-sm font-extrabold">曜日</legend><div className="mt-1 grid grid-cols-4 gap-1">{WEEKDAYS.map((day) => <label key={day.id} className="flex min-h-11 items-center justify-center gap-1 rounded-xl border border-line-strong bg-canvas"><input type="checkbox" checked={weekdays.includes(day.id)} onChange={(event) => { const checked = event.currentTarget.checked; setWeekdays((current) => checked ? [...current, day.id] : current.filter((id) => id !== day.id)); }} />{day.label}</label>)}</div></fieldset> : null}</div> : null}
      </fieldset><div className="sticky -bottom-4 z-10 bg-canvas pt-2 pb-1"><button type="submit" disabled={saving || !dataFresh || pendingCommand !== null} className={consoleButtonClass("primary", "lg", "w-full disabled:opacity-50")}>{saving ? "保存中…" : "追加する"}</button></div>
    </form></WorkspaceDialog> : null}

    {dialog?.kind === "occurrence" ? <WorkspaceDialog title={dialog.item.experienceTitle} closeDisabled={saving || pendingCommand !== null} onClose={closeDialog}><div className="space-y-4">
      {dialogFeedback}
      <div className="border-y border-line py-4"><strong className="block text-base">{dateLabel(dialog.item.localDate)}</strong><span className="mt-1 block font-display text-2xl tabular-nums">{timeLabel(dialog.item.startUtc)}–{timeLabel(dialog.item.endUtc)}</span></div>
      <div className="flex flex-wrap items-center gap-2">{statePill(dialog.item)}{(dialog.item.confirmedSeats ?? 0) > 0 || (dialog.item.heldSeats ?? 0) > 0 ? <strong className="text-sm text-info">予約あり</strong> : null}{data?.scope === "MEMBER" ? <span className="text-sm text-ink-soft">定員 {dialog.item.capacity}人</span> : null}</div>
      <HostCalendarChannelDetails state={channels} occurrenceId={dialog.item.id} />
      {data?.canEdit ? <>{!dialog.item.canReschedule ? null : <details className="group"><summary className="flex min-h-11 cursor-pointer items-center justify-between text-sm font-bold">日時を変更<span aria-hidden="true">⌄</span></summary><form onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const localDate = String(form.get("localDate")); void mutate({ action: "rescheduleOccurrence", occurrenceId: dialog.item.id, expectedVersion: dialog.item.overrideVersion ?? null, localDate, localStartTime: String(form.get("localStartTime")) }, localDate); }} className="grid gap-3 rounded-xl bg-sand p-3"><fieldset disabled={saving || pendingCommand !== null} className="contents"><div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-sm font-extrabold">日付<input name="localDate" type="date" defaultValue={dialog.item.localDate} required className={FIELD} /></label><label className="grid gap-1 text-sm font-extrabold">開始<input name="localStartTime" type="time" defaultValue={dialog.item.localStartTime} required className={FIELD} /></label></div><button type="submit" disabled={saving || !dataFresh || pendingCommand !== null} className={consoleButtonClass("secondary", "lg", "w-full disabled:opacity-50")}>保存</button></fieldset></form></details>}
      <div className="sticky -bottom-4 z-10 bg-canvas pt-2 pb-1"><button type="button" disabled={saving || !dataFresh || pendingCommand !== null} onClick={() => void mutate({ action: "setSalesState", occurrenceId: dialog.item.id, expectedVersion: dialog.item.salesStateVersion ?? null, desiredState: dialog.item.status === "CLOSED" ? "OPEN" : "CLOSED" }, dialog.item.localDate)} className={consoleButtonClass("primary", "lg", "w-full disabled:opacity-50")}>{dialog.item.status === "CLOSED" ? "受付を再開" : "受付を休止"}</button></div></> : <p className="text-sm font-bold text-warn">このカレンダーは変更できません</p>}
    </div></WorkspaceDialog> : null}
    {dialog?.kind === "disconnect" ? <WorkspaceDialog title="接続を切りますか？" onClose={closeDialog}><div className="space-y-3">{dialogFeedback}<p className="text-sm text-ink-soft">予約は消えません。Google の予定による受付停止は終わります。</p><div className="flex justify-end gap-2"><button type="button" disabled={saving} onClick={closeDialog} className={consoleButtonClass("secondary", "lg")}>やめる</button><button type="button" disabled={saving || !dataFresh} onClick={() => void mutateGoogle("disconnect")} className={consoleButtonClass("primary", "lg", "disabled:opacity-50")}>接続を切る</button></div></div></WorkspaceDialog> : null}
  </div>;
}
