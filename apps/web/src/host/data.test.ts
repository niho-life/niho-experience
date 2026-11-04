import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostProvider } from "@/lib/host/providers";
import type { HostMockScenario } from "@/lib/host/session";

/** The console's data entry point against the contract mock (mock) and a stubbed NIHO (http). */
const state = vi.hoisted(() => ({
  config: { apiMode: "mock" as "mock" | "http", nihoWebOrigin: "https://niho.example.test" },
  providers: [] as HostProvider[],
  scenario: "default" as HostMockScenario,
  selectedHostClient: null as unknown,
  publicationRepository: null as unknown,
  notificationLoad: { status: "preparing" } as import("./notification-settings-server").HostNotificationSettingsLoad,
  notificationCalls: [] as { providerId: string; nihoUserId: string }[],
}));
vi.mock("server-only", () => ({}));
// The experience DB's 通知 (#109) is its own module; here only what it answers.
vi.mock("./notification-settings-server", () => ({
  loadNotificationSettings: async (provider: HostProvider) => {
    state.notificationCalls.push({ providerId: provider.id, nihoUserId: provider.nihoUserId });
    return state.notificationLoad;
  },
}));
vi.mock("@/lib/config", () => ({ config: state.config, isPreview: true }));
// The real hostApiClient (typed client + contract mock, or the global fetch in http mode); only the session and the list are stubbed.
vi.mock("@/lib/host/server", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/host/server")>();
  const now = Date.now();
  const session = { refreshToken: "r", accessToken: "mock-access-token.data-test", accessTokenExpiresAt: now + 3_600_000, connectionId: "c", connectionExpiresAt: now + 86_400_000, expiresAt: now + 86_400_000, displayName: "サンプル ホスト", iconUrl: null };
  return {
    ...actual,
    readHostSession: async () => ({ ...session, mockScenario: state.scenario }),
    loadHostProviders: async () => ({ status: "ok", providers: state.providers }),
    selectedHostApiClient: async (...args: Parameters<typeof actual.selectedHostApiClient>) => {
      if (state.selectedHostClient) return state.selectedHostClient as Awaited<ReturnType<typeof actual.selectedHostApiClient>>;
      return actual.selectedHostApiClient(...args);
    },
  };
});
vi.mock("@/lib/experience/store-server", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/experience/store-server")>();
  return { ...actual, experiencePublicationRepository: () => state.publicationRepository };
});

import { hostPageContext, loadHostBookings, loadHostConsoleData, loadHostExperienceEditor, loadHostMessages, loadHostPayout, loadHostReviews, loadHostSales, loadHostSession, loadRegistrationConsent } from "./data";
import { GOOGLE_NOT_CONNECTED } from "./calendar";
import { MOCK_GOOGLE_CONNECTION } from "./mock/provider";
import { MOCK_SALES_PERIOD } from "./mock/sales";

/** A local Experience seller membership joined to synthetic NIHO identity. */
const provider = (fields: Pick<HostProvider, "id" | "displayName" | "memberRole"> & Partial<HostProvider>): HostProvider => ({
  nihoUserId: "sample-user",
  legacyProviderId: "sample-legacy-provider",
  kind: "INDIVIDUAL",
  bio: "",
  sellerDisclosureUrl: null,
  reviewStatus: "DRAFT",
  consentVersion: "sample-provider-consent-1",
  paymentReuseSourceSpotId: null,
  ...fields,
});

const KITCHEN = provider({ id: "sample-provider-kitchen", displayName: "サンプルの台所", memberRole: "OWNER", reviewStatus: "APPROVED" });
const STUDIO = provider({ id: "sample-provider-studio", displayName: "サンプル工房", memberRole: "EDITOR", kind: "BUSINESS" });
const GARDEN = provider({ id: "sample-provider-garden", displayName: "サンプルの庭", memberRole: "OWNER" });

/** http mode: NIHO is the global fetch, recorded here. */
function stubNiho(respond: (url: string) => Response) {
  const calls: { url: string; authorization: string | null }[] = [];
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
    return respond(String(input));
  }) as typeof fetch);
  return calls;
}

beforeEach(() => {
  state.config.apiMode = "mock";
  state.providers = [KITCHEN, STUDIO];
  state.scenario = "default";
  state.selectedHostClient = null;
  state.publicationRepository = null;
  state.notificationLoad = { status: "preparing" };
  state.notificationCalls = [];
});
afterEach(() => vi.unstubAllGlobals());

