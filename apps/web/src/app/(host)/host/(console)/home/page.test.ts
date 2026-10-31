import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { HostHomeData } from "@/host/console-data";
import type { HomeUpcoming } from "@/host/home";

type Load = Mock<(...args: unknown[]) => Promise<unknown>>;

/** ホーム's sessions and todos with this site's bookings (#285 slice 8b), against stubbed data. */
const state = vi.hoisted(() => ({
  providerOperations: false,
  site: { status: "closed" } as Record<string, unknown>,
  loadSiteHome: null as null | Load,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/host/data", () => ({
  hostPageContext: async () => ({
    session: { nihoUserId: "sample-niho-user" },
    providers: [],
    provider: { id: "sample-provider", displayName: "Synthetic provider", memberRole: "OWNER" },
    providerNotFound: false,
    linkProviderId: "sample-provider",
  }),
  loadHostConsoleData: async () => ({ home: CONSOLE_HOME, settings: { calendar: { google: { status: "disconnected" }, icsUrl: null } } }),
}));
vi.mock("@/lib/experience/calendar-actor", () => ({ resolveCalendarContext: async () => null }));
vi.mock("@/host/site-sessions-server", () => ({ loadSiteHome: (...args: unknown[]) => state.loadSiteHome!(...args) }));
vi.mock("@/lib/host/server", () => ({ isHostMock: () => false }));
vi.mock("@/lib/host/provider-operations-server", () => ({ providerOperationsEnabled: () => state.providerOperations }));

import HostHomePage from "./page";
import { HostHomeTodos } from "@/components/host/HostHomeTodos";
import { SITE_HOME_LOAD_FAILED_TEXT } from "@/host/site-sessions";

/** http mode: NIHO's sessions are not read yet (TODO(#87)), so ホーム's own part is empty. */
const CONSOLE_HOME: HostHomeData = { todos: [], sessions: { today: [], tomorrow: [], later: [] }, month: null };

function row(key: string, source?: string): HomeUpcoming {
  return { key, href: `/host/bookings/session?key=${key}`, dateLabel: "11月1日（日）", weekday: "日", day: 1, title: `Synthetic ${key}`, detail: "10:00 開始", seats: "3名", bookings: "2件", dietary: "", phase: null, ...(source ? { source } : {}) };
}

const TODO = { key: "site-payment-review/x", status: { label: "確認待ち", tone: "wait" }, aside: null, title: "確認待ちの支払いがあります", detail: "", approval: null, action: { label: "この回を見る", href: "/host/bookings/session?x", primary: false } };

beforeEach(() => {
  state.providerOperations = false;
  state.site = { status: "closed" };
  state.loadSiteHome = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => state.site);
});

/** Every element of the page's tree, with its local views (DaySessions and the like) left as elements. */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

async function page() {
  const element = await HostHomePage({ searchParams: Promise.resolve({}) });
  const all = elements(element);
  const named = (name: string) => all.filter((item) => typeof item.type === "function" && item.type.name === name);
  return {
    all,
    todos: all.find((item) => item.type === HostHomeTodos)?.props.todos,
    days: Object.fromEntries(named("DaySessions").map((item) => [item.props.id, (item.props.sessions as HomeUpcoming[]).map((upcoming) => upcoming.key)])),
    later: all.filter((item) => item.type === "li" && typeof item.key === "string" && item.key.length > 0).map((item) => item.key),
    sources: named("SessionSource").map((item) => (item.props.item as HomeUpcoming).source),
    alert: all.find((item) => item.props.role === "alert")?.props.children,
  };
}

describe("ホーム with this site's bookings", () => {
  it("fills the sessions and 次にすること with them without NIHO's bookings (provider operations off)", async () => {
    state.site = { status: "live", todos: [TODO], sessions: { today: [row("today")], tomorrow: [row("tomorrow")], later: [row("later")] } };
    const view = await page();
    expect(state.loadSiteHome).toHaveBeenCalledWith(expect.objectContaining({ id: "sample-provider" }), "sample-niho-user", false);
    expect(view.todos).toEqual([TODO]);
    expect(view.days).toEqual({ "home-today": ["today"], "home-tomorrow": ["tomorrow"] });
    expect(view.later).toContain("later");
    expect(view.sources.filter(Boolean)).toEqual([]);
    expect(view.alert).toBeUndefined();
  });

  it("adds them labelled as this site's beside NIHO's bookings (provider operations on)", async () => {
    state.providerOperations = true;
    state.site = { status: "live", todos: [], sessions: { today: [], tomorrow: [], later: [row("later", "このサイトの予約")] } };
    const view = await page();
    expect(state.loadSiteHome).toHaveBeenCalledWith(expect.anything(), "sample-niho-user", true);
    expect(view.later).toContain("later");
    expect(view.sources).toEqual(["このサイトの予約"]);
  });

  it("keeps today's screen while they are closed to the account, and says when they could not be read", async () => {
    const closed = await page();
    expect(closed.todos).toBe(CONSOLE_HOME.todos);
    expect(closed.days).toEqual({ "home-today": [], "home-tomorrow": [] });
    expect(closed.alert).toBeUndefined();

    state.site = { status: "error" };
    const failed = await page();
    expect(failed.todos).toBe(CONSOLE_HOME.todos);
    expect(failed.alert).toBe(SITE_HOME_LOAD_FAILED_TEXT);
  });
});
