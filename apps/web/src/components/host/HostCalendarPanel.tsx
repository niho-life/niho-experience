"use client";

import { useRef, useState } from "react";
import {
  applyCalendarChange,
  busyCalendarsHint,
  CALENDAR_BLOCK_DETAIL,
  CALENDAR_BLOCK_LABEL,
  CALENDAR_ICS_TEXT,
  CALENDAR_WRITE_DETAIL,
  CALENDAR_WRITE_LABEL,
  calendarColor,
  calendarPanelControls,
  googleCalendarView,
  renewIcsUrl,
  writableCalendars,
  type CalendarChange,
} from "@/host/calendar";
import type { HostNotice } from "@/host/payout";
import { PREPARING_STATUS } from "@/host/status";
import type { HostCalendarSettings, HostGoogleConnection } from "@/host/types";
import { DISABLED, useFocusAfterRender } from "./editor-parts";
import { FIELD_DISABLED, FieldRow, FieldSection, SELECT, SwitchRow } from "./fields";
import { HostConfirmDialog } from "./HostConfirmDialog";
import { consoleButtonClass } from "./host-ui";
import { HostIcon } from "./HostIcon";
import { HostNoticeLine } from "./HostNoticeLine";
import { StatusPill } from "./ui";

const CONNECT_ID = "settings-calendar-connect";
const BLOCK_ID = "settings-calendar-block";
const WRITE_ID = "settings-calendar-write";
const WRITE_TO_ID = "settings-calendar-write-to";
const ICS_ID = "settings-calendar-ics";
/** The feed's address: read-only (sand, like a field that cannot be changed) but selectable, 16px on phones like every field. */
const URL_FIELD = "block min-h-10 w-full rounded-[10px] border border-line-strong bg-sand px-3 py-2 text-[1rem] leading-normal text-ink-soft md:max-w-[520px] md:text-[0.875rem]";

