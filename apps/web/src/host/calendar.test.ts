import { describe, expect, it } from "vitest";
import {
  applyCalendarChange,
  busyCalendarsHint,
  calendarColor,
  calendarPanelControls,
  GOOGLE_NOT_CONNECTED,
  googleCalendarView,
  homeCalendarPrompt,
  renewIcsUrl,
  writableCalendars,
  type CalendarChange,
} from "./calendar";
import type { HostCalendarSettings, HostGoogleConnection } from "./types";

const ICS = "https://calendar.example.com/sample-kitchen/aaaabbbbccccdddd/bookings.ics";
const CONNECTION: HostGoogleConnection = {
  account: "host@example.com",
  calendars: [
    { id: "holidays", name: "日本の祝日", color: "#7a4b00", checked: false, writable: false },
    { id: "main", name: "個人の予定", color: "#355e1f", checked: true, writable: true },
    { id: "classes", name: "教室の予定", color: "#1e4ea8", checked: false, writable: true },
  ],
};
const NOT_CONNECTED: HostCalendarSettings = { google: GOOGLE_NOT_CONNECTED, icsUrl: ICS };
const apply = (calendar: HostCalendarSettings, ...changes: CalendarChange[]) =>
  changes.reduce<{ calendar: HostCalendarSettings; message: string | null }>((result, change) => applyCalendarChange(result.calendar, change), { calendar, message: null });
const CONNECTED = apply(NOT_CONNECTED, { kind: "connect", connection: CONNECTION }).calendar;

describe("the Google Calendar's states", () => {
  it("has a pill and one sentence for each state, and a button where one connects", () => {
    expect(googleCalendarView(GOOGLE_NOT_CONNECTED)).toEqual({ status: { label: "未接続", tone: "draft" }, text: "つなぐと、予定がある時間は予約を受け付けません", connect: "つなぐ", settings: false });
    expect(googleCalendarView(CONNECTED.google)).toEqual({ status: { label: "接続中", tone: "ok" }, text: "host@example.com", connect: null, settings: true });
    expect(googleCalendarView({ ...CONNECTED.google, status: "revoked" })).toEqual({
      status: { label: "接続が切れました", tone: "wait" },
      text: "Google カレンダーの権限が取り消されたため、予定の確認と書き込みを止めています",
      connect: "もう一度つなぐ",
      settings: false,
    });
  });
});

describe("calendarPanelControls", () => {
  it("lets the preview try everything on screen", () => {
    expect(calendarPanelControls(NOT_CONNECTED, true, CONNECTION)).toEqual({ preparing: false, connect: true, change: true, copy: true });
  });

  it("is 準備中 in http mode, with nothing to press until NIHO's API is in the host contract", () => {
    const http: HostCalendarSettings = { google: GOOGLE_NOT_CONNECTED, icsUrl: null };
    expect(calendarPanelControls(http, false, null)).toEqual({ preparing: true, connect: false, change: false, copy: false });
    expect(calendarPanelControls(CONNECTED, false, null)).toMatchObject({ preparing: true, connect: false, change: false });
  });
});

