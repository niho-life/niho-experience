import { describe, expect, it } from "vitest";
import type { HostGuestBooking, HostGuestSession } from "@niho-experience/experience-store";
import { bookingGroups, sessionHref } from "./bookings";
import type { HostHomeData } from "./console-data";
import { homeBadgeCount, type HomeUpcoming } from "./home";
import { sessionSections } from "./session";
import { SITE_BOOKING_ERASED_TEXT, siteBooking, siteBookingExperiences } from "./site-bookings";
import {
  SITE_PAYMENT_REVIEW_TODO_TITLE,
  SITE_SESSION_LABEL,
  siteHomeSessions,
  siteHomeTodos,
  siteSessionBooking,
  siteSessionCountLines,
  siteSessionHref,
  siteSessionView,
  withSiteHome,
} from "./site-sessions";

/** ホーム and この回 for this site's bookings (#285 slice 8b): the experience DB's sessions and bookings as the screens show them. Synthetic data. */
function session(overrides: Partial<HostGuestSession> = {}): HostGuestSession {
  return {
    productId: "tea",
    productTitle: "Synthetic tea ceremony",
    offerId: "sample-am",
    localDate: "2026-11-01",
    localStartTime: "10:00",
    timeZone: "Asia/Tokyo",
    startUtc: "2026-11-01T01:00:00.000Z",
    endUtc: "2026-11-01T02:30:00.000Z",
    participants: 4,
    bookings: 2,
    paymentReviews: 0,
    ...overrides,
  };
}

const at = (date: string, time: string) => new Date(`${date}T${time}:00+09:00`).toISOString();
const TODAY = session();
const TOMORROW = session({ productId: "walk", productTitle: "Synthetic walk", offerId: "sample-walk-pm", localDate: "2026-11-02", localStartTime: "14:00", startUtc: at("2026-11-02", "14:00"), endUtc: at("2026-11-02", "15:00"), participants: 1, bookings: 1 });
const LATER = [3, 4, 5, 6].map((day) => session({ localDate: `2026-11-0${day}`, startUtc: at(`2026-11-0${day}`, "10:00"), endUtc: at(`2026-11-0${day}`, "11:30"), participants: 1, bookings: 1, paymentReviews: day === 4 ? 1 : 0 }));
const NOW = "2026-11-01T10:30";

const STORED: HostGuestBooking = {
  publicBookingId: "00000000-0000-4000-8000-000000000285",
  productId: "tea",
  productTitle: "Synthetic tea ceremony",
  offerId: "sample-am",
  status: "CONFIRMED",
  localDate: "2026-11-01",
  localStartTime: "10:00",
  timeZone: "Asia/Tokyo",
  startUtc: "2026-11-01T01:00:00.000Z",
  endUtc: "2026-11-01T02:30:00.000Z",
  adultCount: 2,
  childCount: 1,
  language: "EN",
  guest: { name: "Sample Guest", phone: "+81 90 0000 0000", note: "Sample note", answers: [{ questionId: "arrival", prompt: "Arrival station", text: "Kamakura", options: [] }] },
  currency: "JPY",
  adultUnitAmount: 4000,
  childUnitAmount: 2000,
  totalAmount: 10000,
  platformFee: { supportEnabled: false, basisPoints: 1000, amount: 1000 },
  providerAmount: 9000,
  cancellationPolicy: "FREE_UNTIL_24H",
  bookedAtUtc: "2026-10-31T03:04:00.000Z",
  paidAtUtc: "2026-10-31T03:06:00.000Z",
  cancelledAtUtc: null,
  cancelledBy: null,
  cancellationReason: null,
  cancellationNote: null,
  refundedAmount: 0,
  refundPendingAmount: 0,
  refundFailed: false,
  cancellationRequested: false,
};
const REVIEW: HostGuestBooking = { ...STORED, publicBookingId: "00000000-0000-4000-8000-000000000286", status: "PAYMENT_REVIEW", adultCount: 1, childCount: 0, guest: { name: "Review Guest", phone: null, note: null, answers: [] } };
const CANCELLED: HostGuestBooking = { ...STORED, publicBookingId: "00000000-0000-4000-8000-000000000287", status: "CANCELLED", cancelledAtUtc: "2026-10-31T05:00:00.000Z" };
const ERASED: HostGuestBooking = { ...STORED, publicBookingId: "00000000-0000-4000-8000-000000000288", guest: null };
const QUERY = { date: "2026-11-01", start: "10:00", experience: "tea", offer: "sample-am" };

