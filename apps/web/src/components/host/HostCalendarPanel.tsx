"use client";

import { useRef, useState, type RefObject } from "react";
import {
  applyCalendarChange,
  busyCalendarsHint,
  CALENDAR_BLOCK_DETAIL,
  CALENDAR_BLOCK_LABEL,
  CALENDAR_FEED_ISSUE_FAILED_TEXT,
  CALENDAR_FEED_REVOKE_FAILED_TEXT,
  CALENDAR_ICS_TEXT,
  CALENDAR_WRITE_DETAIL,
  CALENDAR_WRITE_LABEL,
  calendarColor,
  calendarPanelControls,
  GOOGLE_CALENDAR_STATUS,
  GOOGLE_DISCONNECT_FAILED_TEXT,
  GOOGLE_DISCONNECTED_TEXT,
  GOOGLE_NOT_CONNECTED,
  googleCalendarView,
  liveGoogleSyncLines,
  liveGoogleText,
  renewIcsUrl,
  writableCalendars,
  type CalendarChange,
  type HostCalendarLoad,
} from "@/host/calendar";
import { issueHostCalendarFeed, revokeHostCalendarFeed } from "@/host/calendar-actions";
import type { HostNotice } from "@/host/payout";
import type { HostCalendarSettings, HostGoogleCalendar, HostGoogleConnection } from "@/host/types";
import { HOST_CALENDAR_PATH, withProvider } from "@/lib/host/routes";
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
const ICS_CREATE_ID = "settings-calendar-ics-create";
/** The feed's address: read-only (sand, like a field that cannot be changed) but selectable, 16px on phones like every field. */
const URL_FIELD = "block min-h-10 w-full rounded-[10px] border border-line-strong bg-sand px-3 py-2 text-[1rem] leading-normal text-ink-soft md:max-w-[520px] md:text-[0.875rem]";
/** URL を止める's confirming button: it takes something away, in the danger color as the bookings' cancel buttons. */
const STOP_BUTTON =
  "inline-flex h-[38px] shrink-0 items-center justify-center whitespace-nowrap rounded-full border border-line-strong bg-canvas px-4 text-[0.84375rem] leading-none font-extrabold text-danger hover:bg-danger-pale";
const DISCONNECT_TITLE = "Google カレンダーの接続を切りますか？";
const DISCONNECT_TEXT = "切っても予約は消えません。書き込んだ予定は残ります。予定がある時間の判定は止まります。";
const RENEW_TITLE = "URL を作り直しますか？";
const RENEW_TEXT = "今の URL は使えなくなります。登録したカレンダーで、新しい URL を登録し直してください。";

/** A new secret part for the preview's feed address (http mode's is made on the server). */
function previewToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** URL をコピー: to the clipboard, or (when the browser refuses) the address selected for the host to copy. */
async function copyFeedUrl(url: string, input: HTMLInputElement | null): Promise<HostNotice> {
  try {
    await navigator.clipboard.writeText(url);
    return { tone: "success", message: "URL をコピーしました" };
  } catch {
    input?.select();
    return { tone: "error", message: "コピーできませんでした。URL を選んでコピーしてください" };
  }
}

/** The feed's address, read-only: a click or a tab selects all of it. */
function FeedUrlField({ url, inputRef }: { url: string; inputRef: RefObject<HTMLInputElement | null> }) {
  return (
    <input
      ref={inputRef}
      id={ICS_ID}
      readOnly
      value={url}
      aria-label="予約の一覧の URL"
      aria-describedby={`${ICS_ID}-text`}
      spellCheck={false}
      // The whole address at once: a click or a tab selects all of it.
      onFocus={(event) => event.currentTarget.select()}
      onClick={(event) => event.currentTarget.select()}
      className={URL_FIELD}
    />
  );
}

/** The G tile, the Google row's pill and sentence (both panels). */
function GoogleState({ google, text }: { google: HostGoogleCalendar; text: string }) {
  return (
    <>
      <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-sand text-[0.9375rem] font-extrabold">
        G
      </span>
      <StatusPill status={GOOGLE_CALENDAR_STATUS[google.status]} />
      <span className={`min-w-0 [overflow-wrap:anywhere] ${google.status === "connected" ? "font-bold" : "text-ink-soft"}`}>{text}</span>
    </>
  );
}

