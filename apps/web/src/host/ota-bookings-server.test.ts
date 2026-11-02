import { StoreAccessDeniedError, StoreNotFoundError, type HostOtaBooking } from "@niho-experience/experience-store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostProvider } from "@/lib/host/providers";

/** OTA の予約の画面's reads (#194 PR B): who reads which, against a stubbed store. Synthetic data only. */
const state = vi.hoisted(() => ({
  mock: false,
  config: { otaGuestDetailsEnabled: true, hostAttendanceEnabled: false },
  assignments: [] as { providerId: string }[],
  session: { nihoUserId: "owner-a", accessTokenExpiresAt: Date.now() + 3_600_000 } as null | { nihoUserId: string; accessTokenExpiresAt: number },
  providers: { status: "ok", providers: [{ id: "provider-a", ownerUserId: "owner-a", memberRole: "OWNER" }] } as Record<string, unknown>,
  store: null as null | Record<string, ReturnType<typeof vi.fn>>,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));
vi.mock("@/lib/experience/store-server", () => ({
  hostOtaBookings: () => state.store,
  productOperatorRepository: () => ({ listAssignments: async () => state.assignments }),
}));
vi.mock("@/lib/host/server", () => ({ isHostMock: () => state.mock, readHostSession: async () => state.session, loadHostProviders: async () => state.providers }));

import { MOCK_OTA_BOOKINGS } from "./mock/ota-bookings";
import { loadOtaBookings, loadOtaHomeTodos, loadOtaSession, otaReaderFor, recordOtaAttendanceAsHost } from "./ota-bookings-server";

const [gyg] = MOCK_OTA_BOOKINGS as [HostOtaBooking];
const OWNER = { id: "provider-a", ownerUserId: "owner-a", memberRole: "OWNER" } as HostProvider;
const EDITOR = { ...OWNER, memberRole: "EDITOR" } as HostProvider;
const store = () => ({
  listForHost: vi.fn(async (): Promise<HostOtaBooking[]> => [gyg]),
  getForHost: vi.fn(async (): Promise<HostOtaBooking> => { throw new StoreNotFoundError("OTA booking"); }),
  attendanceForHost: vi.fn(async () => new Map([[gyg.ref, "NO_SHOW" as const]])),
  recordAttendanceAsHost: vi.fn(async () => ({ outcome: "RECORDED" as const, status: "ATTENDED" as const })),
});

beforeEach(() => {
  state.mock = false;
  state.config = { otaGuestDetailsEnabled: true, hostAttendanceEnabled: false };
  state.assignments = [];
  state.session = { nihoUserId: "owner-a", accessTokenExpiresAt: Date.now() + 3_600_000 };
  state.providers = { status: "ok", providers: [OWNER] };
  state.store = store();
});

describe("OTA bookings on the server", () => {
  it("reads as NIHO's OWNER, or as a product operator with a grant there, and nobody else", async () => {
    expect(await otaReaderFor("provider-a", OWNER)).toEqual({ kind: "OWNER", actor: { providerId: "provider-a", nihoUserId: "owner-a", calendarRoleCeiling: "OWNER" } });
    expect(await otaReaderFor("provider-a", EDITOR)).toBeNull();
    state.assignments = [{ providerId: "provider-a" }];
    expect(await otaReaderFor("provider-a", null)).toEqual({ kind: "OPERATOR", actor: { providerId: "provider-a", nihoUserId: "owner-a", calendarScope: "OPERATOR" } });
    expect(await otaReaderFor("provider-b", null)).toBeNull();
  });

  it("lists a window around today with the push's booking, and closes while off, denied, or unreadable", async () => {
    const live = await loadOtaBookings("provider-a", OWNER, "0b7f3c1e-5a2d-4e8f-9c61-2d4b8a7e1f99", undefined, () => state.store as never);
    expect(live).toMatchObject({ status: "live", reader: "OWNER", requestedMissing: true, bookings: [{ id: gyg.ref, ota: { siteLabel: "GetYourGuide" } }] });
    const [, options] = state.store!.listForHost!.mock.calls[0] as [unknown, { fromUtc: string; toUtc: string; limit: number }];
    expect((Date.parse(options.toUtc) - Date.parse(options.fromUtc)) / 86_400_000).toBe(120);
    expect(options.limit).toBe(200);
    expect(state.store!.getForHost).toHaveBeenCalledWith(expect.anything(), "0b7f3c1e-5a2d-4e8f-9c61-2d4b8a7e1f99");
    expect(await loadOtaBookings("provider-a", OWNER, gyg.ref, undefined, () => state.store as never)).toMatchObject({ requestedMissing: false });
    expect(await loadOtaBookings("provider-a", OWNER, null, undefined, () => null)).toEqual({ status: "closed" });
    expect(await loadOtaBookings("provider-a", EDITOR, null, undefined, () => state.store as never)).toEqual({ status: "closed" });
    state.store!.listForHost!.mockRejectedValueOnce(new StoreAccessDeniedError());
    expect(await loadOtaBookings("provider-a", OWNER, null, undefined, () => state.store as never)).toEqual({ status: "closed" });
    state.store!.listForHost!.mockRejectedValueOnce(new Error("synthetic outage"));
    expect(await loadOtaBookings("provider-a", OWNER, null, undefined, () => state.store as never)).toEqual({ status: "error" });
  });

  it("shows the preview's synthetic bookings only with ?mock=ota-bookings", async () => {
    state.mock = true;
    expect(await loadOtaBookings("provider-a", OWNER, null, "default")).toEqual({ status: "closed" });
    const preview = await loadOtaBookings("provider-a", OWNER, null, "ota-bookings");
    expect(preview).toMatchObject({ status: "live", preview: true });
    expect(preview.status === "live" ? preview.bookings.length : 0).toBe(MOCK_OTA_BOOKINGS.length);
    expect((await loadOtaHomeTodos("provider-a", OWNER, "ota-bookings")).todos.length).toBe(3);
    const session = await loadOtaSession("provider-a", OWNER, { date: "2026-10-22", start: "18:00", experience: "community-dinner", offer: "offer-dinner" }, "ota-bookings");
    expect(session).toMatchObject({ status: "live", bookings: [{ id: gyg.ref, phone: "+44 20 0000 0000" }] });
  });

  it("gives この回 the session's OTA guests with their phone, and their 出欠 where it is kept", async () => {
    const query = { date: "2026-10-22", start: "18:00", experience: "community-dinner", offer: "offer-dinner" };
    expect(await loadOtaSession("provider-a", OWNER, query, undefined, () => state.store as never)).toMatchObject({ status: "live", attendance: false, bookings: [{ phone: "+44 20 0000 0000", attendance: null }] });
    expect(state.store!.attendanceForHost).not.toHaveBeenCalled();
    state.config = { otaGuestDetailsEnabled: true, hostAttendanceEnabled: true };
    expect(await loadOtaSession("provider-a", OWNER, query, undefined, () => state.store as never)).toMatchObject({ attendance: true, bookings: [{ attendance: "no_show" }] });
    expect(await loadOtaSession("provider-a", OWNER, { ...query, start: "13:00" }, undefined, () => state.store as never)).toMatchObject({ bookings: [] });
    const [, options] = state.store!.listForHost!.mock.calls[0] as [unknown, { productId: string; offerId: string }];
    // Narrowed to the session's offer in the store, before its limit.
    expect([options.productId, options.offerId]).toEqual(["community-dinner", "offer-dinner"]);
    // A session that fills the limit is not shown in part.
    state.store!.listForHost!.mockResolvedValueOnce(Array.from({ length: 200 }, () => gyg));
    expect(await loadOtaSession("provider-a", OWNER, query, undefined, () => state.store as never)).toEqual({ status: "error" });
  });

  it("records 出欠 for the session's reader, with a live sign-in, and says why it did not", async () => {
    const s = store();
    state.store = s;
    state.config = { otaGuestDetailsEnabled: true, hostAttendanceEnabled: true };
    expect(await recordOtaAttendanceAsHost("provider-a", gyg.ref, "attended")).toEqual({ ok: true, message: "", attendance: "attended" });
    expect(s.recordAttendanceAsHost).toHaveBeenCalledWith({ providerId: "provider-a", nihoUserId: "owner-a", calendarRoleCeiling: "OWNER" }, gyg.ref, "ATTENDED");
    s.recordAttendanceAsHost.mockResolvedValueOnce({ outcome: "NOT_STARTED", status: null } as never);
    expect((await recordOtaAttendanceAsHost("provider-a", gyg.ref, "attended")).ok).toBe(false);
    state.session = null;
    expect((await recordOtaAttendanceAsHost("provider-a", gyg.ref, "attended")).ok).toBe(false);
    state.session = { nihoUserId: "owner-a", accessTokenExpiresAt: Date.now() + 3_600_000 };
    state.config = { otaGuestDetailsEnabled: true, hostAttendanceEnabled: false };
    expect((await recordOtaAttendanceAsHost("provider-a", gyg.ref, "attended")).ok).toBe(false);
    expect(s.recordAttendanceAsHost).toHaveBeenCalledTimes(2);
  });
});