describe("siteHomeSessions", () => {
  it("splits the sessions into today, tomorrow and the next few, with who may come and where today's stand", () => {
    const sessions = siteHomeSessions([TODAY, TOMORROW, ...LATER], NOW, false);
    expect(sessions.today).toEqual<HomeUpcoming[]>([
      {
        key: "site/2026-11-01T10:00/tea/sample-am",
        href: "/host/bookings/session?date=2026-11-01&start=10%3A00&experience=tea&offer=sample-am",
        dateLabel: "11月1日（日）",
        weekday: "日",
        day: 1,
        title: "Synthetic tea ceremony",
        detail: "10:00 開始 · 1時間30分",
        seats: "4名",
        bookings: "2件",
        dietary: "",
        // No attendance is kept here: never "出欠が未記録".
        phase: { text: "開催中", tone: "muted" },
      },
    ]);
    expect(sessions.tomorrow.map((row) => [row.title, row.seats, row.phase])).toEqual([["Synthetic walk", "1名", null]]);
    expect(sessions.later.map((row) => row.dateLabel)).toEqual(["11月3日（火）", "11月4日（水）", "11月5日（木）"]);
    expect(siteHomeSessions([TODAY], "2026-11-01T12:00", false).today[0]?.phase).toEqual({ text: "終了", tone: "muted" });
    expect(siteHomeSessions([TODAY], "2026-11-01T09:00", false).today[0]?.phase).toEqual({ text: "開始前", tone: "muted" });
  });

  it("labels the rows beside NIHO's bookings and leads them to この回 with ?source=site", () => {
    const [row] = siteHomeSessions([TODAY], NOW, true).today;
    expect(row).toMatchObject({ source: SITE_SESSION_LABEL, href: "/host/bookings/session?source=site&date=2026-11-01&start=10%3A00&experience=tea&offer=sample-am" });
    expect(siteHomeSessions([TODAY], NOW, false).today[0]).not.toHaveProperty("source");
  });

  it("names the same session as 予約's heading for the same bookings", () => {
    const booking = siteBooking(STORED);
    const [group] = bookingGroups([booking], siteBookingExperiences([STORED]), { filter: "upcoming", experienceId: null }, "2026-11-01");
    expect(group && sessionHref(group)).toBe(siteSessionHref(TODAY, false));
  });
});

describe("siteHomeTodos", () => {
  it("asks about each session with payments under review, leading to この回, and leaves them out of the app badge", () => {
    const todos = siteHomeTodos([TODAY, ...LATER], false);
    expect(todos).toEqual([
      {
        key: "site-payment-review/2026-11-04T10:00/tea/sample-am",
        status: { label: "確認待ち", tone: "wait" },
        aside: null,
        title: SITE_PAYMENT_REVIEW_TODO_TITLE,
        detail: "11/4（水）10:00 · Synthetic tea ceremony · 1 件 · 席は確保されていません",
        approval: null,
        action: { label: "この回を見る", href: "/host/bookings/session?date=2026-11-04&start=10%3A00&experience=tea&offer=sample-am", primary: false },
      },
    ]);
    expect(homeBadgeCount(todos)).toBe(0);
    expect(siteHomeTodos(LATER, true)[0]).toMatchObject({ aside: { text: SITE_SESSION_LABEL, tone: "muted" }, action: { href: expect.stringContaining("source=site") } });
  });
});

describe("withSiteHome", () => {
  it("puts this site's todos first and its sessions after NIHO's on each day, keeping the month", () => {
    const niho = { key: "niho", title: "NIHO" } as HomeUpcoming;
    const home: HostHomeData = { todos: [{ key: "draft-1" } as HostHomeData["todos"][number]], sessions: { today: [niho], tomorrow: [], later: [niho] }, month: null };
    const site = { todos: siteHomeTodos(LATER, true), sessions: siteHomeSessions([TODAY, TOMORROW, ...LATER], NOW, true) };
    const merged = withSiteHome(home, site);
    expect(merged.todos.map((todo) => todo.key)).toEqual(["site-payment-review/2026-11-04T10:00/tea/sample-am", "draft-1"]);
    expect(merged.sessions.today.map((row) => row.key)).toEqual(["niho", "site/2026-11-01T10:00/tea/sample-am"]);
    expect(merged.sessions.tomorrow).toHaveLength(1);
    expect(merged.sessions.later.map((row) => row.key)).toEqual(["niho", ...site.sessions.later.map((row) => row.key)]);
    expect(merged.month).toBeNull();
  });
});

describe("この回 of this site's bookings", () => {
  it("shows each booking as 予約 does, with the phone the guest gave", () => {
    expect(siteSessionBooking(STORED)).toEqual({ ...siteBooking(STORED), phone: "+81 90 0000 0000" });
    expect(siteBooking(STORED).phone).toBeNull();
    expect(siteSessionBooking(ERASED)).toMatchObject({ guest: SITE_BOOKING_ERASED_TEXT, phone: null, note: "", answers: [] });
    expect(JSON.stringify(siteSessionBooking(STORED))).not.toMatch(/@/);
  });

  it("builds the session from its bookings, or none without them", () => {
    const view = siteSessionView([STORED, REVIEW, CANCELLED], QUERY);
    expect(view).toMatchObject({ date: "2026-11-01", start: "10:00", end: "11:30", experienceId: "tea", offerId: "sample-am", title: "Synthetic tea ceremony", capacity: null, meetingArea: "" });
    expect(view?.bookings.map((booking) => [booking.status, booking.phone])).toEqual([["confirmed", "+81 90 0000 0000"], ["payment_review", null], ["cancelled", "+81 90 0000 0000"]]);
    expect(siteSessionView([], QUERY)).toBeNull();
  });

  it("lists the confirmed guests and the payments under review, not the cancelled, and counts them as ホーム does", () => {
    const bookings = siteSessionView([STORED, REVIEW, CANCELLED], QUERY)!.bookings;
    expect(sessionSections(bookings, bookings)).toEqual({ participants: [bookings[0], bookings[1]], requests: [] });
    expect(siteSessionCountLines(bookings)).toEqual({ main: "参加 4 名", pending: "うち確認待ち 1 名（席は確保されていません）" });
    expect(siteSessionCountLines(bookings.slice(0, 1))).toEqual({ main: "参加 3 名", pending: null });
  });
});
