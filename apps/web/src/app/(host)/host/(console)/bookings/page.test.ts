import { isValidElement, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

type Load = Mock<(...args: unknown[]) => Promise<unknown>>;

/** ExperienceとOTA予約だけを表示する予約ページを合成データで確認する。 */
const state = vi.hoisted(() => ({
  memberRole: "OWNER" as string,
  site: { status: "closed" } as Record<string, unknown>,
  providerNotFound: false,
  ota: { status: "closed" } as Record<string, unknown>,
  otaShown: false,
  loadSiteBookings: null as null | Load,
  loadOtaBookings: null as null | Load,
  calendarChoice: null as null | Record<string, unknown>,
  translateEnabled: false,
}));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", async (importActual) => ({
  ...(await importActual<typeof import("next/navigation")>()),
  notFound: () => { throw new Error("NOT_FOUND"); },
}));
vi.mock("@/host/actions", () => ({ loadMoreSiteBookingList: vi.fn(), cancelSiteBooking: vi.fn() }));
vi.mock("@/host/data", () => ({
  hostPageContext: async () => ({
    session: { nihoUserId: "sample-niho-user", mockScenario: undefined },
    providers: [],
    provider: { id: "sample-provider", displayName: "Synthetic provider", memberRole: state.memberRole },
    providerNotFound: state.providerNotFound,
    linkProviderId: "sample-provider",
  }),
}));
vi.mock("@/host/site-bookings-server", () => ({ loadSiteBookings: (...args: unknown[]) => state.loadSiteBookings!(...args) }));
vi.mock("@/host/ota-bookings-server", () => ({
  loadOtaBookings: (...args: unknown[]) => state.loadOtaBookings!(...args),
  otaBookingsShown: () => state.otaShown,
}));
vi.mock("@/lib/experience/calendar-actor", () => ({ resolveCalendarContext: async () => ({ choices: [], choice: state.calendarChoice, providerNotFound: false }) }));
vi.mock("@/lib/host/support-history-server", () => ({ isHostSupportHistoryEnabled: () => false }));
vi.mock("@/lib/host/fee-summary-server", () => ({ isHostFeeSummaryUiEnabled: () => false }));
vi.mock("@/lib/host/translate-rooms-server", () => ({ translateRoomsEnabled: () => state.translateEnabled, translateRoomsEntry: () => state.translateEnabled ? { today: "2026-10-31" } : null }));

import HostBookingsPage from "./page";
import { HostBookings } from "@/components/host/HostBookings";

const LIVE = { status: "live", bookings: [{ id: "b-1" }], experiences: [], requestedMissing: false, nextCursor: "sample-cursor", today: "2026-10-31", messages: true, preview: false, readOnly: false };

beforeEach(() => {
  state.memberRole = "OWNER";
  state.site = { status: "closed" };
  state.providerNotFound = false;
  state.ota = { status: "closed" };
  state.otaShown = false;
  state.calendarChoice = null;
  state.translateEnabled = false;
  state.loadSiteBookings = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => state.site);
  state.loadOtaBookings = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => state.ota);
});

/** Unwrap the page's local presentation helpers to the screen component. */
async function page(query: Record<string, string> = {}): Promise<ReactElement<Record<string, unknown>>> {
  let element: unknown = await HostBookingsPage({ searchParams: Promise.resolve(query) });
  while (isValidElement(element) && typeof element.type === "function" && (element.type.name === "SiteBookings" || element.type.name === "OtaOnlyBookings")) {
    element = (element.type as (props: unknown) => unknown)(element.props);
  }
  expect(isValidElement(element)).toBe(true);
  return element as ReactElement<Record<string, unknown>>;
}

describe("Experience bookings", () => {
  it("shows the OWNER's Experience bookings and passes only the current booking data", async () => {
    state.site = LIVE;
    state.translateEnabled = true;
    const view = await page({ booking: "b-1" });
    expect(view.type).toBe(HostBookings);
    expect(view.props).toMatchObject({ bookings: LIVE.bookings, providerId: "sample-provider", providerDataId: "sample-provider", live: { nextCursor: "sample-cursor", messages: true } });
    expect(view.props).not.toHaveProperty("niho");
    expect(state.loadSiteBookings).toHaveBeenCalledWith(expect.objectContaining({ id: "sample-provider" }), "b-1");
  });

  it("keeps the screen unavailable when Experience bookings are closed and reports read failures", async () => {
    expect((await page()).props).toEqual({});
    state.site = { status: "error" };
    expect((await page()).props).toMatchObject({ title: "予約を読み込めませんでした" });
  });

  it("does not hide an Experience booking read failure behind OTA rows", async () => {
    state.site = { status: "error" };
    state.otaShown = true;
    state.ota = { status: "live", bookings: [{ id: "ota-1" }], experiences: [], today: "2026-10-31" };
    expect((await page()).props).toMatchObject({ title: "予約を読み込めませんでした" });
  });

  it("returns not found for another provider's booking and keeps the page OWNER-only", async () => {
    state.site = { ...LIVE, requestedMissing: true };
    await expect(page({ booking: "someone-else" })).rejects.toThrow("NOT_FOUND");
    state.memberRole = "EDITOR";
    await expect(page()).rejects.toThrow("NOT_FOUND");
  });

  it("shows read-only OTA bookings beside Experience bookings", async () => {
    state.site = LIVE;
    state.otaShown = true;
    const ota = { status: "live", bookings: [{ id: "ota-1" }], experiences: [], today: "2026-10-31" };
    state.ota = ota;
    const view = await page({ ota: "ota-1" });
    expect(view.type).toBe(HostBookings);
    expect(view.props).toMatchObject({ bookings: LIVE.bookings, ota: { bookings: ota.bookings } });
  });

  it("shows a product operator only their read-only OTA bookings", async () => {
    state.providerNotFound = true;
    state.otaShown = true;
    state.calendarChoice = { kind: "OPERATOR", id: "provider-b", displayName: "Synthetic seller", memberRole: null };
    state.ota = { status: "live", bookings: [{ id: "ota-1" }], experiences: [], today: "2026-10-31" };
    const view = await page({ providerId: "provider-b" });
    expect(view.type).toBe(HostBookings);
    expect(view.props).toMatchObject({ providerDataId: "provider-b", bookings: [], ota: { bookings: [{ id: "ota-1" }] } });
    expect(state.loadSiteBookings).not.toHaveBeenCalled();
  });
});
