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
  month: { status: "closed" } as Record<string, unknown>,
  loadSiteHomeMonth: null as null | Load,
  live: { todos: [], failed: [] } as Record<string, unknown>,
  loadHomeTodos: null as null | Load,
  calendar: { status: "closed" } as Record<string, unknown>,
  loadHostCalendar: null as null | Load,
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
vi.mock("@/host/site-sales-server", () => ({ loadSiteHomeMonth: (...args: unknown[]) => state.loadSiteHomeMonth!(...args) }));
vi.mock("@/host/home-server", () => ({ loadHomeTodos: (...args: unknown[]) => state.loadHomeTodos!(...args) }));
vi.mock("@/host/calendar-server", () => ({ loadHostCalendar: (...args: unknown[]) => state.loadHostCalendar!(...args) }));
vi.mock("@/lib/host/server", () => ({ isHostMock: () => false }));
vi.mock("@/lib/host/provider-operations-server", () => ({ providerOperationsEnabled: () => state.providerOperations }));

import HostHomePage from "./page";
import { HostHomeTodos } from "@/components/host/HostHomeTodos";
import { SITE_SALES_HOME_LOAD_FAILED_TEXT, SITE_SALES_HOME_SCOPE_TEXT } from "@/host/site-sales";
import { SITE_HOME_LOAD_FAILED_TEXT } from "@/host/site-sessions";
import { GOOGLE_NOT_CONNECTED } from "@/host/calendar";

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
  state.month = { status: "closed" };
  state.loadSiteHomeMonth = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => state.month);
  state.live = { todos: [], failed: [] };
  state.loadHomeTodos = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => state.live);
  state.calendar = { status: "closed" };
  state.loadHostCalendar = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => state.calendar);
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
    alerts: all.filter((item) => item.props.role === "alert").map((item) => item.props.children),
    calendarPrompt: named("CalendarPromptCard")[0]?.props.prompt,
    /** The month card's numbers ("売上 ¥7,500"), its note, or what it says instead. */
    month: all.filter((item) => item.type === "dt" || item.type === "dd").map((item) => item.props.children),
    monthText: all.filter((item) => item.type === "p").map((item) => item.props.children).filter((text) => typeof text === "string"),
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

describe("ホーム's month card (#91)", () => {
  it("is this site's sales this month when the ledger is open to the OWNER, and says whose they are", async () => {
    state.month = { status: "live", month: { label: "11月", figures: [{ label: "売上", value: "¥7,500" }, { label: "受取額", value: "¥6,750" }], note: SITE_SALES_HOME_SCOPE_TEXT } };
    const view = await page();
    expect(state.loadSiteHomeMonth).toHaveBeenCalledWith(expect.objectContaining({ id: "sample-provider" }), { nihoUserId: "sample-niho-user" });
    expect(view.month).toEqual(["売上", "¥7,500", "受取額", "¥6,750"]);
    expect(view.monthText).toContain(SITE_SALES_HOME_SCOPE_TEXT);
  });

  it("keeps 準備中 while it is closed, and says when it could not be read", async () => {
    const closed = await page();
    expect(closed.month).toEqual([]);
    expect(closed.monthText).toContain("売上の集計は準備中です。");

    state.month = { status: "error" };
    const failed = await page();
    expect(failed.month).toEqual([]);
    expect(failed.alert).toBe(SITE_SALES_HOME_LOAD_FAILED_TEXT);
  });
});

describe("ホーム's 次にすること and calendar card in http mode", () => {
  const THREAD = { key: "thread-1", status: { label: "返信待ち", tone: "wait" }, aside: { text: "予約前の質問", tone: "muted" }, title: "「…」", detail: "", approval: null, action: { label: "返信する", href: "/host/messages?thread=1", primary: true } };
  const DRAFT = { key: "draft-page-1", status: { label: "下書き", tone: "draft" }, aside: null, title: "題名なし の原稿を仕上げる", detail: "", approval: null, action: { label: "編集する", href: "/host/experiences/page-1", primary: false } };

  it("lists what the OWNER reads after this site's payments under review, and counts the threads on the app icon", async () => {
    state.site = { status: "live", todos: [TODO], sessions: { today: [], tomorrow: [], later: [] } };
    state.live = { todos: [THREAD, DRAFT], failed: [] };
    const view = await page();
    expect(state.loadHomeTodos).toHaveBeenCalledWith(expect.objectContaining({ id: "sample-provider" }), { nihoUserId: "sample-niho-user" });
    expect(view.todos).toEqual([TODO, THREAD, DRAFT]);
    expect(view.all.find((item) => typeof item.type === "function" && item.type.name === "HostAppBadge")?.props.count).toBe(1);
    expect(view.alert).toBeUndefined();

    state.site = { status: "closed" };
    expect((await page()).todos).toEqual([THREAD, DRAFT]);
  });

  it("says which sources could not be read, in one line", async () => {
    state.live = { todos: [DRAFT], failed: ["messages", "reviews"] };
    const view = await page();
    expect(view.todos).toEqual([DRAFT]);
    expect(view.alerts).toEqual(["メッセージとレビューを読み込めませんでした。次にすることに出ていないものがあるかもしれません。"]);
  });

  it("shows the calendar's card from the OWNER's Google connection, and none while it is closed or connected", async () => {
    expect((await page()).calendarPrompt).toBeUndefined();
    expect(state.loadHostCalendar).toHaveBeenCalledWith(expect.objectContaining({ id: "sample-provider" }), "sample-niho-user", { feed: false });

    state.calendar = { status: "live", google: GOOGLE_NOT_CONNECTED, googleSync: null, feed: null };
    expect((await page()).calendarPrompt).toEqual({ title: "Google カレンダーをつなぐ", text: "予定がある時間は予約を受け付けません", action: "つなぐ" });
    state.calendar = { status: "live", google: { ...GOOGLE_NOT_CONNECTED, status: "revoked" }, googleSync: null, feed: null };
    expect((await page()).calendarPrompt).toMatchObject({ action: "もう一度つなぐ" });
    state.calendar = { status: "live", google: { ...GOOGLE_NOT_CONNECTED, status: "connected" }, googleSync: { lastCheckedAt: null, failing: false }, feed: null };
    expect((await page()).calendarPrompt).toBeUndefined();
    // Google's sign-in is not configured here: nothing to connect.
    state.calendar = { status: "live", google: null, googleSync: null, feed: null };
    expect((await page()).calendarPrompt).toBeUndefined();
    state.calendar = { status: "error" };
    expect((await page()).calendarPrompt).toBeUndefined();
  });
});
