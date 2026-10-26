"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { HostCalendarData } from "@/experience/calendar-contract";
import { withProvider } from "@/lib/host/routes";

const API_PATH = "/host/calendar/data";
const WEEKDAYS = [
  { id: "MONDAY", label: "月" }, { id: "TUESDAY", label: "火" }, { id: "WEDNESDAY", label: "水" },
  { id: "THURSDAY", label: "木" }, { id: "FRIDAY", label: "金" }, { id: "SATURDAY", label: "土" }, { id: "SUNDAY", label: "日" },
] as const;

const todayInTokyo = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const plusDays = (day: string, count: number) => new Date(Date.parse(`${day}T00:00:00.000Z`) + count * 86_400_000).toISOString().slice(0, 10);
const localDateTime = (instant: string) => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(instant));

/** Host-only calendar. All changes go to the server; no browser state is treated as capacity. */
export function HostCalendarWorkspace({ providerId }: { providerId: string }) {
  const [fromDate, setFromDate] = useState(todayInTokyo);
  const [data, setData] = useState<HostCalendarData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [weekdays, setWeekdays] = useState<string[]>([]);
  const [recurrence, setRecurrence] = useState("WEEKLY");
  const [editingId, setEditingId] = useState<string | null>(null);
  const toDate = plusDays(fromDate, 13);

  useEffect(() => {
    const controller = new AbortController();
    const url = new URL(API_PATH, location.origin);
    url.search = new URLSearchParams({ providerId, fromDate, toDate }).toString();
    fetch(url, { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 503 ? "カレンダーを準備しています。しばらくしてから再度お試しください。" : "カレンダーを読み込めませんでした。もう一度お試しください。");
        return response.json() as Promise<HostCalendarData>;
      })
      .then((result) => { if (!controller.signal.aborted) { setData(result); setMessage(null); } })
      .catch((error: unknown) => { if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "読み込みに失敗しました。"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [providerId, fromDate, toDate, nonce]);

  const mutate = async (body: unknown): Promise<boolean> => {
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(API_PATH, {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId, ...body as object }),
      });
      if (!response.ok) throw new Error(response.status === 409 ? "別の予約または変更と重なりました。表示を更新して確認してください。" : "保存できませんでした。内容を確認して再度お試しください。");
      setLoading(true);
      setData(null);
      setNonce((value) => value + 1);
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存に失敗しました。");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const mutateGoogle = async (action: "sync" | "disconnect") => {
    if (action === "disconnect" && !window.confirm("Google カレンダーの接続を切りますか？確定済み予約は残ります。")) return;
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch("/host/calendar/google", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId, action }) });
      if (!response.ok) throw new Error("Google カレンダーを更新できませんでした。再接続が必要な場合は接続し直してください。");
      setLoading(true);
      setData(null);
      setNonce((value) => value + 1);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "更新に失敗しました。");
    } finally {
      setSaving(false);
    }
  };

  const submitRule = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const kind = String(form.get("recurrence"));
    if (kind === "SELECTED_WEEKDAYS" && weekdays.length === 0) { setMessage("曜日を1つ以上選んでください。"); return; }
    void mutate({ action: "createRule", experienceId: String(form.get("experienceId")), rule: {
      timeZone: "Asia/Tokyo", startsOn: String(form.get("startsOn")),
      endsOn: String(form.get("endsOn")) || undefined, localStartTime: String(form.get("localStartTime")),
      durationMinutes: Number(form.get("durationMinutes")), capacity: Number(form.get("capacity")),
      bookingCutoffMinutes: 120, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0,
      recurrence: kind === "SELECTED_WEEKDAYS" ? { kind, weekdays } : { kind },
    } });
  };

  const moveRange = (days: number) => {
    setLoading(true);
    setData(null);
    setFromDate((current) => plusDays(current, days));
  };

  return (
    <div className="space-y-5">
      <p role="note" className="rounded-xl border border-warn/20 bg-warn-pale p-3 text-sm text-warn">
        移行準備中：この画面の開催枠と Google の予定は、現在の NIHO 側の予約受付にはまだ反映されません。販売中の枠を止める場合は、現行の管理画面でも停止してください。
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => moveRange(-14)} className="min-h-10 rounded-xl border border-line px-3 font-bold">前の2週間</button>
        <span className="font-bold tabular-nums">{fromDate} 〜 {toDate}（日本時間）</span>
        <button type="button" onClick={() => moveRange(14)} className="min-h-10 rounded-xl border border-line px-3 font-bold">次の2週間</button>
      </div>

      {message ? <p role="alert" className="rounded-xl bg-warn-pale p-3 text-warn">{message}</p> : null}
      {loading ? <p role="status" className="text-ink-soft">カレンダーを読み込んでいます…</p> : null}
      {data ? <>
        {data.preview ? <p className="rounded-xl bg-sand p-3 text-sm font-bold">これは合成データのプレビューです。変更は保存できません。</p> : null}
        <section aria-label="予定と開催枠" className="rounded-2xl border border-line bg-white p-4 md:p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-bold">予定と開催枠</h2>
            <div className="flex flex-wrap gap-3 text-sm font-bold">
              {data.google.connected ? <>
                <span role="status">Google：{data.google.syncStatus === "FRESH" ? "予定を確認済み" : "確認待ち"}</span>
                {data.google.canManage ? <>
                  <button type="button" disabled={saving} onClick={() => void mutateGoogle("sync")} className="text-moss underline underline-offset-4 disabled:opacity-50">予定を再確認</button>
                  <button type="button" disabled={saving} onClick={() => void mutateGoogle("disconnect")} className="text-ink-soft underline underline-offset-4 disabled:opacity-50">接続を切る</button>
                </> : null}
              </> : data.google.canManage ? <a href={withProvider("/host/calendar/google/connect", providerId)} className="text-moss underline underline-offset-4">Google カレンダーをつなぐ</a> : <span>Google カレンダー未接続</span>}
            </div>
          </div>
          <p className="mb-3 text-sm text-ink-soft">
            Google の予定は内容を表示せず「予定あり」として表示します。
            {data.google.blockingEnabled && data.google.syncStatus !== "FRESH" ? " 予定の確認ができないため、新しい予約は停止中です。" : ""}
          </p>
          <ul className="space-y-2">
            {[...data.occurrences.map((item) => ({ id: item.id, startUtc: item.startUtc, endUtc: item.endUtc, kind: "experience" as const, item })),
              ...data.busyIntervals.map((item, index) => ({ id: `busy-${index}`, startUtc: item.startUtc, endUtc: item.endUtc, kind: "busy" as const, item }))]
              .sort((a, b) => a.startUtc.localeCompare(b.startUtc)).map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line p-3">
                  <span><span className="block font-bold">{entry.kind === "busy" ? "Google の予定あり" : entry.item.experienceTitle}</span><span className="text-sm text-ink-soft">{localDateTime(entry.startUtc)} 〜 {localDateTime(entry.endUtc)}</span></span>
                  {entry.kind === "experience" ? <span className="flex items-center gap-2">
                    <span className="text-sm font-bold">{entry.item.status === "CLOSED" ? "休止" : entry.item.availabilityReason === "GOOGLE_BUSY" ? "予定と重複" : entry.item.availabilityReason === "GOOGLE_SYNC_UNAVAILABLE" ? "確認待ち" : `残り ${entry.item.availableSeats} 席`}</span>
                    {entry.item.status === "OPEN" ? <>
                      <button type="button" disabled={saving || data.preview} onClick={() => setEditingId(entry.item.id)} className="min-h-10 rounded-xl border border-line px-3 text-sm font-bold disabled:opacity-50">日時を変更</button>
                      <button type="button" disabled={saving || data.preview} onClick={() => void mutate({ action: "closeOccurrence", occurrenceId: entry.item.id })} className="min-h-10 rounded-xl border border-line px-3 text-sm font-bold disabled:opacity-50">この回を休止</button>
                    </> : null}
                  </span> : null}
                  {entry.kind === "experience" && editingId === entry.item.id ? <form className="flex w-full flex-wrap items-end gap-2 border-t border-line pt-3" onSubmit={(event) => {
                    event.preventDefault();
                    const fields = new FormData(event.currentTarget);
                    void mutate({ action: "rescheduleOccurrence", occurrenceId: entry.item.id, localDate: String(fields.get("localDate")), localStartTime: String(fields.get("localStartTime")) }).then((saved) => { if (saved) setEditingId(null); });
                  }}>
                    <label className="grid gap-1 text-sm font-bold">変更後の日付<input type="date" name="localDate" defaultValue={entry.item.localDate} required className="min-h-10 rounded-xl border border-line px-3" /></label>
                    <label className="grid gap-1 text-sm font-bold">開始時刻<input type="time" name="localStartTime" defaultValue={entry.item.localStartTime} required className="min-h-10 rounded-xl border border-line px-3" /></label>
                    <button type="submit" disabled={saving} className="min-h-10 rounded-xl bg-moss px-4 text-sm font-bold text-white disabled:opacity-50">この回だけ変更</button>
                    <button type="button" onClick={() => setEditingId(null)} className="min-h-10 rounded-xl border border-line px-3 text-sm font-bold">閉じる</button>
                  </form> : null}
                </li>
              ))}
          </ul>
          {data.occurrences.length === 0 && data.busyIntervals.length === 0 ? <p className="text-sm text-ink-soft">この期間の予定はありません。</p> : null}
        </section>

        <section aria-label="開催枠を追加" className="rounded-2xl border border-line bg-white p-4 md:p-5">
          <h2 className="mb-3 font-bold">繰り返しの開催枠を追加</h2>
          {data.experiences.length ? <form onSubmit={submitRule} className="grid gap-3 md:grid-cols-2">
            <label className="grid gap-1 text-sm font-bold">体験<select name="experienceId" required className="min-h-11 rounded-xl border border-line px-3">{data.experiences.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
            <label className="grid gap-1 text-sm font-bold">繰り返し<select name="recurrence" value={recurrence} onChange={(event) => setRecurrence(event.target.value)} className="min-h-11 rounded-xl border border-line px-3"><option value="DAILY">毎日</option><option value="WEEKLY">毎週（開始日の曜日）</option><option value="WEEKENDS">毎土日</option><option value="SELECTED_WEEKDAYS">曜日を選ぶ</option></select></label>
            {recurrence === "SELECTED_WEEKDAYS" ? <fieldset className="flex flex-wrap gap-2 md:col-span-2"><legend className="mb-1 text-sm font-bold">曜日</legend>{WEEKDAYS.map((day) => <label key={day.id} className="flex min-h-10 items-center gap-1 rounded-xl border border-line px-3"><input type="checkbox" checked={weekdays.includes(day.id)} onChange={(event) => setWeekdays((current) => event.target.checked ? [...current, day.id] : current.filter((id) => id !== day.id))} />{day.label}</label>)}</fieldset> : null}
            <label className="grid gap-1 text-sm font-bold">開始日<input name="startsOn" type="date" defaultValue={fromDate} required className="min-h-11 rounded-xl border border-line px-3" /></label>
            <label className="grid gap-1 text-sm font-bold">終了日（任意）<input name="endsOn" type="date" className="min-h-11 rounded-xl border border-line px-3" /></label>
            <label className="grid gap-1 text-sm font-bold">開始時刻<input name="localStartTime" type="time" defaultValue="10:00" required className="min-h-11 rounded-xl border border-line px-3" /></label>
            <label className="grid gap-1 text-sm font-bold">所要時間（分）<input name="durationMinutes" type="number" min="1" max="1440" defaultValue="90" required className="min-h-11 rounded-xl border border-line px-3" /></label>
            <label className="grid gap-1 text-sm font-bold">定員<input name="capacity" type="number" min="1" max="1000" defaultValue="4" required className="min-h-11 rounded-xl border border-line px-3" /></label>
            <div className="flex items-end"><button type="submit" disabled={saving || data.preview} className="min-h-11 rounded-xl bg-moss px-5 font-bold text-white disabled:opacity-50">{saving ? "保存中…" : "開催枠を保存"}</button></div>
          </form> : <p className="text-sm text-ink-soft">開催枠を作るには、まず体験を登録してください。</p>}
        </section>
      </> : null}
    </div>
  );
}
