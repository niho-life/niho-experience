import type { StatusLabel } from "./status";
import type { HostBusyCalendar, HostCalendarSettings, HostGoogleCalendar, HostGoogleCalendarStatus, HostGoogleConnection } from "./types";

/*
 * 設定 › カレンダー (#109, Epic #103) as the screens show it: the Google Calendar's three states,
 * what each change does and says, the bookings feed's address, and ホーム's card while Google is
 * not connected. Plain data and rules (no server code), shared by the settings and home pages.
 */

export const GOOGLE_CALENDAR_STATUS: Record<HostGoogleCalendarStatus, StatusLabel> = {
  // Connecting is the host's choice, not something missing: the quiet tone.
  disconnected: { label: "未接続", tone: "draft" },
  connected: { label: "接続中", tone: "ok" },
  revoked: { label: "接続が切れました", tone: "wait" },
};

export const CALENDAR_BLOCK_LABEL = "予定がある時間は予約を受け付けない";
export const CALENDAR_BLOCK_DETAIL = "選んだカレンダーの予定と重なる回は、体験サイトで満席と同じ扱いになります（理由は予約者に出しません）";
export const CALENDAR_WRITE_LABEL = "確定した予約をカレンダーに書き込む";
export const CALENDAR_WRITE_DETAIL = "人数と食べものの希望を予定のメモに入れます。予約者の連絡先は入れません";
export const CALENDAR_ICS_TEXT = "Apple・Outlook などに予約の一覧を表示します";

/** A Google sign-in that has not happened: nothing chosen, NIHO's defaults for when it does. */
export const GOOGLE_NOT_CONNECTED: HostGoogleCalendar = { status: "disconnected", account: null, busyCalendars: [], blockBusy: true, writeBookings: true, writeCalendarId: null };

/** The Google row: its pill, one sentence, and the button that (re)connects; null while connected. */
export interface GoogleCalendarView {
  status: StatusLabel;
  text: string;
  connect: "つなぐ" | "もう一度つなぐ" | null;
  /** The switches, the calendars and 接続を切る (connected only). */
  settings: boolean;
}

export function googleCalendarView(google: HostGoogleCalendar): GoogleCalendarView {
  const status = GOOGLE_CALENDAR_STATUS[google.status];
  if (google.status === "connected") return { status, text: google.account ?? "Google アカウント", connect: null, settings: true };
  if (google.status === "revoked") return { status, text: "Google カレンダーの権限が取り消されたため、予定の確認と書き込みを止めています", connect: "もう一度つなぐ", settings: false };
  return { status, text: "つなぐと、予定がある時間は予約を受け付けません", connect: "つなぐ", settings: false };
}

/** What カレンダー lets the host press. */
export interface CalendarPanelControls {
  /** The pill beside カレンダー: http mode shows the panel as 準備中. */
  preparing: boolean;
  /** つなぐ / もう一度つなぐ. */
  connect: boolean;
  /** The switches, the calendars, 接続を切る and URL を作り直す. */
  change: boolean;
  /** URL をコピー: whenever there is an address to copy. */
  copy: boolean;
}

/**
 * Everything works in the preview (on screen only, with its synthetic Google account); http mode has
 * nothing to press until NIHO's Google connection and ICS feed are in the host contract (#87).
 */
export function calendarPanelControls(calendar: HostCalendarSettings, preview: boolean, connection: HostGoogleConnection | null): CalendarPanelControls {
  return { preparing: !preview, connect: preview && connection !== null, change: preview, copy: calendar.icsUrl !== null };
}

/** The calendars bookings can be written to (Google's own subscriptions, such as holidays, cannot). */
export function writableCalendars(google: HostGoogleCalendar): HostBusyCalendar[] {
  return google.busyCalendars.filter((calendar) => calendar.writable);
}

/** A hint under the calendars when blocking is on but no calendar is chosen; null otherwise. */
export function busyCalendarsHint(google: HostGoogleCalendar): string | null {
  if (google.status !== "connected" || !google.blockBusy) return null;
  return google.busyCalendars.some((calendar) => calendar.checked) ? null : "カレンダーを 1 つ以上選ぶと、予定がある時間の予約を止めます";
}

/** A color Google gave, or none: only #rrggbb is drawn (it never reaches CSS as anything else). */
export function calendarColor(color: string): string | null {
  return /^#[0-9a-f]{6}$/i.test(color) ? color : null;
}

/** What the host does in カレンダー. Each one shows at once and says what changed. */
export type CalendarChange =
  /** つなぐ / もう一度つなぐ: Google's sign-in brought this account (a revoked one keeps its own and its choices). */
  | { kind: "connect"; connection: HostGoogleConnection }
  | { kind: "disconnect" }
  | { kind: "block"; on: boolean }
  | { kind: "busy"; id: string; checked: boolean }
  | { kind: "write"; on: boolean }
  | { kind: "write-to"; id: string }
  /** URL を作り直す: the old address stops working. */
  | { kind: "new-ics"; url: string };

