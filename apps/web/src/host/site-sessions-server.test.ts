import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreAccessDeniedError, StoreNotFoundError, StoreValidationError, type HostActor, type HostGuestBooking, type HostGuestSession } from "@niho-experience/experience-store";
import type { HostProvider } from "@/lib/host/providers";

/** ホーム and この回 for the bookings made on this site against a stubbed experience store (#285 slice 8b, #107). */
const state = vi.hoisted(() => ({
  store: null as null | Record<string, ReturnType<typeof vi.fn>>,
  attendance: null as null | Record<string, ReturnType<typeof vi.fn>>,
  session: null as null | { nihoUserId: string; idTokenExpiresAt: number },
  providers: { status: "ok", providers: [] } as { status: string; providers?: { id: string; memberRole: string }[] },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/experience/store-server", () => ({ guestBookingRepository: () => state.store, bookingAttendance: () => state.attendance }));
vi.mock("@/lib/host/server", () => ({ readHostSession: async () => state.session, loadHostProviders: async () => state.providers }));
vi.mock("@/lib/host/session", () => ({ idTokenUsable: (session: { idTokenExpiresAt: number }, now: number) => session.idTokenExpiresAt > now }));

import { HOST_INVALID_INPUT_TEXT, HOST_SESSION_ENDED_TEXT } from "./errors";
import { SITE_BOOKING_LOAD_FAILED_TEXT } from "./site-bookings";
import { SITE_BOOKING_OWNER_ONLY_TEXT } from "./site-bookings-server";
import { SITE_ATTENDANCE_FAILED_TEXT, SITE_ATTENDANCE_NOT_CONFIRMED_TEXT, SITE_ATTENDANCE_NOT_STARTED_TEXT } from "./site-sessions";
import { loadSiteHome, loadSiteSession, recordSiteAttendanceAsOwner } from "./site-sessions-server";

const OWNER = { id: "sample-provider", memberRole: "OWNER" } as HostProvider;
const ACTOR: HostActor = { providerId: "sample-provider", nihoUserId: "sample-niho-user", calendarRoleCeiling: "OWNER" };
const QUERY = { date: "2026-11-01", start: "10:00", experience: "tea", offer: "sample-am" };

const SESSION: HostGuestSession = {
  productId: "tea", productTitle: "Synthetic tea ceremony", offerId: "sample-am", localDate: "2026-11-01", localStartTime: "10:00", timeZone: "Asia/Tokyo",
  startUtc: "2026-11-01T01:00:00.000Z", endUtc: "2026-11-01T02:30:00.000Z", participants: 3, bookings: 2, paymentReviews: 1,
};
const STORED: HostGuestBooking = {
  publicBookingId: "00000000-0000-4000-8000-000000000285", productId: "tea", productTitle: "Synthetic tea ceremony", offerId: "sample-am", status: "CONFIRMED",
  localDate: "2026-11-01", localStartTime: "10:00", timeZone: "Asia/Tokyo", startUtc: "2026-11-01T01:00:00.000Z", endUtc: "2026-11-01T02:30:00.000Z",
  adultCount: 2, childCount: 0, language: "JA", guest: { name: "Sample Guest", phone: "+81 90 0000 0000", note: null, answers: [] },
  currency: "JPY", adultUnitAmount: 4000, childUnitAmount: null, totalAmount: 8000, platformFee: { supportEnabled: false, basisPoints: 1000, amount: 800 },
  providerAmount: 7200, cancellationPolicy: "NONE", bookedAtUtc: "2026-10-31T03:04:00.000Z", paidAtUtc: "2026-10-31T03:06:00.000Z", cancelledAtUtc: null, cancelledBy: null, cancellationReason: null, cancellationNote: null, refundedAmount: 0, refundPendingAmount: 0, refundFailed: false, cancellationRequested: false,
};

const KEY = { productId: "tea", offerId: "sample-am", localDate: "2026-11-01", localStartTime: "10:00" };
const MARK = { publicBookingId: STORED.publicBookingId, status: "ATTENDED", recordedAtUtc: "2026-11-01T01:20:00.000Z" };

beforeEach(() => {
  vi.useRealTimers();
  state.store = {
    listGuestSessionsForHost: vi.fn(async () => [SESSION]),
    listGuestBookingsForSession: vi.fn(async () => [STORED]),
  };
  state.attendance = null;
  state.session = { nihoUserId: "sample-niho-user", idTokenExpiresAt: Date.now() + 3_600_000 };
  state.providers = { status: "ok", providers: [{ id: "sample-provider", memberRole: "OWNER" }] };
});

describe("loadSiteHome", () => {
  it("reads the OWNER's sessions from the start of today in Japan into today's rows and 次にすること", async () => {
    // 01:30 on 1 November in Japan.
    vi.useFakeTimers({ now: Date.parse("2026-10-31T16:30:00.000Z"), toFake: ["Date"] });
    const load = await loadSiteHome(OWNER, "sample-niho-user", false);
    expect(state.store?.listGuestSessionsForHost).toHaveBeenCalledWith(ACTOR, { from: "2026-10-31T15:00:00.000Z", limit: 100 });
    expect(load.status).toBe("live");
    if (load.status !== "live") return;
    expect(load.sessions.today.map((row) => [row.title, row.seats, row.bookings, row.phase?.text, row.source])).toEqual([["Synthetic tea ceremony", "3名", "2件", "開始前", undefined]]);
    expect(load.sessions.tomorrow).toEqual([]);
    expect(load.todos.map((todo) => [todo.title, todo.action?.href])).toEqual([["確認待ちの支払いがあります", "/host/bookings/session?date=2026-11-01&start=10%3A00&experience=tea&offer=sample-am"]]);
    expect(JSON.stringify(load)).not.toMatch(/@|\+81|Sample Guest/);
  });

  it("labels the rows and keeps ?source=site beside NIHO's bookings", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-31T16:30:00.000Z"), toFake: ["Date"] });
    const load = await loadSiteHome(OWNER, "sample-niho-user", true);
    expect(load.status === "live" && load.sessions.today[0]).toMatchObject({ source: "このサイトの予約", href: expect.stringContaining("source=site") });
  });

  it("keeps today's screen while closed, for anyone but the owner, and says when the DB fails", async () => {
    for (const memberRole of ["EDITOR", "COHOST"] as const) {
      expect(await loadSiteHome({ ...OWNER, memberRole }, "sample-niho-user", false)).toEqual({ status: "closed" });
    }
    state.store!.listGuestSessionsForHost!.mockRejectedValueOnce(new StoreAccessDeniedError());
    expect(await loadSiteHome(OWNER, "sample-niho-user", false)).toEqual({ status: "closed" });
    state.store!.listGuestSessionsForHost!.mockRejectedValueOnce(new Error("synthetic outage"));
    expect(await loadSiteHome(OWNER, "sample-niho-user", false)).toEqual({ status: "error" });
    state.store = null;
    expect(await loadSiteHome(OWNER, "sample-niho-user", false)).toEqual({ status: "closed" });
  });
});

describe("loadSiteSession", () => {
  it("reads the session the address names by its snapshot's day and start, with the guests' phones", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-01T01:30:00.000Z"), toFake: ["Date"] });
    const load = await loadSiteSession(OWNER, "sample-niho-user", QUERY);
    expect(state.store?.listGuestBookingsForSession).toHaveBeenCalledWith(ACTOR, { productId: "tea", offerId: "sample-am", localDate: "2026-11-01", localStartTime: "10:00" });
    expect(load).toMatchObject({ status: "live", now: "2026-11-01T10:30", attendance: false, session: { date: "2026-11-01", start: "10:00", end: "11:30", title: "Synthetic tea ceremony", capacity: null } });
    expect(load.status === "live" && load.session?.bookings.map((booking) => [booking.guest, booking.phone, booking.language])).toEqual([["Sample Guest", "+81 90 0000 0000", "ja"]]);
    expect(JSON.stringify(load)).not.toMatch(/@/);
  });

  it("finds no session without bookings here or for an address the store cannot read", async () => {
    state.store!.listGuestBookingsForSession!.mockResolvedValueOnce([]);
    expect(await loadSiteSession(OWNER, "sample-niho-user", QUERY)).toMatchObject({ status: "live", session: null });
    state.store!.listGuestBookingsForSession!.mockRejectedValueOnce(new StoreValidationError("offerId must be a stable 1-256 character identifier."));
    expect(await loadSiteSession(OWNER, "sample-niho-user", { ...QUERY, offer: "not an id" })).toMatchObject({ status: "live", session: null });
  });

  it("keeps today's screen while closed, for anyone but the owner, and says when the DB fails", async () => {
    expect(await loadSiteSession({ ...OWNER, memberRole: "COHOST" }, "sample-niho-user", QUERY)).toEqual({ status: "closed" });
    state.store!.listGuestBookingsForSession!.mockRejectedValueOnce(new StoreAccessDeniedError());
    expect(await loadSiteSession(OWNER, "sample-niho-user", QUERY)).toEqual({ status: "closed" });
    state.store!.listGuestBookingsForSession!.mockRejectedValueOnce(new Error("synthetic outage"));
    expect(await loadSiteSession(OWNER, "sample-niho-user", QUERY)).toEqual({ status: "error" });
    state.store = null;
    expect(await loadSiteSession(OWNER, "sample-niho-user", QUERY)).toEqual({ status: "closed" });
  });
});

describe("出欠 of this site's bookings (#107)", () => {
  it("reads the session's marks and capacity with its bookings where attendance is kept", async () => {
    state.attendance = { readSessionForHost: vi.fn(async () => ({ capacity: 8, marks: [MARK] })) };
    const load = await loadSiteSession(OWNER, "sample-niho-user", QUERY);
    expect(state.attendance.readSessionForHost).toHaveBeenCalledWith(ACTOR, KEY);
    expect(load).toMatchObject({ status: "live", attendance: true, session: { capacity: 8 } });
    expect(load.status === "live" && load.session?.bookings.map((booking) => booking.attendance)).toEqual(["attended"]);
    // No bookings here: nothing more to read.
    state.store!.listGuestBookingsForSession!.mockResolvedValueOnce([]);
    expect(await loadSiteSession(OWNER, "sample-niho-user", QUERY)).toMatchObject({ status: "live", session: null, attendance: true });
    expect(state.attendance.readSessionForHost).toHaveBeenCalledTimes(1);
  });

  it("says the guests could not be read when the marks could not be: none is shown as 未記録 by mistake", async () => {
    state.attendance = { readSessionForHost: vi.fn(async () => { throw new Error("synthetic outage"); }) };
    expect(await loadSiteSession(OWNER, "sample-niho-user", QUERY)).toEqual({ status: "error" });
  });

  it("keeps the OWNER's mark and answers what the store kept", async () => {
    state.attendance = { recordAsHost: vi.fn(async () => ({ outcome: "RECORDED", mark: { ...MARK, status: "NO_SHOW" } })) };
    expect(await recordSiteAttendanceAsOwner("sample-provider", STORED.publicBookingId, "no_show")).toEqual({ ok: true, message: "", attendance: "no_show" });
    expect(state.attendance.recordAsHost).toHaveBeenCalledWith(ACTOR, STORED.publicBookingId, "NO_SHOW");
  });

  it("changes nothing before the start by the store's clock, or for a booking no longer confirmed", async () => {
    state.attendance = { recordAsHost: vi.fn(async () => ({ outcome: "NOT_STARTED", mark: null })) };
    expect(await recordSiteAttendanceAsOwner("sample-provider", STORED.publicBookingId, "attended")).toEqual({ ok: false, message: SITE_ATTENDANCE_NOT_STARTED_TEXT });
    state.attendance.recordAsHost!.mockResolvedValueOnce({ outcome: "NOT_CONFIRMED", mark: null });
    expect(await recordSiteAttendanceAsOwner("sample-provider", STORED.publicBookingId, "attended")).toEqual({ ok: false, message: SITE_ATTENDANCE_NOT_CONFIRMED_TEXT });
  });

  it("is the OWNER's with a live sign-in, and says why it failed", async () => {
    state.attendance = { recordAsHost: vi.fn(async () => ({ outcome: "RECORDED", mark: MARK })) };
    state.session = null;
    expect(await recordSiteAttendanceAsOwner("sample-provider", STORED.publicBookingId, "attended")).toEqual({ ok: false, message: HOST_SESSION_ENDED_TEXT });
    state.session = { nihoUserId: "sample-niho-user", idTokenExpiresAt: Date.now() + 3_600_000 };
    state.providers = { status: "ok", providers: [{ id: "sample-provider", memberRole: "COHOST" }] };
    expect(await recordSiteAttendanceAsOwner("sample-provider", STORED.publicBookingId, "attended")).toEqual({ ok: false, message: SITE_BOOKING_OWNER_ONLY_TEXT });
    state.providers = { status: "ok", providers: [{ id: "sample-provider", memberRole: "OWNER" }] };
    expect(state.attendance.recordAsHost).not.toHaveBeenCalled();

    for (const [error, message] of [
      [new StoreAccessDeniedError(), SITE_BOOKING_OWNER_ONLY_TEXT],
      [new StoreValidationError("attendance must be ATTENDED or NO_SHOW."), HOST_INVALID_INPUT_TEXT],
      [new StoreNotFoundError("guest booking"), SITE_BOOKING_LOAD_FAILED_TEXT],
      [new Error("synthetic outage"), SITE_ATTENDANCE_FAILED_TEXT],
    ] as const) {
      state.attendance.recordAsHost!.mockRejectedValueOnce(error);
      expect(await recordSiteAttendanceAsOwner("sample-provider", STORED.publicBookingId, "attended")).toEqual({ ok: false, message });
    }
    // The flag is off (or no DB): nothing to keep it in.
    state.attendance = null;
    expect(await recordSiteAttendanceAsOwner("sample-provider", STORED.publicBookingId, "attended")).toEqual({ ok: false, message: SITE_ATTENDANCE_FAILED_TEXT });
  });
});