/** A new secret part for the preview's feed address (NIHO makes the real one). */
function previewToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 設定 › カレンダー (#109, the journey mock's H6): the Google Calendar and the bookings feed for
 * other calendars. Like the payout account it works on its own, outside 保存: connecting,
 * disconnecting, each switch and calendar and a new feed address take effect at once and say so
 * here. Disconnecting and a new address are asked first in a dialog.
 *
 * The preview (mock mode) connects a synthetic Google account and keeps every change on screen
 * only. http mode shows the panel as 準備中 with nothing to press.
 * TODO(#87): NIHO's Google connection (niho-app#19317: Google's consent page and back, the
 * calendars, the switches) and the ICS feed (#19316: its address and a new one) once they are in
 * the host contract.
 */
export function HostCalendarPanel({ calendar: initial, connection, preview }: { calendar: HostCalendarSettings; connection: HostGoogleConnection | null; preview: boolean }) {
  const [calendar, setCalendar] = useState(initial);
  const [notice, setNotice] = useState<HostNotice | null>(null);
  const [asking, setAsking] = useState<"disconnect" | "renew" | null>(null);
  const stay = useRef<HTMLButtonElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const focusLater = useFocusAfterRender();
  const { google, icsUrl } = calendar;
  const view = googleCalendarView(google);
  const can = calendarPanelControls(calendar, preview, connection);
  const connected = google.status === "connected";
  const writable = writableCalendars(google);
  const hint = busyCalendarsHint(google);

  const change = (next: CalendarChange) => {
    const result = applyCalendarChange(calendar, next);
    setCalendar(result.calendar);
    setNotice(result.message ? { tone: "success", message: result.message } : null);
  };

  const connect = () => {
    if (!can.connect || !connection) return;
    change({ kind: "connect", connection });
    // The button is gone: the first new setting takes the focus.
    focusLater(BLOCK_ID);
  };

  const disconnect = () => {
    change({ kind: "disconnect" });
    focusLater(CONNECT_ID);
  };

  const copy = async () => {
    if (!icsUrl) return;
    try {
      await navigator.clipboard.writeText(icsUrl);
      setNotice({ tone: "success", message: "URL をコピーしました" });
    } catch {
      urlInput.current?.select();
      setNotice({ tone: "error", message: "コピーできませんでした。URL を選んでコピーしてください" });
    }
  };

  const button = consoleButtonClass("secondary", "sm", DISABLED);
  return (
    <FieldSection id="settings-calendar" title="カレンダー" status={can.preparing ? PREPARING_STATUS : null}>
      <FieldRow label="Google カレンダー" labelId="settings-calendar-google">
        <div role="group" aria-labelledby="settings-calendar-google" className="flex min-h-10 flex-wrap items-center gap-x-2.5 gap-y-2">
          <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-sand text-[0.9375rem] font-extrabold">
            G
          </span>
          <StatusPill status={view.status} />
          <span className={`min-w-0 [overflow-wrap:anywhere] ${connected ? "font-bold" : "text-ink-soft"}`}>{view.text}</span>
          {view.connect ? (
            <button id={CONNECT_ID} type="button" disabled={!can.connect} onClick={connect} className={button}>
              {view.connect === "つなぐ" ? "Google カレンダーをつなぐ" : "もう一度つなぐ"}
            </button>
          ) : null}
          {connected ? (
            <button type="button" disabled={!can.change} onClick={() => setAsking("disconnect")} className={consoleButtonClass("ghost", "sm", `${DISABLED} md:ml-auto`)}>
              接続を切る
            </button>
          ) : null}
        </div>
      </FieldRow>

      {connected ? (
        <>
          <FieldRow label="空きの確認" labelId="settings-calendar-busy">
            <div role="group" aria-labelledby="settings-calendar-busy" className="md:max-w-[520px]">
              <SwitchRow id={BLOCK_ID} label={CALENDAR_BLOCK_LABEL} detail={CALENDAR_BLOCK_DETAIL} checked={google.blockBusy} disabled={!can.change} onChange={(on) => change({ kind: "block", on })} />
              <p id="settings-calendar-busy-list" className="pt-1 text-xs font-extrabold text-muted">
                空きを見るカレンダー
              </p>
              <ul aria-labelledby="settings-calendar-busy-list">
                {google.busyCalendars.map((entry) => {
                  const color = calendarColor(entry.color);
                  return (
                    <li key={entry.id}>
                      <label className="flex min-h-10 items-center gap-2.5 text-[0.875rem] has-[:disabled]:text-ink-soft">
                        <span aria-hidden="true" className={`size-3 shrink-0 rounded-[4px] ${color ? "" : "bg-line-strong"}`} style={color ? { backgroundColor: color } : undefined} />
                        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{entry.name}</span>
                        <input
                          type="checkbox"
                          checked={entry.checked}
                          disabled={!can.change || !google.blockBusy}
                          onChange={(event) => change({ kind: "busy", id: entry.id, checked: event.currentTarget.checked })}
                          className="size-5 shrink-0 accent-moss disabled:cursor-not-allowed"
                        />
                      </label>
                    </li>
                  );
                })}
              </ul>
              {hint ? <p className="text-[0.78125rem] leading-normal font-bold text-warn">{hint}</p> : null}
            </div>
          </FieldRow>

          <FieldRow label="予約の書き込み" labelId="settings-calendar-write-label">
            <div role="group" aria-labelledby="settings-calendar-write-label" className="md:max-w-[520px]">
              <SwitchRow id={WRITE_ID} label={CALENDAR_WRITE_LABEL} detail={CALENDAR_WRITE_DETAIL} checked={google.writeBookings} disabled={!can.change || writable.length === 0} onChange={(on) => change({ kind: "write", on })} />
              <label htmlFor={WRITE_TO_ID} className="mb-1 block pt-1 text-xs font-extrabold text-muted">
                書き込み先
              </label>
              <select
                id={WRITE_TO_ID}
                value={google.writeCalendarId ?? ""}
                disabled={!can.change || !google.writeBookings || writable.length === 0}
                onChange={(event) => change({ kind: "write-to", id: event.currentTarget.value })}
                className={`${SELECT} ${FIELD_DISABLED}`}
              >
                {google.writeCalendarId ? null : <option value="">書き込むカレンダーを選ぶ</option>}
                {writable.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </div>
          </FieldRow>
        </>
      ) : null}

      <FieldRow label="ほかのカレンダーで見る" labelId="settings-calendar-ics-label">
        <div role="group" aria-labelledby="settings-calendar-ics-label" className="flex flex-col items-start gap-2">
          <p id={`${ICS_ID}-text`} className="text-ink-soft">
            {CALENDAR_ICS_TEXT}
          </p>
          {icsUrl ? (
            <input
              ref={urlInput}
              id={ICS_ID}
              readOnly
              value={icsUrl}
              aria-label="予約の一覧の URL"
              aria-describedby={`${ICS_ID}-text`}
              spellCheck={false}
              // The whole address at once: a click or a tab selects all of it.
              onFocus={(event) => event.currentTarget.select()}
              onClick={(event) => event.currentTarget.select()}
              className={URL_FIELD}
            />
          ) : (
            <p className="text-muted">URL はまだありません。</p>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={!can.copy} onClick={copy} className={button}>
              <HostIcon name="copy" className="size-3.5" />
              URL をコピー
            </button>
            <button type="button" disabled={!can.change || !icsUrl} onClick={() => setAsking("renew")} className={button}>
              URL を作り直す
            </button>
          </div>
        </div>
      </FieldRow>

      <HostNoticeLine notice={notice} className="pt-1" />

      {asking === "disconnect" ? (
        <HostConfirmDialog
          title="Google カレンダーの接続を切りますか？"
          description="切っても予約は消えません。書き込んだ予定は残ります。予定がある時間の判定は止まります。"
          focusRef={stay}
          stayRef={stay}
          confirm={
            <button type="submit" className={consoleButtonClass("primary")}>
              接続を切る
            </button>
          }
          onConfirm={disconnect}
          onClose={() => setAsking(null)}
        />
      ) : null}
      {asking === "renew" && icsUrl ? (
        <HostConfirmDialog
          title="URL を作り直しますか？"
          description="今の URL は使えなくなります。登録したカレンダーで、新しい URL を登録し直してください。"
          focusRef={stay}
          stayRef={stay}
          confirm={
            <button type="submit" className={consoleButtonClass("primary")}>
              URL を作り直す
            </button>
          }
          onConfirm={() => change({ kind: "new-ics", url: renewIcsUrl(icsUrl, previewToken()) })}
          onClose={() => setAsking(null)}
        />
      ) : null}
    </FieldSection>
  );
}
