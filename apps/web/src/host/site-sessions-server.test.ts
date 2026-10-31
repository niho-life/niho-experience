import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreAccessDeniedError, StoreValidationError, type HostActor, type HostGuestBooking, type HostGuestSession } from "@niho-experience/experience-store";
import type { HostProvider } from "@/lib/host/providers";

/** ホーム and この回 for the bookings made on this site against a stubbed experience store (#285 slice 8b). */
const state = vi.hoisted(() => ({ store: null as null | Record<string, ReturnType<typeof vi.fn>> }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/experience/store-server", () => ({ guestBookingRepository: () => state.store }));
vi.mock("@/lib/host/server", () => ({ readHostSession: async () => null, loadHostProviders: async () => ({ status: "ok", providers: [] }) }));

import { loadSiteHome, loadSiteSession } from "./site-sessions-server";

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
  providerAmount: 7200, cancellationPolicy: "NONE", bookedAtUtc: "2026-10-31T03:04:00.000Z", paidAtUtc: "2026-10-31T03:06:00.000Z", cancelledAtUtc: null,
};

beforeEach(() => {
  vi.useRealTimers();
  state.store = {
    listGuestSessionsForHost: vi.fn(async () => [SESSION]),
    listGuestBookingsForSession: vi.fn(async () => [STORED]),
  };
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
    expect(load).toMatchObject({ status: "live", now: "2026-11-01T10:30", session: { date: "2026-11-01", start: "10:00", end: "11:30", title: "Synthetic tea ceremony", capacity: null } });
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
