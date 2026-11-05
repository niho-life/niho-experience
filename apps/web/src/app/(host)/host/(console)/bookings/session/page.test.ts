import { isValidElement, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

type Load = Mock<(...args: unknown[]) => Promise<unknown>>;

/** Experience開催回ページが旧予約ソースを持たず、Experience/OTAデータを使うことを確認する。 */
const state = vi.hoisted(() => ({
  memberRole: "OWNER" as string,
  site: { status: "closed" } as Record<string, unknown>,
  ota: { status: "closed" } as Record<string, unknown>,
  otaShown: false,
  loadSiteSession: null as null | Load,
  loadOtaSession: null as null | Load,
}));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", async (importActual) => ({
  ...(await importActual<typeof import("next/navigation")>()),
  notFound: () => { throw new Error("NOT_FOUND"); },
}));
vi.mock("@/host/data", () => ({
  hostPageContext: async () => ({
    session: { nihoUserId: "sample-niho-user" },
    providers: [],
    provider: { id: "sample-provider", displayName: "Synthetic provider", memberRole: state.memberRole },
    providerNotFound: false,
    linkProviderId: "sample-provider",
  }),
}));
vi.mock("@/host/site-sessions-server", () => ({ loadSiteSession: (...args: unknown[]) => state.loadSiteSession!(...args) }));
vi.mock("@/host/ota-bookings-server", () => ({
  loadOtaSession: (...args: unknown[]) => state.loadOtaSession!(...args),
  otaBookingsShown: () => state.otaShown,
}));
vi.mock("@/lib/experience/calendar-actor", () => ({ resolveCalendarContext: async () => ({ choices: [], choice: null, providerNotFound: false }) }));

import HostSessionPage from "./page";
import { HostSession } from "@/components/host/HostSession";

const QUERY = { date: "2026-11-01", start: "10:00", experience: "tea", offer: "sample-am" };
const VIEW = { date: "2026-11-01", start: "10:00", end: "11:30", experienceId: "tea", offerId: "sample-am", title: "Synthetic tea ceremony", offer: "Synthetic tea ceremony", capacity: null, meetingArea: "", bookings: [{ id: "b-1" }] };
const LIVE = { status: "live", session: VIEW, now: "2026-11-01T09:00", messages: true, attendance: true };

beforeEach(() => {
  state.memberRole = "OWNER";
  state.site = { status: "closed" };
  state.ota = { status: "closed" };
  state.otaShown = false;
  state.loadSiteSession = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => state.site);
  state.loadOtaSession = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => state.ota);
});

async function page(query: Record<string, string> = QUERY): Promise<ReactElement<Record<string, unknown>>> {
  const element: unknown = await HostSessionPage({ searchParams: Promise.resolve(query) });
  expect(isValidElement(element)).toBe(true);
  return element as ReactElement<Record<string, unknown>>;
}

describe("Experience session", () => {
  it("shows the OWNER's Experience guests and attendance controls", async () => {
    state.site = LIVE;
    const view = await page();
    expect(view.type).toBe(HostSession);
    expect(view.props).toEqual({ session: VIEW, now: "2026-11-01T09:00", providerId: "sample-provider", site: { providerId: "sample-provider", messages: true, attendance: true }, ota: null });
    expect(state.loadSiteSession).toHaveBeenCalledWith(expect.objectContaining({ id: "sample-provider" }), QUERY);
  });

  it("says when Experience session data is unavailable and rejects unknown sessions", async () => {
    expect((await page()).props).toEqual({ backHref: "/host/bookings?providerId=sample-provider" });
    state.site = { status: "error" };
    expect((await page()).props).toMatchObject({ title: "参加者を読み込めませんでした" });
    state.site = { ...LIVE, session: null };
    await expect(page()).rejects.toThrow("NOT_FOUND");
  });

  it("keeps the session OWNER-only", async () => {
    state.memberRole = "EDITOR";
    await expect(page()).rejects.toThrow("NOT_FOUND");
    expect(state.loadSiteSession).not.toHaveBeenCalled();
  });

  it("adds OTA guests when the read-only OTA integration is enabled", async () => {
    state.site = LIVE;
    state.otaShown = true;
    state.ota = { status: "live", bookings: [], attendance: false, now: "2026-11-01T09:30" };
    const view = await page();
    expect(view.type).toBe(HostSession);
    expect(view.props).toMatchObject({ site: { providerId: "sample-provider" }, ota: { attendance: false } });
    expect(state.loadOtaSession).toHaveBeenCalledWith("sample-provider", expect.objectContaining({ memberRole: "OWNER" }), QUERY, undefined);
  });
});