/**
 * 設定 › カレンダー (#109, the journey mock's H6): the Google Calendar and the bookings feed for
 * other calendars. Like the payout account it works on its own, outside 保存: connecting,
 * disconnecting, each switch and calendar and a new feed address take effect at once and say so
 * here. Disconnecting and a new address are asked first in a dialog.
 *
 * The preview (mock mode) connects a synthetic Google account and keeps every change on screen
 * only. http mode has HostLiveCalendarPanel below.
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
    setNotice(await copyFeedUrl(icsUrl, urlInput.current));
  };

  const button = consoleButtonClass("secondary", "sm", DISABLED);
  return (
    <FieldSection id="settings-calendar" title="カレンダー" status={null}>
      <FieldRow label="Google カレンダー" labelId="settings-calendar-google">
        <div role="group" aria-labelledby="settings-calendar-google" className="flex min-h-10 flex-wrap items-center gap-x-2.5 gap-y-2">
          <GoogleState google={google} text={view.text} />
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
          {icsUrl ? <FeedUrlField url={icsUrl} inputRef={urlInput} /> : <p className="text-muted">URL はまだありません。</p>}
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
          title={DISCONNECT_TITLE}
          description={DISCONNECT_TEXT}
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
          title={RENEW_TITLE}
          description={RENEW_TEXT}
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

/**
 * 設定 › カレンダー in http mode (#109), for the provider's OWNER, in the preview's rows: the Google Calendar as the
 * experience DB has it (つなぐ goes to Google's consent page and comes back to the calendar; 接続を切る is asked first),
 * what its busy times do and when they were last read, the link to the sessions, and with
 * EXPERIENCE_HOST_CALENDAR_FEED_ENABLED the bookings feed: its address to copy, made, made again or stopped (the last
 * two asked first). No Google account or calendar list is kept, so there are no switches: busy times come from the
 * calendar chosen when connecting. Each result is said at the bottom.
 */
