import { isValidElement, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

type Load = Mock<(...args: unknown[]) => Promise<unknown>>;

/** この回's choice between NIHO's sessions and this site's bookings (#285 slice 8b), against stubbed data. */
const state = vi.hoisted(() => ({
  providerOperations: false,
  memberRole: "OWNER" as string,
  site: { status: "closed" } as Record<string, unknown>,
  loadSiteSession: null as null | Load,
  loadHostSession: null as null | Load,
}));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", async (importActual) => ({
  ...(await importActual<typeof import("next/navigation")>()),
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("@/host/data", () => ({
  hostPageContext: async () => ({
    session: { nihoUserId: "sample-niho-user" },
    providers: [],
    provider: { id: "sample-provider", displayName: "Synthetic provider", memberRole: state.memberRole },
    providerNotFound: false,
    linkProviderId: "sample-provider",
  }),
  loadHostSession: (...args: unknown[]) => state.loadHostSession!(...args),
}));
vi.mock("@/host/site-sessions-server", () => ({ loadSiteSession: (...args: unknown[]) => state.loadSiteSession!(...args) }));
vi.mock("@/lib/host/provider-operations-server", () => ({ providerOperationsEnabled: () => state.providerOperations }));

import HostSessionPage from "./page";
import { HostSession } from "@/components/host/HostSession";

const QUERY = { date: "2026-11-01", start: "10:00", experience: "tea", offer: "sample-am" };
const VIEW = { date: "2026-11-01", start: "10:00", end: "11:30", experienceId: "tea", offerId: "sample-am", title: "Synthetic tea ceremony", offer: "Synthetic tea ceremony", capacity: null, meetingArea: "", bookings: [{ id: "b-1" }] };
const LIVE = { status: "live", session: VIEW, now: "2026-11-01T09:00" };

beforeEach(() => {
  state.providerOperations = false;
  state.memberRole = "OWNER";
  state.site = { status: "closed" };
  state.loadSiteSession = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => state.site);
  state.loadHostSession = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ lookup: { status: "unavailable" }, now: "2026-11-01T09:00", conversations: [] }));
});

async function page(query: Record<string, string> = QUERY): Promise<ReactElement<Record<string, unknown>>> {
  const element: unknown = await HostSessionPage({ searchParams: Promise.resolve(query) });
  expect(isValidElement(element)).toBe(true);
  return element as ReactElement<Record<string, unknown>>;
}

describe("この回 without NIHO's bookings (provider operations off)", () => {
  it("shows the OWNER this site's bookings of the session, read only, in place of 準備中", async () => {
    state.site = LIVE;
    const view = await page();
    expect(view.type).toBe(HostSession);
    expect(view.props).toEqual({ session: VIEW, now: "2026-11-01T09:00", conversations: [], providerId: "sample-provider", site: { besideNiho: false } });
    expect(state.loadSiteSession).toHaveBeenCalledWith(expect.objectContaining({ id: "sample-provider" }), "sample-niho-user", QUERY);
    expect(state.loadHostSession).not.toHaveBeenCalled();
  });

  it("keeps today's screen while this site's bookings are closed to the account", async () => {
    const view = await page();
    expect((view.type as { name: string }).name).toBe("SessionUnavailable");
    expect(view.props).toEqual({ backHref: "/host/bookings?providerId=sample-provider" });
    expect(state.loadHostSession).toHaveBeenCalled();
  });

  it("says the guests could not be read, and finds no session without this site's bookings", async () => {
    state.site = { status: "error" };
    expect((await page()).props).toMatchObject({ title: "参加者を読み込めませんでした", backHref: "/host/bookings?providerId=sample-provider" });
    state.site = { ...LIVE, session: null };
    await expect(page()).rejects.toThrow("NOT_FOUND");
    await expect(page({ date: "2026-11-01" })).rejects.toThrow("NOT_FOUND");
  });
});

describe("この回 beside NIHO's bookings (provider operations on)", () => {
  beforeEach(() => {
    state.providerOperations = true;
  });

  it("shows this site's bookings for ?source=site, going back to them", async () => {
    state.site = LIVE;
    const view = await page({ ...QUERY, source: "site" });
    expect(view.type).toBe(HostSession);
    expect(view.props.site).toEqual({ besideNiho: true });
    state.site = { status: "error" };
    expect((await page({ ...QUERY, source: "site" })).props).toMatchObject({ backHref: "/host/bookings?providerId=sample-provider&source=site" });
  });

  it("keeps NIHO's screen without ?source=site", async () => {
    state.site = LIVE;
    const view = await page();
    expect((view.type as { name: string }).name).toBe("SessionUnavailable");
    expect(state.loadSiteSession).not.toHaveBeenCalled();
  });
});
