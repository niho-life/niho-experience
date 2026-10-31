import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { HostCalendarLoad } from "@/host/calendar";

/** 設定 › カレンダー in http mode (#109) as first drawn, on synthetic states. */
vi.mock("@/host/calendar-actions", () => ({ issueHostCalendarFeed: vi.fn(), revokeHostCalendarFeed: vi.fn() }));
vi.mock("@/host/actions", () => ({ saveNotificationSettings: vi.fn(), saveProviderMeetingPoint: vi.fn(), saveProviderProfile: vi.fn(), submitProviderReview: vi.fn() }));

import { CALENDAR_LOAD_FAILED_TEXT, GOOGLE_NOT_CONNECTED, GOOGLE_SYNC_FAILING_TEXT } from "@/host/calendar";
import { HostLiveCalendarPanel } from "./HostCalendarPanel";
import { HostSettingsForm } from "./HostSettingsForm";

type Live = Extract<HostCalendarLoad, { status: "live" }>;
const FEED_URL = "https://experience.example/host/calendar/feed/Abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE/bookings.ics";
const live = (overrides: Partial<Live> = {}): Live => ({ status: "live", google: GOOGLE_NOT_CONNECTED, googleSync: null, feed: { url: null }, ...overrides });
const panel = (load: Live) => renderToStaticMarkup(createElement(HostLiveCalendarPanel, { providerId: "sample-provider", load }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("HostLiveCalendarPanel", () => {
  it("leads to Google's consent page while not connected, and says what connecting does", () => {
    const html = panel(live());
    expect(html).toContain('id="settings-calendar"');
    expect(html).toMatch(/<a id="settings-calendar-connect" href="\/host\/calendar\/google\/connect\?providerId=sample-provider"[^>]*>Google カレンダーをつなぐ<\/a>/);
    expect(text(html)).toContain("未接続 つなぐと、予定がある時間は予約を受け付けません");
    expect(html).not.toContain("空きの確認");
    expect(html).not.toContain("接続を切る");
  });

  it("asks to connect again once Google refused it", () => {
    const html = panel(live({ google: { ...GOOGLE_NOT_CONNECTED, status: "revoked" } }));
    expect(html).toMatch(/href="\/host\/calendar\/google\/connect\?providerId=sample-provider"[^>]*>もう一度つなぐ<\/a>/);
    expect(text(html)).toContain("接続が切れました Google カレンダーの権限が取り消されたため、予定の確認と書き込みを止めています");
  });

  it("shows a connection's state, when busy times were last read or that they cannot be, and 接続を切る", () => {
    const connected = { ...GOOGLE_NOT_CONNECTED, status: "connected" as const };
    const fresh = text(panel(live({ google: connected, googleSync: { lastCheckedAt: "2026-11-01T10:05", failing: false } })));
    expect(fresh).toContain("接続中 予定がある時間は予約を受け付けません");
    expect(fresh).toContain("接続を切る");
    expect(fresh).toContain("空きの確認");
    expect(fresh).toContain("最後に確かめた時刻 11月1日 10:05");
    const failing = panel(live({ google: connected, googleSync: { lastCheckedAt: "2026-11-01T10:05", failing: true } }));
    expect(failing).toContain(`text-warn">${GOOGLE_SYNC_FAILING_TEXT}`);
    expect(failing).not.toContain("最後に確かめた時刻");
    expect(panel(live({ google: connected }))).not.toContain("settings-calendar-connect");
  });

  it("has no Google row without Google's sign-in, and keeps the link to the sessions", () => {
    const html = panel(live({ google: null, feed: null }));
    expect(html).not.toContain("Google カレンダー<");
    expect(html).toContain('href="/host/calendar?providerId=sample-provider"');
    expect(html).not.toContain("ほかのカレンダーで見る");
  });

  it("offers to make the feed's address, then shows it to copy, make again or stop", () => {
    const none = panel(live());
    expect(text(none)).toContain("URL はまだありません。");
    expect(none).toMatch(/id="settings-calendar-ics-create"[^>]*>URL を作る<\/button>/);
    const made = panel(live({ feed: { url: FEED_URL } }));
    expect(made).toMatch(new RegExp(`<input[^>]*id="settings-calendar-ics"[^>]*readOnly=""[^>]*value="${FEED_URL.replace(/[.?]/g, "\\$&")}"`));
    for (const label of ["URL をコピー", "URL を作り直す", "URL を止める"]) expect(made).toContain(label);
    expect(made).not.toContain("URL を作る<");
    expect(made).toContain('role="status"');
  });
});

describe("HostSettingsForm's カレンダー", () => {
  const settings = {
    displayName: "Synthetic provider", kind: null, bio: "", sellerDisclosureUrl: "", reviewStatus: null, consentCurrent: true, meetingPoint: null,
    calendar: { google: GOOGLE_NOT_CONNECTED, icsUrl: null }, notifications: null, notificationSource: "preparing",
  } as const;
  const form = (liveCalendar: HostCalendarLoad | null) => renderToStaticMarkup(createElement(HostSettingsForm, {
    providerId: "sample-provider", role: "OWNER", settings, payout: { status: "error" } as never, connectNotice: null, googleConnection: null, liveCalendar, preview: false, account: null,
  }));

  it("is the live panel for the OWNER, and today's link otherwise, saying when it could not be read", () => {
    expect(form(live())).toContain("settings-calendar-connect");
    const closed = form({ status: "closed" });
    expect(closed).toContain("開催枠と Google の予定");
    expect(closed).not.toContain(CALENDAR_LOAD_FAILED_TEXT);
    const failed = form({ status: "error" });
    expect(failed).toContain(`role="alert"`);
    expect(failed).toContain(CALENDAR_LOAD_FAILED_TEXT);
    expect(failed).toContain('href="/host/calendar?providerId=sample-provider"');
  });
});
