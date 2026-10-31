import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreAccessDeniedError, StoreNotFoundError, StoreValidationError, type HostActor, type HostGuestBooking } from "@niho-experience/experience-store";
import type { HostProvider } from "@/lib/host/providers";

/** 予約's bookings made on this site against a stubbed experience store and NIHO provider list (#285 slice 8). */
const state = vi.hoisted(() => ({
  store: null as null | Record<string, ReturnType<typeof vi.fn>>,
  session: null as null | { nihoUserId: string; idTokenExpiresAt: number },
  providers: { status: "ok", providers: [] } as { status: string; providers?: Pick<HostProvider, "id" | "memberRole">[] },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/experience/store-server", () => ({ guestBookingRepository: () => state.store }));
vi.mock("@/lib/host/server", () => ({ readHostSession: async () => state.session, loadHostProviders: async () => state.providers }));
vi.mock("@/lib/host/session", () => ({ idTokenUsable: (session: { idTokenExpiresAt: number }, now: number) => session.idTokenExpiresAt > now }));

import { HOST_INVALID_INPUT_TEXT, HOST_SESSION_ENDED_TEXT } from "./errors";
import { SITE_BOOKING_LOAD_FAILED_TEXT } from "./site-bookings";
import { countSiteBookings, loadMoreSiteBookings, loadSiteBookings, SITE_BOOKING_OWNER_ONLY_TEXT } from "./site-bookings-server";

const OWNER = { id: "sample-provider", memberRole: "OWNER" } as HostProvider;
const ACTOR: HostActor = { providerId: "sample-provider", nihoUserId: "sample-niho-user", calendarRoleCeiling: "OWNER" };
const BOOKING_ID = "00000000-0000-4000-8000-000000000285";
const OTHER_ID = "00000000-0000-4000-8000-000000000286";

const STORED: HostGuestBooking = {
  publicBookingId: BOOKING_ID, productId: "tea", productTitle: "Synthetic tea ceremony", offerId: "sample-am", status: "CONFIRMED",
  localDate: "2026-11-05", localStartTime: "10:00", timeZone: "Asia/Tokyo", startUtc: "2026-11-05T01:00:00.000Z", endUtc: "2026-11-05T02:30:00.000Z",
  adultCount: 1, childCount: 0, language: "EN", guest: { name: "Sample Guest", phone: "+81 90 0000 0000", note: null, answers: [] },
  currency: "JPY", adultUnitAmount: 4000, childUnitAmount: null, totalAmount: 4000, platformFee: { supportEnabled: false, basisPoints: 1000, amount: 400 },
  providerAmount: 3600, cancellationPolicy: "NONE", bookedAtUtc: "2026-10-31T03:04:00.000Z", paidAtUtc: "2026-10-31T03:06:00.000Z", cancelledAtUtc: null,
};
const OTHER: HostGuestBooking = { ...STORED, publicBookingId: OTHER_ID, localDate: "2026-12-05", startUtc: "2026-12-05T01:00:00.000Z", endUtc: "2026-12-05T02:30:00.000Z" };

beforeEach(() => {
  vi.useRealTimers();
  state.store = {
    listGuestBookingsForHost: vi.fn(async () => ({ bookings: [STORED], nextCursor: null })),
    getGuestBookingForHost: vi.fn(async () => OTHER),
    countGuestBookingsForHost: vi.fn(async () => 3),
  };
  state.session = { nihoUserId: "sample-niho-user", idTokenExpiresAt: Date.now() + 60_000 };
  state.providers = { status: "ok", providers: [OWNER, { id: "sample-other", memberRole: "EDITOR" }] };
});

describe("loadSiteBookings", () => {
  it("lists the OWNER's bookings from the start of today in Japan, with the experiences they name and no address or phone", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-31T16:00:00.000Z"), toFake: ["Date"] });
    const load = await loadSiteBookings(OWNER, "sample-niho-user", null);
    expect(load).toMatchObject({ status: "live", requestedMissing: false, nextCursor: null, today: "2026-11-01", experiences: [{ id: "tea", title: "Synthetic tea ceremony" }] });
    expect(load.status === "live" && load.bookings.map((booking) => [booking.id, booking.guest, booking.phone, booking.site?.payoutYen])).toEqual([[BOOKING_ID, "Sample Guest", null, 3600]]);
    expect(state.store?.listGuestBookingsForHost).toHaveBeenCalledWith(ACTOR, { from: "2026-10-31T15:00:00.000Z", limit: 100 });
    expect(state.store?.getGuestBookingForHost).not.toHaveBeenCalled();
    expect(JSON.stringify(load)).not.toMatch(/@|\+81/);
  });

  it("adds the booking `?booking=` names when the first page does not hold it, and marks one that is not the provider's", async () => {
    const opened = await loadSiteBookings(OWNER, "sample-niho-user", OTHER_ID);
    expect(opened.status === "live" && opened.bookings.map((booking) => booking.id)).toEqual([BOOKING_ID, OTHER_ID]);
    expect(state.store?.getGuestBookingForHost).toHaveBeenCalledWith(ACTOR, OTHER_ID);
    // Already on the list: not read again.
    await loadSiteBookings(OWNER, "sample-niho-user", BOOKING_ID);
    expect(state.store?.getGuestBookingForHost).toHaveBeenCalledTimes(1);
    for (const error of [new StoreNotFoundError("guest booking"), new StoreValidationError("publicBookingId must be a UUID.")]) {
      state.store!.getGuestBookingForHost!.mockRejectedValueOnce(error);
      expect(await loadSiteBookings(OWNER, "sample-niho-user", "not-a-booking")).toMatchObject({ status: "live", requestedMissing: true, bookings: [expect.objectContaining({ id: BOOKING_ID })] });
    }
  });

  it("keeps today's screen while closed, for anyone but the owner, and while the experience DB has no OWNER for them", async () => {
    for (const memberRole of ["EDITOR", "COHOST"] as const) {
      expect(await loadSiteBookings({ ...OWNER, memberRole }, "sample-niho-user", null)).toEqual({ status: "closed" });
    }
    state.store!.listGuestBookingsForHost!.mockRejectedValueOnce(new StoreAccessDeniedError());
    expect(await loadSiteBookings(OWNER, "sample-niho-user", null)).toEqual({ status: "closed" });
    state.store = null;
    expect(await loadSiteBookings(OWNER, "sample-niho-user", null)).toEqual({ status: "closed" });
  });

  it("says the bookings could not be read when the DB fails, and hands on the cursor of the rest", async () => {
    state.store!.listGuestBookingsForHost!.mockRejectedValueOnce(new Error("synthetic outage"));
    expect(await loadSiteBookings(OWNER, "sample-niho-user", null)).toEqual({ status: "error" });
    state.store!.getGuestBookingForHost!.mockRejectedValueOnce(new Error("synthetic outage"));
    expect(await loadSiteBookings(OWNER, "sample-niho-user", OTHER_ID)).toEqual({ status: "error" });
    state.store!.listGuestBookingsForHost!.mockResolvedValueOnce({ bookings: [STORED], nextCursor: "sample-cursor" });
    expect(await loadSiteBookings(OWNER, "sample-niho-user", null)).toMatchObject({ status: "live", nextCursor: "sample-cursor" });
  });
});

describe("countSiteBookings", () => {
  it("counts the OWNER's bookings, and none for anyone else, without the store, or when counting fails", async () => {
    expect(await countSiteBookings(OWNER, "sample-niho-user")).toBe(3);
    expect(state.store?.countGuestBookingsForHost).toHaveBeenCalledWith(ACTOR);
    expect(await countSiteBookings({ ...OWNER, memberRole: "COHOST" }, "sample-niho-user")).toBe(0);
    state.store!.countGuestBookingsForHost!.mockRejectedValueOnce(new StoreAccessDeniedError());
    expect(await countSiteBookings(OWNER, "sample-niho-user")).toBe(0);
    state.store!.countGuestBookingsForHost!.mockRejectedValueOnce(new Error("synthetic outage"));
    expect(await countSiteBookings(OWNER, "sample-niho-user")).toBe(0);
    state.store = null;
    expect(await countSiteBookings(OWNER, "sample-niho-user")).toBe(0);
  });
});

describe("loadMoreSiteBookings", () => {
  it("reads the next page from the cursor as the OWNER", async () => {
    state.store!.listGuestBookingsForHost!.mockResolvedValueOnce({ bookings: [OTHER], nextCursor: null });
    const page = await loadMoreSiteBookings("sample-provider", "sample-cursor");
    expect(page).toMatchObject({ ok: true, nextCursor: null, experiences: [{ id: "tea" }] });
    expect(page.ok && page.bookings.map((booking) => booking.id)).toEqual([OTHER_ID]);
    expect(state.store?.listGuestBookingsForHost).toHaveBeenCalledWith(ACTOR, { cursor: "sample-cursor", limit: 100 });
  });

  it("refuses without a usable session, for anyone but the OWNER, and says why a read failed", async () => {
    state.session = null;
    expect(await loadMoreSiteBookings("sample-provider", "c")).toEqual({ ok: false, message: HOST_SESSION_ENDED_TEXT });
    state.session = { nihoUserId: "sample-niho-user", idTokenExpiresAt: Date.now() + 60_000 };
    expect(await loadMoreSiteBookings("sample-other", "c")).toEqual({ ok: false, message: SITE_BOOKING_OWNER_ONLY_TEXT });
    state.providers = { status: "error" };
    expect(await loadMoreSiteBookings("sample-provider", "c")).toEqual({ ok: false, message: SITE_BOOKING_LOAD_FAILED_TEXT });
    state.providers = { status: "ok", providers: [OWNER] };
    const failures: [Error, string][] = [
      [new StoreAccessDeniedError(), SITE_BOOKING_OWNER_ONLY_TEXT],
      [new StoreValidationError("cursor is invalid."), HOST_INVALID_INPUT_TEXT],
      [new Error("synthetic outage"), SITE_BOOKING_LOAD_FAILED_TEXT],
    ];
    for (const [error, message] of failures) {
      state.store!.listGuestBookingsForHost!.mockRejectedValueOnce(error);
      expect(await loadMoreSiteBookings("sample-provider", "c")).toEqual({ ok: false, message });
    }
    state.store = null;
    expect(await loadMoreSiteBookings("sample-provider", "c")).toEqual({ ok: false, message: SITE_BOOKING_LOAD_FAILED_TEXT });
  });
});
