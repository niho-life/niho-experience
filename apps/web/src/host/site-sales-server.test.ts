import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreAccessDeniedError, StoreError, type HostSaleEntry } from "@niho-experience/experience-store";

/** 売上 and ホーム's month of bookings made on this site, against a stubbed experience store (#91). */
const state = vi.hoisted(() => ({
  mock: false,
  store: null as null | { listGuestSalesForHost: ReturnType<typeof vi.fn> },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/experience/store-server", () => ({ hostSalesRepository: () => state.store }));
vi.mock("@/lib/host/server", () => ({ isHostMock: () => state.mock }));
vi.mock("./site-bookings-server", () => ({ ownerActor: (providerId: string, nihoUserId: string) => ({ providerId, nihoUserId, calendarRoleCeiling: "OWNER" }) }));

import { loadSiteHomeMonth, loadSiteSales } from "./site-sales-server";
import { SITE_SALES_HOME_SCOPE_TEXT } from "./site-sales";

const OWNER = { id: "sample-provider", memberRole: "OWNER" } as const;
const SESSION = { nihoUserId: "sample-niho-user" };
const ACTOR = { providerId: "sample-provider", nihoUserId: "sample-niho-user", calendarRoleCeiling: "OWNER" };
const PAYMENT: HostSaleEntry = {
  key: "payment:00000000-0000-4000-8000-000000000001", kind: "PAYMENT", amount: 7500, currency: "JPY", occurredAtUtc: "2026-11-02T01:00:00.000Z",
  publicBookingId: "00000000-0000-4000-8000-000000000001", productTitle: "Synthetic walk", bookingStatus: "CONFIRMED", localDate: "2026-11-05",
  localStartTime: "10:00", adultCount: 2, childCount: 1, guestName: "Sample Guest", platformFeeAmount: 750, providerAmount: 6750, feeEstimated: false, refund: null,
};
const NOVEMBER = { from: "2026-10-31T15:00:00.000Z", to: "2026-11-30T15:00:00.000Z" };
const OCTOBER = { from: "2026-09-30T15:00:00.000Z", to: "2026-10-31T15:00:00.000Z" };

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-11-20T03:00:00.000Z"), toFake: ["Date"] });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  state.mock = false;
  state.store = { listGuestSalesForHost: vi.fn(async () => ({ entries: [PAYMENT], firstEntryAtUtc: "2026-09-20T03:00:00.000Z" })) };
});

describe("売上 from the experience DB", () => {
  it("reads the month `?month=` names, in Japan, as the OWNER", async () => {
    const load = await loadSiteSales(OWNER, SESSION, "2026-10");
    expect(state.store!.listGuestSalesForHost).toHaveBeenCalledWith(ACTOR, OCTOBER);
    expect(load).toMatchObject({ status: "live", page: { label: "2026年10月", previous: { year: 2026, month: 9 }, next: { year: 2026, month: 11 } } });
  });

  it("opens on this month for no month, a later one, or one before the first entry", async () => {
    expect(await loadSiteSales(OWNER, SESSION, undefined)).toMatchObject({ status: "live", page: { label: "2026年11月", next: null } });
    expect(state.store!.listGuestSalesForHost).toHaveBeenLastCalledWith(ACTOR, NOVEMBER);
    await loadSiteSales(OWNER, SESSION, "2027-01");
    expect(state.store!.listGuestSalesForHost).toHaveBeenLastCalledWith(ACTOR, NOVEMBER);
    state.store!.listGuestSalesForHost.mockClear();
    expect(await loadSiteSales(OWNER, SESSION, "2026-08")).toMatchObject({ status: "live", page: { label: "2026年11月" } });
    expect(state.store!.listGuestSalesForHost.mock.calls.map(([, window]) => window)).toEqual([
      { from: "2026-07-31T15:00:00.000Z", to: "2026-08-31T15:00:00.000Z" },
      NOVEMBER,
    ]);
  });

  it("keeps today's screen for anyone but the OWNER, without the store, and when the store refuses the OWNER", async () => {
    expect(await loadSiteSales({ id: "sample-provider", memberRole: "EDITOR" }, SESSION, undefined)).toEqual({ status: "closed" });
    state.store!.listGuestSalesForHost.mockRejectedValueOnce(new StoreAccessDeniedError());
    expect(await loadSiteSales(OWNER, SESSION, undefined)).toEqual({ status: "closed" });
    state.store = null;
    expect(await loadSiteSales(OWNER, SESSION, undefined)).toEqual({ status: "closed" });
  });

  it("says it could not read, logging no more than the error's name", async () => {
    state.store!.listGuestSalesForHost.mockRejectedValueOnce(new StoreError("The sales window has more ledger entries than one read takes."));
    expect(await loadSiteSales(OWNER, SESSION, undefined)).toEqual({ status: "error" });
    expect(console.error).toHaveBeenCalledWith("Experience host sales read failed", { error: "StoreError" });
  });

  it("is ホーム's card for this month", async () => {
    expect(await loadSiteHomeMonth(OWNER, SESSION)).toEqual({
      status: "live",
      month: { label: "11月", figures: [{ label: "売上", value: "¥7,500" }, { label: "返金", value: "¥0" }, { label: "受取額", value: "¥6,750" }, { label: "支払い", value: "1件" }], note: SITE_SALES_HOME_SCOPE_TEXT },
    });
    expect(state.store!.listGuestSalesForHost).toHaveBeenCalledWith(ACTOR, NOVEMBER);
    state.store!.listGuestSalesForHost.mockRejectedValueOnce(new Error("down"));
    expect(await loadSiteHomeMonth(OWNER, SESSION)).toEqual({ status: "error" });
    expect(await loadSiteHomeMonth({ id: "sample-provider", memberRole: "COHOST" }, SESSION)).toEqual({ status: "closed" });
  });
});

describe("the preview", () => {
  it("shows the synthetic ledger only to the `?mock=site-sales` sign-in, never reading the store", async () => {
    state.mock = true;
    expect(await loadSiteSales(OWNER, SESSION, undefined)).toEqual({ status: "closed" });
    const load = await loadSiteSales(OWNER, { ...SESSION, mockScenario: "site-sales" }, undefined);
    expect(load).toMatchObject({ status: "live", page: { label: "2026年10月", previous: { year: 2026, month: 9 }, next: null } });
    expect(load.status === "live" && load.page.rows).toHaveLength(7);
    const september = await loadSiteSales(OWNER, { ...SESSION, mockScenario: "site-sales" }, "2026-09");
    expect(september.status === "live" && september.page.rows.map((row) => row.shortDate)).toEqual(["09/30", "09/20"]);
    expect(await loadSiteHomeMonth(OWNER, { ...SESSION, mockScenario: "site-sales" })).toMatchObject({ status: "live", month: { label: "10月" } });
    expect(state.store!.listGuestSalesForHost).not.toHaveBeenCalled();
  });
});