describe("applyCalendarChange", () => {
  it("connects the account Google brought: its calendars as Google chose them, bookings to the first one it can write to", () => {
    const result = applyCalendarChange(NOT_CONNECTED, { kind: "connect", connection: CONNECTION });
    expect(result.message).toBe("Google カレンダーをつなぎました（host@example.com）");
    expect(result.calendar).toEqual({
      icsUrl: ICS,
      google: { status: "connected", account: "host@example.com", busyCalendars: CONNECTION.calendars, blockBusy: true, writeBookings: true, writeCalendarId: "main" },
    });
    // Already connected: nothing changes, nothing is said.
    expect(applyCalendarChange(CONNECTED, { kind: "connect", connection: CONNECTION })).toEqual({ calendar: CONNECTED, message: null });
  });

  it("brings a revoked calendar back with its own account and choices", () => {
    const chosen = apply(CONNECTED, { kind: "busy", id: "classes", checked: true }, { kind: "write-to", id: "classes" }).calendar;
    const revoked: HostCalendarSettings = { ...chosen, google: { ...chosen.google, status: "revoked" } };
    const result = applyCalendarChange(revoked, { kind: "connect", connection: { account: "someone-else@example.com", calendars: [] } });
    expect(result.message).toBe("Google カレンダーにもう一度つなぎました（host@example.com）");
    expect(result.calendar).toEqual(chosen);
  });

  it("disconnects without touching the bookings feed, and starts over the next time", () => {
    const result = applyCalendarChange(CONNECTED, { kind: "disconnect" });
    expect(result).toEqual({ calendar: { google: GOOGLE_NOT_CONNECTED, icsUrl: ICS }, message: "Google カレンダーの接続を切りました。予約はそのままです" });
    const revoked = applyCalendarChange({ ...CONNECTED, google: { ...CONNECTED.google, status: "revoked" } }, { kind: "disconnect" });
    expect(revoked.calendar.google).toEqual(GOOGLE_NOT_CONNECTED);
    expect(applyCalendarChange(NOT_CONNECTED, { kind: "disconnect" })).toEqual({ calendar: NOT_CONNECTED, message: null });
  });

  it("switches busy times and the calendars they come from, saying what changed", () => {
    const off = applyCalendarChange(CONNECTED, { kind: "block", on: false });
    expect(off.calendar.google.blockBusy).toBe(false);
    expect(off.message).toBe("予定がある時間も予約を受け付けます");
    expect(applyCalendarChange(off.calendar, { kind: "block", on: true }).message).toBe("予定がある時間は予約を受け付けません");

    const classes = applyCalendarChange(CONNECTED, { kind: "busy", id: "classes", checked: true });
    expect(classes.calendar.google.busyCalendars.filter((entry) => entry.checked).map((entry) => entry.id)).toEqual(["main", "classes"]);
    expect(classes.message).toBe("「教室の予定」の予定がある時間は予約を受け付けません");
    expect(applyCalendarChange(CONNECTED, { kind: "busy", id: "main", checked: false }).message).toBe("「個人の予定」の予定は見ません");
    // A calendar the account does not have changes nothing.
    expect(applyCalendarChange(CONNECTED, { kind: "busy", id: "nope", checked: true })).toEqual({ calendar: CONNECTED, message: null });
  });

  it("writes bookings to a calendar the account can write to, and stops writing", () => {
    const off = applyCalendarChange(CONNECTED, { kind: "write", on: false });
    expect(off).toMatchObject({ calendar: { google: { writeBookings: false, writeCalendarId: "main" } }, message: "予約をカレンダーに書き込みません" });
    expect(applyCalendarChange(off.calendar, { kind: "write", on: true }).message).toBe("確定した予約を「個人の予定」に書き込みます");
    const classes = applyCalendarChange(CONNECTED, { kind: "write-to", id: "classes" });
    expect(classes).toMatchObject({ calendar: { google: { writeCalendarId: "classes" } }, message: "確定した予約を「教室の予定」に書き込みます" });
    // Google's holidays cannot be written to.
    expect(applyCalendarChange(CONNECTED, { kind: "write-to", id: "holidays" })).toEqual({ calendar: CONNECTED, message: null });
    expect(writableCalendars(CONNECTED.google).map((entry) => entry.id)).toEqual(["main", "classes"]);
  });

  it("changes no switch of a calendar that is not connected", () => {
    const revoked: HostCalendarSettings = { ...CONNECTED, google: { ...CONNECTED.google, status: "revoked" } };
    const changes: CalendarChange[] = [
      { kind: "block", on: false },
      { kind: "busy", id: "classes", checked: true },
      { kind: "write", on: false },
      { kind: "write-to", id: "classes" },
    ];
    for (const change of changes) {
      expect(applyCalendarChange(revoked, change), change.kind).toEqual({ calendar: revoked, message: null });
      expect(applyCalendarChange(NOT_CONNECTED, change), change.kind).toEqual({ calendar: NOT_CONNECTED, message: null });
    }
  });

  it("puts the bookings feed at a new address, whatever the calendar's state", () => {
    const url = renewIcsUrl(ICS, "0123456789abcdef");
    expect(url).toBe("https://calendar.example.com/sample-kitchen/0123456789abcdef/bookings.ics");
    for (const calendar of [NOT_CONNECTED, CONNECTED]) {
      expect(applyCalendarChange(calendar, { kind: "new-ics", url })).toEqual({
        calendar: { ...calendar, icsUrl: url },
        message: "URL を作り直しました。登録したカレンダーで、新しい URL を登録し直してください",
      });
    }
  });
});

describe("calendar details", () => {
  it("asks for a calendar when busy times are on and none is chosen", () => {
    expect(busyCalendarsHint(CONNECTED.google)).toBeNull();
    const none = apply(CONNECTED, { kind: "busy", id: "main", checked: false }).calendar.google;
    expect(busyCalendarsHint(none)).toBe("カレンダーを 1 つ以上選ぶと、予定がある時間の予約を止めます");
    expect(busyCalendarsHint({ ...none, blockBusy: false })).toBeNull();
    expect(busyCalendarsHint(GOOGLE_NOT_CONNECTED)).toBeNull();
  });

  it("draws only a plain #rrggbb color", () => {
    expect(calendarColor("#355e1f")).toBe("#355e1f");
    for (const color of ["red", "#355e1f; background:url(x)", "#fff", "", "var(--color-moss)"]) expect(calendarColor(color), color).toBeNull();
  });
});

describe("homeCalendarPrompt", () => {
  it("leads to つなぐ while Google is not connected, and to もう一度つなぐ once its access was taken away", () => {
    expect(homeCalendarPrompt(NOT_CONNECTED, true)).toEqual({ title: "Google カレンダーをつなぐ", text: "予定がある時間は予約を受け付けません", action: "つなぐ" });
    expect(homeCalendarPrompt({ ...CONNECTED, google: { ...CONNECTED.google, status: "revoked" } }, true)).toEqual({
      title: "Google カレンダーの接続が切れました",
      text: "もう一度つなぐまで、予定の確認と書き込みを止めています",
      action: "もう一度つなぐ",
    });
    expect(homeCalendarPrompt(CONNECTED, true)).toBeNull();
  });

  it("is not shown in http mode, where the calendar cannot be connected yet", () => {
    expect(homeCalendarPrompt(NOT_CONNECTED, false)).toBeNull();
    expect(homeCalendarPrompt({ ...CONNECTED, google: { ...CONNECTED.google, status: "revoked" } }, false)).toBeNull();
  });
});
