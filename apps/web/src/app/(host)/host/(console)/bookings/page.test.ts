import { isValidElement, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

type Load = Mock<(...args: unknown[]) => Promise<unknown>>;

/** 予約's choice between NIHO's bookings, this site's (#285 slice 8) and both on one list (#84), against stubbed data. */
const state = vi.hoisted(() => ({
  providerOperations: false,
  memberRole: "OWNER" as string,
  site: { status: "closed" } as Record<string, unknown>,
  loadSiteBookings: null as null | Load,
  loadHostBookings: null as null | Load,
}));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", async (importActual) => ({
  ...(await importActual<typeof import("next/navigation")>()),
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("@/host/actions", () => ({ loadMoreSiteBookingList: vi.fn(), cancelSiteBooking: vi.fn() }));
vi.mock("@/host/data", () => ({
  hostPageContext: async () => ({
    session: { nihoUserId: "sample-niho-user", mockScenario: undefined },
    providers: [],
    provider: { id: "sample-provider", displayName: "Synthetic provider", memberRole: state.memberRole },
    providerNotFound: false,
    linkProviderId: "sample-provider",
  }),
  loadHostBookings: (...args: unknown[]) => state.loadHostBookings!(...args),
}));
vi.mock("@/host/site-bookings-server", () => ({
  loadSiteBookings: (...args: unknown[]) => state.loadSiteBookings!(...args),
}));
vi.mock("@/lib/host/server", () => ({ isHostMock: () => false }));
vi.mock("@/lib/host/support-history-server", () => ({ isHostSupportHistoryEnabled: () => false }));
vi.mock("@/lib/host/fee-summary-server", () => ({ isHostFeeSummaryUiEnabled: () => false }));
vi.mock("@/lib/host/provider-operations-server", () => ({ providerOperationsEnabled: () => state.providerOperations }));
vi.mock("@/lib/host/translate-rooms-server", () => ({ translateRoomsEnabled: () => false, translateRoomsEntry: () => ({ today: "2026-10-31" }) }));

import HostBookingsPage from "./page";
import { HostBookings } from "@/components/host/HostBookings";
import { HostLiveBookings } from "@/components/host/HostLiveBookings";

const LIVE = { status: "live", bookings: [{ id: "b-1" }], experiences: [], requestedMissing: false, nextCursor: "sample-cursor", today: "2026-10-31" };

beforeEach(() => {
  state.providerOperations = false;
  state.memberRole = "OWNER";
  state.loadSiteBookings = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => state.site);
  state.loadHostBookings = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ list: { status: "unavailable" }, requested: null, experiences: [], today: "2026-10-31", now: null, conversations: [] }));
  state.site = { status: "closed" };
});

/** The page, with its own local views (SiteBookings) rendered down to the screen component they choose. */
async function page(query: Record<string, string> = {}): Promise<ReactElement<Record<string, unknown>>> {
  let element: unknown = await HostBookingsPage({ searchParams: Promise.resolve(query) });
  while (isValidElement(element) && typeof element.type === "function" && element.type.name === "SiteBookings") {
    element = (element.type as (props: unknown) => unknown)(element.props);
  }
  expect(isValidElement(element)).toBe(true);
  return element as ReactElement<Record<string, unknown>>;
}

describe("予約 without NIHO's bookings (provider operations off)", () => {
  it("shows the OWNER this site's bookings, read only, in place of 準備中", async () => {
    state.site = LIVE;
    const view = await page({ booking: "b-1" });
    expect(view.type).toBe(HostBookings);
    expect(view.props).toMatchObject({ bookings: LIVE.bookings, providerId: "sample-provider", providerDataId: "sample-provider", conversations: [], live: { nextCursor: "sample-cursor" }, niho: null });
    expect(view.props).toMatchObject({ supportHistoryEnabled: false, feeSummaryEnabled: false, translateEnabled: false });
    expect(state.loadSiteBookings).toHaveBeenCalledWith(expect.objectContaining({ id: "sample-provider" }), "sample-niho-user", "b-1", undefined);
    expect(state.loadHostBookings).not.toHaveBeenCalled();
  });

  it("keeps today's screen while this site's bookings are closed to the account", async () => {
    const view = await page();
    expect(view.props).toEqual({});
    expect((view.type as { name: string }).name).toBe("BookingsUnavailable");
    expect(state.loadHostBookings).toHaveBeenCalled();
  });

  it("says the bookings could not be read, and finds no booking that is not the provider's", async () => {
    state.site = { status: "error" };
    expect((await page()).props).toMatchObject({ title: "予約を読み込めませんでした" });
    state.site = { ...LIVE, requestedMissing: true };
    await expect(page({ booking: "someone-else" })).rejects.toThrow("NOT_FOUND");
  });

  it("still has no bookings screen for an EDITOR", async () => {
    state.memberRole = "EDITOR";
    await expect(page()).rejects.toThrow("NOT_FOUND");
    expect(state.loadSiteBookings).not.toHaveBeenCalled();
  });
});

describe("予約 beside NIHO's bookings (provider operations on)", () => {
  beforeEach(() => {
    state.providerOperations = true;
  });

  it("puts NIHO's bookings and this site's on one list for the OWNER, whatever ?source= says (#84)", async () => {
    state.site = LIVE;
    for (const query of [{}, { source: "site" }] as Record<string, string>[]) {
      const view = await page(query);
      expect(view.type).toBe(HostBookings);
      expect(view.props).toMatchObject({ bookings: LIVE.bookings, live: { nextCursor: "sample-cursor" }, niho: { providerId: "sample-provider", translate: { today: "2026-10-31" } } });
    }
    // A booking this site does not have may be NIHO's: the screen reads it from NIHO instead of a 404.
    state.site = { ...LIVE, requestedMissing: true };
    expect((await page({ booking: "niho-1" })).type).toBe(HostBookings);
    expect(state.loadHostBookings).not.toHaveBeenCalled();
  });

  it("keeps NIHO's bookings alone for anyone the experience DB does not show this site's bookings to", async () => {
    const view = await page({ booking: "niho-1" });
    expect(view.type).toBe(HostLiveBookings);
    expect(view.props).toMatchObject({ providerId: "sample-provider", initialBookingId: "niho-1", siteNotice: null });
  });

  it("keeps NIHO's bookings and says this site's could not be read when the DB fails", async () => {
    state.site = { status: "error" };
    const view = await page();
    expect(view.type).toBe(HostLiveBookings);
    expect(((view.props.siteNotice as ReactElement).type as { name: string }).name).toBe("SiteBookingsFailed");
  });
});