describe("loadHostConsoleData", () => {
  it("mock: the kitchen's synthetic seller data and preview data", async () => {
    const data = await loadHostConsoleData(KITCHEN, { meetingPoint: true });
    expect(data.settings).toEqual({
      displayName: "サンプルの台所",
      kind: "INDIVIDUAL",
      bio: "",
      sellerDisclosureUrl: "",
      reviewStatus: "APPROVED",
      consentCurrent: null,
      meetingPoint: expect.objectContaining({ overview: "Near Kamakura Station, 5-minute walk", mapUrl: "https://maps.example.com/sample-kitchen" }),
      calendar: { google: expect.objectContaining({ status: "connected", account: "kitchen@example.com" }), icsUrl: expect.stringMatching(/^https:\/\/calendar\.example\.com\//) },
      notifications: { email: { addresses: ["kitchen@example.com"] }, items: expect.any(Array) },
      notificationSource: "preview",
    });
    // The preview never reads the experience DB.
    expect(state.notificationCalls).toEqual([]);
    expect(data.googleConnection).toBe(MOCK_GOOGLE_CONNECTION);
    expect(data.experiences).toHaveLength(3);
    expect(data.home.todos).toHaveLength(10);
  });

  it("mock: the notification settings are the owner's only, as NIHO answers them", async () => {
    const data = await loadHostConsoleData(STUDIO);
    expect(data.settings.notifications).toBeNull();
    expect(data.settings.calendar.google).toEqual(GOOGLE_NOT_CONNECTED);
  });

  it("mock: ?mock=calendar-revoked shows the kitchen's calendar as revoked", async () => {
    state.scenario = "calendar-revoked";
    expect((await loadHostConsoleData(KITCHEN)).settings.calendar.google).toMatchObject({ status: "revoked", account: "kitchen@example.com" });
  });

  it("mock: the studio is a business still in draft", async () => {
    const data = await loadHostConsoleData(STUDIO);
    expect(data.settings).toMatchObject({ displayName: "サンプル工房", kind: "BUSINESS", reviewStatus: "DRAFT", consentCurrent: null });
    expect(data.experiences.map((experience) => experience.status)).toEqual(["draft"]);
    expect(data.home.sessions).toEqual({ today: [], tomorrow: [], later: [] });
  });

  it("http: uses the local Experience seller profile and does not call removed NIHO provider APIs", async () => {
    state.config.apiMode = "http";
    const calls = stubNiho(() => { throw new Error("legacy provider API must not be called"); });
    const data = await loadHostConsoleData(KITCHEN, { meetingPoint: true });
    expect(calls).toEqual([]);
    expect(data.settings).toMatchObject({
      displayName: "サンプルの台所", kind: "INDIVIDUAL", bio: "", sellerDisclosureUrl: "",
      reviewStatus: "APPROVED", consentCurrent: null, meetingPoint: null,
    });
    expect(data.settings.calendar).toEqual({ google: GOOGLE_NOT_CONNECTED, icsUrl: null });
    expect(data.googleConnection).toBeNull();
    expect(data.experiences).toEqual([]);
    expect(data.home).toEqual({ todos: [], sessions: { today: [], tomorrow: [], later: [] }, month: null });
  });

  it("http: 通知 comes from the experience DB for the owner once it is open there (#109)", async () => {
    state.config.apiMode = "http";
    const calls = stubNiho(() => { throw new Error("legacy provider API must not be called"); });
    const items = [{ key: "NEW_BOOKING", enabled: true, locked: true }, { key: "NEW_REVIEW", enabled: false, locked: false }];
    state.notificationLoad = { status: "live", items };
    // Only 設定 asks for them; the other pages never read the DB for them.
    expect((await loadHostConsoleData(KITCHEN)).settings.notificationSource).toBe("preparing");
    expect(state.notificationCalls).toEqual([]);
    const live = await loadHostConsoleData(KITCHEN, { notifications: true });
    expect(live.settings).toMatchObject({ notifications: { email: { addresses: [] }, items }, notificationSource: "live" });
    expect(state.notificationCalls).toEqual([{ providerId: KITCHEN.id, nihoUserId: "sample-user" }]);
    expect(calls).toEqual([]);
    state.notificationLoad = { status: "error" };
    expect((await loadHostConsoleData(KITCHEN, { notifications: true })).settings.notificationSource).toBe("error");
    // An editor never reads them.
    state.notificationCalls = [];
    expect((await loadHostConsoleData(STUDIO, { notifications: true })).settings).toMatchObject({ notifications: null, notificationSource: "preparing" });
    expect(state.notificationCalls).toEqual([]);
  });

  it("http: never tries a NIHO provider detail fallback", async () => {
    state.config.apiMode = "http";
    const calls = stubNiho(() => { throw new Error("legacy provider API must not be called"); });
    expect((await loadHostConsoleData(KITCHEN)).settings).toMatchObject({
      displayName: "サンプルの台所", kind: "INDIVIDUAL", bio: "", sellerDisclosureUrl: "", reviewStatus: "APPROVED",
      consentCurrent: null, meetingPoint: null,
    });
    expect(calls).toEqual([]);
  });

  it("http: meeting defaults are unavailable without the Experience product API", async () => {
    state.config.apiMode = "http";
    const calls = stubNiho(() => { throw new Error("legacy provider API must not be called"); });
    expect((await loadHostConsoleData(STUDIO, { meetingPoint: true })).settings.meetingPoint).toBeNull();
    expect((await loadHostConsoleData(STUDIO)).settings.meetingPoint).toBeNull();
    const cohost = provider({ id: KITCHEN.id, displayName: "サンプルの台所", memberRole: "COHOST" });
    expect((await loadHostConsoleData(cohost, { meetingPoint: true })).settings.meetingPoint).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("loadHostExperienceEditor", () => {
  it("passes verified mock publication facts, and keeps non-owner or unreadable facts closed", async () => {
    expect((await loadHostExperienceEditor(KITCHEN, "coffee")).publication).toEqual({
      role: "OWNER", payoutReason: "READY", sellerDisclosureReady: false, consentCurrent: null, providerStatus: "available",
    });
    expect((await loadHostExperienceEditor(STUDIO, "calligraphy")).publication).toEqual({
      role: "EDITOR", payoutReason: null, sellerDisclosureReady: false, consentCurrent: null, providerStatus: "available",
    });
  });

  it("does not add a legacy NIHO provider detail dependency to the HTTP editor", async () => {
    state.config.apiMode = "http";
    const calls = stubNiho(() => { throw new Error("legacy provider API must not be called"); });
    expect((await loadHostExperienceEditor(KITCHEN, "coffee")).editor).toEqual({ status: "unavailable" });
    expect(calls).toEqual([]);
  });
});

describe("loadHostBookings", () => {
  it("mock: the kitchen's bookings, the one ?booking= names, and the experiences without their pages", async () => {
    const data = await loadHostBookings(KITCHEN, "bk-2041");
    expect([data.today, data.now]).toEqual(["2026-10-21", "2026-10-21T15:30"]);
    expect(data.list.status === "ready" && data.list.bookings).toHaveLength(18);
    expect(data.requested).toMatchObject({ status: "ready", booking: { id: "bk-2041", guest: "Lucas & Mia Chen" } });
    expect(data.experiences[0]).toEqual({
      id: "community-dinner",
      title: "Kamakura Community Dinner with Locals",
      offers: [
        { id: "offer-dinner", capacity: 8, durationMinutes: 120 },
        { id: "offer-tea", capacity: 8, durationMinutes: 120 },
      ],
    });
    // The booking with a thread shows its last message (#106).
    expect(data.conversations).toEqual([{ bookingId: "bk-2031", threadId: "th-3004", text: expect.stringContaining("スーツケース"), at: "2026-10-21T11:05" }]);
    expect((await loadHostBookings(KITCHEN, null)).requested).toBeNull();
    // The studio has no bookings, and the kitchen's are not its own.
    const studio = await loadHostBookings(STUDIO, "bk-2041");
    expect([studio.list, studio.requested]).toEqual([{ status: "ready", bookings: [] }, { status: "missing" }]);
  });

  it("http: nothing to read until the provider API has bookings (#87)", async () => {
    state.config.apiMode = "http";
    const calls = stubNiho(() => new Response("unexpected", { status: 500 }));
    const data = await loadHostBookings(KITCHEN, "bk-2041");
    expect([data.list, data.requested, data.now, data.conversations]).toEqual([{ status: "unavailable" }, { status: "unavailable" }, null, []]);
    expect(calls).toEqual([]);
  });
});

describe("loadHostSession", () => {
  const sofia = { date: "2026-10-27", start: "18:00", experience: "community-dinner", offer: "offer-dinner" };

  it("mock: one session's bookings with the threads they have, at the preview's moment", async () => {
    const data = await loadHostSession(KITCHEN, sofia);
    expect(data.now).toBe("2026-10-21T15:30");
    expect(data.lookup.status === "ready" && data.lookup.session.bookings.map((booking) => booking.guest)).toEqual(["Sofia Rossi"]);
    expect(data.conversations).toEqual([{ bookingId: "bk-2031", threadId: "th-3004", text: expect.stringContaining("スーツケース"), at: "2026-10-21T11:05" }]);
    // Tomorrow's dinner has no thread yet; the studio has no such session.
    expect((await loadHostSession(KITCHEN, { ...sofia, date: "2026-10-22" })).conversations).toEqual([]);
    expect(await loadHostSession(STUDIO, sofia)).toMatchObject({ lookup: { status: "missing" }, conversations: [] });
  });

  it("http: nothing to read until NIHO has the session's guests and attendance (#87)", async () => {
    state.config.apiMode = "http";
    const calls = stubNiho(() => new Response("unexpected", { status: 500 }));
    expect(await loadHostSession(KITCHEN, sofia)).toMatchObject({ lookup: { status: "unavailable" }, conversations: [] });
    expect(calls).toEqual([]);
  });
});

describe("loadHostMessages", () => {
  it("mock: the kitchen's threads, the one ?thread= or ?booking= names, and the experiences' titles", async () => {
    const data = await loadHostMessages(KITCHEN, { thread: "th-3012", booking: null });
    expect([data.today, data.now]).toEqual(["2026-10-21", "2026-10-21T15:30"]);
    expect(data.list.status === "ready" && data.list.threads.map((thread) => thread.id)).toEqual(["th-3012", "th-3007", "th-3004", "th-3010"]);
    expect(data.requested).toMatchObject({ status: "thread", thread: { id: "th-3012" } });
    expect(data.experiences[0]).toEqual({ id: "community-dinner", title: "Kamakura Community Dinner with Locals" });
    // ?thread= wins over ?booking=.
    expect((await loadHostMessages(KITCHEN, { thread: "th-3007", booking: "bk-2031" })).requested).toMatchObject({ status: "thread", thread: { id: "th-3007" } });
    expect((await loadHostMessages(KITCHEN, { thread: null, booking: "bk-2044" })).requested).toMatchObject({ status: "new", thread: { id: "th-bk-2044" } });
    expect((await loadHostMessages(KITCHEN, { thread: null, booking: null })).requested).toBeNull();
    const studio = await loadHostMessages(STUDIO, { thread: "th-3012", booking: null });
    expect([studio.list, studio.requested]).toEqual([{ status: "ready", threads: [] }, { status: "missing" }]);
  });

  it("http: nothing to read until NIHO's API has the messages (#87)", async () => {
    state.config.apiMode = "http";
    const calls = stubNiho(() => new Response("unexpected", { status: 500 }));
    const data = await loadHostMessages(KITCHEN, { thread: "th-3012", booking: null });
    expect([data.list, data.requested]).toEqual([{ status: "unavailable" }, { status: "unavailable" }]);
    expect(calls).toEqual([]);
  });
});

describe("loadHostReviews", () => {
  it("mock: the kitchen's reviews, the preview's moment and the experiences' titles; the studio has none", () => {
    const data = loadHostReviews(KITCHEN);
    expect(data.now).toBe("2026-10-21T15:30");
    expect(data.list.status === "ready" && data.list.reviews.map((review) => review.id)).toEqual(["rv-5020", "rv-5013", "rv-4926", "rv-4912", "rv-4906", "rv-4902"]);
    expect(data.experiences).toEqual([
      { id: "community-dinner", title: "Kamakura Community Dinner with Locals" },
      { id: "kintsugi", title: "Mend a Broken Bowl with a Kamakura Restorer" },
      { id: "coffee", title: "Roast Your Own Coffee in a Kamakura Living Room" },
    ]);
    expect(loadHostReviews(STUDIO).list).toEqual({ status: "ready", reviews: [] });
  });

  it("http: nothing to read until NIHO's API has the reviews (#87)", () => {
    state.config.apiMode = "http";
    const calls = stubNiho(() => new Response("unexpected", { status: 500 }));
    expect(loadHostReviews(KITCHEN).list).toEqual({ status: "unavailable" });
    expect(calls).toEqual([]);
  });
});

describe("hostPageContext", () => {
  it("opens the provider named in ?providerId= and carries it on links", async () => {
    expect(await hostPageContext({ providerId: STUDIO.id })).toMatchObject({ provider: STUDIO, providerNotFound: false, linkProviderId: STUDIO.id });
    expect(await hostPageContext({})).toMatchObject({ provider: KITCHEN, providerNotFound: false, linkProviderId: null });
  });

  it("falls back to the first provider, and says so, for ids this account cannot open", async () => {
    expect(await hostPageContext({ providerId: "someone-else" })).toMatchObject({ provider: KITCHEN, providerNotFound: true, linkProviderId: "someone-else" });
    expect(await hostPageContext({ providerId: "../admin" })).toMatchObject({ provider: KITCHEN, providerNotFound: true, linkProviderId: null });
    expect(await hostPageContext({ providerId: [STUDIO.id, KITCHEN.id] })).toMatchObject({ provider: KITCHEN, providerNotFound: false, linkProviderId: null });
  });

  it("has no provider for an account that has not registered one", async () => {
    state.providers = [];
    expect(await hostPageContext({ providerId: STUDIO.id })).toMatchObject({ provider: null, providers: [] });
  });
});

describe("loadHostSales", () => {
  it("mock: the preview's months for every provider, with the kitchen's ledger; http: nothing to read yet", () => {
    expect(loadHostSales(KITCHEN)).toMatchObject({ status: "ready", period: MOCK_SALES_PERIOD });
    expect(loadHostSales(GARDEN)).toEqual({ status: "ready", period: MOCK_SALES_PERIOD, sales: [] });
    state.config.apiMode = "http";
    expect(loadHostSales(KITCHEN)).toEqual({ status: "unavailable" });
  });
});

describe("loadHostPayout", () => {
  it("mock: the owner reads the kitchen's ready account; an editor reads nothing", async () => {
    expect(await loadHostPayout(KITCHEN)).toEqual({
      load: { status: "owner", payout: { reason: "READY", sharedFrom: null, candidates: [], reuseConsent: null } },
      notice: null,
      redirectTo: null,
    });
    expect(await loadHostPayout(STUDIO)).toEqual({ load: { status: "not-owner" }, notice: null, redirectTo: null });
  });

  it("mock: a provider without a Connect account has no candidate or reuse operation", async () => {
    state.scenario = "payments-pending";
    expect((await loadHostPayout(GARDEN)).load).toEqual({ status: "owner", payout: { reason: "NOT_CONNECTED", sharedFrom: null, candidates: [], reuseConsent: null } });
    expect((await loadHostPayout(GARDEN, { candidates: false })).load).toMatchObject({ status: "owner", payout: { reason: "NOT_CONNECTED", candidates: [] } });
  });

  it("mock: Connect return and refresh do not mutate NIHO Connect state", async () => {
    expect(await loadHostPayout(KITCHEN, { connect: "return" })).toMatchObject({ load: { payout: { reason: "READY" } }, notice: null, redirectTo: null });
    state.scenario = "payments-pending";
    expect(await loadHostPayout(GARDEN, { connect: "return" })).toMatchObject({ load: { payout: { reason: "NOT_CONNECTED" } }, notice: null, redirectTo: null });
    expect(await loadHostPayout(GARDEN, { connect: "refresh" })).toMatchObject({ load: { payout: { reason: "NOT_CONNECTED" } }, notice: null, redirectTo: null });
  });

  it("http: Connect is read-only and never calls the removed setup-link endpoint", async () => {
    state.config.apiMode = "http";
    const getLegacyConnectAccount = vi.fn().mockResolvedValue({ ok: true, data: {
      legacyProviderId: KITCHEN.legacyProviderId,
      stripeAccountId: "acct_synthetic12345678",
      readiness: { ready: true, reason: "READY" },
      paymentReuseConsent: { accepted: true, version: "synthetic-payment-v1", consentedAt: "2026-11-04T00:00:00.000Z" },
    } });
    state.selectedHostClient = { getLegacyConnectAccount };
    state.publicationRepository = {
      currentOwnerSellerProfile: vi.fn().mockResolvedValue({ kind: "ready", profile: {
        providerId: KITCHEN.id,
        legacyProviderId: KITCHEN.legacyProviderId,
        providerDisplayName: KITCHEN.displayName,
        sellerNihoAccountRef: KITCHEN.nihoUserId,
        stripeConnectAccountRef: "acct_synthetic12345678",
        sellerDisplayName: "Synthetic legal seller",
      } }),
    };
    const calls = stubNiho(() => { throw new Error("Connect mutation API must not be called"); });
    expect(await loadHostPayout(KITCHEN, { connect: "refresh" })).toMatchObject({
      load: { status: "owner", payout: { reason: "READY", sharedFrom: null, candidates: [], reuseConsent: null } },
      notice: null, redirectTo: null,
    });
    expect(getLegacyConnectAccount).toHaveBeenCalledWith(KITCHEN.legacyProviderId);
    expect(calls).toEqual([]);
  });
});

describe("loadRegistrationConsent", () => {
  it("does not read provider terms from the removed NIHO provider list", async () => {
    expect(await loadRegistrationConsent()).toBeNull();
    state.config.apiMode = "http";
    const calls = stubNiho(() => { throw new Error("legacy provider API must not be called"); });
    expect(await loadRegistrationConsent()).toBeNull();
    expect(calls).toEqual([]);
  });
});