export function HostLiveCalendarPanel({ providerId, load }: { providerId: string; load: Extract<HostCalendarLoad, { status: "live" }> }) {
  const [google, setGoogle] = useState(load.google);
  const [feedUrl, setFeedUrl] = useState(load.feed?.url ?? null);
  const [notice, setNotice] = useState<HostNotice | null>(null);
  const [asking, setAsking] = useState<"disconnect" | "renew" | "revoke" | null>(null);
  const [pending, setPending] = useState(false);
  const stay = useRef<HTMLButtonElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const focusLater = useFocusAfterRender();
  const syncLines = google ? liveGoogleSyncLines(google, load.googleSync) : [];
  const button = consoleButtonClass("secondary", "sm", DISABLED);
  const connectHref = withProvider("/host/calendar/google/connect", providerId);

  const disconnect = async () => {
    setPending(true);
    try {
      const response = await fetch("/host/calendar/google", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId, action: "disconnect" }),
      });
      if (!response.ok) throw new Error(`disconnect ${response.status}`);
      setGoogle(GOOGLE_NOT_CONNECTED);
      setNotice({ tone: "success", message: GOOGLE_DISCONNECTED_TEXT });
      // The button is gone: つなぐ takes the focus.
      focusLater(CONNECT_ID);
    } catch {
      setNotice({ tone: "error", message: GOOGLE_DISCONNECT_FAILED_TEXT });
    } finally {
      setPending(false);
    }
  };

  /** URL を作る / 作り直す / 止める, on the server; the address shown becomes the one it answers. */
  const changeFeed = async (kind: "issue" | "revoke") => {
    setPending(true);
    try {
      const result = kind === "issue" ? await issueHostCalendarFeed(providerId) : await revokeHostCalendarFeed(providerId);
      if (result.ok) {
        setFeedUrl(result.url);
        focusLater(result.url ? ICS_ID : ICS_CREATE_ID);
      }
      setNotice({ tone: result.ok ? "success" : "error", message: result.message });
    } catch {
      setNotice({ tone: "error", message: kind === "issue" ? CALENDAR_FEED_ISSUE_FAILED_TEXT : CALENDAR_FEED_REVOKE_FAILED_TEXT });
    } finally {
      setPending(false);
    }
  };

  const copy = async () => {
    if (!feedUrl) return;
    setNotice(await copyFeedUrl(feedUrl, urlInput.current));
  };

  return (
    <FieldSection id="settings-calendar" title="カレンダー" status={null}>
      {google ? (
        <FieldRow label="Google カレンダー" labelId="settings-calendar-google">
          <div role="group" aria-labelledby="settings-calendar-google" className="flex min-h-10 flex-wrap items-center gap-x-2.5 gap-y-2">
            <GoogleState google={google} text={liveGoogleText(google)} />
            {google.status === "connected" ? (
              <button type="button" disabled={pending} onClick={() => setAsking("disconnect")} className={consoleButtonClass("ghost", "sm", `${DISABLED} md:ml-auto`)}>
                接続を切る
              </button>
            ) : (
              <a id={CONNECT_ID} href={connectHref} className={consoleButtonClass("secondary", "sm")}>
                {google.status === "revoked" ? "もう一度つなぐ" : "Google カレンダーをつなぐ"}
              </a>
            )}
          </div>
        </FieldRow>
      ) : null}

      {syncLines.length ? (
        <FieldRow label="空きの確認" labelId="settings-calendar-busy">
          <div role="group" aria-labelledby="settings-calendar-busy" className="flex min-h-10 flex-col justify-center gap-1 md:max-w-[520px]">
            {syncLines.map((line) => (
              <p key={line.text} className={line.tone === "warn" ? "text-[0.78125rem] leading-normal font-bold text-warn" : "text-ink-soft"}>
                {line.text}
              </p>
            ))}
          </div>
        </FieldRow>
      ) : null}

      <FieldRow label="開催枠" labelId="settings-calendar-link">
        <div className="flex min-h-10 items-center">
          <a href={withProvider(HOST_CALENDAR_PATH, providerId)} className="font-bold text-moss underline underline-offset-4">
            カレンダーを開く
          </a>
        </div>
      </FieldRow>

      {load.feed ? (
        <FieldRow label="ほかのカレンダーで見る" labelId="settings-calendar-ics-label">
          <div role="group" aria-labelledby="settings-calendar-ics-label" className="flex flex-col items-start gap-2">
            <p id={`${ICS_ID}-text`} className="text-ink-soft">
              {CALENDAR_ICS_TEXT}
            </p>
            {feedUrl ? <FeedUrlField url={feedUrl} inputRef={urlInput} /> : <p className="text-muted">URL はまだありません。</p>}
            <div className="flex flex-wrap gap-2">
              {feedUrl ? (
                <>
                  <button type="button" disabled={pending} onClick={copy} className={button}>
                    <HostIcon name="copy" className="size-3.5" />
                    URL をコピー
                  </button>
                  <button type="button" disabled={pending} onClick={() => setAsking("renew")} className={button}>
                    URL を作り直す
                  </button>
                  <button type="button" disabled={pending} onClick={() => setAsking("revoke")} className={consoleButtonClass("ghost", "sm", DISABLED)}>
                    URL を止める
                  </button>
                </>
              ) : (
                <button id={ICS_CREATE_ID} type="button" disabled={pending} onClick={() => void changeFeed("issue")} className={button}>
                  URL を作る
                </button>
              )}
            </div>
          </div>
        </FieldRow>
      ) : null}

      <HostNoticeLine notice={notice} className="pt-1" />

      {asking === "disconnect" ? (
        <HostConfirmDialog
          title={DISCONNECT_TITLE}
          description={DISCONNECT_TEXT}
          focusRef={stay}
          stayRef={stay}
          confirm={
            <button type="submit" className={consoleButtonClass("primary")}>
              接続を切る
            </button>
          }
          onConfirm={() => void disconnect()}
          onClose={() => setAsking(null)}
        />
      ) : null}
      {asking === "renew" ? (
        <HostConfirmDialog
          title={RENEW_TITLE}
          description={RENEW_TEXT}
          focusRef={stay}
          stayRef={stay}
          confirm={
            <button type="submit" className={consoleButtonClass("primary")}>
              URL を作り直す
            </button>
          }
          onConfirm={() => void changeFeed("issue")}
          onClose={() => setAsking(null)}
        />
      ) : null}
      {asking === "revoke" ? (
        <HostConfirmDialog
          title="URL を止めますか？"
          description="今の URL は使えなくなり、登録したカレンダーに予約が届かなくなります。もう一度作ることもできます。"
          focusRef={stay}
          stayRef={stay}
          confirm={
            <button type="submit" className={STOP_BUTTON}>
              URL を止める
            </button>
          }
          onConfirm={() => void changeFeed("revoke")}
          onClose={() => setAsking(null)}
        />
      ) : null}
    </FieldSection>
  );
}