export interface CalendarChangeResult {
  calendar: HostCalendarSettings;
  /** Said in the panel's role=status; null when nothing changed. */
  message: string | null;
}

const unchanged = (calendar: HostCalendarSettings): CalendarChangeResult => ({ calendar, message: null });

function nameOf(google: HostGoogleCalendar, id: string | null): string {
  return google.busyCalendars.find((calendar) => calendar.id === id)?.name ?? "カレンダー";
}

/** The first calendar bookings can go to, when none is chosen (or the chosen one cannot take them). */
function writeTarget(google: HostGoogleCalendar): string | null {
  const writable = writableCalendars(google);
  return writable.some((calendar) => calendar.id === google.writeCalendarId) ? google.writeCalendarId : (writable[0]?.id ?? null);
}

/**
 * One change to カレンダー, and what to say about it. The switches and the calendars only change a
 * connected calendar; connecting a revoked one brings back its account and its choices.
 */
export function applyCalendarChange(calendar: HostCalendarSettings, change: CalendarChange): CalendarChangeResult {
  const { google } = calendar;
  const connected = google.status === "connected";
  const withGoogle = (next: HostGoogleCalendar, message: string): CalendarChangeResult => ({ calendar: { ...calendar, google: next }, message });

  switch (change.kind) {
    case "connect": {
      if (connected) return unchanged(calendar);
      if (google.status === "revoked" && google.account) return withGoogle({ ...google, status: "connected" }, `Google カレンダーにもう一度つなぎました（${google.account}）`);
      const fresh: HostGoogleCalendar = { ...GOOGLE_NOT_CONNECTED, status: "connected", account: change.connection.account, busyCalendars: change.connection.calendars };
      return withGoogle({ ...fresh, writeCalendarId: writeTarget(fresh) }, `Google カレンダーをつなぎました（${change.connection.account}）`);
    }
    case "disconnect":
      if (google.status === "disconnected") return unchanged(calendar);
      return withGoogle(GOOGLE_NOT_CONNECTED, "Google カレンダーの接続を切りました。予約はそのままです");
    case "new-ics":
      return { calendar: { ...calendar, icsUrl: change.url }, message: "URL を作り直しました。登録したカレンダーで、新しい URL を登録し直してください" };
    case "block":
      if (!connected) return unchanged(calendar);
      return withGoogle({ ...google, blockBusy: change.on }, change.on ? "予定がある時間は予約を受け付けません" : "予定がある時間も予約を受け付けます");
    case "busy": {
      if (!connected || !google.busyCalendars.some((entry) => entry.id === change.id)) return unchanged(calendar);
      const busyCalendars = google.busyCalendars.map((entry) => (entry.id === change.id ? { ...entry, checked: change.checked } : entry));
      const name = nameOf(google, change.id);
      return withGoogle({ ...google, busyCalendars }, change.checked ? `「${name}」の予定がある時間は予約を受け付けません` : `「${name}」の予定は見ません`);
    }
    case "write": {
      if (!connected) return unchanged(calendar);
      if (!change.on) return withGoogle({ ...google, writeBookings: false }, "予約をカレンダーに書き込みません");
      const writeCalendarId = writeTarget(google);
      return withGoogle({ ...google, writeBookings: true, writeCalendarId }, `確定した予約を「${nameOf(google, writeCalendarId)}」に書き込みます`);
    }
    case "write-to":
      if (!connected || !writableCalendars(google).some((entry) => entry.id === change.id)) return unchanged(calendar);
      return withGoogle({ ...google, writeCalendarId: change.id }, `確定した予約を「${nameOf(google, change.id)}」に書き込みます`);
  }
}

/**
 * The bookings feed at a new address (the preview's URL を作り直す): the same address with `token`
 * in place of the secret part before `bookings.ics`. NIHO makes the real one (niho-app#19316).
 */
export function renewIcsUrl(url: string, token: string): string {
  return url.replace(/\/[^/]+\/bookings\.ics$/, `/${token}/bookings.ics`);
}

/** ホーム's card while Google Calendar is not connected (or lost its access). */
export interface HomeCalendarPrompt {
  title: string;
  text: string;
  action: string;
}

/**
 * The card on ホーム, or null: only while the calendar is not connected, and only where the host
 * can connect it (the preview; http mode cannot until NIHO's API is in the host contract).
 */
export function homeCalendarPrompt(calendar: HostCalendarSettings, preview: boolean): HomeCalendarPrompt | null {
  if (!preview) return null;
  if (calendar.google.status === "revoked") return { title: "Google カレンダーの接続が切れました", text: "もう一度つなぐまで、予定の確認と書き込みを止めています", action: "もう一度つなぐ" };
  if (calendar.google.status === "disconnected") return { title: "Google カレンダーをつなぐ", text: "予定がある時間は予約を受け付けません", action: "つなぐ" };
  return null;
}
